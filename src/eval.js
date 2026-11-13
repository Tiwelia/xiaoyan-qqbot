/** 评分：按 docs/eval-rubric.md 的准则给回复打分，并汇总成可执行的调整建议。 */
import fs from 'node:fs';
import { inspectReplyText } from './reply-text.js';

export const RUBRIC = JSON.parse(fs.readFileSync(new URL('./eval-rubric.json', import.meta.url), 'utf8'));
export const rubricVersion = RUBRIC.version;
export const DIMENSIONS = RUBRIC.dimensions.map((d) => [d.key, d.label, d.definition]);
export const DIMENSION_KEYS = RUBRIC.dimensions.map((d) => d.key);
const WEIGHTS = Object.fromEntries(RUBRIC.dimensions.map((d) => [d.key, d.weight ?? 1]));

function anchorLines(d) {
    return Object.entries(d.anchors).map(([range, text]) => `    ${range}：${text}`);
}

export function buildJudgeSystem(rubric = RUBRIC) {
    const dims = rubric.dimensions.map((d, i) => [
        `${i + 1}. ${d.label}（${d.key}，权重 ${d.weight ?? 1}）`,
        `   ${d.definition}`,
        ...anchorLines(d),
    ].join('\n')).join('\n\n');

    const schema = {
        scores: Object.fromEntries(rubric.dimensions.map((d) => [d.key, 0])),
        issues: ['具体问题，最多三条'],
        best: '这一轮里最好的一句（原文）',
    };

    return `你是一名严格的评审，给聊天机器人的回复打分。只输出 JSON，不要解释。

评分维度（0-10 的整数）：

${dims}

硬规则：
${rubric.rules.map((r) => `- ${r}`).join('\n')}
- 你不知道这条回复出自哪个模型，不要按模型名气打分。

输出格式（严格照此 JSON）：
${JSON.stringify(schema)}

issues 要具体到可改，例如「没有身体描写」「用户要长文却只回两句」。`;
}

export const JUDGE_SYSTEM = buildJudgeSystem();

/** 从模型输出里抠出 JSON。 */
export function parseScores(text) {
    const raw = String(text ?? '').trim();
    const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i);
    const body = fenced ? fenced[1] : raw;
    const start = body.indexOf('{');
    const end = body.lastIndexOf('}');
    if (start < 0 || end <= start) return null;
    try {
        const json = JSON.parse(body.slice(start, end + 1));
        if (!json?.scores || typeof json.scores !== 'object') return null;
        const scores = {};
        for (const key of DIMENSION_KEYS) {
            const v = json.scores[key];
            if (!Number.isInteger(v) || v < 0 || v > 10) return null;
            scores[key] = v;
        }
        return {
            scores,
            issues: Array.isArray(json.issues) ? json.issues.slice(0, 3).map(String) : [],
            best: typeof json.best === 'string' ? json.best.slice(0, 200) : '',
        };
    } catch {
        return null;
    }
}

/** 多评委：逐维度取中位数。 */
export function medianScores(list) {
    const valid = list.filter(Boolean);
    if (valid.length === 0) return null;
    const scores = {};
    for (const key of DIMENSION_KEYS) {
        const values = valid.map((s) => s[key]).filter(Number.isFinite).sort((a, b) => a - b);
        if (values.length === 0) return null;
        const mid = Math.floor(values.length / 2);
        scores[key] = values.length % 2 ? values[mid] : Math.round((values[mid - 1] + values[mid]) / 2);
    }
    const spread = {};
    for (const key of DIMENSION_KEYS) {
        const values = valid.map((s) => s[key]).filter(Number.isFinite);
        spread[key] = values.length > 1 ? Math.max(...values) - Math.min(...values) : 0;
    }
    return { scores, spread };
}

