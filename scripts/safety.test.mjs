import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig, validateConfig } from '../src/config.js';
import { createOwnerGuard } from '../src/owner.js';
import { createDeliveryBudget } from '../src/delivery.js';
import { createBot } from '../src/bot.js';
import { createCommandHandler } from '../src/commands.js';
import { handleMessage } from '../src/conversation.js';
import { createTts } from '../src/tts.js';
import { buildWavHeader, parseWav, splitWav } from '../src/audio.js';
import { LlmClient } from '../src/llm.js';

const logger = { info() {}, warn() {}, error() {}, debug() {} };
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r; }); return { promise, resolve }; };
const configFor = (extra = {}) => loadConfig({
    QQBOT_APPID: 'test', QQBOT_SECRET: 'test', DEEPSEEK_API_KEY: 'test', OWNER_OPENID: 'alice',
    STREAMING: 'false', TYPING_INDICATOR: 'false', PEER_COOLDOWN_MS: '0', ...extra,
});
const message = (content = 'hello', senderId = 'alice', id = 'm1') => ({
    kind: 'c2c', senderId, messageId: id, content,
    replyTarget: { scope: 'c2c', targetId: senderId, msgId: id },
});
const sessions = () => ({ toMessages: () => [], isFresh: () => true, append() {} });
function temporary(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyan-safety-'));
    t.after(() => {
        const rel = path.relative(path.resolve(os.tmpdir()), path.resolve(root));
        assert.ok(rel.startsWith('xiaoyan-safety-') && !rel.includes(path.sep));
        fs.rmSync(root, { recursive: true, force: true });
    });
    return root;
}
function wav(byte = 17) {
    const data = Buffer.alloc(4800, byte);
    return Buffer.concat([buildWavHeader(data.length, { sampleRate: 24000, channels: 1, bitsPerSample: 16 }), data]);
}
function ttsFixture(t, extra = {}) {
    const config = configFor({ DATA_DIR: temporary(t), TTS_ENABLED: 'true', TTS_API_KEY: 'test', TTS_ENGINE: 'openai', ...extra });
    const tts = createTts({ config, logger });
    t.after(() => tts.stop());
    return { config, tts };
}

test('ownership requires the console code, persists, and cannot be rebound by another account', async (t) => {
    const config = configFor({ DATA_DIR: temporary(t), OWNER_OPENID: '' });
    const auth = createOwnerGuard({ config, logger, makeCode: () => 'private-code' });
    const sent = [];
    const bot = { sendText: async (_target, text) => sent.push(text) };
    assert.equal(await auth.check(message('hello'), bot), false);
    assert.equal(await auth.check(message('/bind wrong', 'bob'), bot), false);
    assert.equal(auth.isOwner('bob'), false);
    assert.equal(await auth.check({ ...message('/bind private-code'), kind: 'group' }, bot), false);
    assert.equal(await auth.check(message('/bind private-code'), bot), false);
    assert.equal(auth.isOwner('alice'), true);
    assert.equal(await auth.check(message('/bind private-code', 'bob'), bot), false);
    const restarted = createOwnerGuard({ config, logger, makeCode: () => { throw Error('must not issue another code'); } });
    assert.equal(await restarted.check(message(), bot), true);
    assert.equal(await restarted.check(message('hello', 'bob'), bot), false);
    assert.ok(sent.every((s) => !s.includes('private-code')), 'never disclose the code in QQ');
    assert.ok(!fs.readFileSync(path.join(config.dataDir, 'owner.json'), 'utf8').includes('private-code'));
});

test('expired binding code and corrupted ownership data fail closed', async (t) => {
    const config = configFor({ DATA_DIR: temporary(t), OWNER_OPENID: '' });
    let now = 100;
    const auth = createOwnerGuard({ config, logger, now: () => now, makeCode: () => 'code' });
    now += 10 * 60_000;
    await auth.check(message('/bind code'), { sendText: async () => {} });
    assert.equal(auth.isOwner('alice'), false);
    fs.writeFileSync(path.join(config.dataDir, 'owner.json'), '{}');
    assert.throws(() => createOwnerGuard({ config, logger }), /绑定文件损坏/);
});

