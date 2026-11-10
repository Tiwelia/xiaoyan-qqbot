/**
 * WAV 拼接 —— 长语音的地基。
 *
 * 语音引擎一次只肯合成几百字（单次请求延迟随字数线性涨），所以长音频只能
 * 拆段合成再拼回去。WAV 是 PCM 裸数据加一个 44 字节头，拼接不需要解码：
 * 校验格式一致 → 去掉各段的头 → 中间可选插静音 → 重写一个头。
 *
 * 全程零依赖，纯 Buffer 操作。
 */

/** 在 Buffer 里找一个 chunk 的起始位置（从 offset 起）。 */
function findChunk(buf, tag, from = 12) {
    let offset = from;
    while (offset + 8 <= buf.length) {
        const id = buf.toString('ascii', offset, offset + 4);
        const size = buf.readUInt32LE(offset + 4);
        if (id === tag) return { id, size, dataStart: offset + 8, dataEnd: offset + 8 + size };
        offset += 8 + size + (size % 2); // chunk 按偶数字节对齐
    }
    return null;
}

/**
 * 解析一段 WAV 的头，取出 PCM 数据和格式。
 * @param {Buffer} buf
 * @returns {{sampleRate:number, channels:number, bitsPerSample:number, audioFormat:number, data:Buffer}}
 */
export function parseWav(buf) {
    if (!Buffer.isBuffer(buf) || buf.length < 44) throw new Error('WAV 太短，解析不了');
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('不是 RIFF/WAVE 格式');
    }
    const fmt = findChunk(buf, 'fmt ');
    if (!fmt || fmt.size < 16 || fmt.dataEnd > buf.length) throw new Error('WAV 缺少或截断了 fmt 块');
    const audioFormat = buf.readUInt16LE(fmt.dataStart);
    const channels = buf.readUInt16LE(fmt.dataStart + 2);
    const sampleRate = buf.readUInt32LE(fmt.dataStart + 4);
    const bitsPerSample = buf.readUInt16LE(fmt.dataStart + 14);
    if (!channels || !sampleRate || ![8, 16, 24, 32, 64].includes(bitsPerSample)) throw new Error('WAV 的声道、采样率或位深无效');
    const data = findChunk(buf, 'data');
    if (!data) throw new Error('WAV 缺少 data 块');
    // 有些引擎写的 data 长度是 0xFFFFFFFF 或超出实际长度，按实际剩余字节兜底
    const end = Math.min(data.dataEnd, buf.length);
    return {
        audioFormat,
        channels,
        sampleRate,
        bitsPerSample,
        data: buf.subarray(data.dataStart, end),
    };
}

/**
 * 重采样（16bit PCM，线性插值）。
 *
 * 只为一个目的：QQ 语音条的软上限是 20MB，而 24kHz 单声道 wav 每秒吃 48KB，
 * 也就是 7 分钟就顶到 20MB。降到 16kHz（32KB/s）能撑 10 分钟，8kHz 能撑 20 分钟。
 * 语音条最终会被平台转成 silk，采样率降一档听感损失很小。
 */
export function resampleWav(buffer, targetRate) {
    const wav = parseWav(buffer);
    if (wav.sampleRate === targetRate) return buffer;
    const { channels, bitsPerSample, sampleRate } = wav;
    if (bitsPerSample !== 16 || wav.audioFormat !== 1) throw new Error(`只支持 16bit PCM 重采样（当前 ${bitsPerSample}bit）`);
    if (!Number.isSafeInteger(targetRate) || targetRate <= 0) throw new Error('目标采样率必须为正整数');
    const bytesPerFrame = channels * 2;
    const inFrames = Math.floor(wav.data.length / bytesPerFrame);
    if (inFrames === 0) return buffer;
    const outFrames = Math.max(1, Math.round((inFrames * targetRate) / sampleRate));
    const out = Buffer.alloc(outFrames * bytesPerFrame);
    const ratio = sampleRate / targetRate;
    for (let i = 0; i < outFrames; i += 1) {
        const srcPos = i * ratio;
        const i0 = Math.floor(srcPos);
        const i1 = Math.min(i0 + 1, inFrames - 1);
        const t = srcPos - i0;
        const base0 = i0 * bytesPerFrame;
        const base1 = i1 * bytesPerFrame;
        for (let ch = 0; ch < channels; ch += 1) {
            const s0 = wav.data.readInt16LE(base0 + ch * 2);
            const s1 = wav.data.readInt16LE(base1 + ch * 2);
            const value = Math.max(-32768, Math.min(32767, Math.round(s0 + (s1 - s0) * t)));
            out.writeInt16LE(value, i * bytesPerFrame + ch * 2);
        }
    }
    const header = buildWavHeader(out.length, { sampleRate: targetRate, channels, bitsPerSample });
    return Buffer.concat([header, out], header.length + out.length);
}

