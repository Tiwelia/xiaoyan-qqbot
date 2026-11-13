import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, validateConfig } from '../src/config.js';
import { createCompanion, chatPreference, localClock, isQuietHour } from '../src/companion.js';
import { buildChatStyle } from '../src/chat-style.js';
import { createStateStore } from '../src/state.js';
import { createBot } from '../src/bot.js';
import { LlmClient } from '../src/llm.js';
import { QQBot } from '@tencent-connect/qqbot-nodejs';

const MINUTE = 60_000;
const logger = { info() {}, warn() {}, error() {}, debug() {} };
const msg = (content = '今天考试考完了', senderId = 'alice') => ({
    kind: 'c2c', content, senderId, messageId: 'm1', replyTarget: { scope: 'c2c', targetId: senderId, msgId: 'm1' },
});
const configFor = (extra = {}) => loadConfig({
    QQBOT_APPID: 'test', QQBOT_SECRET: 'test', DEEPSEEK_API_KEY: 'test', OWNER_OPENID: 'alice',
    STREAMING: 'false', TYPING_INDICATOR: 'false', PEER_COOLDOWN_MS: '0', TZ: 'Asia/Shanghai', ...extra,
});
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };

test('reset excludes old proactive text from timer prompts without disabling future context', async () => {
    const f = fixture();
    f.companion.observe(msg());
    const resetAt = f.state.get('companion').lastUserAt;
    f.state.set('companion', { ...f.state.get('companion'), lastPushText: 'BEFORE_RESET_MARKER',
        pushStatus: 'sent', lastPushAt: resetAt - 1000 });
    f.deps.sessions.getResetAt = () => resetAt;
    f.advance(91);
    await f.companion.tick();
    assert.ok(!JSON.stringify(f.requests[0].messages).includes('BEFORE_RESET_MARKER'));
    const style = buildChatStyle({ config: f.config, state: f.state, peerKey: 'c2c:alice',
        now: f.state.get('companion').lastPushAt, resetAt });
    assert.ok(style.includes('考试结束了'));
    await f.companion.stop();
});

test('a proactive send completing after reset retains its original context boundary', async () => {
    const began = deferred(), finish = deferred();
    const f = fixture({ bot: { send: async () => { began.resolve(); await finish.promise; } } });
    f.companion.observe(msg());
    f.advance(91);
    const pending = f.companion.tick();
    await began.promise;
    const created = f.state.get('companion').lastPushCreatedAt;
    const resetAt = created + 1;
    f.advance(1);
    f.companion.observe(msg('/reset'));
    finish.resolve();
    await pending;
    const saved = f.state.get('companion');
    assert.ok(saved.lastPushAt > resetAt);
    assert.equal(saved.lastPushCreatedAt, created);
    assert.ok(!buildChatStyle({ config: f.config, state: f.state, peerKey: 'c2c:alice',
        now: saved.lastPushAt, resetAt }).includes('考试结束了'));
    assert.equal(saved.sent, 1);
    await f.companion.stop();
});

function fixture(over = {}) {
    let at = Date.parse('2026-11-09T02:00:00Z'); // Beijing 10:00
    const values = new Map();
    const state = { get: (k, fallback) => values.has(k) ? values.get(k) : fallback, set: (k, v) => values.set(k, v), flush() {} };
    const sent = [], requests = [];
    const config = configFor();
    const auth = { isOwner: (id) => id === 'alice', check: async (message) => message.senderId === 'alice' };
    const deps = {
        config, state, auth, logger, now: () => at, random: () => 0,
        runtime: { activeTurns: () => 0 }, memory: { available: false }, sessions: { toMessages: () => [] },
        bot: { send: async (opts) => sent.push(opts) },
        llm: { stream: async (opts) => { requests.push(opts); return { text: '考试结束了，要不要先歇会儿？', toolCalls: [] }; } },
        ...over,
    };
    const companion = createCompanion(deps);
    companion.setOnline(true);
    return { companion, state, config, sent, requests, deps, advance: (minutes) => { at += minutes * MINUTE; }, setTime: (iso) => { at = Date.parse(iso); } };
}