test('untrusted private and group senders cannot invoke model, history, memory, or commands', async () => {
    class Bot {
        handlers = {}; use() {} on(k, fn) { this.handlers[k] = fn; }
        async sendText() { throw Error('must not reply to another account'); }
    }
    const forbidden = () => { throw Error('unauthorized work'); };
    const bot = createBot({
        config: configFor({ SCOPE_MODE: 'both', GROUP_MODE: 'open' }), logger,
        llm: { stream: forbidden }, memory: { renderForPrompt: forbidden },
        sessions: { toMessages: forbidden }, commands: { handle: forbidden }, toolkit: { definitions: [] },
    }, { Bot });
    await bot.handlers.message({ state: {} }, message('/mem list', 'bob'));
    await bot.handlers.message({ state: {} }, { ...message('/model bad', 'bob'), kind: 'group', groupOpenid: 'g1' });
    await bot.handlers.message({ state: {} }, { ...message('hello', 'alice'), kind: 'group', groupOpenid: 'g1' });
    await bot.drain();
    const auth = { isOwner: (id) => id === 'alice' };
    const commands = createCommandHandler({ config: configFor(), logger, auth, state: { set: forbidden }, memory: { available: true, deleteImportant: forbidden } });
    assert.match(await commands.handle({ text: '/mem del 1', msg: { senderId: 'bob' } }), /主人/);
    assert.match(await commands.handle({ text: '/model bad', msg: { senderId: 'bob' } }), /主人/);
});

test('/stop cancels queued messages as well as active work, and later messages still work', async () => {
    class Bot {
        handlers = {}; sent = []; use() {} on(k, fn) { this.handlers[k] = fn; }
        async sendText(_t, text) { this.sent.push(text); }
    }
    const started = deferred();
    let calls = 0;
    const bot = createBot({
        config: configFor(), logger, memory: { available: false }, sessions: sessions(), toolkit: { definitions: [] },
        llm: { stream: async ({ signal }) => {
            if (++calls === 1) {
                started.resolve();
                await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
            }
            return { text: 'reply', toolCalls: [] };
        } },
    }, { Bot });
    const active = bot.handlers.message({ state: {} }, message());
    await started.promise;
    const queued = bot.handlers.message({ state: {} }, message('queued', 'alice', 'm2'));
    await bot.handlers.message({ state: {} }, message('/stop', 'alice', 'm3'));
    await Promise.all([active, queued]);
    assert.equal(calls, 1);
    await bot.handlers.message({ state: {} }, message('new', 'alice', 'm4'));
    assert.equal(calls, 2);
    assert.equal(bot.runtime.activeTurns(), 0);
    await bot.drain();
});

test('TTS abort removes queued work before fetch and cancels the active provider request', async (t) => {
    const { tts } = ttsFixture(t, { TTS_MAX_CONCURRENCY: '1' });
    const started = deferred(); let fetches = 0;
    t.mock.method(globalThis, 'fetch', async (_u, { signal }) => {
        fetches++; started.resolve();
        return new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
    });
    const active = new AbortController(), queued = new AbortController();
    const first = assert.rejects(tts.synthesize({ text: 'first', signal: active.signal }), /stop/);
    await started.promise;
    const second = assert.rejects(tts.synthesize({ text: 'second', signal: queued.signal }), /stop/);
    queued.abort(new Error('/stop queued')); active.abort(new Error('/stop active'));
    await Promise.all([first, second]);
    assert.equal(fetches, 1);
    assert.equal(tts.stats().queued, 0);
    assert.equal(tts.stats().active, 0);
    assert.equal(tts.stats().files, 0);
});