/**
 * 把音频压到指定体积以内：优先保持原采样率，超了就逐档降采样。
 *
 * @param {Buffer} buffer
 * @param {number} maxBytes
 * @param {{rates?: number[], logger?: object}} [opts]
 */
export function fitWavUnder(buffer, maxBytes, { rates = [24000, 16000, 12000, 8000], logger } = {}) {
    if (buffer.length <= maxBytes) {
        return { buffer, sampleRate: parseWav(buffer).sampleRate, downgraded: false };
    }
    const current = parseWav(buffer).sampleRate;
    const ladder = rates.filter((r) => r <= current);
    for (const rate of ladder) {
        const candidate = resampleWav(buffer, rate);
        logger?.info?.(`语音降采样到 ${rate}Hz：${(buffer.length / 1024 / 1024).toFixed(1)}MB → ${(candidate.length / 1024 / 1024).toFixed(1)}MB`);
        if (candidate.length <= maxBytes) return { buffer: candidate, sampleRate: rate, downgraded: true };
    }
    const lowest = ladder[ladder.length - 1] ?? current;
    return { buffer: resampleWav(buffer, lowest), sampleRate: lowest, downgraded: true };
}

/**
 * 把一段音频按体积切成几段（按帧对齐，不会切坏采样）。
 *
 * 用途：QQ 语音条软上限 20MB，10 分钟 24kHz 的 wav 有 28MB，与其降采样把
 * 音质搞糊，不如切成两条语音条——额度够用（单聊一条消息能回 4 次）。
 */
export function splitWav(buffer, maxBytes) {
    const wav = parseWav(buffer);
    const bytesPerFrame = (wav.channels * wav.bitsPerSample) / 8;
    const totalFrames = Math.floor(wav.data.length / bytesPerFrame);
    const totalBytes = totalFrames * bytesPerFrame;
    if (buffer.length <= maxBytes) return [buffer];
    const payloadLimit = Math.floor((maxBytes - 44) / bytesPerFrame) * bytesPerFrame;
    if (payloadLimit < bytesPerFrame) throw new Error('语音分段字节上限过小');

    // 平均切：贪心填满会让最后一条只剩几十秒，听感很怪
    const partsCount = Math.ceil(totalBytes / payloadLimit);
    const framesPerPart = Math.ceil(totalFrames / partsCount);

    const parts = [];
    for (let start = 0; start < totalFrames; start += framesPerPart) {
        const frames = Math.min(framesPerPart, totalFrames - start);
        const data = wav.data.subarray(start * bytesPerFrame, (start + frames) * bytesPerFrame);
        const header = buildWavHeader(data.length, wav);
        parts.push(Buffer.concat([header, data], header.length + data.length));
    }
    return parts;
}

/**
 * 立体声降成单声道（16bit PCM）。
 *
 * 音频生成模型固定输出 2 声道，我们自己的 TTS 是单声道；拼在一起之前得先统一，
 * 否则 concatWav 会直接拒（格式不一致），而且立体声白占一半体积。
 */
