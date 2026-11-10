#!/usr/bin/env node
/**
 * 用你自己的声音做一个音色（阿里云百炼「声音复刻」）。
 *
 *   node scripts/voice-clone.mjs 我的声音.m4a --name 软糖
 *   node scripts/voice-clone.mjs --list
 *   node scripts/voice-clone.mjs --delete 软糖
 *
 * 生成的是绑定到 target_model 的 voice_id（默认 qwen-audio-3.1-tts-flash），
 * 之后直接 /voice 软糖 就能用。创建音色不收费，合成按正常语音计费。
 *
 * 官方要求：mp3 / m4a / wav（16bit），10~60 秒，≤10MB，采样率 ≥16kHz、单声道或双声道。
 * 本项目统一预处理成 24kHz 单声道（体积小、和线上合成一致）。
 * 其它格式（比如 QQ 的 amr 语音）会先用 ffmpeg 转成 24kHz 单声道 wav 再传。
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

import { parseWav, wavDurationMs } from '../src/audio.js';

const ROOT = path.resolve(import.meta.dirname, '..');
process.loadEnvFile(path.join(ROOT, '.env'));

const config = {
    baseUrl: (process.env.TTS_QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/+$/, ''),
    model: process.env.TTS_QWEN_MODEL || 'qwen-audio-3.1-tts-flash',
    apiKey: process.env.TTS_QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '',
    registry: path.join(ROOT, process.env.DATA_DIR || './data', 'voice', 'cloned.json'),
};

const args = process.argv.slice(2);
const flag = (name) => {
    const i = args.indexOf(name);
    if (i < 0) return undefined;
    const value = args[i + 1];
    args.splice(i, value && !value.startsWith('--') ? 2 : 1);
    return value ?? true;
};

function loadRegistry() {
    try {
        const raw = fs.readFileSync(config.registry, 'utf8');
        const data = JSON.parse(raw);
        return Array.isArray(data) ? data : [];
    } catch {
        return [];
    }
}

function saveRegistry(list) {
    fs.mkdirSync(path.dirname(config.registry), { recursive: true });
    const tmp = `${config.registry}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(list, null, 2)}\n`);
    fs.renameSync(tmp, config.registry);
}

/**
 * 一律在独立临时目录里准备样本：转码、裁剪都只动副本，绝不碰原始录音。
 * 官方输入要求 ≥16kHz、单/双声道、WAV(16bit)/MP3/M4A；24kHz 单声道只是我们自己的预处理目标。
 */
function prepareSample(input) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'voice-'));
    const out = path.join(dir, 'sample.wav');
    try {
        execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', input, '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', out]);
    } catch (error) {
        throw new Error(`转码失败（需要 ffmpeg）：${String(error.message).split('\n')[0]}`);
    }
    return { file: out, dir };
}

async function call(payload) {
    if (!config.apiKey) throw new Error('缺 TTS_QWEN_API_KEY / DASHSCOPE_API_KEY，先在 .env 里填上');
    const res = await fetch(`${config.baseUrl}/services/audio/tts/customization`, {
        method: 'POST',
        headers: { authorization: `Bearer ${config.apiKey}`, 'content-type': 'application/json' },
        body: JSON.stringify(payload),
    });
    const text = await res.text();
    let json;
    try {
        json = JSON.parse(text);
    } catch {
        throw new Error(`接口返回不是 JSON：${text.slice(0, 200)}`);
    }
    if (!res.ok) throw new Error(`${res.status} ${json.code || ''} ${json.message || text.slice(0, 200)}`);
    return json;
}