test('cancel during the final long-speech batch cannot send a late voice or leave files', async (t) => {
    const { config, tts } = ttsFixture(t);
    const started = deferred(), finish = deferred(); let innerSignal, sent = 0;
    t.mock.method(globalThis, 'fetch', async (_u, { signal }) => {
        innerSignal = signal; started.resolve(); await finish.promise;
        return new Response(wav()); // Even a provider ignoring abort must not produce a late file.
    });
    const bot = { sendText: async () => {}, sendVoice: async () => { sent++; } };
    const controller = new AbortController();
    const commands = createCommandHandler({ config, logger, tts, runtime: { bot }, llm: { stream: async () => ({ text: '甲'.repeat(100), toolCalls: [] }) } });
    const running = assert.rejects(commands.handle({ text: '/long 0.1', scope: 'c2c', targetId: 'alice', msg: message(), signal: controller.signal }), /stop/);
    await started.promise;
    controller.abort(new Error('/stop')); assert.equal(innerSignal.aborted, true); finish.resolve();
    await running;
    assert.equal(sent, 0); assert.equal(tts.stats().files, 0); assert.equal(tts.stats().pending, 0);
});

test('one failed long-speech segment cancels sibling requests and cleans intermediate media', async (t) => {
    const { tts } = ttsFixture(t, { TTS_SEGMENT_CHARS: '50' });
    const both = deferred(); let calls = 0, aborted = false;
    t.mock.method(globalThis, 'fetch', async (_u, { signal }) => {
        const n = ++calls;
        if (n === 2) both.resolve();
        if (n === 1) { await both.promise; return new Response('failed', { status: 500 }); }
        return new Promise((_r, reject) => signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }));
    });
    await assert.rejects(tts.synthesizeLong({ text: '甲'.repeat(100) }), /HTTP 500/);
    assert.equal(aborted, true); assert.equal(tts.stats().files, 0); assert.equal(tts.stats().pending, 0);
});

test('concurrent long deliveries use isolated files and preserve each peers audio', async (t) => {
    const root = temporary(t), config = configFor({ DATA_DIR: root, TTS_LONG_DELIVERY: 'voice' });
    config.tts.voiceSoftLimitBytes = 3000; // Force two bubbles per request.
    const sources = [path.join(root, 'a.wav'), path.join(root, 'b.wav')];
    sources.forEach((file, i) => fs.writeFileSync(file, wav(i === 0 ? 17 : 34)));
    const gate = deferred(), paths = [], received = []; let arrivals = 0, generated = 0;
    const bot = {
        sendText: async () => {},
        sendVoice: async (target, { localPath }) => {
            paths.push(localPath);
            if (++arrivals === 2) gate.resolve();
            await gate.promise;
            await new Promise((r) => setImmediate(r)); // SDK local uploads read asynchronously.
            received.push({ peer: target.targetId, value: parseWav(fs.readFileSync(localPath)).data[0] });
        },
    };
    const tts = {
        enabled: true, longMaxMinutes: 15, charsPerSecond: 4.9,
        synthesizeLong: async ({ text }) => ({ path: sources[text[0] === '甲' ? 0 : 1], bytes: 4844, durationMs: 100, segments: 1 }),
        release: (file) => fs.unlinkSync(file),
    };
    const commands = createCommandHandler({ config, logger, tts, runtime: { bot }, llm: { stream: async () => ({ text: (generated++ === 0 ? '甲' : '乙').repeat(100), toolCalls: [] }) } });
    await Promise.all(['alice', 'bob'].map((id) => commands.handle({ text: '/long 0.1', scope: 'c2c', targetId: id, msg: message('', id) })));
    assert.equal(new Set(paths).size, 4);
    assert.ok(received.filter((r) => r.peer === 'alice').every((r) => r.value === 17));
    assert.ok(received.filter((r) => r.peer === 'bob').every((r) => r.value === 34));
    assert.deepEqual(fs.readdirSync(config.tts.tmpDir), []);
});

