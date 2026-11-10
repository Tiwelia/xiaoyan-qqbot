/**
 * 文本工具：分块、清洗、字节估算。
 */

/**
 * 按字符上限切分长文本，尽量在换行 / 句号处断开，避免把一句话劈两半。
 * @param {string} text
 * @param {number} limit 单块最大字符数
 */
export function chunkText(text, limit = 4500) {
    if (!Number.isSafeInteger(limit) || limit <= 0) throw new RangeError('分块长度必须为正整数');
    const s = String(text ?? '');
    if (s.length <= limit) return s === '' ? [] : [s];

    const chunks = [];
    let rest = s;
    const softBreaks = ['\n\n', '\n', '。', '！', '？', '；', '. ', '! ', '? ', '; '];

    while (rest.length > limit) {
        const window = rest.slice(0, limit);
        let cut = -1;
        for (const brk of softBreaks) {
            const idx = window.lastIndexOf(brk);
            if (idx > cut) cut = idx + brk.length;
        }
        if (cut <= 0) cut = limit;
        chunks.push(rest.slice(0, cut).trimEnd());
        rest = rest.slice(cut).trimStart();
    }
    if (rest !== '') chunks.push(rest);
    return chunks.filter((c) => c !== '');
}

/**
 * 粗略估算 token 数（中英混排，够用来做上下文裁剪）。
 */
export function estimateTokens(text) {
    const s = String(text ?? '');
    let cjk = 0;
    for (const ch of s) {
        const code = ch.codePointAt(0);
        if (code >= 0x3000 && code <= 0x9fff) cjk += 1;
    }
    const other = s.length - cjk;
    return Math.ceil(cjk * 1.6 + other / 4);
}

/** 把消息数组压成 token 估算值。 */
export function estimateMessagesTokens(messages) {
    let total = 0;
    for (const m of messages) {
        total += 8;
        if (typeof m.content === 'string') total += estimateTokens(m.content);
        if (Array.isArray(m.content)) {
            for (const part of m.content) {
                if (part?.type === 'text') total += estimateTokens(part.text);
                else total += 800; // 图片按固定值粗算
            }
        }
    }
    return total;
}

/** 去掉 QQ 消息里我们不需要的不可见字符与控制符。 */
export function sanitizeInbound(text) {
    return String(text ?? '')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, '')
        .replace(/\u200b/g, '')
        .trim();
}
