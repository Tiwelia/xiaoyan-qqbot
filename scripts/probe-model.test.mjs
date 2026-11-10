import test from 'node:test';
import assert from 'node:assert/strict';
import { parseOptions, normalizeModel, inspectModel, buildDiagnostics, formatReport } from './probe-model.mjs';

const options = (extra = {}) => ({ base: 'https://example.test/api/v1', provider: 'openrouter', model: 'vendor/model',
    key: '', probe: false, vision: false, efforts: null, timeoutMs: 50, maxTokens: 2048, ...extra });
const entry = (extra = {}) => ({ id: 'vendor/model', architecture: { input_modalities: ['text'] },
    reasoning: { supported_efforts: ['high', 'low', 'none'], default_effort: 'high', mandatory: false }, ...extra });
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

test('OpenRouter overrides DeepSeek base and never borrows its key', () => {
    const o = parseOptions(['--provider', 'openrouter', '--model', 'vendor/model'], {
        LLM_BASE_URL: 'https://api.deepseek.com', DEEPSEEK_API_KEY: 'private-deepseek-key',
    });
    assert.equal(o.base, 'https://openrouter.ai/api/v1');
    assert.equal(o.key, '');
    assert.throws(() => parseOptions(['--provider', 'openrouter', '--model', 'vendor/model', '--probe'], {
        DEEPSEEK_API_KEY: 'private-deepseek-key',
    }), /API Key/);
});

test('CLI normalizes bases, uses provider credentials and rejects ambiguous input', () => {
    const o = parseOptions(['--base', 'https://openrouter.ai/api/v1/chat/completions/', '--model', 'vendor/model'], { OPENROUTER_API_KEY: 'or-key' });
    assert.equal(o.provider, 'openrouter');
    assert.equal(o.base, 'https://openrouter.ai/api/v1');
    assert.equal(o.key, 'or-key');
    assert.equal(parseOptions(['--base', 'https://openrouter.ai', '--model', 'v/m'], {}).base, 'https://openrouter.ai/api/v1');
    for (const args of [['--vision'], ['--efforts', 'high'], ['--timeout-ms', '0'], ['--max-tokens', 'NaN'],
        ['--base', 'https://u:secret@example.test'], ['--unknown'], ['--provider', 'openrouter', '--model', 'deepseek-flash']]) {
        assert.throws(() => parseOptions(args, {}));
    }
});

