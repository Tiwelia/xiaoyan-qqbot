#!/usr/bin/env node
/**
 * 试听一个音色——合成一句话，存成 wav 并告诉你路径。
 *
 *   node scripts/voice-preview.mjs anruorou_v3.1
 *   node scripts/voice-preview.mjs 软糖
 *   node scripts/voice-preview.mjs xuxiaoqiao_v3.1 --text "你还没睡啊，我贴着你说。"
 *
 * 文件落在 data/tmp/preview/（不进上传包、不进记忆）。选好之后在 QQ 里发 /voice <音色>，
 * 或者把 TTS_VOICE 写成它当默认。
 */
import fs from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(import.meta.dirname, '..');
process.loadEnvFile(path.join(ROOT, '.env'));

const args = process.argv.slice(2);
const textFlag = args.indexOf('--text');
const text = textFlag >= 0 ? args.splice(textFlag, 2)[1] : '你还没睡啊……靠过来一点，我贴着你说。';
const wanted = args[0];

if (!wanted) {
    console.log('用法：node scripts/voice-preview.mjs <音色 id 或复刻名字> [--text "..."]');
    process.exit(1);
}

const { loadConfig } = await import('../src/config.js');
const { createTts } = await import('../src/tts.js');
const { wavDurationMs, parseWav } = await import('../src/audio.js');

const config = loadConfig({ ...process.env, TTS_ENABLED: 'true' });
const logger = { info() {}, warn: console.warn, error: console.error, debug() {} };
const tts = createTts({ config, logger });

const voices = tts.listVoices();
const voice = voices.find((v) => v.id === wanted) ?? voices.find((v) => v.name === wanted);
if (!voice) {
    console.log(`没有「${wanted}」这个音色。可用 ${voices.length} 个，例如：`);
    console.log(voices.slice(0, 10).map((v) => `  ${v.cloned ? v.name : v.id}`).join('\n'));
    process.exit(1);
}

const result = await tts.synthesize({ text, voice: voice.id });
const buffer = fs.readFileSync(result.path);
const outDir = path.join(ROOT, 'data', 'tmp', 'preview');
fs.mkdirSync(outDir, { recursive: true });
const safe = String(voice.name || voice.id).replace(/[^\w\u4e00-\u9fa5.-]/g, '_');
const out = path.join(outDir, `${safe}.wav`);
fs.copyFileSync(result.path, out);
tts.release(result.path);
tts.stop();

const wav = parseWav(buffer);
console.log(`${voice.name || voice.id} → ${out}`);
console.log(`${(wavDurationMs(wav) / 1000).toFixed(1)} 秒 / ${(buffer.length / 1024).toFixed(0)}KB / ${wav.sampleRate}Hz`);
console.log(`满意就发 /voice ${voice.cloned ? voice.name : voice.id}`);