test('voice replies send only the voice note, no duplicated text bubble', async (t) => {
    const { config, tts } = ttsFixture(t, { TYPING_INDICATOR: 'true' });
    let syntheses = 0; const sent = [], texts = [];
    t.mock.method(globalThis, 'fetch', async () => { syntheses++; return new Response(wav()); });
    const d = {
        config, logger, tts, state: { get: (_k, fallback) => fallback ?? true },
        bot: { sendTyping: async () => sent.push('typing'), sendText: async (_t, text) => { texts.push(text); sent.push('text'); }, sendVoice: async (_t, src) => { assert.ok(fs.existsSync(src.localPath)); sent.push('voice'); } },
        llm: { stream: async () => ({ text: '甲'.repeat(13000), toolCalls: [] }) },
        memory: { available: false }, sessions: sessions(), toolkit: { definitions: [] },
    };
    d.state.get = (key, fallback) => key.startsWith('voice:') ? true : fallback;
    await handleMessage(d, { state: {} }, message());
    // 语音开着时只发语音条；念不完的尾巴才用文字补，且不是重复正文
    assert.equal(sent[0], 'voice');
    assert.ok(sent.length >= 2, '尾巴要补成文字');
    assert.match(texts[0], /有 \d+ 字未能朗读/);
    assert.ok(!texts[0].startsWith('甲乙丙'), '不能把念过的正文再贴一遍');
    // 长回复不再逐段发，整段合成后合并成一条语音；可念多少字由「剩余额度 × 每条的体积软限」算出来
    const bytesPerSecond = 48000;
    const capacityChars = Math.floor((4 * config.tts.voiceSoftLimitBytes / bytesPerSecond) * config.tts.charsPerSecond);
    const speakable = Math.min(config.tts.maxChars, capacityChars);
    const expectedSegments = Math.ceil(speakable / config.tts.segmentChars);
    assert.equal(syntheses, expectedSegments, '可念的正文要先整段合成再合并');
    assert.equal(tts.stats().files, 0); assert.equal(tts.stats().pending, 0);
});

test('no TTS request starts once text has exhausted the reply budget', async () => {
    let sent = 0;
    const rawBot = { sendText: async () => { sent++; } };
    const delivery = createDeliveryBudget(rawBot);
    for (let i = 0; i < 3; i++) await delivery.bot.sendText(message().replyTarget, 'earlier media receipts');
    await handleMessage({
        config: configFor(), logger, memory: { available: false }, sessions: sessions(), toolkit: { definitions: [] },
        state: { get: (k, f) => k.startsWith('voice:') ? true : f },
        tts: { enabled: true, maxChars: 600, segmentChars: 200, segmentsMax: 3, synthesize() { throw Error('must not spend on undeliverable audio'); } },
        bot: delivery.bot, delivery, llm: { stream: async () => ({ text: '甲'.repeat(17000), toolCalls: [] }) },
    }, { state: {} }, message());
    assert.equal(sent, 4);
});

test('long synthesis retains source sample rate and data above the per-bubble soft limit', async (t) => {
    const { config, tts } = ttsFixture(t);
    config.tts.voiceSoftLimitBytes = 2000;
    t.mock.method(globalThis, 'fetch', async () => new Response(wav(42)));
    const result = await tts.synthesizeLong({ text: '测试音频' });
    const audio = parseWav(fs.readFileSync(result.path));
    assert.equal(audio.sampleRate, 24000);
    assert.equal(audio.data.length, 4800);
    assert.equal(result.downgraded, false);
    assert.ok(result.bytes > config.tts.voiceSoftLimitBytes);
    tts.release(result.path);
});

test('/long sends a long script without the short-reply cap and keeps the existing command entry', async (t) => {
    const config = configFor({ DATA_DIR: temporary(t) });
    const audioPath = path.join(config.dataDir, 'long.wav'); fs.writeFileSync(audioPath, wav());
    const sent = [], stitched = [], prompts = [];
    const bot = {
        sendText: async (_t, text) => sent.push(text),
        sendVoice: async (_t, src) => { assert.ok(fs.existsSync(src.localPath)); sent.push('[voice]'); },
    };
    const tts = {
        enabled: true, longMaxMinutes: 15, charsPerSecond: 4.9, maxChars: 600,
        synthesizeLong: async (opts) => { stitched.push(opts); return { path: audioPath, bytes: 4844, durationMs: 600000 }; },
        release: (file) => fs.unlinkSync(file),
    };
    const llm = { stream: async (opts) => { prompts.push(opts); return { text: '甲'.repeat(3000), toolCalls: [] }; } };
    const commands = createCommandHandler({ config, logger, tts, runtime: { bot }, llm });
    await handleMessage({ config, logger, tts, bot, llm, commands, memory: { available: false }, sessions: sessions(), toolkit: { definitions: [] } }, { state: {} }, message('/long 10 雨夜放松'));
    assert.equal(prompts.length, 1);
    assert.ok(prompts[0].messages[0].content.includes('2940 字'));
    assert.equal(stitched[0].text.length, 3000);
    assert.equal(commands.list().includes('asmr'), false);
    assert.equal(sent.length, 3); assert.equal(sent[1], '[voice]');
    assert.equal(fs.existsSync(audioPath), false);
});

