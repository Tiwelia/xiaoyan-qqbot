import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { loadConfig } from '../src/config.js';
import { SessionStore } from '../src/session.js';
import { MemoryStore } from '../src/memory.js';
import { createStateStore } from '../src/state.js';
import { createCommandHandler } from '../src/commands.js';
import { createBot } from '../src/bot.js';
import { handleMessage } from '../src/conversation.js';

const logger = { info() {}, warn() {}, debug() {}, error() {} };
const deferred = () => { let resolve; const promise = new Promise(r => { resolve = r; }); return { promise, resolve }; };
const message = (content, id = content, senderId = 'alice') => ({ kind: 'c2c', senderId, content, messageId: id,
    replyTarget: { scope: 'c2c', targetId: senderId, msgId: id } });
const oldContext = 'OLD_DIALOGUE_7c29';
const oldPush = 'OLD_PROACTIVE_83bd';

function fixture(t, extra = {}) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-reset-'));
    const config = loadConfig({ QQBOT_APPID: 'test', QQBOT_SECRET: 'test', DEEPSEEK_API_KEY: 'test',
        OWNER_OPENID: 'alice', DATA_DIR: root, STREAMING: 'false', TYPING_INDICATOR: 'false',
        PEER_COOLDOWN_MS: '0', PEER_RATE_PER_MIN: '0', ...extra });
    const sessions = new SessionStore({ dir: config.sessionDir, logger });
    const state = createStateStore({ file: config.state.file, logger });
    const memory = new MemoryStore({ dbPath: config.memory.dbPath, logger });
    memory.init();
    sessions.append('c2c', 'alice', [{ role: 'user', content: oldContext }, { role: 'assistant', content: 'OLD_ANSWER' }]);
    sessions.flushAll();
    const sent = [], requests = [], runtime = {};
    const deps = { config, sessions, state, memory, runtime, logger,
        auth: { isOwner: id => id === 'alice', check: async msg => msg.senderId === 'alice' },
        toolkit: { definitions: [] }, bot: { sendText: async (_target, text) => sent.push(text) },
        llm: { stream: async opts => { requests.push(structuredClone(opts.messages)); return { text: 'A fresh answer.', toolCalls: [] }; } } };
    deps.commands = createCommandHandler(deps);
    const stores = [sessions];
    const reopen = () => {
        const store = new SessionStore({ dir: config.sessionDir, logger });
        stores.push(store);
        return store;
    };
    t.after(() => {
        for (const store of stores) {
            store.flushAll();
            for (const entry of store.cache.values()) if (entry.timer) clearTimeout(entry.timer);
        }
        state.close(); memory.close();
        assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
        assert.ok(path.basename(root).startsWith('qqbot-reset-'));
        fs.rmSync(root, { recursive: true, force: true });
    });
    const run = text => deps.commands.handle({ text, scope: 'c2c', targetId: 'alice', msg: message(text) });
    const makeBot = () => {
        class Bot {
            handlers = {};
            use() {} on(event, handler) { this.handlers[event] = handler; }
            async sendText(_target, text) { sent.push(text); }
        }
        return createBot(deps, { Bot });
    };
    return { deps, sent, requests, run, reopen, makeBot };
}

test('/reset really clears memory and disk history while preserving long-term memories and archives', async t => {
    const f = fixture(t);
    const memoryId = f.deps.memory.addImportant('user_fact', 'LONG_TERM_PREFERENCE', 'c2c');
    f.deps.memory.addConversation('ARCHIVE_ONLY_e72b');
    assert.match(await f.run('/reset'), /清了/);
    assert.deepEqual(f.deps.sessions.toMessages('c2c', 'alice'), []);
    assert.deepEqual(f.reopen().toMessages('c2c', 'alice'), []);
    assert.ok(f.deps.memory.listImportant(10, 'c2c').some(row => row.id === memoryId));
    assert.equal(f.deps.memory.count().conversation, 1);
    await handleMessage(f.deps, { state: {} }, message('NEW_QUESTION'));
    assert.equal(f.requests.length, 1);
    const payload = JSON.stringify(f.requests[0]);
    assert.ok(!payload.includes(oldContext));
    assert.ok(!payload.includes('OLD_ANSWER'));
    assert.ok(!payload.includes('ARCHIVE_ONLY_e72b'));
    assert.ok(payload.includes('LONG_TERM_PREFERENCE'));
    assert.ok(payload.includes('NEW_QUESTION'));
});

