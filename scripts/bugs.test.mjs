import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { gzipSync } from 'node:zlib';
import { LlmClient } from '../src/llm.js';
import { loadConfig, validateConfig } from '../src/config.js';
import { createCommandHandler } from '../src/commands.js';
import { handleMessage } from '../src/conversation.js';
import { createDeliveryBudget, sendLongAudio } from '../src/delivery.js';
import { buildWavHeader, parseWav, concatWav } from '../src/audio.js';
import { fetchPage, isPrivateHost } from '../src/web.js';
import { createToolkit } from '../src/tools.js';
import { createBot } from '../src/bot.js';
import { execFileSync } from 'node:child_process';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const configFor = (extra = {}) => loadConfig({ QQBOT_APPID: 'test', QQBOT_SECRET: 'test', DEEPSEEK_API_KEY: 'test',
    OWNER_OPENID: 'alice', STREAMING: 'false', TYPING_INDICATOR: 'false', ...extra });
const msg = { kind: 'c2c', senderId: 'alice', content: 'hello', replyTarget: { scope: 'c2c', targetId: 'alice', msgId: 'm1' } };
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const answer = () => new Response(event({ choices: [{ delta: { content: 'OK' }, finish_reason: 'stop' }] }));
const client = extra => new LlmClient({ baseUrl: 'https://example.test', apiKey: 'test-key', model: 'model-a', timeoutMs: 1000, logger, ...extra });
function temporary(t) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-bugs-'));
    t.after(() => {
        assert.equal(path.dirname(dir), path.resolve(os.tmpdir()));
        assert.ok(path.basename(dir).startsWith('qqbot-bugs-'));
        fs.rmSync(dir, { recursive: true, force: true });
    });
    return dir;
}
function wav(bytes = 4800) {
    return Buffer.concat([buildWavHeader(bytes, { sampleRate: 24000, channels: 1, bitsPerSample: 16 }), Buffer.alloc(bytes, 17)]);
}
function pipeline(extra = {}) {
    const sent = [];
    return { config: configFor(), logger, sent,
        bot: { sendText: async (_t, text) => sent.push(text), sendVoice: async () => {}, sendFile: async () => {} },
        state: { get: (_k, fallback) => fallback }, llm: { stream: async () => ({ text: 'A normal answer.', toolCalls: [] }) },
        memory: { available: false }, sessions: { toMessages: () => [], isFresh: () => true, append() {} },
        toolkit: { definitions: [], execute: async () => '' }, ...extra };
}

test('provider-specific request bodies use documented fields without mutating settings', async t => {
    const bodies = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => { bodies.push(JSON.parse(init.body)); return answer(); });
    const ds = client({ provider: 'deepseek', thinking: 'enabled', effort: 'max' });
    await ds.stream({ messages: [] });
    assert.deepEqual(bodies[0].thinking, { type: 'enabled' });
    assert.equal(bodies[0].reasoning_effort, 'max');
    const or = client({ provider: 'openrouter', thinking: 'auto', effort: 'xhigh' });
    await or.stream({ messages: [] });
    await or.stream({ messages: [], thinking: 'disabled' });
    assert.deepEqual(bodies[1].reasoning, { effort: 'xhigh' });
    assert.deepEqual(bodies[2].reasoning, { enabled: false });
    const generic = client({ thinking: 'disabled' });
    await generic.stream({ messages: [] });
    assert.equal(bodies[3].reasoning_effort, 'none');
    assert.ok(bodies.every(b => !Object.hasOwn(b, 'effort')));
    assert.equal(or.effort, 'xhigh');
});

test('schema fallback is per model and never erases global effort', async t => {
    const bodies = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
        const body = JSON.parse(init.body); bodies.push(body);
        return body.model === 'model-a' && body.reasoning_effort
            ? new Response('{"error":{"message":"Unknown parameter: reasoning_effort"}}', { status: 400 }) : answer();
    });
    const c = client({ effort: 'high' });
    await c.stream({ messages: [] });
    await c.stream({ messages: [] });
    await c.stream({ messages: [], model: 'model-b' });
    assert.deepEqual(bodies.map(b => b.reasoning_effort), ['high', undefined, undefined, 'high']);
    assert.equal(c.getEffort(), 'high');
});