export function downmixToMono(buffer) {
    const wav = parseWav(buffer);
    if (wav.channels === 1) return buffer;
    if (wav.bitsPerSample !== 16 || wav.audioFormat !== 1) throw new Error(`只支持 16bit PCM 降混（当前 ${wav.bitsPerSample}bit）`);
    const frames = Math.floor(wav.data.length / (wav.channels * 2));
    const out = Buffer.alloc(frames * 2);
    for (let i = 0; i < frames; i += 1) {
        let sum = 0;
        for (let ch = 0; ch < wav.channels; ch += 1) {
            sum += wav.data.readInt16LE((i * wav.channels + ch) * 2);
        }
        const value = Math.max(-32768, Math.min(32767, Math.round(sum / wav.channels)));
        out.writeInt16LE(value, i * 2);
    }
    const header = buildWavHeader(out.length, { sampleRate: wav.sampleRate, channels: 1, bitsPerSample: 16 });
    return Buffer.concat([header, out], header.length + out.length);
}

/** 一段音频的时长（毫秒）。 */
export function wavDurationMs({ data, sampleRate, channels, bitsPerSample }) {
    const bytesPerFrame = (channels * bitsPerSample) / 8;
    if (!bytesPerFrame || !sampleRate) return 0;
    return Math.round((data.length / bytesPerFrame / sampleRate) * 1000);
}

/** 造一段静音 PCM。 */
export function buildSilence(ms, { sampleRate, channels, bitsPerSample }) {
    const frames = Math.max(0, Math.round((ms / 1000) * sampleRate));
    return Buffer.alloc(frames * ((channels * bitsPerSample) / 8));
}

/** 按格式造一个标准 44 字节头。 */
export function buildWavHeader(dataLength, { sampleRate, channels, bitsPerSample, audioFormat = 1 }) {
    const byteRate = (sampleRate * channels * bitsPerSample) / 8;
    const header = Buffer.alloc(44);
    header.write('RIFF', 0, 'ascii');
    header.writeUInt32LE(36 + dataLength, 4);
    header.write('WAVE', 8, 'ascii');
    header.write('fmt ', 12, 'ascii');
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(audioFormat, 20);
    header.writeUInt16LE(channels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE((channels * bitsPerSample) / 8, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36, 'ascii');
    header.writeUInt32LE(dataLength, 40);
    return header;
}

/**
 * 把多段 WAV 拼成一个。
 *
 * @param {Buffer[]} buffers
 * @param {{gapMs?: number, logger?: object}} [opts] gapMs = 段与段之间留多少静音
 * @returns {{buffer: Buffer, durationMs: number, bytes: number, segments: number, format: object}}
 */
export function concatWav(buffers, { gapMs = 0, logger } = {}) {
    const list = (buffers ?? []).filter((b) => Buffer.isBuffer(b) && b.length > 0);
    if (list.length === 0) throw new Error('没有可拼接的音频');

    const parsed = list.map((buf) => parseWav(buf));
    const format = parsed[0];
    for (const [i, p] of parsed.entries()) {
        if (p.audioFormat !== format.audioFormat || p.sampleRate !== format.sampleRate || p.channels !== format.channels || p.bitsPerSample !== format.bitsPerSample) {
            throw new Error(`第 ${i + 1} 段音频格式不一致（${p.sampleRate}Hz/${p.channels}ch/${p.bitsPerSample}bit）`);
        }
    }

    const silence = gapMs > 0 ? buildSilence(gapMs, format) : Buffer.alloc(0);
    const parts = [];
    let total = 0;
    for (const [i, p] of parsed.entries()) {
        if (i > 0 && silence.length > 0) {
            parts.push(silence);
            total += silence.length;
        }
        parts.push(p.data);
        total += p.data.length;
    }
    const body = Buffer.concat(parts, total);
    const header = buildWavHeader(body.length, format);
    const buffer = Buffer.concat([header, body], header.length + body.length);
    // 注意顺序：body 必须放在后面，别让 ...format 里的旧 data 覆盖掉拼好的数据
    const durationMs = wavDurationMs({ ...format, data: body });
    logger?.debug?.(`WAV 拼接：${parsed.length} 段 → ${(buffer.length / 1024 / 1024).toFixed(2)} MB / ${(durationMs / 1000).toFixed(1)} 秒`);
    return { buffer, durationMs, bytes: buffer.length, segments: parsed.length, format };
}