test('no owner activity, disabled mode, quiet time, or a busy turn spends model tokens', async () => {
    const f = fixture();
    await f.companion.tick();
    f.companion.observe(msg('hello', 'bob'));
    f.advance(91);
    await f.companion.tick();
    assert.equal(f.requests.length, 0);
    f.companion.observe(msg());
    f.advance(91);
    f.deps.runtime.activeTurns = () => 1;
    await f.companion.tick();
    f.deps.runtime.activeTurns = () => 0;
    f.setTime('2026-11-09T15:00:00Z');
    await f.companion.tick();
    f.setTime('2026-11-10T02:00:00Z');
    f.companion.handleControl('先别主动找我', 'alice');
    await f.companion.tick();
    assert.equal(f.requests.length, 0);
    assert.equal(f.sent.length, 0);
    await f.companion.stop();
});

test('proactive messages target only the owner and never reuse an old msg_id or wakeup slot', async () => {
    const f = fixture();
    f.companion.observe(msg());
    f.advance(91);
    await Promise.all([f.companion.tick(), f.companion.tick()]);
    assert.equal(f.requests.length, 1);
    assert.equal(f.requests[0].maxTokens, 320);
    assert.equal(f.requests[0].thinking, 'disabled');
    assert.deepEqual(f.sent[0], { target: { scope: 'c2c', targetId: 'alice' }, msgType: 0, content: '考试结束了，要不要先歇会儿？' });
    f.advance(180);
    await f.companion.tick();
    assert.equal(f.sent.length, 1, 'must wait for an actual owner reply');
    assert.equal(f.companion.stats().awaitingReply, true);
    await f.companion.stop();
});

test('draft attempts are capped at three times the daily send limit, sends stay capped', async () => {
    let calls = 0;
    const f = fixture({ llm: { stream: async () => { calls++; return { text: '[[skip]]' }; } } });
    f.companion.observe(msg());
    // 跳过（没话题）也算一次生成，但给到 dailyMax×3 的余量，免得一天的机会被「没话题」耗光
    for (let i = 0; i < 20; i++) { f.advance(30); await f.companion.tick(); }
    assert.equal(calls, 12);
    assert.equal(f.sent.length, 0, '跳过不发送');
    f.setTime('2026-11-10T02:00:00Z');
    await f.companion.tick();
    assert.equal(calls, 13, 'next Beijing day gets a fresh draft allowance');
    await f.companion.stop();
});

