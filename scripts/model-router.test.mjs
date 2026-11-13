import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { TextModelRouter, BAIDU_MODEL } from '../src/model-router.js';
import { createStateStore } from '../src/state.js';
import { createCommandHandler } from '../src/commands.js';
import { createLocalEval } from '../src/local-eval.js';

const configFor = extra => loadConfig({ QQBOT_APPID: 'test', QQBOT_SECRET: 'test',
    DEEPSEEK_API_KEY: 'ds-private-key', OPENROUTER_API_KEY: 'or-private-key',
    OWNER_OPENID: 'alice', STREAMING: 'false', PEER_COOLDOWN_MS: '0', ...extra });
const response = () => new Response('data: {"choices":[{"delta":{"content":"请求成功。"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
function fixture(t, extra) {
    const config = configFor(extra), dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-model-test-'));
    const file = path.join(dir, 'state.json'), state = createStateStore({ file });
    const llm = new TextModelRouter({ config: config.llm, state });
    const commands = createCommandHandler({ config, state, llm, auth: { isOwner: id => id === 'alice' } });
    t.after(() => { state.close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const run = text => commands.handle({ text, args: [], scope: 'c2c', targetId: 'alice', msg: { senderId: 'alice' } });
    return { config, state, llm, commands, run, file };
}

test('QQ controls switch service and credentials while preserving original image route', async t => {
    const f = fixture(t, { LLM_THINKING: 'disabled' }), requests = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        requests.push({ url, key: init.headers.authorization, body: JSON.parse(init.body) }); return response();
    });
    const text = { messages: [{ role: 'user', content: 'hello' }] };
    await f.run('/model ernie-5.5-flash-preview-free');
    await f.llm.stream({ ...text, thinking: 'disabled' });
    await f.llm.stream({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] }] });
    await f.run('/model deepseek-v4.1-flash');
    await f.llm.stream(text);
    assert.deepEqual(requests.map(r => [r.url, r.key, r.body.model]), [
        ['https://openrouter.ai/api/v1/chat/completions', 'Bearer or-private-key', BAIDU_MODEL],
        ['https://api.deepseek.com/chat/completions', 'Bearer ds-private-key', 'deepseek-flash'],
        ['https://api.deepseek.com/chat/completions', 'Bearer ds-private-key', 'deepseek-flash'],
    ]);
    assert.deepEqual(requests[0].body.reasoning, { enabled: true, effort: 'high' });
    assert.deepEqual(requests[1].body.thinking, { type: 'disabled' });
    assert.deepEqual(f.config.tts, configFor().tts);
});

test('model and effort survive restart without persisting any credential; invalid effort is atomic', async t => {
    const f = fixture(t);
    await f.run('/model ernie-5.5-flash-preview-free');
    for (const level of ['off', 'none', 'low', 'medium', 'max']) {
        assert.match(await f.run(`/effort ${level}`), /只有 high/);
        assert.equal(f.llm.getEffort(), 'high');
        assert.equal(f.state.get('effortLevel'), 'high');
    }
    await f.run('/effort auto');
    assert.match(await f.run('/status'), /high/);
    assert.match(await f.run('/model list'), /deepseek-v4\.1-flash/);
    const disk = fs.readFileSync(f.file, 'utf8');
    assert.ok(!disk.includes('private-key'));
    const restored = createStateStore({ file: f.file });
    try {
        const llm = new TextModelRouter({ config: f.config.llm, state: restored });
        assert.equal(llm.provider, 'openrouter'); assert.equal(llm.model, BAIDU_MODEL);
        assert.equal(llm.getThinking(), 'enabled'); assert.equal(llm.getEffort(), 'high');
    } finally { restored.close(); }
    await f.run('/model deepseek-v4-pro'); await f.run('/effort max');
    assert.equal(f.llm.provider, 'deepseek'); assert.equal(f.llm.getEffort(), 'max');
    await f.run('/model reset');
    assert.equal(f.llm.model, f.config.llm.model); assert.equal(f.state.get('model'), undefined);
});

test('missing credentials and unauthorized commands cannot change text routing', async t => {
    const f = fixture(t, { OPENROUTER_API_KEY: '' });
    assert.match(await f.run('/model ernie-5.5-flash-preview-free'), /未配置 openrouter/);
    assert.equal(f.llm.provider, 'deepseek'); assert.equal(f.state.get('model'), undefined);
    const blocked = await f.commands.handle({ text: '/model deepseek-v4-pro', msg: { senderId: 'stranger' } });
    assert.match(blocked, /主人/); assert.equal(f.llm.model, 'deepseek-flash');
});

