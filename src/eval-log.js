/** 把每一轮对话原样落一份到 data/eval，给评分脚本用。不改动正常流程。 */
import fs from 'node:fs';
import path from 'node:path';

export function createEvalLog({ dir, enabled = false, maxBytes = 8 * 1024 * 1024, logger }) {
    if (!enabled) return { append() {}, enabled: false, file: '' };
    let file = '';
    let size = 0;
    let day = '';

    const open = (at) => {
        const d = new Date(at);
        const stamp = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
        if (stamp === day && file) return file;
        day = stamp;
        fs.mkdirSync(dir, { recursive: true });
        file = path.join(dir, `turns-${stamp}.jsonl`);
        size = fs.existsSync(file) ? fs.statSync(file).size : 0;
        return file;
    };

    return {
        enabled: true,
        get file() { return file; },
        /**
         * @param {{at?:number, scope?:string, user:string, reply:string, voice?:boolean, model?:string,
         *          effort?:string, thinking?:string, persona?:string}} record
         */
        append(record) {
            try {
                const at = record.at ?? Date.now();
                const target = open(at);
                const line = JSON.stringify({
                    at,
                    time: new Date(at).toISOString(),
                    scope: record.scope ?? 'c2c',
                    user: String(record.user ?? '').slice(0, 4000),
                    reply: String(record.reply ?? '').slice(0, 12000),
                    voice: Boolean(record.voice),
                    model: record.model ?? '',
                    effort: record.effort ?? '',
                    thinking: record.thinking ?? '',
                    persona: record.persona ?? '',
                    promptProfile: record.promptProfile ?? '',
                    promptVersion: record.promptVersion ?? '',
                    textMetrics: record.textMetrics ?? null,
                    layoutNormalized: Boolean(record.layoutNormalized),
                    capture: {
                        userTruncated: String(record.user ?? '').length > 4000,
                        replyTruncated: String(record.reply ?? '').length > 12000,
                    },
                });
                if (size + Buffer.byteLength(line) > maxBytes) {
                    logger?.warn?.('评分日志超过上限，这一轮不再写入');
                    return;
                }
                fs.appendFileSync(target, line + '\n', { mode: 0o600 });
                size += Buffer.byteLength(line) + 1;
            } catch (error) {
                logger?.warn?.(`评分日志写入失败：${error?.message || error}`);
            }
        },
    };
}

/** 读回 jsonl，按天或全部。 */
export function readTurns(file) {
    if (!fs.existsSync(file)) return [];
    return fs.readFileSync(file, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => {
            try { return JSON.parse(line); } catch { return null; }
        })
        .filter(Boolean);
}
