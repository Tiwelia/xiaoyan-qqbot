import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createLocalEval } from '../src/local-eval.js';
import path from 'node:path';
import { buildWavHeader } from '../src/audio.js';
const source = () => loadConfig({ QQBOT_APPID: 'test', QQBOT_SECRET: 'test', DEEPSEEK_API_KEY: 'test',
    OWNER_OPENID: 'actual-owner', STREAMING: 'false', PEER_COOLDOWN_MS: '0', PEER_RATE_PER_MIN: '0', TTS_DEFAULT_ON: 'false' });

test('local eval uses SDK dedup, owner checks and real command/session storage without connecting QQ', async t => {
    let calls = 0;
    const h = createLocalEval({ config: source(), llm: { stream: async () => { calls++; return { text: 'answer', toolCalls: [] }; } } });
    t.after(() => h.close());
    await assert.rejects(h.bot.start(), /cannot connect/);
    await h.send('hello', { id: 'duplicate' });
    await h.send('hello again', { id: 'duplicate' });
    await h.send('/reset', { senderId: 'stranger' });
    assert.equal(calls, 1);
    assert.equal(h.sessions.turnCount('c2c', h.owner), 1);
    const reset = await h.send('/reset');
    assert.ok(reset.events.some(e => e.type === 'text' && e.text.includes('清了')));
    assert.deepEqual(h.sessions.toMessages('c2c', h.owner), []);
    assert.equal(h.config.qq.appSecret, 'not-used');
    assert.ok(h.config.tts.tmpDir.startsWith(h.dir));
});

test('local memory tools and reset share the same real isolated memory database', async t => {
    const h = createLocalEval({ config: source() });
    t.after(() => h.close());
    await h.send('/mem add preference 喜欢绿茶');
    assert.equal(h.memory.listImportant(10, 'c2c').length, 1);
    await h.send('/reset');
    const listed = await h.send('/mem list');
    assert.ok(listed.events.some(e => e.text?.includes('喜欢绿茶')));
});

test('SDK quote middleware enriches the real prompt and close removes only isolated test data', async () => {
    const requests = [];
    const h = createLocalEval({ config: source(), llm: { stream: async opts => {
        requests.push(opts.messages); return { text: 'answer', toolCalls: [] };
    } } });
    await h.send('quoted-local-marker', { id: 'first' });
    await h.send('what did I say?', { refMsgIdx: 'first' });
    assert.ok(requests[1][0].content.includes('quoted-local-marker'));
    const dir = h.dir;
    await h.close();
    assert.equal(fs.existsSync(dir), false);
    await h.close();
    await assert.rejects(h.send('after close'), /closed/);
});

test('one-turn text removes audio tools, preserves voice settings, and the next turn speaks again', async t => {
    let h, syntheses = 0;
    const pending = new Map(), requests = [];
    const tts = { enabled: true, engine: 'qwen', defaultOn: true, defaultVoice: 'voice', maxChars: 8000,
        segmentChars: 600, segmentsMax: 3, charsPerSecond: 5,
        listVoices: () => [{ id: 'voice', name: '测试音色' }],
        stats: () => ({ enabled: true }), stop() {},
        async synthesize() {
            const id = `audio-${++syntheses}`, file = path.join(h.dir, `${id}.wav`);
            fs.writeFileSync(file, Buffer.concat([buildWavHeader(4800, { sampleRate: 24000, channels: 1, bitsPerSample: 16 }), Buffer.alloc(4800)]));
            const audio = { id, path: file, bytes: 4844 };
            pending.set(id, audio); return audio;
        },
        take(id) { const record = pending.get(id); pending.delete(id); return record; },
        drop(id) { pending.delete(id); }, release(file) { fs.unlinkSync(file); },
    };
    h = createLocalEval({ config: source(), tts, llm: { stream: async options => {
        requests.push(options); return { text: '请求成功。', toolCalls: [] };
    } } });
    t.after(() => h.close());
    const first = await h.send('这条用文字回复：解释200。');
    assert.ok(first.events.some(e => e.type === 'text'));
    assert.ok(!first.events.some(e => e.type === 'voice'));
    assert.equal(syntheses, 0);
    assert.equal(h.state.get(`voice:c2c:${h.owner}`, true), true);
    assert.ok(requests[0].tools.every(t => !t.function.name.startsWith('tts_') && t.function.name !== 'audio_scene'));
    assert.equal(first.turns[0].voice, false);
    const second = await h.send('你觉得“这条用文字回复”是什么意思？');
    assert.equal(syntheses, 1);
    assert.ok(second.events.some(e => e.type === 'voice' && e.bytes > 44));
    assert.equal(second.turns[0].voice, true);
});

test('natural voice pagination accepts spaces and stays entirely local', async t => {
    let calls = 0;
    const h = createLocalEval({ config: source(), tts: { enabled: true, defaultOn: false, stop() {},
        listVoices: () => Array.from({ length: 25 }, (_, i) => ({ id: `v${i}`, name: `音色${i}` })) },
        llm: { stream: async () => { calls++; throw new Error('must stay local'); } } });
    t.after(() => h.close());
    const result = await h.send('查看音色第 2 页');
    assert.equal(calls, 0);
    assert.ok(result.events.some(e => e.text?.includes('第 2/3 页')));
});

test('a clean-context retry keeps the current user request and its format, not the oldest question', async t => {
    const config = source(); config.uncensor.retries = 1;
    const requests = [];
    const h = createLocalEval({ config, llm: { stream: async opts => {
        requests.push(structuredClone(opts.messages));
        if (requests.length === 1) throw Object.assign(new Error('retry test'), { emptyTruncated: true });
        return { text: '200表示请求成功。', toolCalls: [] };
    } } });
    t.after(() => h.close());
    h.sessions.append('c2c', h.owner, [{ role: 'user', content: 'obsolete-topic-marker' }, { role: 'assistant', content: 'previous-answer' }]);
    await h.send('只用一句话解释HTTP 200。');
    assert.equal(requests.length, 2);
    assert.ok(JSON.stringify(requests[1]).includes('只用一句话解释HTTP 200'));
    assert.ok(JSON.stringify(requests[1]).includes('本轮输出格式'));
    assert.ok(!JSON.stringify(requests[1]).includes('obsolete-topic-marker'));
});