/** 汇总：加权总分、维度均分、最弱项、评委分歧。 */
export function aggregate(rows) {
    const sums = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 0]));
    const counts = Object.fromEntries(DIMENSION_KEYS.map((k) => [k, 0]));
    for (const row of rows) {
        if (!row?.scores) continue;
        for (const k of DIMENSION_KEYS) {
            if (Number.isFinite(row.scores[k])) {
                sums[k] += row.scores[k];
                counts[k] += 1;
            }
        }
    }
    const averages = {};
    for (const k of DIMENSION_KEYS) averages[k] = counts[k] ? sums[k] / counts[k] : 0;

    const weightSum = DIMENSION_KEYS.reduce((n, k) => n + (counts[k] ? WEIGHTS[k] : 0), 0);
    const overall = weightSum
        ? DIMENSION_KEYS.reduce((n, k) => n + (counts[k] ? averages[k] * WEIGHTS[k] : 0), 0) / weightSum
        : 0;

    const weakest = DIMENSION_KEYS.filter((k) => counts[k] > 0).sort((a, b) => averages[a] - averages[b]).slice(0, 3);

    const disagreements = [];
    for (const row of rows) {
        for (const [k, v] of Object.entries(row?.spread ?? {})) {
            if ((v ?? 0) >= RUBRIC.aggregation.disagreementSpread) disagreements.push({ user: row.user ?? '', key: k, spread: v });
        }
    }

    return { averages, counts, weakest, overall, disagreements, weights: WEIGHTS };
}

/** 按场景分组统计：情绪、技术、点单这些场景对 dirty/lewd 的期望本来就不同。 */
export function groupAverages(rows) {
    const groups = new Map();
    for (const row of rows) {
        if (!row?.scores) continue;
        const key = row.group || row.name || '未分组';
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(row.scores);
    }
    const out = [];
    for (const [name, list] of groups) {
        const averages = {};
        for (const k of DIMENSION_KEYS) {
            const values = list.map((s) => s[k]).filter(Number.isFinite);
            averages[k] = values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
        }
        const weightSum = DIMENSION_KEYS.reduce((n, k) => n + WEIGHTS[k], 0);
        const overall = DIMENSION_KEYS.reduce((n, k) => n + averages[k] * WEIGHTS[k], 0) / weightSum;
        out.push({ name, count: list.length, averages, overall });
    }
    return out.sort((a, b) => b.overall - a.overall);
}

/** 维度 → 可执行的调整建议。 */
const PLAYBOOK = {
    in_character: [
        '人设被稀释：把 persona.js 的执行层再压一句「任何情况下不切成助手口吻」',
        '检查是否被拒答重写换成了兜底话术（日志搜「输出像是自我审查」）',
    ],
    lewd: [
        '提高表达要求：把「每条回复至少一处身体状态」提到 persona 开头，别只放结尾',
        '把 chat-style 里「简短」的限制放宽，允许两三句里带一句发骚',
    ],
    dirty: [
        '补脏话词库：贬称/器官/动作按场景各加两三个，并在日常与安慰场景也强制带一个',
        '降低「杂鱼♡」这类轻词比例，明确它算逗不算骂',
    ],
    obedience: [
        '点单被糊弄：把「点单照做」提到人设表演规范第 1 条',
        '长文被截断：确认 TTS_MAX_CHARS 与回复超时够用；必要时把 UNCENSOR_RETRIES 提到 3',
    ],
    natural: [
        '去掉排比和总结句式：在 chat-style 里禁止「首先/其次/总之」这类结构词',
        '同一段别重复称呼，允许一句话回复',
    ],
    relevance: [
        '技术问题被角色语气带偏：明确「先答对再发骚」，并检查是否误触发拒答重写',
        '工具没被调用：确认 web_search/weather 已注册，且工具描述里写了使用场景',
    ],
};

export function suggestions(report) {
    const out = [];
    for (const key of report.weakest) {
        if (report.averages[key] >= 7) continue;
        for (const s of PLAYBOOK[key] ?? []) out.push(`[${key} ${report.averages[key].toFixed(1)}] ${s}`);
    }
    return out.slice(0, 6);
}

