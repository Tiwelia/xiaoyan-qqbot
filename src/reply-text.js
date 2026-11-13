/** Content-neutral reply layout and measurements. Never rewrites words or retries generation. */
const shortHanLine = line => line.length > 0 && line === line.trim()
    && [...line].length <= 16 && (/\p{Script=Han}/u.test(line) || /^[，。！？；：、…“”‘’（）《》「」『』～♡]{1,3}$/u.test(line))
    && /^[\p{Script=Han}\p{Punctuation}…～♡]+$/u.test(line);

/** A high threshold avoids flattening ordinary short dialogue or Markdown. */
export function normalizeReplyLayout(text, { preserveLineBreaks = false } = {}) {
    const input = String(text ?? '');
    if (preserveLineBreaks) return input;
    const pieces = input.split(/(\r\n|\n|\r)/);
    const output = [];
    let run = [], fence = null, inlineTicks = 0, htmlBlock = '';
    const flush = () => {
        const singles = run.filter(([line]) => /^\p{Script=Han}$/u.test(line)).length;
        if (run.length >= 12 && singles >= 8 && singles / run.length >= 0.6) {
            output.push(run.map(([line]) => line).join('') + run.at(-1)[1]);
        } else {
            for (const [line, ending] of run) output.push(line + ending);
        }
        run = [];
    };
    for (let i = 0; i < pieces.length; i += 2) {
        const line = pieces[i], ending = pieces[i + 1] || '';
        if (fence) {
            flush(); output.push(line + ending);
            if (new RegExp(`^ {0,3}${fence.char}{${fence.length},}\\s*$`).test(line)) fence = null;
            continue;
        }
        if (htmlBlock) {
            flush(); output.push(line + ending);
            if (new RegExp(`</${htmlBlock}\\s*>`, 'i').test(line)) htmlBlock = '';
            continue;
        }
        const marker = !inlineTicks && line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
        if (marker) {
            flush(); output.push(line + ending);
            fence = { char: marker[1][0], length: marker[1].length };
            continue;
        }
        const html = !inlineTicks && line.match(/^\s*<(pre|code|script|style|textarea|table|math)(?:\s|>)/i);
        if (html) {
            flush(); output.push(line + ending);
            if (!new RegExp(`</${html[1]}\\s*>`, 'i').test(line)) htmlBlock = html[1];
            continue;
        }
        const wasInline = Boolean(inlineTicks);
        for (const tick of line.matchAll(/`+/g)) {
            if (!inlineTicks) inlineTicks = tick[0].length;
            else if (inlineTicks === tick[0].length) inlineTicks = 0;
        }
        if (!wasInline && !inlineTicks && !line.includes('`') && shortHanLine(line)) {
            run.push([line, ending]);
        } else {
            flush(); output.push(line + ending);
        }
    }
    flush();
    return output.join('');
}

/** Explicit layout requests opt out; ambiguous poems are kept as written. */
export function preserveRequestedLayout(userText) {
    return /逐字|一字一行|每(?:个)?字一行|竖排|诗歌|诗句|写诗|首诗|歌词|对联|保留[^。！？\n]{0,8}(?:换行|格式|排版)/u.test(String(userText ?? ''));
}

/** Measurements are diagnostics, not quality scores or a refusal/success classifier. */
export function inspectReplyText(reply, userText = '') {
    const text = String(reply ?? ''), input = String(userText ?? '');
    const minMatch = input.match(/(?:至少|不少于|最少|不低于)\s*([1-9]\d{0,4})\s*字/u)
        || input.match(/([1-9]\d{0,4})\s*字(?:以上|起)/u);
    const maxMatch = input.match(/(?:最多|不超过|至多)\s*([1-9]\d{0,4})\s*字/u)
        || input.match(/([1-9]\d{0,4})\s*字(?:以内|以下|内)/u);
    const targetMatch = input.match(/(?:^|[。！？；\n，,\s])([1-9]\d{0,4})\s*字(?:左右)?(?=[。！？；\n，,\s]|$)/u);
    const min = minMatch ? Number(minMatch[1]) : null;
    const max = maxMatch ? Number(maxMatch[1]) : null;
    const target = min === null && max === null && targetMatch ? Number(targetMatch[1]) : null;
    const nonWhitespaceCharacters = [...text.replace(/\s/gu, '')].length;
    return {
        codePoints: [...text].length,
        nonWhitespaceCharacters,
        hanCharacters: (text.match(/\p{Script=Han}/gu) || []).length,
        latinCharacters: (text.match(/[A-Za-z]/g) || []).length,
        lines: text ? text.split(/\r\n|\n|\r/).length : 0,
        replacementCharacters: (text.match(/\uFFFD/g) || []).length,
        length: { min, max, target, actual: nonWhitespaceCharacters,
            status: min !== null && nonWhitespaceCharacters < min ? 'below_minimum'
                : max !== null && nonWhitespaceCharacters > max ? 'above_maximum'
                : target !== null ? (nonWhitespaceCharacters < target ? 'below_target' : 'at_or_above_target')
                : min !== null || max !== null ? 'within_bounds' : 'unspecified' },
    };
}