test('/long uses a separate deadline while ordinary commands retain the short deadline', async () => {
    class Bot {
        handlers = {}; sent = []; use() {} on(k, fn) { this.handlers[k] = fn; }
        async sendText(_t, text) { this.sent.push(text); }
    }
    const config = configFor({ REPLY_TIMEOUT_MS: '5', LONG_REPLY_TIMEOUT_MS: '500' });
    const commands = { handle: async ({ signal }) => {
        await new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, 30);
            signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
        });
        return 'finished';
    } };
    const bot = createBot({ config, logger, commands, toolkit: { definitions: [] } }, { Bot });
    await bot.handlers.message({ state: {} }, message('/ping'));
    assert.ok(bot.sent[0].includes('卡太久'));
    await bot.handlers.message({ state: {} }, message('/long 10', 'alice', 'm2'));
    assert.deepEqual(bot.sent.slice(1), ['finished']);
    await bot.drain();
});

test('long deadline configuration validates bounded finite values', () => {
    assert.equal(configFor().behavior.typingIndicator, false);
    assert.equal(configFor().behavior.longReplyTimeoutMs, 900000);
    assert.ok(validateConfig(configFor({ LONG_REPLY_TIMEOUT_MS: '3600000' })).some((s) => s.includes('LONG_REPLY_TIMEOUT_MS')));
});

test('stream frames cost one slot and failed sends do not allow budget overruns', async () => {
    let sends = 0;
    const delivery = createDeliveryBudget({
        sendText: async () => { sends++; throw Error('uncertain response'); },
        openStream: () => ({ update: async () => {}, complete: async () => {}, cancel() {} }),
    });
    const stream = delivery.bot.openStream({});
    await stream.update('a'); await stream.update('ab'); await stream.complete();
    assert.equal(delivery.used, 1);
    for (let i = 0; i < 3; i++) await assert.rejects(delivery.bot.sendText({}, 'test'), /uncertain/);
    await assert.rejects(delivery.bot.sendText({}, 'extra'), /额度/);
    assert.equal(sends, 3); assert.equal(delivery.remaining, 0);
});


test('oversized audio responses stop reading before full allocation', async (t) => {
    const { tts } = ttsFixture(t, { TTS_MAX_BYTES: '1024' }); let pulls = 0, cancelled = false;
    t.mock.method(globalThis, 'fetch', async () => new Response(new ReadableStream({
        pull(c) { pulls++; c.enqueue(new Uint8Array(800)); }, cancel() { cancelled = true; },
    }, { highWaterMark: 0 })));
    await assert.rejects(tts.synthesize({ text: 'test' }), /字节上限/);
    assert.equal(pulls, 2); assert.equal(cancelled, true); assert.equal(tts.stats().files, 0);
});

test('images use the configured vision model and text-only retries return to the selected text model', async (t) => {
    const chosen = [];
    t.mock.method(globalThis, 'fetch', async (_url, { body }) => {
        chosen.push(JSON.parse(body).model);
        return new Response('data: {"choices":[{"delta":{"content":"answer"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
    });
    const client = new LlmClient({ baseUrl: 'https://invalid.example', apiKey: 'test', model: 'deepseek-v4-pro', visionModel: 'deepseek-flash', timeoutMs: 1000 });
    await client.stream({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }] });
    await client.stream({ model: 'deepseek-v4-pro', messages: [{ role: 'user', content: 'text fallback' }] });
    assert.deepEqual(chosen, ['deepseek-flash', 'deepseek-v4-pro']);
});

test('split WAV includes headers in its byte cap', () => {
    const parts = splitWav(wav(), 2444);
    assert.equal(parts.length, 2);
    assert.ok(parts.every((p) => p.length <= 2444));
    assert.equal(parts.reduce((n, p) => n + parseWav(p).data.length, 0), 4800);
});

