import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCommandHandler, parseSettingsText } from '../src/commands.js';
import { loadConfig } from '../src/config.js';
import { createStateStore } from '../src/state.js';
import { handleMessage } from '../src/conversation.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const voices = [
    { id: 'lingxin', name: '龙安灵心', locale: 'zh-CN', gender: '女' },
    { id: 'cloned-id', name: '软糖', locale: 'zh-CN', gender: '男', cloned: true },
    ...Array.from({ length: 21 }, (_, i) => ({ id: `voice-${i}`, name: `音色${i}`, locale: 'en-US', gender: '女' })),
];
const message = { kind: 'c2c', senderId: 'alice', content: '', replyTarget: { scope: 'c2c', targetId: 'alice', msgId: 'm1' } };

function fixture(t, env = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-experience-'));
    const file = path.join(dir, 'state.json');
    const state = createStateStore({ file, logger });
    t.after(() => {
        state.close();
        assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
        assert.ok(path.basename(dir).startsWith('qqbot-experience-'));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    const config = loadConfig({ QQBOT_APPID: 'test', QQBOT_SECRET: 'test', DEEPSEEK_API_KEY: 'test',
        OWNER_OPENID: 'alice', STREAMING: 'false', TYPING_INDICATOR: 'false', ...env });
    const deps = {
        config, logger, state, auth: { isOwner: id => id === 'alice' },
        memory: { available: true, count: () => ({ important: 8, conversation: 10 }) },
        sessions: { stats: () => ({ sessions: 1, messages: 20 }), turnCount: () => 10 },
        tts: { enabled: true, defaultOn: true, defaultVoice: 'lingxin', listVoices: () => voices,
            stats: () => ({ enabled: true, active: 0, queued: 0, tmpBytes: 0, tmpMaxBytes: 1024 }) },
        runtime: { uptimeText: () => '1h', modelName: () => config.llm.model },
    };
    const commands = createCommandHandler(deps);
    return { deps, file, commands, run: text => commands.handle({ text, scope: 'c2c', targetId: 'alice', msg: message }) };
}

test('explicit voice controls are idempotent and survive reopening the state store', async t => {
    const { deps, file, run } = fixture(t);
    for (const text of ['关闭语音', '关闭语音。', '以后只发文字！']) {
        assert.match(await run(text), /文字/);
        assert.equal(deps.state.get('voice:c2c:alice'), false);
    }
    const restored = createStateStore({ file, logger });
    assert.equal(restored.get('voice:c2c:alice'), false);
    restored.close();
    for (const text of ['打开语音', '打开语音', '恢复语音']) {
        assert.match(await run(text), /语音/);
        assert.equal(deps.state.get('voice:c2c:alice'), true);
    }
});

test('questions, quotes, temporary requests and mixed chat do not change persistent settings', async t => {
    const { deps, run } = fixture(t);
    const ordinary = ['能关闭语音吗', '关闭语音？', '“关闭语音”', '他说关闭语音', '不要关闭语音',
        '关闭语音，然后说说今天的天气', '关闭语音\n我还有问题', '这条用文字回',
        '音色换成龙安灵心好听吗', '如果音色换成龙安灵心', '音色换成“龙安灵心”', '清空聊天', '忘掉所有记忆'];
    for (const text of ordinary) {
        assert.equal(parseSettingsText(text, voices), null, text);
        assert.equal(await run(text), null, text);
    }
    assert.equal(deps.state.get('voice:c2c:alice'), undefined);
});

test('natural settings keep the owner gate and command-disable preference', async t => {
    const { deps, commands } = fixture(t);
    assert.match(await commands.handle({ text: '关闭语音', msg: { senderId: 'bob' } }), /主人/);
    assert.equal(deps.state.get('voice:c2c:alice'), undefined);
    const disabled = createCommandHandler({ ...deps, config: { ...deps.config, commands: { ...deps.config.commands, enabled: false } } });
    assert.equal(await disabled.handle({ text: '关闭语音', msg: message }), null);
    assert.equal(await commands.handle({ text: '关闭语音', msg: { ...message, attachments: [{ content_type: 'image' }] } }), null);
});

test('voice names and clone names work without slash commands and enable voice', async t => {
    const { deps, run } = fixture(t);
    await run('关闭语音');
    assert.match(await run('音色换成龙安灵心'), /龙安灵心/);
    assert.equal(deps.state.get('voiceName:c2c:alice'), '龙安灵心');
    assert.equal(deps.state.get('voice:c2c:alice'), true);
    assert.match(await run('把音色换成软糖'), /软糖/);
    assert.equal(deps.state.get('voiceName:c2c:alice'), '软糖');
    deps.tts.listVoices = () => [...voices, { id: 'custom-english', name: 'My Voice' }];
    assert.match(await run('音色换成 My Voice'), /My Voice/);
    assert.equal(deps.state.get('voiceName:c2c:alice'), 'My Voice');
    assert.match(await run('/voice unknown'), /当前设置未变/);
    assert.equal(deps.state.get('voiceName:c2c:alice'), 'My Voice');
});

test('voice browsing is paged, marks the current voice, and keeps all entries reachable', async t => {
    const { deps, run } = fixture(t);
    const first = await run('查看音色');
    assert.match(first, /第 1\/3 页/);
    assert.match(first, /龙安灵心.*当前/);
    assert.match(first, /查看音色第2页/);
    assert.match(first, /软糖.*复刻/);
    const second = await run('查看音色第2页');
    const third = await run('/voice list 3');
    assert.match(second, /第 2\/3 页/);
    assert.match(third, /第 3\/3 页/);
    assert.equal((first.match(/^- /gm) ?? []).length, 10);
    assert.equal((second.match(/^- /gm) ?? []).length, 10);
    assert.equal((third.match(/^- /gm) ?? []).length, 3);
    for (const v of voices) assert.equal([first, second, third].filter(page => page.includes(`/voice ${v.id}\n`) || page.endsWith(`/voice ${v.id}`)).length, 1);
    for (const page of ['0', '-1', '4', '1.5', 'NaN', '99999999999999999999']) assert.match(await run(`/voice list ${page}`), /页码范围/);
    assert.deepEqual(deps.state.all(), {}, 'browsing must not alter voice settings');
});

test('voice search supports friendly names, IDs, locale, gender and clones, with bounded output', async t => {
    const { run } = fixture(t);
    for (const text of ['找音色 灵心', '/voice search LINGXIN']) assert.match(await run(text), /龙安灵心/);
    assert.match(await run('找音色 复刻'), /软糖/);
    assert.match(await run('找音色 男'), /软糖/);
    const many = await run('/voice search en-US');
    assert.equal((many.match(/^- /gm) ?? []).length, 10);
    assert.match(many, /增加关键词/);
    assert.match(await run('找音色 不存在'), /没有找到/);
    assert.match(await run('/voice search'), /关键词/);
});

test('settings are concise by default, use readable names and expose details separately', async t => {
    const { deps, run } = fixture(t);
    deps.state.set('model', 'openrouter/example');
    deps.state.set('voiceName:c2c:alice', 'obsolete-voice');
    const short = await run('查看设置');
    assert.match(short, /openrouter\/example/);
    assert.match(short, /龙安灵心/);
    assert.doesNotMatch(short, /会话缓存|临时|并发|obsolete-voice/);
    const detail = await run('查看详细状态');
    assert.match(detail, /会话缓存/);
    assert.match(detail, /重要 8 条/);
    assert.match(detail, /并发/);
    assert.match(await run('查看帮助'), /关闭语音/);
    assert.doesNotMatch(await run('/help'), /mem add/);
    assert.match(await run('/help all'), /\/reset/);
});

test('a natural setting short-circuits the real message pipeline using one text send and no model', async t => {
    const { deps, commands } = fixture(t);
    const sent = [];
    let calls = 0;
    await handleMessage({ ...deps, commands,
        bot: { sendText: async (_target, text) => sent.push(text) },
        llm: { stream: async () => { calls++; throw Error('must not call a paid model'); } },
    }, { state: {} }, { ...message, content: '关闭语音' });
    assert.equal(calls, 0);
    assert.equal(sent.length, 1);
    assert.match(sent[0], /文字/);
    assert.equal(deps.state.get('voice:c2c:alice'), false);
});