test('a new owner message cancels an active proactive draft before any send', async () => {
    const started = deferred();
    const f = fixture({ llm: { stream: ({ signal }) => new Promise((_resolve, reject) => {
        started.resolve(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) } });
    f.companion.observe(msg()); f.advance(91);
    const task = f.companion.tick(); await started.promise;
    f.companion.observe(msg('我回来了'));
    await task;
    assert.equal(f.sent.length, 0);
    assert.equal(f.state.get('companion').awaitingReply, false);
    await f.companion.stop();
});

test('quiet hours, busy/sleep hints and explicit natural-language opt-out are respected', async () => {
    assert.equal(localClock(Date.parse('2026-11-08T16:01:00Z'), 'Asia/Shanghai').day, '2026-11-09');
    assert.equal(isQuietHour(0, 23, 9), true);
    assert.equal(isQuietHour(9, 23, 9), false);
    assert.equal(chatPreference('不要主动找我聊天'), 'off');
    assert.equal(chatPreference('小说里她说“不要主动找我聊天”'), null);
    const f = fixture();
    f.companion.observe(msg('我先忙了')); f.advance(91); await f.companion.tick();
    assert.equal(f.sent.length, 0);
    f.companion.observe(msg('晚安')); f.advance(181); await f.companion.tick();
    assert.equal(f.sent.length, 0);
    assert.equal(f.companion.handleControl('先别主动找我', 'bob'), null);
    f.companion.handleControl('先别主动找我', 'alice');
    assert.equal(f.companion.stats().enabled, false);
    f.companion.handleControl('恢复主动聊天', 'alice');
    assert.equal(f.companion.stats().enabled, true);
    await f.companion.stop();
});

test('restart preserves unanswered sends and the daily counters in the state file', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-companion-test-'));
    let state;
    try {
        const file = path.join(root, 'state.json');
        state = createStateStore({ file, logger });
        const f = fixture({ state });
        f.companion.observe(msg()); f.advance(91); await f.companion.tick();
        await f.companion.stop(); state.close();
        state = createStateStore({ file, logger });
        const restored = fixture({ state }); restored.advance(500);
        await restored.companion.tick();
        assert.equal(restored.sent.length, 0);
        assert.equal(restored.companion.stats().sent, 1);
        assert.equal(restored.companion.stats().awaitingReply, true);
        await restored.companion.stop();
    } finally {
        state?.close();
        const relative = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
        assert.ok(relative.startsWith('qqbot-companion-test-') && !relative.includes(path.sep));
        fs.rmSync(path.resolve(root), { recursive: true, force: true });
    }
});

test('a rejected/uncertain QQ push is not retried and its draft is not presented as delivered', async () => {
    let sends = 0;
    const f = fixture({ bot: { send: async () => { sends++; throw Object.assign(new Error('disabled'), { code: 40034105 }); } } });
    f.companion.observe(msg()); f.advance(91); await f.companion.tick();
    assert.equal(f.state.get('companion').pushStatus, 'failed');
    assert.equal(f.companion.stats().sent, 1, 'uncertain outcomes still consume the local send allowance');
    f.companion.observe(msg()); f.advance(91); await f.companion.tick();
    assert.equal(sends, 1);
    assert.ok(!buildChatStyle({ config: f.config, state: f.state, peerKey: 'c2c:alice' }).includes('已经发出'));
    await f.companion.stop();
});

test('ordinary replies get conversation habits and natural-language controls skip the model', async () => {
    class Bot {
        handlers = {}; sent = []; use() {} on(k, fn) { this.handlers[k] = fn; }
        async sendText(_target, text) { this.sent.push(text); }
    }
    let prompt = '';
    const f = fixture();
    const bot = createBot({ config: f.config, logger, state: f.state, auth: f.deps.auth,
        runtime: { companion: f.companion }, memory: { available: false }, toolkit: { definitions: [] },
        sessions: { toMessages: () => [], isFresh: () => true, append() {} },
        llm: { stream: async ({ messages }) => { prompt = messages[0].content; return { text: '歇会儿吧。', toolCalls: [] }; } },
    }, { Bot });
    await bot.handlers.message({ state: {} }, msg());
    assert.ok(prompt.includes('私聊的交流习惯') && prompt.includes('长文'));
    prompt = '';
    await bot.handlers.message({ state: {} }, msg('先别主动找我'));
    assert.equal(prompt, '');
    assert.equal(f.companion.stats().enabled, false);
    assert.ok(bot.sent.at(-1).includes('不主动找你'));
    await bot.drain();
});

test('proactive configuration rejects invalid timezones, hours, limits and inverted delays', () => {
    for (const extra of [{ TZ: 'invalid/zone' }, { PROACTIVE_DAILY_MAX: '0' }, { PROACTIVE_DAILY_MAX: 'NaN' },
        { PROACTIVE_QUIET_START: '24' }, { PROACTIVE_QUIET_END: '23' },
        { PROACTIVE_MIN_IDLE_MINUTES: '200', PROACTIVE_MAX_IDLE_MINUTES: '100' }]) {
        assert.ok(validateConfig(configFor(extra)).length > 0);
    }
    assert.deepEqual(validateConfig(configFor()), []);
});

test('per-request token and thinking overrides do not change the regular conversation settings', async (t) => {
    const bodies = [];
    t.mock.method(globalThis, 'fetch', async (_url, opts) => {
        bodies.push(JSON.parse(opts.body));
        return new Response('data: {"choices":[{"delta":{"content":"ok"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const llm = new LlmClient({ baseUrl: 'https://invalid.example', provider: 'deepseek', apiKey: 'test', model: 'test', maxTokens: 1024, thinking: 'enabled', effort: 'high', logger });
    await llm.stream({ messages: [], maxTokens: 512, thinking: 'disabled' });
    await llm.stream({ messages: [], maxTokens: 4096 });
    assert.deepEqual(bodies.map((b) => b.max_tokens), [512, 1024]);
    assert.deepEqual(bodies.map((b) => b.thinking.type), ['disabled', 'enabled']);
    assert.deepEqual(bodies.map((b) => b.reasoning_effort), [undefined, 'high']);
});

test('successful sends still stop at four even when every proactive message gets a reply', async () => {
    let drafts = 0;
    const f = fixture({ llm: { stream: async () => ({ text: `延续上次的话题 ${++drafts}`, toolCalls: [] }) } });
    for (let i = 0; i < 6; i++) {
        f.companion.observe(msg('我回你啦'));
        f.advance(91);
        await f.companion.tick();
    }
    assert.equal(f.sent.length, 4);
    assert.equal(drafts, 4);
    await f.companion.stop();
});

test('send reservations survive a restart even before the HTTP result is known', async () => {
    const sending = deferred(), finish = deferred();
    const f = fixture({ bot: { send: async () => { sending.resolve(); await finish.promise; } } });
    f.companion.observe(msg()); f.advance(91);
    const task = f.companion.tick(); await sending.promise;
    const restored = fixture({ state: f.state }); restored.advance(181);
    await restored.companion.tick();
    assert.equal(restored.requests.length, 0);
    assert.equal(restored.companion.stats().awaitingReply, true);
    finish.resolve(); await task;
    await Promise.all([f.companion.stop(), restored.companion.stop()]);
});

test('shutdown cancels an in-flight proactive model call and leaves no later send', async () => {
    const started = deferred();
    const f = fixture({ llm: { stream: ({ signal }) => new Promise((_resolve, reject) => {
        started.resolve(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
    }) } });
    f.companion.observe(msg()); f.advance(91);
    const task = f.companion.tick(); await started.promise;
    await f.companion.stop(); await task;
    f.advance(181); await f.companion.tick();
    assert.equal(f.sent.length, 0);
});

test('the real SDK builds a proactive plain-text body without passive reply identifiers', async () => {
    const requests = [];
    const sdk = { creds: {}, messageApi: { sendRaw: async (scope, targetId, _creds, body) => requests.push({ scope, targetId, body }) } };
    const f = fixture({ bot: { send: (options) => QQBot.prototype.send.call(sdk, options) } });
    f.companion.observe(msg()); f.advance(91); await f.companion.tick();
    assert.deepEqual(requests, [{ scope: 'c2c', targetId: 'alice', body: { msg_type: 0, content: '考试结束了，要不要先歇会儿？' } }]);
    await f.companion.stop();
});

test('a draft that completes after quiet hours begin is not sent', async () => {
    const started = deferred(), finish = deferred();
    const f = fixture({ llm: { stream: async () => { started.resolve(); return finish.promise; } } });
    f.companion.observe(msg());
    f.setTime('2026-11-09T14:59:00Z');
    const task = f.companion.tick(); await started.promise;
    f.setTime('2026-11-09T15:01:00Z');
    finish.resolve({ text: '刚才的话题我还记得呢。', toolCalls: [] });
    await task;
    assert.equal(f.sent.length, 0);
    await f.companion.stop();
});

test('a reply the next day still carries the last delivered proactive message, only for its owner', async () => {
    const f = fixture();
    f.companion.observe(msg()); f.advance(91); await f.companion.tick();
    f.advance(36 * 60);
    f.companion.observe(msg('我现在才看到，昨天歇过啦'));
    const style = buildChatStyle({ config: f.config, state: f.state, peerKey: 'c2c:alice', now: f.state.get('companion').lastUserAt });
    assert.ok(style.includes('考试结束了，要不要先歇会儿？'));
    assert.ok(!buildChatStyle({ config: f.config, state: f.state, peerKey: 'c2c:bob' }).includes('考试结束了'));
    await f.companion.stop();
});

test('a pending push older than a day releases the awaiting-reply latch', async () => {
    const { createCompanion } = await import('../src/companion.js');
    const saved = new Map();
    const state = { get: (k, d) => (saved.has(k) ? saved.get(k) : d), set: (k, v) => saved.set(k, v), flush() {} };
    let at = new Date('2026-11-09T12:00:00Z').getTime();
    const config = { timezone: 'Asia/Shanghai', companion: { enabled: true, dailyMax: 4, idleMinMs: 60_000, idleMaxMs: 120_000, quietStart: 23, quietEnd: 9, checkEveryMs: 60_000, timeoutMs: 1000, maxChars: 200 } };
    const companion = createCompanion({ config, state, auth: { isOwner: () => true }, bot: {}, llm: {}, memory: {}, sessions: {}, runtime: {}, logger: { info() {}, warn() {}, error() {}, debug() {} }, now: () => at });
    saved.set('companion', { day: '2026-11-09', ownerId: 'u1', lastUserAt: at - 60_000, awaitingReply: true, pushStatus: 'pending', lastPushAt: at, attempts: 1, sent: 1 });
    assert.equal(companion.stats().awaitingReply, true, '刚发出去时应当等回复');
    at += 25 * 60 * 60 * 1000;
    const stats = companion.stats();
    assert.equal(stats.awaitingReply, false, '超过一天要放开，不能永久闭嘴');
    assert.equal(stats.pushStatus, 'stale');
});