test('cancel during SDK media upload prevents the subsequent message send', async () => {
    const controller = new AbortController(), started = deferred(), finish = deferred();
    let sends = 0;
    const delivery = createDeliveryBudget({
        sendVoice: async () => { throw Error('must split upload from send'); },
        uploadMedia: async (opts) => {
            assert.equal(opts.fileType, 3); assert.equal(opts.srvSendMsg, false);
            started.resolve(); await finish.promise; return { file_info: 'uploaded' };
        },
        send: async () => { sends++; },
    }, { signal: controller.signal });
    const operation = assert.rejects(delivery.bot.sendVoice(message().replyTarget, { localPath: 'test.wav' }), /stop/);
    await started.promise; controller.abort(new Error('/stop')); finish.resolve(); await operation;
    assert.equal(sends, 0);
});

test('public SDK media upload and send preserve file type, target, content, and filename', async () => {
    const requests = [];
    const target = message().replyTarget;
    const delivery = createDeliveryBudget({
        sendFile() { throw Error('use the SDK public two-step interface'); },
        uploadMedia: async (opts) => { requests.push(opts); return { file_info: 'uploaded' }; },
        send: async (opts) => { requests.push(opts); return { id: 'sent' }; },
    });
    const result = await delivery.bot.sendFile(target, { localPath: 'voice.wav' }, { fileName: 'recording.wav', content: 'caption' });
    assert.equal(requests[0].fileType, 4); assert.equal(requests[0].fileName, 'recording.wav');
    assert.equal(requests[1].target, target); assert.equal(requests[1].msgType, 7);
    assert.equal(requests[1].content, 'caption'); assert.deepEqual(requests[1].media, { file_info: 'uploaded' });
    assert.equal(result.message.id, 'sent'); assert.equal(delivery.used, 1);
});

test('unsafe temporary directory and truncating speech segment configuration fail validation', () => {
    assert.ok(validateConfig(configFor({ TTS_TMP_DIR: '.' })).some((s) => s.includes('独立临时目录')));
    assert.ok(validateConfig(configFor({ TTS_TMP_DIR: './data' })).some((s) => s.includes('独立临时目录')));
    assert.ok(validateConfig(configFor({ TTS_SEGMENT_CHARS: '1000', TTS_MAX_CHARS: '600' })).some((s) => s.includes('TTS_SEGMENT_CHARS')));
    assert.equal(validateConfig(configFor()).length, 0);
    const groupProblems = validateConfig(configFor({ SCOPE_MODE: 'both', GROUP_MODE: 'open' }));
    assert.ok(groupProblems.some((s) => s.includes('SCOPE_MODE=c2c')));
    assert.ok(groupProblems.some((s) => s.includes('GROUP_MODE')));
});

test('a new message interrupts the running turn without /stop, and still gets answered', async () => {
    class Bot {
        handlers = {}; sent = []; use() {} on(k, fn) { this.handlers[k] = fn; }
        async sendText(_t, text) { this.sent.push(text); }
    }
    const started = deferred();
    let calls = 0;
    const bot = createBot({
        // 故意开冷却：打断性的新消息必须能绕过它
        config: configFor({ PEER_COOLDOWN_MS: '5000' }),
        logger, memory: { available: false }, sessions: sessions(), toolkit: { definitions: [] },
        llm: { stream: async ({ signal }) => {
            if (++calls === 1) {
                started.resolve();
                await new Promise((_r, reject) => signal.addEventListener('abort', () => reject(signal.reason), { once: true }));
            }
            return { text: 'second reply', toolCalls: [] };
        } },
    }, { Bot });
    const first = bot.handlers.message({ state: {} }, message('first', 'alice', 'm1'));
    await started.promise;
    const second = bot.handlers.message({ state: {} }, message('second', 'alice', 'm2'));
    await Promise.all([first, second]);
    assert.equal(calls, 2, '打断之后新消息必须照常进模型');
    assert.deepEqual(bot.sent, ['second reply']);
    assert.equal(bot.runtime.activeTurns(), 0);
    await bot.drain();
});





