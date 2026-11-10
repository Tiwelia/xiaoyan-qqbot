#!/usr/bin/env node
/** Metadata first. --probe explicitly opts into billable Chat Completions diagnostics. */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const GATEWAY_EFFORTS = ['max', 'xhigh', 'high', 'medium', 'low', 'minimal', 'none'];
const BASES = { deepseek: 'https://api.deepseek.com', openrouter: 'https://openrouter.ai/api/v1', openai: 'https://api.openai.com/v1' };
const HELP = `模型能力查询（默认仅 GET /models，不调用生成接口）
  node scripts/probe-model.mjs
  node scripts/probe-model.mjs --model deepseek-v4-pro
  node scripts/probe-model.mjs --provider openrouter --model openai/gpt-5.2
  node scripts/probe-model.mjs --provider openrouter --model anthropic/claude-sonnet-4.6 --json
  node scripts/probe-model.mjs --provider openrouter --model openai/gpt-5.2 --probe

选项：--base URL --key KEY --model ID --provider auto|deepseek|openrouter|openai|generic
      --json --probe --vision --efforts low,high --timeout-ms 20000 --max-tokens 2048
--probe 会产生模型费用；--vision 额外诊断图像请求，必须与 --probe 一起使用。
--efforts 指定诊断档位，必须与 --probe 一起使用；缺少档位元数据时不会自动穷举。
密钥建议使用环境变量：OPENROUTER_API_KEY / DEEPSEEK_API_KEY / OPENAI_API_KEY / LLM_API_KEY。
OpenRouter 的公开模型目录无需密钥；其诊断请求不会使用 DEEPSEEK_API_KEY。`;

export function parseOptions(argv, env = process.env) {
    const { values: v } = parseArgs({ args: argv, options: {
        base: { type: 'string' }, key: { type: 'string' }, model: { type: 'string' },
        provider: { type: 'string', default: 'auto' }, json: { type: 'boolean' },
        probe: { type: 'boolean' }, vision: { type: 'boolean' }, efforts: { type: 'string' },
        'timeout-ms': { type: 'string', default: '20000' }, 'max-tokens': { type: 'string', default: '2048' },
        help: { type: 'boolean', short: 'h' },
    } });
    if (v.help) return { help: true };
    if (!['auto', 'generic', ...Object.keys(BASES)].includes(v.provider)) throw new Error('未知 --provider');
    const url = new URL(v.base || (v.provider !== 'auto' ? BASES[v.provider] : '') || env.LLM_BASE_URL || BASES.deepseek);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
        throw new Error('--base 必须是不含账号密码、查询参数或片段的 HTTP(S) 地址');
    }
    let provider = v.provider;
    if (provider === 'auto') provider = ({ 'api.deepseek.com': 'deepseek', 'openrouter.ai': 'openrouter', 'api.openai.com': 'openai' })[url.hostname] || 'generic';
    url.pathname = url.pathname.replace(/\/+$/, '').replace(/\/(?:chat\/completions|models|responses)$/, '');
    if (provider === 'openrouter' && (!url.pathname || url.pathname === '/')) url.pathname = '/api/v1';
    if (provider === 'openai' && (!url.pathname || url.pathname === '/')) url.pathname = '/v1';
    const model = (v.model || env.LLM_MODEL || (provider === 'deepseek' ? 'deepseek-flash' : '')).trim();
    if (!model) throw new Error('请通过 --model 指定模型');
    if (provider === 'openrouter' && !model.includes('/')) throw new Error('OpenRouter 模型需要组织前缀，例如 --model openai/gpt-5.2');
    const providerKey = ({ deepseek: env.DEEPSEEK_API_KEY, openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY })[provider];
    const key = v.key || env.LLM_API_KEY || providerKey || '';
    if ((v.vision || v.efforts !== undefined) && !v.probe) throw new Error('--vision / --efforts 必须与 --probe 一起使用');
    const efforts = v.efforts === undefined ? null : [...new Set(v.efforts.split(',').map(s => s.trim()).filter(Boolean))];
    if (efforts && (!efforts.length || efforts.some(s => !/^[a-z][a-z0-9_-]*$/.test(s)))) throw new Error('--efforts 应为逗号分隔的档位名称');
    const number = name => {
        const n = Number(v[name]);
        if (!Number.isSafeInteger(n) || n < 1 || n > 2_147_483_647) throw new Error(`--${name} 必须为有效正整数`);
        return n;
    };
    if (v.probe && !key) throw new Error('诊断生成请求需要对应服务的 API Key');
    return { base: url.href.replace(/\/+$/, ''), provider, model, key, json: !!v.json,
        probe: !!v.probe, vision: !!v.vision, efforts, timeoutMs: number('timeout-ms'), maxTokens: number('max-tokens') };
}