test('default inspection only sends one metadata GET, no paid POST or authentication', async () => {
    const calls = [];
    const report = await inspectModel(options(), async (url, init) => {
        calls.push({ url, init });
        return json({ data: [entry()] });
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'GET');
    assert.equal(calls[0].init.headers.authorization, undefined);
    assert.deepEqual(report.model.reasoning.supportedEfforts, ['high', 'low', 'none']);
    assert.equal(report.model.reasoning.defaultEffort, 'high');
    assert.equal(report.model.vision, false);
    assert.deepEqual(report.diagnostics, []);
});

test('null, absent and missing reasoning metadata have different meanings', () => {
    const all = normalizeModel(entry({ reasoning: { supported_efforts: null } }), 'openrouter');
    assert.equal(all.reasoning.effortSelection, 'all');
    assert.ok(all.reasoning.supportedEfforts.includes('minimal'));
    const budget = normalizeModel(entry({ reasoning: { supports_max_tokens: true, default_enabled: false } }), 'openrouter');
    assert.equal(budget.reasoning.effortSelection, 'none');
    assert.equal(budget.reasoning.supportsMaxTokens, true);
    assert.equal(budget.reasoning.defaultEnabled, false);
    const unknown = normalizeModel({ id: 'openrouter/auto', supported_parameters: ['reasoning'] }, 'openrouter');
    assert.equal(unknown.reasoning.effortSelection, 'unknown');
    assert.equal(unknown.reasoning.supported, true);
    assert.equal(normalizeModel({ id: 'plain-model' }, 'openai').reasoning.supported, null);
    assert.equal(normalizeModel(entry({ reasoning: { default_effort: 'none' } }), 'openrouter').reasoning.defaultEnabled, false);
});

test('mandatory reasoning filters none, including all-gateway metadata', () => {
    for (const supported_efforts of [null, ['high', 'none']]) {
        const m = normalizeModel(entry({ reasoning: { supported_efforts, mandatory: true } }), 'openrouter');
        assert.ok(!m.reasoning.supportedEfforts.includes('none'));
        const plan = buildDiagnostics(options({ probe: true }), m);
        assert.ok(plan.every(d => d.body.reasoning?.effort !== 'none' && d.body.reasoning?.enabled !== false));
        assert.throws(() => buildDiagnostics(options({ efforts: ['none'] }), m));
    }
});

test('DeepSeek metadata uses its native effort list and correct request parameter', () => {
    const m = normalizeModel({ id: 'deepseek-v4-pro', input_modalities: ['text'],
        effort: { supported_levels: ['low', 'high', 'max'], default_level: 'high' } }, 'deepseek');
    assert.deepEqual(m.reasoning.supportedEfforts, ['low', 'high', 'max']);
    const plan = buildDiagnostics(options({ provider: 'deepseek', model: m.id }), m);
    assert.equal(plan.find(d => d.name === 'effort=max').body.reasoning_effort, 'max');
    assert.ok(plan.some(d => d.body.thinking?.type === 'disabled'));
    assert.ok(plan.every(d => !Object.hasOwn(d.body, 'effort') && !d.body.reasoning));
});

test('OpenRouter diagnostics use reasoning.effort and require_parameters; no DeepSeek fields', () => {
    const m = normalizeModel(entry(), 'openrouter');
    const plan = buildDiagnostics(options({ efforts: ['low'] }), m);
    assert.equal(plan.length, 2);
    assert.equal(plan[1].body.reasoning.effort, 'low');
    assert.ok(plan.every(d => d.body.provider.require_parameters && !d.body.thinking && !Object.hasOwn(d.body, 'effort') && !d.body.reasoning_effort));
    assert.throws(() => buildDiagnostics(options({ efforts: ['max'] }), m), /未声明/);
});

test('missing effort metadata does not trigger guessed levels or forbidden vision', () => {
    const m = normalizeModel({ id: 'v/m', input_modalities: ['text'] }, 'generic');
    assert.equal(buildDiagnostics(options({ vision: true }), m).length, 1);
    const plan = buildDiagnostics(options({ provider: 'generic', efforts: ['medium'] }), m);
    assert.equal(plan[1].body.reasoning_effort, 'medium');
    const vision = buildDiagnostics(options({ vision: true }), normalizeModel(entry({ architecture: { input_modalities: ['text', 'image'] } }), 'openrouter'));
    assert.ok(Array.isArray(vision.at(-1).body.messages[0].content));
});

test('token-budget-only reasoning uses enabled and honors mandatory state', () => {
    const m = normalizeModel(entry({ reasoning: { supports_max_tokens: true, mandatory: true } }), 'openrouter');
    const plan = buildDiagnostics(options(), m);
    assert.equal(plan.length, 2);
    assert.deepEqual(plan[1].body.reasoning, { enabled: true });
    assert.throws(() => buildDiagnostics(options({ efforts: ['high'] }), m), /未开放/);
});

test('successful request without visible reasoning stays an acceptance observation', async () => {
    const report = await inspectModel(options({ probe: true, key: 'secret', efforts: ['high'] }), async (_url, init) =>
        init.method === 'GET' ? json({ data: [entry()] }) : json({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }));
    assert.equal(report.diagnostics.length, 2);
    assert.ok(report.diagnostics.every(d => d.accepted && !d.reasoningObserved));
    assert.equal(report.model.reasoning.supported, true);
    assert.match(formatReport(report), /请求被接受/);
    assert.match(formatReport(report), /结果可能不完整/);
    assert.match(formatReport(report), /不证明参数生效/);
    assert.ok(!JSON.stringify(report).includes('secret'));
});

test('recognizes OpenRouter reasoning_details and token usage', async () => {
    const report = await inspectModel(options({ probe: true, efforts: [] }), async (_url, init) =>
        init.method === 'GET' ? json({ data: [entry()] }) : json({ choices: [{ message: { reasoning_details: [{ type: 'reasoning.encrypted' }] } }],
            usage: { completion_tokens_details: { reasoning_tokens: 17 } } }));
    assert.equal(report.diagnostics[0].reasoningObserved, true);
    assert.equal(report.diagnostics[0].reasoningTokens, 17);
});

test('missing model and malformed catalogs fail before any generation request', async () => {
    for (const body of [{ data: [] }, { invalid: true }]) {
        let calls = 0;
        await assert.rejects(inspectModel(options({ probe: true }), async () => { calls++; return json(body); }));
        assert.equal(calls, 1);
    }
});

test('HTTP and 200 application errors do not become positive capability results', async () => {
    for (const response of [() => json({ error: { message: 'invalid parameter' } }, 400),
        () => json({ error: { message: 'upstream failed' } }), () => json({}), () => new Response('<html>bad gateway</html>')]) {
        const report = await inspectModel(options({ probe: true, efforts: [] }), async (_url, init) =>
            init.method === 'GET' ? json({ data: [entry()] }) : response());
        assert.equal(report.diagnostics[0].accepted, false);
        assert.ok(report.diagnostics[0].error);
    }
});

test('stops generation on auth, credit and rate-limit errors and redacts echoed credentials', async () => {
    for (const status of [401, 402, 403, 429]) {
        let calls = 0;
        const report = await inspectModel(options({ probe: true, key: 'private-secret' }), async (_url, init) => {
            calls++;
            return init.method === 'GET' ? json({ data: [entry()] }) : json({ error: { message: 'private-secret Bearer another-secret' } }, status);
        });
        assert.equal(calls, 2);
        assert.equal(report.diagnostics.length, 1);
        assert.ok(!JSON.stringify(report).includes('private-secret'));
        assert.ok(!JSON.stringify(report).includes('another-secret'));
    }
});

test('timeout aborts stalled metadata reads with a useful failure', async () => {
    const stalled = (_url, { signal }) => new Promise((_resolve, reject) => {
        // The ref'ed timer keeps this isolated test alive until AbortSignal.timeout fires.
        const keepAlive = setTimeout(() => reject(new Error('deadline failed')), 200);
        signal.addEventListener('abort', () => { clearTimeout(keepAlive); reject(signal.reason); }, { once: true });
    });
    await assert.rejects(inspectModel(options({ timeoutMs: 10 }), stalled), /TimeoutError/);
});
