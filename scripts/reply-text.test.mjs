import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeReplyLayout, preserveRequestedLayout, inspectReplyText } from '../src/reply-text.js';
import { loadConfig } from '../src/config.js';
import { createLocalEval } from '../src/local-eval.js';
import fs from 'node:fs';
import path from 'node:path';
import { buildWavHeader } from '../src/audio.js';

const body = '欢迎大家来到今天的展览现场请慢慢参观。';
const fragmented = [...body].join('\n');

test('dense fragmented Chinese is joined without changing words, blank paragraphs or line endings elsewhere', () => {
    const input = `开场。\r\n\r\n${fragmented.replaceAll('\n', '\r\n')}\r\n\r\n结尾。`;
    const result = normalizeReplyLayout(input);
    assert.equal(result, `开场。\r\n\r\n${body}\r\n\r\n结尾。`);
    assert.equal(result.replace(/\s/g, ''), input.replace(/\s/g, ''));
    assert.equal(normalizeReplyLayout(result), result);
});

test('short dialogue, Markdown lists, headings, tables and deliberate vertical layouts stay intact', () => {
    for (const text of ['你\n好\n呀', '今天很好\n明天再来\n后天也行',
        '# 标题\n\n- 一\n- 二\n\n> 引用\n\n| 甲 | 乙 |\n|---|---|\n| 一 | 二 |',
        Array(20).fill('短句。').join('\n')]) {
        assert.equal(normalizeReplyLayout(text), text);
    }
    for (const user of ['请逐字换行', '保留原有排版', '写首诗', '每个字一行']) {
        assert.equal(preserveRequestedLayout(user), true);
        assert.equal(normalizeReplyLayout(fragmented, { preserveLineBreaks: preserveRequestedLayout(user) }), fragmented);
    }
});

test('fenced, indented, inline multiline and HTML code retain exact contents, even with open fences', () => {
    for (const protectedBlock of [
        '```text\n' + fragmented + '\n```',
        '~~~~text\n' + fragmented + '\n~~~~',
        '````text\n```\n' + fragmented + '\n````',
        fragmented.split('\n').map(l => '    ' + l).join('\n'),
        '`\n' + fragmented + '\n`',
        '<pre>\n' + fragmented + '\n</pre>',
        '```text\n' + fragmented,
    ]) {
        assert.equal(normalizeReplyLayout(protectedBlock), protectedBlock);
    }
    assert.equal(normalizeReplyLayout('```text\n' + fragmented + '\n```\n\n' + fragmented),
        '```text\n' + fragmented + '\n```\n\n' + body);
});

test('English terms, uncertain fragments and Unicode are never guessed, translated or deleted', () => {
    const text = 'HTTP接口与UTF-8编码。olic的声音。English quotation.\n\uFFFD\n😀';
    assert.equal(normalizeReplyLayout(text), text);
    const metrics = inspectReplyText(text);
    assert.equal(metrics.replacementCharacters, 1);
    assert.ok(metrics.latinCharacters > 0);
    assert.equal(inspectReplyText('😀 A\n中').nonWhitespaceCharacters, 3);
});

test('length diagnostics exclude whitespace and do not count line breaks as delivered content', () => {
    const plain = inspectReplyText(body, '写一段至少800字的展览介绍。');
    const split = inspectReplyText(fragmented, '写一段至少800字的展览介绍。');
    assert.equal(plain.nonWhitespaceCharacters, split.nonWhitespaceCharacters);
    assert.equal(split.length.status, 'below_minimum');
    assert.equal(inspectReplyText('你好', '不超过2字').length.status, 'within_bounds');
    assert.equal(inspectReplyText('你好。', '2字以内').length.status, 'above_maximum');
    assert.equal(inspectReplyText(body, '写一段展览介绍，800 字。').length.status, 'below_target');
    assert.equal(inspectReplyText('200', '解释HTTP 200').length.status, 'unspecified');
});

for (const streaming of [false, true]) {
    test(`QQ inbound delivery, history and eval record use the same normalized reply (stream=${streaming})`, async t => {
        let calls = 0;
        const config = loadConfig({ QQBOT_APPID: 'test', QQBOT_SECRET: 'test', DEEPSEEK_API_KEY: 'test',
            OWNER_OPENID: 'test-owner', STREAMING: String(streaming), PEER_COOLDOWN_MS: '0',
            TYPING_INDICATOR: 'false', TTS_DEFAULT_ON: 'false', PEER_RATE_PER_MIN: '0' });
        config.llm.maxToolRounds = 0;
        const h = createLocalEval({ config, llm: { stream: async options => {
            calls++;
            options.onDelta?.(fragmented.slice(0, 20), fragmented.slice(0, 20));
            options.onDelta?.(fragmented.slice(20), fragmented);
            return { text: fragmented, toolCalls: [] };
        } } });
        t.after(() => h.close());
        const result = await h.send('请写一段至少100字的展览介绍。');
        assert.equal(calls, 1, 'layout and diagnostics must not retry or expand content');
        assert.equal(result.turns.at(-1).reply, body);
        assert.ok(result.events.some(e => ['text', 'stream'].includes(e.type) && e.text === body));
        assert.equal(h.sessions.toMessages('c2c', h.owner).at(-1).content, body);
        assert.equal(result.turns.at(-1).layoutNormalized, true);
        assert.equal(result.turns.at(-1).textMetrics.length.status, 'below_minimum');
        const poem = await h.send('按原字逐字换行。');
        assert.equal(calls, 2);
        assert.equal(poem.turns.at(-1).reply, fragmented);
    });
}

test('automatic speech receives the normalized text without real synthesis or QQ access', async t => {
    const config = loadConfig({ QQBOT_APPID: 'test', QQBOT_SECRET: 'test', DEEPSEEK_API_KEY: 'test',
        OWNER_OPENID: 'test-owner', STREAMING: 'false', TTS_DEFAULT_ON: 'true', PEER_COOLDOWN_MS: '0' });
    const spoken = [], pending = new Map();
    let h;
    const tts = { enabled: true, engine: 'qwen', defaultOn: true, defaultVoice: 'test-voice',
        maxChars: 8000, segmentChars: 600, segmentsMax: 3, charsPerSecond: 5,
        listVoices: () => [{ id: 'test-voice', name: '测试音色' }], stats: () => ({ enabled: true }), stop() {},
        async synthesize({ text }) {
            spoken.push(text);
            const record = { id: 'audio', path: path.join(h.dir, 'fixture.wav'), bytes: 4844 };
            fs.writeFileSync(record.path, Buffer.concat([buildWavHeader(4800, {
                sampleRate: 24000, channels: 1, bitsPerSample: 16,
            }), Buffer.alloc(4800)]));
            pending.set(record.id, record); return record;
        },
        take(id) { const record = pending.get(id); pending.delete(id); return record; },
        drop(id) { pending.delete(id); }, release(file) { fs.unlinkSync(file); },
    };
    h = createLocalEval({ config, tts, llm: { stream: async () => ({ text: fragmented, toolCalls: [] }) } });
    t.after(() => h.close());
    const result = await h.send('介绍一下今天的展览。');
    assert.deepEqual(spoken, [body]);
    assert.ok(result.events.some(e => e.type === 'voice'));
    assert.equal(result.turns.at(-1).reply, body);
});