function stringList(value) {
    return Array.isArray(value) && value.every(s => typeof s === 'string') ? [...new Set(value)] : null;
}

export function normalizeModel(model, provider) {
    const parameters = stringList(model.supported_parameters);
    const inputs = stringList(model.architecture?.input_modalities ?? model.input_modalities);
    const reasoning = { supported: null, effortSelection: 'unknown', supportedEfforts: null,
        defaultEffort: null, defaultEnabled: null, mandatory: null, supportsMaxTokens: null };
    if (provider === 'openrouter' && model.reasoning && typeof model.reasoning === 'object') {
        const r = model.reasoning;
        reasoning.supported = true;
        reasoning.mandatory = typeof r.mandatory === 'boolean' ? r.mandatory : null;
        reasoning.defaultEffort = typeof r.default_effort === 'string' ? r.default_effort : null;
        reasoning.defaultEnabled = typeof r.default_enabled === 'boolean' ? r.default_enabled
            : r.default_effort === 'none' ? false : null;
        reasoning.supportsMaxTokens = typeof r.supports_max_tokens === 'boolean' ? r.supports_max_tokens : null;
        if (r.supported_efforts === null) {
            reasoning.effortSelection = 'all';
            reasoning.supportedEfforts = [...GATEWAY_EFFORTS];
        } else if (Object.hasOwn(r, 'supported_efforts')) {
            const levels = stringList(r.supported_efforts);
            if (levels) {
                reasoning.effortSelection = 'listed';
                reasoning.supportedEfforts = levels;
            }
        } else {
            reasoning.effortSelection = 'none';
            reasoning.supportedEfforts = [];
        }
        if (reasoning.mandatory && reasoning.supportedEfforts) reasoning.supportedEfforts = reasoning.supportedEfforts.filter(s => s !== 'none');
    } else if (model.effort && typeof model.effort === 'object') {
        const levels = stringList(model.effort.supported_levels);
        reasoning.supported = true;
        reasoning.effortSelection = levels ? 'listed' : 'unknown';
        reasoning.supportedEfforts = levels;
        reasoning.defaultEffort = typeof model.effort.default_level === 'string' ? model.effort.default_level : null;
        if (provider === 'deepseek') {
            reasoning.defaultEnabled = true;
            reasoning.mandatory = false;
        }
    } else if (parameters) {
        reasoning.supported = parameters.some(p => ['reasoning', 'reasoning_effort', 'include_reasoning'].includes(p)) ? true : null;
        // Old catalogs and dynamic routers can omit fields: don't infer unsupported from absence.
    }
    return { id: model.id, name: model.name || model.id, inputModalities: inputs,
        vision: inputs ? inputs.includes('image') : null,
        contextWindow: model.context_window ?? model.context_length ?? null,
        maxOutputTokens: model.max_output_tokens ?? model.top_provider?.max_completion_tokens ?? null,
        supportedParameters: parameters, reasoning };
}