test('ambiguous vendor names do not select a model; exact aliases and full IDs stay stable', async t => {
    const f = fixture(t);
    for (const name of ['百度', 'baidu', 'deepseek', 'flash', 'pro', 'mimo']) {
        assert.match(await f.run(`/model ${name}`), /指定具体型号/);
        assert.equal(f.llm.model, 'deepseek-flash');
    }
    await f.run('/model deepseek-v4.1-flash');
    assert.equal(f.llm.model, 'deepseek-flash');
    assert.equal(f.llm.displayName(), 'DeepSeek-V4.1-Flash');
    await f.run(`/model ${BAIDU_MODEL}`);
    assert.equal(f.llm.model, BAIDU_MODEL);
    await f.run('/model deepseek/deepseek-v4-pro');
    assert.equal(f.llm.provider, 'openrouter');
    assert.equal(f.llm.model, 'deepseek/deepseek-v4-pro');
});

test('MiMo-V2.6-Flash uses OpenRouter, exposes only reasoning toggle and preserves the image route', async t => {
    const f = fixture(t), requests = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        requests.push({ url, key: init.headers.authorization, body: JSON.parse(init.body) }); return response();
    });
    const list = await f.run('/model list');
    assert.match(list, /mimo-v2\.6-flash/); assert.match(list, /ernie-5\.5-flash-preview-free/);
    await f.run('/model mimo-v2.6-flash');
    assert.equal(f.llm.model, 'xiaomi/mimo-v2.6-flash');
    assert.match(await f.run('/effort high'), /off \/ on \/ auto/);
    assert.equal(f.llm.getEffort(), '');
    await f.run('/effort on');
    await f.llm.stream({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(requests[0].key, 'Bearer or-private-key');
    assert.equal(requests[0].body.model, 'xiaomi/mimo-v2.6-flash');
    assert.deepEqual(requests[0].body.reasoning, { enabled: true });
    const state = createStateStore({ file: f.file });
    try {
        const restored = new TextModelRouter({ config: f.config.llm, state });
        assert.equal(restored.model, 'xiaomi/mimo-v2.6-flash'); assert.equal(restored.getThinking(), 'enabled');
    } finally { state.close(); }
    await f.run('/effort off');
    await f.llm.stream({ messages: [{ role: 'user', content: 'hello' }] });
    assert.deepEqual(requests[1].body.reasoning, { enabled: false });
    await f.run('/effort auto');
    await f.llm.stream({ messages: [{ role: 'user', content: 'hello' }] });
    assert.equal(requests[2].body.reasoning, undefined);
    await f.llm.stream({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'https://example.test/image.png' } }] }] });
    assert.equal(requests[3].body.model, 'deepseek-flash'); assert.equal(requests[3].key, 'Bearer ds-private-key');
});

test('Baidu default overrides a stale saved off and keeps explicit DeepSeek vision credentials', t => {
    const f = fixture(t, { LLM_PROVIDER: 'openrouter', LLM_BASE_URL: 'https://openrouter.ai/api/v1',
        LLM_MODEL: BAIDU_MODEL, LLM_THINKING: 'disabled', LLM_VISION_PROVIDER: 'deepseek' });
    f.state.set('effortLevel', 'off');
    const llm = new TextModelRouter({ config: f.config.llm, state: f.state });
    assert.equal(llm.getThinking(), 'enabled'); assert.equal(llm.getEffort(), 'high');
    assert.equal(llm.visionClient.provider, 'deepseek');
    assert.equal(llm.visionClient.apiKey, 'ds-private-key');
});

test('real QQ SDK command flow uses the new route on the next text turn without model calls for controls', async t => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        requests.push({ url, body: JSON.parse(init.body) }); return response();
    });
    const source = configFor(), llm = new TextModelRouter({ config: source.llm });
    const h = createLocalEval({ config: source, llm });
    llm.state = h.state;
    t.after(() => h.close());
    await h.send('/model ernie-5.5-flash-preview-free'); await h.send('/effort off');
    assert.equal(requests.length, 0);
    await h.send('只回复请求成功。');
    assert.equal(requests.length, 1); assert.equal(requests[0].body.model, BAIDU_MODEL);
    await h.send('/model deepseek-v4.1-flash'); await h.send('只回复请求成功。');
    assert.equal(requests.length, 2); assert.match(requests[1].url, /api.deepseek.com/);
});

