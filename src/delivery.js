/** All messages replying to one inbound message share the QQ passive-send budget. */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { concatWav, fitWavUnder, splitWav } from './audio.js';

/**
 * 发一条长音频。
 *
 * 按 QQ 语音条软上限（20MB）切成几条，条数受本轮剩余被动额度约束；
 * 额度装不下就先降采样再切；语音条整条失败才退回文件消息。
 *
 * @returns {Promise<number>} Successfully delivered voice/file messages.
 */
export async function sendLongAudio({ bot, msg, result, config, logger, signal, slots, media }) {
    signal?.throwIfAborted();
    const limit = config.tts.voiceSoftLimitBytes || 18 * 1024 * 1024;
    const maxParts = Math.min(slots ?? 3, 3);
    if (maxParts <= 0) throw new Error('本轮 QQ 被动回复额度已用完');
    const written = [];
    let sent = 0;
    const write = buffer => {
        media?.reserve(buffer.length);
        const file = path.join(config.tts.tmpDir, `voice-${randomUUID()}.wav`);
        fs.mkdirSync(config.tts.tmpDir, { recursive: true });
        fs.writeFileSync(file, buffer, { flag: 'wx' });
        written.push(file);
        return file;
    };
    try {
        let fallbackPath = result.path;
        if (config.tts.longDelivery !== 'file') {
            const raw = fs.readFileSync(result.path);
            let parts = splitWav(raw, limit);
            if (parts.length > maxParts) {
                const fitted = fitWavUnder(raw, Math.max(44, Math.floor(limit * maxParts) - 1024), { logger });
                parts = splitWav(fitted.buffer, limit);
            }
            if (parts.length > maxParts && config.tts.longDelivery === 'voice') throw new Error('音频无法在本轮剩余额度内完整发送');
            if (parts.length <= maxParts) {
                try {
                    for (const part of parts) {
                        signal?.throwIfAborted();
                        const partPath = write(part);
                        await bot.sendVoice(msg.replyTarget, { localPath: partPath });
                        sent++;
                    }
                    logger?.info(`长语音按语音条发出：${sent} 条`);
                    return sent;
                } catch (error) {
                    signal?.throwIfAborted();
                    if (config.tts.longDelivery === 'voice') throw error;
                    logger?.warn(`长语音条发送失败，剩余音频改用文件：${error?.message || error}`);
                    // Successful bubbles must not be replayed in a whole-file fallback.
                    if (sent > 0) fallbackPath = write(concatWav(parts.slice(sent)).buffer);
                }
            }
        }
        signal?.throwIfAborted();
        await bot.sendFile(msg.replyTarget, { localPath: fallbackPath }, {
            fileName: `xiaoyan-${Math.round(result.durationMs / 1000)}s.wav`,
        });
        logger?.info('长语音按文件发出');
        return sent + 1;
    } catch (error) {
        if (error && typeof error === 'object') error.sentCount = sent;
        throw error;
    } finally {
        for (const file of written) { try { fs.unlinkSync(file); } catch { /* already removed */ } }
    }
}

export function createDeliveryBudget(bot, { isGroup = false, signal } = {}) {
    const maximum = isGroup ? 5 : 4;
    let used = 0;
    const spend = () => {
        signal?.throwIfAborted();
        if (used >= maximum) throw new Error('本轮 QQ 被动回复额度已用完');
        used += 1; // Failed/uncertain requests are conservatively counted too.
    };
    const methods = new Map();
    const wrapped = new Proxy(bot, {
        get(target, key) {
            if (methods.has(key)) return methods.get(key);
            const value = Reflect.get(target, key, target);
            if (typeof value !== 'function') return value;
            let fn;
            if (['sendText', 'sendVoice', 'sendFile', 'sendImage', 'sendTyping'].includes(key)) {
                fn = async (...args) => {
                    spend();
                    // The SDK's convenience method uploads AND sends. Split those steps so
                    // cancellation during an upload cannot start a new message afterwards.
                    const fileType = { sendImage: 1, sendVoice: 3, sendFile: 4 }[key];
                    if (fileType && typeof target.uploadMedia === 'function' && typeof target.send === 'function') {
                        const [replyTarget, source, options = {}] = args;
                        const upload = await target.uploadMedia({
                            target: replyTarget, fileType, ...source, srvSendMsg: false,
                            ...(key === 'sendFile' ? { fileName: options.fileName } : {}),
                            onProgress: options.onProgress,
                        });
                        signal?.throwIfAborted();
                        const message = await target.send({
                            target: replyTarget, msgType: 7, media: { file_info: upload.file_info },
                            ...(options.content ? { content: options.content } : {}),
                        });
                        return { upload, message };
                    }
                    return value.apply(target, args);
                };
            } else if (key === 'openStream') {
                fn = (...args) => {
                    signal?.throwIfAborted();
                    const stream = value.apply(target, args);
                    let counted = false;
                    const onAbort = () => stream.cancel();
                    signal?.addEventListener('abort', onAbort, { once: true });
                    return new Proxy(stream, {
                        get(s, k) {
                            const method = Reflect.get(s, k, s);
                            if (typeof method !== 'function') return method;
                            if (k === 'cancel') return (...params) => {
                                signal?.removeEventListener('abort', onAbort);
                                return method.apply(s, params);
                            };
                            if (!['update', 'complete'].includes(k)) return method.bind(s);
                            return async (...params) => {
                                signal?.throwIfAborted();
                                if (!counted) { spend(); counted = true; }
                                try { return await method.apply(s, params); }
                                finally { if (k === 'complete') signal?.removeEventListener('abort', onAbort); }
                            };
                        },
                    });
                };
            } else fn = value.bind(target);
            methods.set(key, fn);
            return fn;
        },
    });
    return { bot: wrapped, get remaining() { return maximum - used; }, get used() { return used; } };
}