async function enroll(file, name, { dry = false } = {}) {
    const stat = fs.statSync(file);
    if (stat.size > 10 * 1024 * 1024) throw new Error(`文件 ${(stat.size / 1024 / 1024).toFixed(1)}MB，超过 10MB 上限`);
    const { file: wavFile, dir } = prepareSample(file);
    try {
        let buf = fs.readFileSync(wavFile);
        let info = parseWav(buf);
        let seconds = wavDurationMs(info) / 1000;

        // 官方要求：10 秒～60 秒、≤10MB、≥16kHz、单/双声道；我们预处理成 24kHz 单声道
        if (seconds > 60) {
            const trimmed = path.join(path.dirname(wavFile), 'trimmed.wav');
            execFileSync('ffmpeg', ['-v', 'error', '-y', '-i', wavFile, '-t', '60', '-ac', '1', '-ar', '24000', '-c:a', 'pcm_s16le', trimmed]);
            fs.copyFileSync(trimmed, wavFile);
            buf = fs.readFileSync(wavFile);
            info = parseWav(buf);
            seconds = wavDurationMs(info) / 1000;
            console.log('样本超过 60 秒，已自动截到前 60 秒');
        }
        if (seconds < 10) throw new Error(`样本只有 ${seconds.toFixed(1)} 秒，至少要 10 秒`);
        if (info.sampleRate < 16000) console.warn(`注意：采样率 ${info.sampleRate}Hz 低于官方要求的 16kHz`);
        
        if (buf.length > 7.5 * 1024 * 1024) throw new Error(`音频 ${(buf.length / 1024 / 1024).toFixed(1)}MB，base64 后会超过 10MB 上限`);

        if (dry) {
            console.log(`预处理完成（未上传）：${seconds.toFixed(1)} 秒 / ${(buf.length / 1024).toFixed(0)}KB / ${info.sampleRate}Hz / ${info.channels} 声道`);
            console.log(`原始文件保持不动：${file}`);
            return null;
        }
        const prefix = (name || 'voice').replace(/[^a-zA-Z0-9]/g, '').slice(0, 10) || 'voice';
        console.log(`上传样本：${seconds.toFixed(1)} 秒 / ${(buf.length / 1024).toFixed(0)}KB → ${config.model}`);
        const json = await call({
            model: 'voice-enrollment',
            input: {
                action: 'create_voice',
                target_model: config.model,
                prefix,
                audio: 'data:audio/wav;base64,' + buf.toString('base64'),
                language_hints: ['zh'],
                enable_volume_normalization: 'false',
            },
        });
        const voiceId = json?.output?.voice_id;
        if (!voiceId) throw new Error(`没拿到 voice_id：${JSON.stringify(json).slice(0, 200)}`);

        const list = loadRegistry().filter((v) => v.name !== name);
        list.push({ name: name || prefix, voiceId, model: config.model, seconds: Number(seconds.toFixed(1)), createdAt: new Date().toISOString() });
        saveRegistry(list);
        console.log(`\n搞定：${name || prefix} → ${voiceId}`);
        console.log('在 QQ 里发：/voice ' + (name || prefix));
        return voiceId;
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
}

const dry = flag('--dry');
const list = flag('--list');
const del = flag('--delete');
const name = flag('--name');
const model = flag('--model');
if (model) config.model = model;
const file = args[0];

if (list) {
    const items = loadRegistry();
    if (items.length === 0) {
        console.log('还没有复刻音色。用法：node scripts/voice-clone.mjs 我的声音.m4a --name 软糖');
    } else {
        console.log(`已复刻 ${items.length} 个音色（${config.registry}）：`);
        for (const v of items) console.log(`  ${v.name.padEnd(10)} ${v.voiceId}  ${v.model}  ${v.seconds ?? '?'}s  ${v.createdAt?.slice(0, 10)}`);
    }
} else if (del) {
    const list2 = loadRegistry();
    const target = list2.find((v) => v.name === del);
    if (!target) throw new Error(`没有叫「${del}」的音色`);
    await call({ model: 'voice-enrollment', input: { action: 'delete_voice', voice_id: target.voiceId } });
    saveRegistry(list2.filter((v) => v.name !== del));
    console.log(`已删除：${del}（${target.voiceId}）`);
} else if (file) {
    if (!fs.existsSync(file)) throw new Error(`找不到文件：${file}`);
    await enroll(file, name === true ? undefined : name, { dry: Boolean(dry) });
} else {
    console.log('用法：');
    console.log('  node scripts/voice-clone.mjs <音频文件> [--name 名字] [--model qwen-audio-3.1-tts-flash] [--dry]');
    console.log('  node scripts/voice-clone.mjs --list');
    console.log('  node scripts/voice-clone.mjs --delete 名字');
}

