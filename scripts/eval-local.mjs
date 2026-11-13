#!/usr/bin/env node
/** Bounded daily-use evaluation, authored by a virtual user; no QQ connection. */
import fs from 'node:fs';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { pathToFileURL } from 'node:url';
import { loadConfig, validateConfig } from '../src/config.js';
import { createLocalEval } from '../src/local-eval.js';

export const CASES = [
    { name: '查看设置', user: '查看设置', local: true, includes: '模型：' },
    { name: '切到文字', user: '关闭语音', local: true, includes: '文字' },
    { name: '技术短答', user: 'TCP建立连接为什么需要三次握手？先直接解释原因，控制在120字内。', text: true, maxChars: 120 },
    { name: '明确记忆', user: '记住一个长期偏好：我喝茶不加糖。', text: true, memory: true },
    { name: '清空上下文', user: '/reset', local: true, reset: true },
    { name: '清空后记忆', user: '我喝茶有什么偏好？只回答这个偏好。', text: true, includes: '不加糖' },
    { name: '启用语音', user: '打开语音', local: true, includes: '语音' },
    { name: '短语音', user: '用一句话解释什么是HTTP状态码404。', voice: true, maxSentences: 1 },
    { name: '仅本轮文字', user: '这条用文字回复：用一句话解释HTTP状态码200。', text: true, retainVoice: true, maxSentences: 1 },
    { name: '恢复文字', user: '关闭语音', local: true, includes: '文字' },
    { name: '自然音色翻页', user: '查看音色第 2 页', local: true, includes: '第 2/' },
];

export function assessCase(spec, result, harness, modelCalls) {
    const sends = result.events.filter(e => !['upload'].includes(e.type));
    const text = sends.filter(e => ['text', 'stream'].includes(e.type)).map(e => e.text).join('\n');
    const audio = sends.some(e => ['voice', 'file'].includes(e.type));
    const checks = [{ name: '有可交付结果', passed: sends.some(e => e.type !== 'typing') },
        { name: 'QQ单条入站四次额度', passed: sends.length <= 4 }];
    if (spec.local) checks.push({ name: '设置不调用模型', passed: modelCalls === 0 });
    if (spec.includes) checks.push({ name: `结果包含${spec.includes}`, passed: text.includes(spec.includes) || result.turns.some(t => t.reply.includes(spec.includes)) });
    if (spec.text) checks.push({ name: '按要求投递文字', passed: Boolean(text) && !audio });
    if (spec.voice) checks.push({ name: '真实TTS生成并走语音投递', passed: audio && result.events.some(e => e.type === 'upload' && e.bytes > 44) });
    if (spec.memory) checks.push({ name: '长期偏好实际写库', passed: harness.memory.listImportant(20, 'c2c').some(r => r.content.includes('不加糖')) });
    if (spec.reset) checks.push({ name: '逐条会话已清空', passed: harness.sessions.toMessages('c2c', harness.owner).length === 0 });
    if (spec.retainVoice) checks.push({ name: '单轮文字不修改长期语音开关', passed: harness.state.get(`voice:c2c:${harness.owner}`, harness.tts.defaultOn) === true });
    const reply = result.turns.at(-1)?.reply || text;
    if (spec.maxChars) checks.push({ name: `明确字数上限${spec.maxChars}`, passed: Array.from(reply).length <= spec.maxChars });
    if (spec.maxSentences) checks.push({ name: '一句话要求（按句末标点分句）', passed: reply.split(/[。！？!?]+/u).filter(s => s.trim()).length <= spec.maxSentences });
    return checks;
}

async function main() {
    const args = process.argv.slice(2);
    if (!args.includes('--live')) {
        console.log(`本机QQ流程评测：${CASES.length}个场景。加 --live 调用当前配置的真实模型和TTS；不会连接QQ。`);
        return;
    }
    if (fs.existsSync('.env')) process.loadEnvFile('.env');
    const source = loadConfig();
    const problems = validateConfig(source);
    if (problems.length) throw new Error(problems.join('\n'));
    const outputIndex = args.indexOf('--out');
    if (outputIndex >= 0 && !args[outputIndex + 1]) throw new Error('--out needs a file path');
    const out = path.resolve(outputIndex >= 0 ? args[outputIndex + 1] : path.join(source.eval.dir, `local-${Date.now()}.json`));
    const saved = fs.existsSync(source.state.file) ? JSON.parse(fs.readFileSync(source.state.file, 'utf8')) : {};
    const owner = 'local-eval-owner';
    const sourceOwnerFile = path.join(source.dataDir, 'owner.json');
    const sourceOwner = source.access.ownerOpenid || (fs.existsSync(sourceOwnerFile)
        ? JSON.parse(fs.readFileSync(sourceOwnerFile, 'utf8')).openid : '');
    const stateSeed = {};
    for (const key of ['model', 'effortLevel']) if (saved[key] !== undefined) stateSeed[key] = saved[key];
    for (const setting of ['voice', 'voiceName']) {
        const value = saved[`${setting}:c2c:${sourceOwner}`];
        if (value !== undefined) stateSeed[`${setting}:c2c:${owner}`] = value;
    }
    const harness = createLocalEval({ config: source, live: true, stateSeed, owner, captureDir: `${out}.media` });
    let calls = 0;
    const originalStream = harness.llm.stream.bind(harness.llm);
    harness.llm.stream = async options => { calls++; return originalStream(options); };
    const report = { at: new Date().toISOString(), model: stateSeed.model || source.llm.model,
        provider: source.llm.provider, tts: source.tts.engine,
        parity: 'SDK inbound/middleware → createBot → queue/deadline → commands/conversation → real LLM/tools/TTS → delivery budget. QQ network intercepted; clean isolated history/memory, synthetic owner; assets omitted; proactive timers not started.',
        rows: [], logs: [] };
    const persist = () => {
        fs.mkdirSync(path.dirname(out), { recursive: true });
        fs.writeFileSync(out, JSON.stringify({ ...report, logs: harness.logs.filter(l => ['warn', 'error'].includes(l.level)) }, null, 2));
    };
    try {
        for (const spec of CASES) {
            if (report.rows.length) await pause(Math.max(0, source.behavior.peerCooldownMs) + 50);
            const before = calls;
            const result = await harness.send(spec.user);
            const checks = assessCase(spec, result, harness, calls - before);
            const passed = checks.filter(c => c.passed).length;
            report.rows.push({ ...result, name: spec.name, modelCalls: calls - before, checks });
            persist();
            console.log(`${spec.name}: ${passed}/${checks.length}，${result.elapsedMs}ms，模型请求${calls - before}`);
        }
        const checks = report.rows.flatMap(row => row.checks);
        console.log(`功能检查 ${checks.filter(c => c.passed).length}/${checks.length}；输出 ${out}`);
    } finally { await harness.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