function safeMessage(value, key) {
    let s = String(value);
    if (key) s = s.replaceAll(key, '[REDACTED]');
    return s.replace(/Bearer\s+[^\s"']+/gi, 'Bearer [REDACTED]').slice(0, 400);
}

async function request(options, suffix, { body, fetchImpl = fetch } = {}) {
    const started = Date.now();
    const headers = { accept: 'application/json' };
    if (options.key) headers.authorization = `Bearer ${options.key}`;
    if (body) headers['content-type'] = 'application/json';
    try {
        const response = await fetchImpl(`${options.base}${suffix}`, {
            method: body ? 'POST' : 'GET', headers,
            ...(body ? { body: JSON.stringify(body) } : {}),
            signal: AbortSignal.timeout(options.timeoutMs), redirect: 'error',
        });
        const raw = await response.text();
        let json;
        try { json = JSON.parse(raw); } catch { /* A non-JSON 2xx is not a successful model response. */ }
        const ok = response.ok && !!json && !json.error;
        return { ok, status: response.status, ms: Date.now() - started, json,
            error: ok ? null : safeMessage(json?.error?.message || (json ? `HTTP ${response.status}` : `HTTP ${response.status}，返回非 JSON`), options.key) };
    } catch (e) {
        return { ok: false, status: null, ms: Date.now() - started, json: null,
            error: safeMessage(`${e.name}: ${e.message}`, options.key) };
    }
}

export function buildDiagnostics(options, model) {
    const r = model.reasoning;
    const levels = options.efforts ?? r.supportedEfforts ?? [];
    if (options.efforts) {
        if (r.effortSelection === 'none' && levels.length) throw new Error('此模型未开放 effort 选择');
        if (r.supportedEfforts && levels.some(s => !r.supportedEfforts.includes(s))) throw new Error('--efforts 包含模型元数据未声明的档位');
        if (r.mandatory && levels.includes('none')) throw new Error('此模型强制推理，不能诊断 none');
    }
    const control = effort => options.provider === 'openrouter' ? { reasoning: { effort } } : { reasoning_effort: effort };
    const diagnostics = [{ name: '基础对话', extra: {} }];
    if (options.provider === 'deepseek') {
        diagnostics.push({ name: 'thinking=disabled', extra: { thinking: { type: 'disabled' } } },
            { name: 'thinking=enabled', extra: { thinking: { type: 'enabled' } } });
    } else if (options.provider === 'openrouter' && r.supported && r.effortSelection === 'none') {
        diagnostics.push({ name: 'reasoning.enabled=true', extra: { reasoning: { enabled: true } } });
        if (r.mandatory === false) diagnostics.push({ name: 'reasoning.enabled=false', extra: { reasoning: { enabled: false } } });
    }
    for (const effort of levels) diagnostics.push({ name: `effort=${effort}`, extra: control(effort) });
    if (options.vision && model.vision !== false) diagnostics.push({ name: '图像输入', extra: {}, vision: true });
    return diagnostics.map(d => ({ name: d.name, body: {
        model: options.model, messages: [{ role: 'user', content: d.vision ? [
            { type: 'text', text: 'What color is this image? One word.' },
            { type: 'image_url', image_url: { url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==' } },
        ] : 'Reply with OK.' }], max_tokens: Math.min(options.maxTokens, model.maxOutputTokens || options.maxTokens),
        stream: false, ...d.extra,
        ...(options.provider === 'openrouter' ? { provider: { require_parameters: true } } : {}),
    } }));
}

export async function inspectModel(options, fetchImpl = fetch) {
    const response = await request(options, '/models', { fetchImpl });
    if (!response.ok) throw new Error(`/models 查询失败：${response.error}`);
    if (!Array.isArray(response.json.data)) throw new Error('/models 返回格式错误：缺少 data 数组');
    const raw = response.json.data.find(m => m?.id === options.model);
    if (!raw) throw new Error(`/models 中没有找到模型 ${options.model}，请核对完整 ID 和服务地址`);
    const model = normalizeModel(raw, options.provider);
    const report = { base: options.base, provider: options.provider, model, source: `${options.base}/models`,
        diagnostics: [], notes: ['元数据表示服务端声明；未返回字段保留为未知，不通过模型名猜测。'] };
    if (model.reasoning.effortSelection === 'unknown') report.notes.push('没有明确的 effort 列表；不会自动枚举档位，可用 --probe --efforts 显式诊断。');
    if (model.reasoning.effortSelection === 'all') report.notes.push('supported_efforts=null 表示接受全部网关档位，不能据此认定底层有同样数量的独立档位。');
    if (options.provider === 'deepseek') report.notes.push('DeepSeek supported_levels 仅列思考档位，不含关闭思考的 none。');
    if (options.vision && model.vision === false) report.notes.push('模型元数据声明不接受图片，已跳过图像诊断。');
    if (options.probe) {
        report.notes.push('诊断成功仅表示请求被接受；不证明参数生效、档位独立或推理已关闭。未观察到推理内容也不表示不支持推理。');
        for (const d of buildDiagnostics(options, model)) {
            const result = await request(options, '/chat/completions', { body: d.body, fetchImpl });
            const choice = result.json?.choices?.[0];
            const message = choice?.message;
            const valid = result.ok && !!message && !choice.error;
            const tokens = result.json?.usage?.completion_tokens_details?.reasoning_tokens ?? null;
            report.diagnostics.push({ name: d.name, accepted: valid, status: result.status, ms: result.ms,
                error: valid ? null : result.error || safeMessage(choice?.error?.message || '缺少有效的 choices[0].message', options.key),
                finishReason: choice?.finish_reason ?? null, reasoningTokens: tokens,
                reasoningObserved: !!(message?.reasoning_content || message?.reasoning || message?.reasoning_details?.length || tokens > 0) });
            // Stop on authentication, credit, rate-limit or network failures; never repeat paid work.
            if ([401, 402, 403, 429].includes(result.status) || result.status === null) break;
        }
    }
    return report;
}

export function formatReport(report) {
    const { model: m } = report;
    const show = v => v === null || v === undefined ? '未知' : typeof v === 'boolean' ? (v ? '是' : '否') : v;
    return [`base  ${report.base}`, `model ${m.id} (${m.name})`, `元数据 ${report.source}`,
        `输入类型：${m.inputModalities?.join(', ') ?? '未知'}；看图：${show(m.vision)}`,
        `上下文：${show(m.contextWindow)}；最大输出：${show(m.maxOutputTokens)}`,
        `推理能力：${show(m.reasoning.supported)}；effort 选择：${m.reasoning.effortSelection}`,
        `effort 列表：${m.reasoning.supportedEfforts?.join(', ') || (m.reasoning.effortSelection === 'none' ? '未开放选择' : '未知')}`,
        `默认 effort：${show(m.reasoning.defaultEffort)}；默认启用：${show(m.reasoning.defaultEnabled)}`,
        `强制推理：${show(m.reasoning.mandatory)}；推理 token 预算：${show(m.reasoning.supportsMaxTokens)}`,
        ...report.diagnostics.map(d => `${d.name}：${d.accepted ? '请求被接受' : '诊断失败'} (${d.status ?? '网络错误'}, ${d.ms}ms)${d.error ? ` ${d.error}` : ''}${d.finishReason === 'length' ? '；达到输出上限，结果可能不完整' : ''}`),
        ...report.notes.map(n => `说明：${n}`)].join('\n');
}

if (import.meta.main) {
    let options;
    try {
        const envPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '.env');
        if (fs.existsSync(envPath)) process.loadEnvFile(envPath);
        options = parseOptions(process.argv.slice(2));
        if (options.help) console.log(HELP);
        else {
            const report = await inspectModel(options);
            console.log(options.json ? JSON.stringify(report, null, 2) : formatReport(report));
            if (report.diagnostics.some(d => !d.accepted)) process.exitCode = 1;
        }
    } catch (e) {
        console.error(safeMessage(e.message, options?.key));
        process.exitCode = 1;
    }
}