test('auth, credit, server errors and rejected effort values are not retried', async t => {
    for (const [status, message] of [[401, 'unsupported parameter: reasoning_effort'], [402, 'unsupported parameter: reasoning_effort'],
        [500, 'unsupported parameter: reasoning_effort'], [400, 'Unsupported value for reasoning_effort: max']]) {
        let calls = 0;
        t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response(JSON.stringify({ error: { message } }), { status }); });
        const c = client({ effort: 'max' });
        await assert.rejects(c.stream({ messages: [] }), /LLM HTTP/);
        assert.equal(calls, 1);
        assert.equal(c.effort, 'max');
        t.mock.restoreAll();
    }
});

test('off never silently falls back to reasoning-enabled service defaults', async t => {
    let requests = 0;
    t.mock.method(globalThis, 'fetch', async (_url, init) => {
        requests++;
        const body = JSON.parse(init.body);
        return body.reasoning ? new Response('{"error":{"message":"Unknown parameter: reasoning"}}', { status: 400 }) : answer();
    });
    const c = client({ provider: 'openrouter', effort: 'high' });
    await c.stream({ messages: [] });
    assert.equal(requests, 2);
    await assert.rejects(c.stream({ messages: [], thinking: 'disabled' }), /HTTP 400/);
    assert.equal(requests, 3);
    assert.equal(c.effort, 'high');
});

test('SSE retains native and encrypted reasoning fragments for tool continuations', async t => {
    const chunks = [
        { delta: { reasoning_content: 'part 1', reasoning_details: [{ index: 0, type: 'reasoning.encrypted', id: 'r1', format: 'anthropic-claude-v1', data: 'abc' }] } },
        { delta: { reasoning_content: ' part 2', reasoning_details: [{ index: 0, data: 'def' }], tool_calls: [{ index: 0, id: 'c1', function: { name: 'recall', arguments: '{}' } }] }, finish_reason: 'tool_calls' },
    ];
    t.mock.method(globalThis, 'fetch', async () => new Response(chunks.map(c => event({ choices: [c] })).join('')));
    const r = await client().stream({ messages: [] });
    assert.equal(r.reasoningContent, 'part 1 part 2');
    assert.deepEqual(r.reasoningDetails, [{ index: 0, type: 'reasoning.encrypted', id: 'r1', format: 'anthropic-claude-v1', data: 'abcdef' }]);
});

test('SSE choice-level errors cannot be treated as terminal successful text', async t => {
    t.mock.method(globalThis, 'fetch', async () => new Response(event({ choices: [{ delta: { content: 'partial' }, finish_reason: 'stop', error: { message: 'upstream failed' } }] })));
    await assert.rejects(client().stream({ messages: [] }), /流内错误/);
});

test('tool-loop returns reasoning context to the provider and rejects undeclared tools', async () => {
    for (const reasoning of [{ reasoningContent: 'reasoning text' }, { reasoningDetails: [{ type: 'reasoning.encrypted', data: 'opaque', id: 'r' }] }]) {
        let calls = 0, executions = 0;
        const d = pipeline({ toolkit: { definitions: [{ type: 'function', function: { name: 'recall' } }], execute: async () => { executions++; return 'found'; } } });
        d.llm.stream = async ({ messages }) => {
            if (++calls === 1) return { text: '', ...reasoning, toolCalls: [{ id: 'c1', name: 'recall', args: '{}' }] };
            const assistant = messages.find(m => m.tool_calls);
            if (reasoning.reasoningContent) assert.equal(assistant.reasoning_content, reasoning.reasoningContent);
            else assert.deepEqual(assistant.reasoning_details, reasoning.reasoningDetails);
            return { text: 'A normal answer.', toolCalls: [] };
        };
        await handleMessage(d, {}, msg);
        assert.equal(executions, 1);
    }
    let calls = 0;
    const d = pipeline({ toolkit: { definitions: [{ type: 'function', function: { name: 'recall' } }], execute: () => { throw Error('must not execute undeclared tool'); } } });
    d.llm.stream = async () => ++calls === 1 ? { text: '', toolCalls: [{ id: 'bad', name: 'send_image', args: '{}' }] } : { text: 'A normal answer.', toolCalls: [] };
    await handleMessage(d, {}, msg);
    assert.deepEqual(d.sent, ['A normal answer.']);
});

