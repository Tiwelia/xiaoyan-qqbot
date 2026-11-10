/**
 * 场景音频生成 —— 阿里云百炼 `qwen-audio-3.1-tts-next`。
 *
 * 和语音合成不一样：它吃的是一整段「场景描述」——台词、语气、背景音、音效
 * 写在同一段提示词里，一次出一整条带着雨声/呼吸/床单摩擦的场景音频。
 * 这对 ASMR 是刚需：光有人声没人味。
 *
 * 实测（2026-11）：
 *   - 单次上限 120 秒（播客场景 240 秒），输出固定 2 声道 24kHz wav；
 *   - 生成耗时 ≈ 音频时长 × 1.3（60 秒音频约 84 秒出）；
 *   - 输入内容不过滤，露骨台词照出。
 *
 * 我们这边统一降到单声道再投递：省一半体积，也方便和 TTS 拼在一起。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { downmixToMono, fitWavUnder, parseWav, wavDurationMs } from './audio.js';

/** 读响应体，带字节上限（防止异常大的响应把内存吃掉）。 */
async function readLimited(res, maxBytes, signal) {
    if (!res.body) return Buffer.alloc(0);
    const reader = res.body.getReader();
    const chunks = [];
    let total = 0;
    try {
        for (;;) {
            signal?.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            total += value.byteLength;
            if (total > maxBytes) throw new Error(`响应超过 ${(maxBytes / 1024 / 1024).toFixed(0)} MB 上限`);
            chunks.push(value);
        }
    } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
    }
    return Buffer.concat(chunks);
}

/**
 * @param {object} opts
 * @param {object} opts.config loadConfig() 的结果
 * @param {object} opts.logger
 */
export function createSceneGenerator({ config, logger }) {
    const cfg = config.scene;
    const apiKey = cfg.apiKey || config.tts.qwenApiKey || config.tts.apiKey;
    const ready = Boolean(cfg.enabled && apiKey);

    /**
     * 生成一段场景音频。
     *
     * @returns {Promise<{path:string, bytes:number, durationMs:number, sampleRate:number}>}
     */
    async function generate({ prompt, signal }) {
        if (!ready) throw new Error('场景音频没开（SCENE_ENABLED=true 且需要百炼 key）');
        const text = String(prompt ?? '').trim();
        if (text === '') throw new Error('场景描述是空的');
        if (text.length > cfg.maxPromptChars) {
            throw new Error(`场景描述 ${text.length} 字，超过 ${cfg.maxPromptChars} 字上限`);
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('场景音频生成超时')), cfg.timeoutMs);
        const combined = signal
            ? AbortSignal.any([controller.signal, signal])
            : controller.signal;
        const started = Date.now();
        try {
            const res = await fetch(`${cfg.baseUrl}/services/audio/tts/SpeechSynthesizer`, {
                method: 'POST',
                headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
                body: JSON.stringify({
                    model: cfg.model,
                    input: { text_prompt: text, format: 'wav', sample_rate: cfg.sampleRate },
                }),
                signal: combined,
            });
            if (!res.ok) {
                const detail = (await readLimited(res, 4096, combined).catch(() => Buffer.alloc(0))).toString('utf8');
                throw new Error(`场景音频 HTTP ${res.status}：${detail.slice(0, 200)}`);
            }
            const json = JSON.parse((await readLimited(res, 1024 * 1024, combined)).toString('utf8'));
            const url = json?.output?.audio?.url;
            if (!url) throw new Error('场景音频没返回音频地址');

            const audioRes = await fetch(url, { signal: combined });
            if (!audioRes.ok) throw new Error(`场景音频下载失败 HTTP ${audioRes.status}`);
            const raw = await readLimited(audioRes, cfg.maxBytes, combined);

            // 统一成单声道 24kHz，并按 QQ 语音条软上限压一下
            let buffer = downmixToMono(raw);
            const format = parseWav(buffer);
            if (format.sampleRate > cfg.sampleRate) {
                buffer = fitWavUnder(buffer, cfg.voiceSoftLimitBytes, { logger }).buffer;
            }
            if (buffer.length > cfg.voiceSoftLimitBytes) {
                buffer = fitWavUnder(buffer, cfg.voiceSoftLimitBytes, { logger }).buffer;
            }

            fs.mkdirSync(cfg.tmpDir, { recursive: true });
            const file = path.join(cfg.tmpDir, `scene-${randomUUID()}.wav`);
            fs.writeFileSync(file, buffer, { flag: 'wx' });
            const parsed = parseWav(buffer);
            const durationMs = wavDurationMs(parsed);
            logger?.info(
                `场景音频生成完成：${(durationMs / 1000).toFixed(1)} 秒 / ${(buffer.length / 1024 / 1024).toFixed(2)} MB / ` +
                    `${parsed.sampleRate}Hz 单声道 / 耗时 ${((Date.now() - started) / 1000).toFixed(1)} 秒`,
            );
            return { path: file, bytes: buffer.length, durationMs, sampleRate: parsed.sampleRate };
        } finally {
            clearTimeout(timer);
        }
    }

    return {
        enabled: ready,
        model: cfg.model,
        maxSeconds: cfg.maxSeconds,
        generate,
        remove(file) {
            try { fs.unlinkSync(file); return true; } catch { return false; }
        },
    };
}