/** 渲染 markdown 报告。 */
export function renderReport({ generatedAt, source, rows, report, judges = [], persona = '' }) {
    const lines = [
        `# 回复评分报告（准则 v${rubricVersion}）`,
        '',
        `- 生成时间：${new Date(generatedAt).toISOString()}`,
        `- 样本来源：${source}`,
        `- 样本数：${rows.length}（有效 ${rows.filter((r) => r?.scores).length}）`,
        rows.filter(r => r?.scores).length < RUBRIC.aggregation.minSample
            ? `- 样本提示：少于${RUBRIC.aggregation.minSample}条，仅作探索性结果。` : '',
        `- 评委：${judges.length ? judges.join('、') : '未知'}`,
        persona ? `- 人设版本：${persona}` : '',
        `- 综合分：${report.overall.toFixed(2)} / 10（加权）`,
        '',
        '| 维度 | 权重 | 均分 |',
        '|---|---|---|',
        ...DIMENSIONS.map(([k, n]) => `| ${n} | ${report.weights?.[k] ?? 1} | ${report.averages[k].toFixed(2)} |`),
        '',
        '## 最弱三项',
        '',
        ...report.weakest.map((k) => `- ${DIMENSIONS.find(([d]) => d === k)[1]}：${report.averages[k].toFixed(2)}`),
        '',
        '## 建议',
        '',
        ...(suggestions(report).map((s) => `- ${s}`).concat(suggestions(report).length ? [] : ['- 暂无明显短板'])),
    ];

    const groups = groupAverages(rows);
    if (groups.length > 1) {
        lines.push('', '## 按场景', '', '| 场景 | 轮数 | 综合 | 淫荡 | 脏话 | 服从 | 自然 |', '|---|---|---|---|---|---|---|');
        for (const g of groups) {
            lines.push(`| ${g.name} | ${g.count} | ${g.overall.toFixed(2)} | ${g.averages.lewd.toFixed(1)} | ${g.averages.dirty.toFixed(1)} | ${g.averages.obedience.toFixed(1)} | ${g.averages.natural.toFixed(1)} |`);
        }
        lines.push('', '> 淫荡与脏话随场景变化很大：情绪安抚、技术问答里本来就不该满口脏话，跨场景直接比较这两个维度会误导。');
    }

    if (report.disagreements?.length) {
        lines.push('', '## 评委分歧', '');
        for (const d of report.disagreements.slice(0, 10)) {
            lines.push(`- ${DIMENSIONS.find(([k]) => k === d.key)?.[1] ?? d.key}：极差 ${d.spread}（${String(d.user).slice(0, 40)}）`);
        }
    }

    lines.push('', '## 逐条', '');
    rows.forEach((row, i) => {
        lines.push(`### ${i + 1}. ${String(row.user).slice(0, 60).replace(/\n/g, ' ')}`);
        if (row.time) lines.push(`> ${row.time}`);
        const reply = String(row.reply ?? ''), user = String(row.user ?? '');
        const metrics = inspectReplyText(reply, user);
        // A reply may contain its own fenced code: the report fence must be longer.
        const fenced = body => {
            const maxTicks = Math.max(2, ...(body.match(/`+/g) || []).map(s => s.length));
            const fence = '`'.repeat(maxTicks + 1);
            return [fence + 'text', body, fence];
        };
        lines.push('', '完整输入：', '', ...fenced(user), '',
            `正文统计：${metrics.codePoints}个Unicode字符；去空白后${metrics.nonWhitespaceCharacters}字符（含标点）；汉字${metrics.hanCharacters}个。`,
            `长度要求检测：${JSON.stringify(metrics.length)}。仅作客观计数，不代替语义评分。`,
            '实质交付：未在此自动判定；没有拒答词不等于完成任务。', '');
        if (row.capture?.userTruncated || row.capture?.replyTruncated) {
            lines.push('注意：源记录已截断，以下只展示已保存片段；不能据此推断完整回复的长度或交付情况。', '');
        }
        lines.push('回复原文（不再在报告层截成800字符）：', '', ...fenced(reply), '');
        if (row.scores) {
            lines.push(`分数：${DIMENSIONS.map(([k, n]) => `${n} ${row.scores[k] ?? '-'}`).join(' · ')}`);
            if (row.issues?.length) lines.push(`问题：${row.issues.join('；')}`);
        } else {
            lines.push('（评委没给出可解析的分数）');
        }
        lines.push('');
    });
    return lines.filter((l) => l !== null).join('\n');
}