test('OpenRouter config selects its own key and does not inherit DeepSeek vision defaults', () => {
    const c = configFor({ LLM_BASE_URL: 'https://openrouter.ai', OPENROUTER_API_KEY: 'or-key', LLM_MODEL: 'vendor/model', LLM_EFFORT: 'medium' });
    assert.equal(c.llm.apiKey, 'or-key');
    assert.equal(c.llm.provider, 'openrouter');
    assert.equal(c.llm.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(c.llm.visionModel, '');
    assert.deepEqual(validateConfig(c), []);
    assert.equal(configFor({ LLM_VISION_MODEL: '' }).llm.visionModel, '');
    assert.equal(configFor({ LLM_API_KEY: 'explicit-key' }).llm.apiKey, 'explicit-key');
    assert.equal(configFor({ LLM_BASE_URL: 'https://openrouter.ai', OPENROUTER_API_KEY: '' }).llm.apiKey, '');
});

test('/effort auto clears both controls and persists across an explicit disabled config', async () => {
    const store = new Map();
    const state = { get: (k, fallback) => store.has(k) ? store.get(k) : fallback, set: (k, v) => store.set(k, v), flush() {} };
    const llm = client({ thinking: 'disabled' });
    const h = createCommandHandler({ config: configFor({ LLM_THINKING: 'disabled' }), state, llm, logger });
    await h.handle({ text: '/effort max' });
    assert.equal(llm.effort, 'max');
    await h.handle({ text: '/effort auto' });
    assert.equal(llm.thinking, 'auto');
    assert.equal(llm.effort, '');
    assert.equal(store.get('effortLevel'), 'auto');
});

const dns = async () => [{ address: '8.8.8.8', family: 4 }];
function requestStub(responses, seen = []) {
    return (url, init, callback) => {
        seen.push({ url: url.href, init });
        const req = new EventEmitter();
        req.end = () => {
            const spec = responses.shift();
            assert.ok(spec, 'unexpected extra request');
            const res = new PassThrough();
            res.statusCode = spec.status ?? 200;
            res.headers = spec.headers ?? {};
            const onAbort = () => { res.destroy(init.signal.reason); req.emit('error', init.signal.reason); };
            init.signal.addEventListener('abort', onAbort, { once: true });
            res.once('close', () => init.signal.removeEventListener('abort', onAbort));
            callback(res);
            if (!spec.stalled) res.end(spec.body ?? 'OK');
        };
        return req;
    };
}

test('private IPv4/IPv6 encodings are blocked without blocking fc/fd-prefixed domain names', async () => {
    for (const address of ['127.0.0.1', '10.0.0.1', '100.64.0.1', '[::1]', '::', 'fd00::1', 'fe80::1', '::ffff:127.0.0.1', '[::ffff:7f00:1]']) assert.equal(isPrivateHost(address), true, address);
    for (const address of ['8.8.8.8', '2606:4700:4700::1111', 'fcdn.example.com', 'fd.example.com']) assert.equal(isPrivateHost(address), false, address);
    for (const url of ['http://2130706433/', 'http://[::1]/', 'http://[::ffff:127.0.0.1]/']) {
        await assert.rejects(fetchPage(url, { lookupImpl: () => { throw Error('must not resolve'); } }), /内网/);
    }
});

test('redirect targets are revalidated and DNS results are pinned into socket lookup', async () => {
    const seen = [];
    await assert.rejects(fetchPage('https://public.test/', { lookupImpl: dns,
        requestImpl: requestStub([{ status: 302, headers: { location: 'http://[::1]/secret' } }], seen) }), /内网/);
    assert.equal(seen.length, 1);
    await new Promise((resolve, reject) => seen[0].init.lookup('public.test', { all: true }, (error, addresses) => {
        if (error) reject(error); else { assert.deepEqual(addresses, [{ address: '8.8.8.8', family: 4 }]); resolve(); }
    }));
    await assert.rejects(fetchPage('https://public.test/', { lookupImpl: async () => [{ address: '8.8.8.8', family: 4 }, { address: '127.0.0.1', family: 4 }] }), /内网/);
});

test('web reads obey cancellation during DNS and body streaming and reject decompression overflow', async () => {
    const controller = new AbortController();
    const pending = fetchPage('https://public.test/', { signal: controller.signal, lookupImpl: () => new Promise(() => {}) });
    controller.abort(new Error('new message'));
    await assert.rejects(pending, /new message/);
    await assert.rejects(fetchPage('https://public.test/', { timeoutMs: 10, lookupImpl: dns, requestImpl: requestStub([{ stalled: true }]) }), /请求超时/);
    await assert.rejects(fetchPage('https://public.test/', { lookupImpl: dns,
        requestImpl: requestStub([{ headers: { 'content-encoding': 'gzip' }, body: gzipSync('x'.repeat(1_500_001)) }]) }), /字节上限/);
    const page = await fetchPage('https://public.test/', { lookupImpl: dns,
        requestImpl: requestStub([{ headers: { 'content-encoding': 'gzip' }, body: gzipSync('正常网页') }]) });
    assert.equal(page.body, '正常网页');
});

test('aborted tools do not write memory or turn cancellation into a network result', async () => {
    const toolkit = createToolkit({ memory: { addImportant: () => { throw Error('must not write'); } }, logger });
    const signal = AbortSignal.abort(new Error('new message'));
    for (const name of ['remember', 'weather', 'web_search', 'fetch_url']) {
        await assert.rejects(toolkit.execute({ name, args: '{}' }, { signal }), /new message/);
    }
});

test('successful file delivery is counted as audio and does not trigger duplicate full text', async t => {
    const dir = temporary(t), file = path.join(dir, 'source.wav'); fs.writeFileSync(file, wav());
    let files = 0;
    const d = pipeline(); d.config.tts.longDelivery = 'file'; d.config.tts.tmpDir = dir;
    d.state.get = (key, fallback) => key.startsWith('voice:') ? true : fallback;
    d.bot.sendFile = async () => { files++; };
    d.tts = { enabled: true, defaultOn: true, maxChars: 1000, segmentChars: 20, segmentsMax: 3, charsPerSecond: 5,
        synthesizeLong: async () => ({ path: file, bytes: fs.statSync(file).size, durationMs: 100 }), release() {} };
    d.llm.stream = async () => ({ text: 'one two three four five six seven eight nine ten.'.repeat(3), toolCalls: [] });
    await handleMessage(d, {}, msg);
    assert.equal(files, 1);
    assert.deepEqual(d.sent, []);
});

test('failed speech segments are returned as text without repeating the successful segments', async () => {
    const d = pipeline();
    d.state.get = (key, fallback) => key.startsWith('voice:') ? true : fallback;
    const text = 'A'.repeat(20) + 'B'.repeat(20) + 'C'.repeat(20);
    d.llm.stream = async () => ({ text, toolCalls: [] });
    d.tts = { enabled: true, maxChars: 1000, segmentChars: 20, segmentsMax: 3, charsPerSecond: 5,
        synthesize: async ({ text }) => { if (text.startsWith('B')) throw Error('failed segment'); return { id: text[0] }; },
        take: id => ({ path: id }), release() {}, drop() {} };
    await handleMessage(d, {}, msg);
    assert.equal(d.sent.length, 1);
    assert.ok(d.sent[0].includes('B'.repeat(20)));
    assert.ok(!d.sent[0].includes('A'.repeat(20)) && !d.sent[0].includes('C'.repeat(20)));
});

test('a failed tool TTS is not synthesized a second time automatically', async () => {
    let calls = 0, synth = 0;
    const d = pipeline();
    d.state.get = (key, fallback) => key.startsWith('voice:') ? true : fallback;
    d.tts = { enabled: true, segmentChars: 200, segmentsMax: 3, maxChars: 1000,
        synthesize: async () => { synth++; throw Error('should not retry tool failure'); } };
    d.toolkit = { definitions: [{ type: 'function', function: { name: 'tts_speak' } }], execute: async (_call, ctx) => { ctx.turn.voiceFailed = true; return 'failed'; } };
    d.llm.stream = async () => ++calls === 1 ? { text: '', toolCalls: [{ id: 'c1', name: 'tts_speak', args: '{}' }] } : { text: 'A normal answer.', toolCalls: [] };
    await handleMessage(d, {}, msg);
    assert.equal(synth, 0);
    assert.deepEqual(d.sent, ['A normal answer.']);
});

test('whole-file fallback excludes audio bubbles that were already sent successfully', async t => {
    const dir = temporary(t), file = path.join(dir, 'source.wav'); fs.writeFileSync(file, wav(480));
    const config = configFor(); config.tts.tmpDir = dir; config.tts.voiceSoftLimitBytes = 244;
    let voices = 0, sentData = null;
    const bot = { sendVoice: async () => { if (++voices === 2) throw Error('voice rejected'); },
        sendFile: async (_target, source) => { sentData = parseWav(fs.readFileSync(source.localPath)).data; } };
    const budget = createDeliveryBudget(bot);
    const count = await sendLongAudio({ bot: budget.bot, msg, result: { path: file, durationMs: 10 }, config, logger, slots: budget.remaining });
    assert.equal(count, 2);
    assert.ok(sentData.length > 0 && sentData.length < 480);
    assert.deepEqual(fs.readdirSync(dir), ['source.wav']);
});

test('invalid WAV formats fail early rather than allocating with invalid metadata', () => {
    const bad = wav(); bad.writeUInt16LE(0, 22);
    assert.throws(() => parseWav(bad), /声道/);
    const short = wav(); short.writeUInt32LE(1_000_000, 16);
    assert.throws(() => parseWav(short), /fmt/);
    const pcm = wav(); const float = wav(); float.writeUInt16LE(3, 20);
    assert.throws(() => concatWav([pcm, float]), /格式不一致/);
});

test('SDK ready and resumed start the proactive timer before its long-lived start promise resolves', () => {
    class Bot { handlers = {}; use() {} on(name, handler) { this.handlers[name] = handler; } }
    const events = [];
    const runtime = { companion: { setOnline: value => events.push(value), start: () => events.push('start') } };
    const bot = createBot({ config: configFor(), logger, runtime }, { Bot });
    assert.deepEqual(events, []);
    bot.handlers.ready();
    bot.handlers.resumed();
    assert.deepEqual(events, [true, 'start', true, 'start']);
});

test('Altare accepts dotenv-quoted timezone with inline comments without connecting to QQ', t => {
    const dir = temporary(t);
    fs.mkdirSync(path.join(dir, 'src'));
    for (const name of ['altare.js', 'src/config.js', 'src/voice-style.js']) {
        fs.copyFileSync(new URL(`../${name}`, import.meta.url), path.join(dir, name));
    }
    fs.writeFileSync(path.join(dir, 'package.json'), '{"type":"module"}');
    fs.writeFileSync(path.join(dir, '.env'), 'QQBOT_APPID=test\nQQBOT_SECRET=test\nLLM_API_KEY=test\nTZ="Asia/Shanghai" # timezone\n');
    const output = execFileSync(process.execPath, [path.join(dir, 'altare.js'), '--check'], {
        env: { TZ: 'UTC', ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}) }, encoding: 'utf8', timeout: 5000,
    });
    assert.match(output, /配置检查通过/);
});

test('failed automatic speech falls back to exactly one text copy', async () => {
    const d = pipeline();
    d.state.get = (key, fallback) => key.startsWith('voice:') ? true : fallback;
    d.tts = { enabled: true, maxChars: 1000, segmentChars: 200, segmentsMax: 3, charsPerSecond: 5,
        synthesize: async () => { throw Error('tts failure'); }, drop() {} };
    await handleMessage(d, {}, msg);
    assert.deepEqual(d.sent, ['A normal answer.']);
});

test('Clash fake-ip range is not treated as internal', async () => {
    const { isPrivateHost } = await import('../src/web.js');
    // Clash TUN 把域名解析到 198.18.0.0/15；拦了它，本机所有联网工具都会失效
    assert.equal(isPrivateHost('198.18.0.41'), false);
    assert.equal(isPrivateHost('198.19.0.1'), false);
});