test('/reset is not silently discarded by the normal message rate limit', async t => {
    const f = fixture(t, { PEER_RATE_PER_MIN: '1', PEER_COOLDOWN_MS: '60000' });
    const bot = f.makeBot();
    t.after(() => bot.drain());
    await bot.handlers.message({ state: {} }, message('/ping'));
    await bot.handlers.message({ state: {} }, message('/reset'));
    assert.deepEqual(f.deps.sessions.toMessages('c2c', 'alice'), []);
    assert.ok(f.sent.some(text => text.includes('清了')));
});

test('a quick follow-up cannot cancel a pending reset or restore an interrupted old turn', async t => {
    const f = fixture(t), started = deferred(), finish = deferred();
    f.deps.llm.stream = async opts => {
        f.requests.push(structuredClone(opts.messages));
        if (f.requests.length === 1) { started.resolve(); await finish.promise; }
        return { text: 'A fresh answer.', toolCalls: [] };
    };
    const bot = f.makeBot();
    t.after(() => bot.drain());
    const active = bot.handlers.message({ state: {} }, message('OLD_RUNNING_QUESTION'));
    await started.promise;
    const reset = bot.handlers.message({ state: {} }, message('/reset'));
    await setImmediate();
    const next = bot.handlers.message({ state: {} }, message('NEW_QUESTION'));
    finish.resolve();
    await Promise.all([active, reset, next]);
    assert.equal(f.requests.length, 2);
    assert.ok(!JSON.stringify(f.requests[1]).includes(oldContext));
    assert.ok(!JSON.stringify(f.requests[1]).includes('OLD_RUNNING_QUESTION'));
    f.deps.sessions.flushAll();
    assert.ok(!JSON.stringify(f.reopen().toMessages('c2c', 'alice')).includes(oldContext));
});

test('reset hides pre-reset proactive background in subsequent prompts, including after restart', async t => {
    const f = fixture(t);
    f.deps.state.set('companion', { ownerId: 'alice', previousUserAt: Date.now() - 7_200_000,
        lastPushAt: Date.now() - 5000, lastPushText: oldPush, pushStatus: 'sent', sent: 2, enabled: false });
    await f.run('/reset');
    const after = f.reopen();
    await handleMessage({ ...f.deps, sessions: after }, { state: {} }, message('NEW_QUESTION'));
    assert.ok(!JSON.stringify(f.requests[0]).includes(oldPush));
    const saved = f.deps.state.get('companion');
    assert.equal(saved.sent, 2);
    assert.equal(saved.enabled, false);
});

test('a failed durable reset is reported instead of claiming it was cleared successfully', async t => {
    const f = fixture(t);
    const sessionFile = f.deps.sessions.filePath('c2c', 'alice');
    const rename = fs.renameSync;
    const mock = t.mock.method(fs, 'renameSync', (source, dest) => {
        if (dest === sessionFile) throw new Error('simulated full disk');
        return rename(source, dest);
    });
    const reply = await f.run('/reset');
    mock.mock.restore();
    assert.match(reply, /尚未保存|未能保存|失败/);
    assert.ok(!reply.includes('上下文清了'));
});

test('reset remains owner-only and /new uses the same reset behavior', async t => {
    const f = fixture(t);
    assert.match(await f.deps.commands.handle({ text: '/reset', scope: 'c2c', targetId: 'alice', msg: message('/reset', 'denied', 'bob') }), /主人/);
    assert.ok(f.deps.sessions.turnCount('c2c', 'alice') > 0);
    await f.run('/new');
    assert.deepEqual(f.reopen().toMessages('c2c', 'alice'), []);
});
