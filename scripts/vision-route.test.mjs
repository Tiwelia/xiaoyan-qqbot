import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig, validateConfig } from '../src/config.js';
import { LlmClient } from '../src/llm.js';

const configFor = extra => loadConfig({ QQBOT_APPID: 'test', QQBOT_SECRET: 'test', OWNER_OPENID: 'alice',
    DEEPSEEK_API_KEY: 'ds-key', ...extra });
const textMessages = [{ role: 'user', content: 'hello' }];
const imageMessages = [{ role: 'user', content: [{ type: 'text', text: 'describe' },
    { type: 'image_url', image_url: { url: 'data:image/png;base64,AA==' } }] }];
const response = () => new Response('data: {"choices":[{"delta":{"content":"OK"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
const routedConfig = extra => configFor({ OPENROUTER_API_KEY: 'or-key', LLM_VISION_PROVIDER: 'openrouter',
    LLM_VISION_MODEL: 'vendor/vision', ...extra });
const clientFor = config => new LlmClient({ ...config.llm, timeoutMs: 1000 });

test('reserving an OpenRouter key leaves current routes intact; main reasoning model can later switch independently', () => {
    const reserved = configFor({ OPENROUTER_API_KEY: 'or-key' });
    assert.equal(reserved.llm.apiKey, 'ds-key');
    assert.equal(reserved.llm.provider, 'deepseek');
    assert.equal(reserved.llm.visionModel, 'deepseek-flash');
    assert.equal(reserved.llm.vision, null);
    assert.deepEqual(validateConfig(reserved), []);
    const switched = configFor({ OPENROUTER_API_KEY: 'or-key', LLM_BASE_URL: 'https://openrouter.ai/api/v1',
        LLM_MODEL: 'vendor/reasoning', LLM_EFFORT: 'high', LLM_VISION_PROVIDER: 'deepseek', LLM_VISION_MODEL: 'deepseek-flash' });
    assert.equal(switched.llm.provider, 'openrouter');
    assert.equal(switched.llm.apiKey, 'or-key');
    assert.equal(switched.llm.vision.provider, 'deepseek');
    assert.equal(switched.llm.vision.apiKey, 'ds-key');
    assert.deepEqual(validateConfig(switched), []);
});

test('vision configuration selects its own endpoint and credentials without borrowing the main key', () => {
    const separate = routedConfig({ LLM_API_KEY: 'main-explicit' });
    assert.deepEqual(separate.llm.vision, { provider: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1', apiKey: 'or-key' });
    assert.equal(separate.llm.apiKey, 'main-explicit');
    assert.deepEqual(validateConfig(separate), []);
    const inferred = routedConfig({ LLM_VISION_PROVIDER: '', LLM_VISION_BASE_URL: 'https://openrouter.ai/', LLM_VISION_API_KEY: 'vision-explicit' });
    assert.equal(inferred.llm.vision.baseUrl, 'https://openrouter.ai/api/v1');
    assert.equal(inferred.llm.vision.provider, 'openrouter');
    assert.equal(inferred.llm.vision.apiKey, 'vision-explicit');
    const missing = routedConfig({ OPENROUTER_API_KEY: '', LLM_API_KEY: 'main-only' });
    assert.equal(missing.llm.vision.apiKey, '');
    assert.match(validateConfig(missing).join('\n'), /独立视觉模型缺少密钥/);
    const custom = routedConfig({ LLM_VISION_PROVIDER: 'generic', LLM_VISION_BASE_URL: 'https://vision.example/v1', OPENROUTER_API_KEY: '' });
    assert.equal(custom.llm.vision.apiKey, '');
    assert.match(validateConfig(custom).join('\n'), /缺少密钥/);
});

test('bad vision configuration fails locally and a blank vision model keeps the route disabled', () => {
    for (const extra of [
        { LLM_VISION_BASE_URL: 'file:///tmp/key' }, { LLM_VISION_BASE_URL: 'https://user:pass@example.test' },
        { LLM_VISION_BASE_URL: 'https://example.test?key=secret' }, { LLM_VISION_PROVIDER: 'invalid' },
        { LLM_VISION_MODEL: 'missing-namespace' },
    ]) assert.ok(validateConfig(routedConfig(extra)).length > 0);
    const disabled = routedConfig({ LLM_VISION_MODEL: '', OPENROUTER_API_KEY: '' });
    assert.deepEqual(validateConfig(disabled), []);
    assert.equal(clientFor(disabled).visionClient, null);
    assert.equal(configFor({ LLM_VISION_PROVIDER: 'openrouter', OPENROUTER_API_KEY: 'or-key' }).llm.visionModel, '');
});

test('text, images, tool continuation and text-only fallback reach the intended service and key', async t => {
    const requests = [];
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        requests.push({ url, key: init.headers.authorization, body: JSON.parse(init.body) });
        return response();
    });
    const client = clientFor(routedConfig({ LLM_MODEL: 'deepseek-v4-pro', LLM_THINKING: 'enabled', LLM_EFFORT: 'max' }));
    const tools = [{ type: 'function', function: { name: 'lookup', parameters: { type: 'object', properties: {} } } }];
    await client.stream({ messages: textMessages, model: 'main-override' });
    let delta = '';
    await client.stream({ messages: imageMessages, tools, maxTokens: 40, onDelta: value => { delta += value; } });
    await client.stream({ messages: [...imageMessages, { role: 'assistant', content: null, tool_calls: [{ id: 't', type: 'function', function: { name: 'lookup', arguments: '{}' } }], reasoning_details: [{ type: 'reasoning.encrypted', data: 'opaque' }] },
        { role: 'tool', tool_call_id: 't', content: 'result' }] });
    await client.stream({ messages: textMessages, model: 'main-override' });
    assert.deepEqual(requests.map(r => [r.url, r.key, r.body.model]), [
        ['https://api.deepseek.com/chat/completions', 'Bearer ds-key', 'main-override'],
        ['https://openrouter.ai/api/v1/chat/completions', 'Bearer or-key', 'vendor/vision'],
        ['https://openrouter.ai/api/v1/chat/completions', 'Bearer or-key', 'vendor/vision'],
        ['https://api.deepseek.com/chat/completions', 'Bearer ds-key', 'main-override'],
    ]);
    assert.equal(requests[0].body.reasoning_effort, 'max');
    assert.ok(!Object.hasOwn(requests[1].body, 'thinking'));
    assert.ok(!Object.hasOwn(requests[1].body, 'reasoning_effort'));
    assert.ok(!Object.hasOwn(requests[1].body, 'reasoning'));
    assert.deepEqual(requests[1].body.tools, tools);
    assert.equal(requests[1].body.max_tokens, 40);
    assert.equal(delta, 'OK');
    assert.equal(requests[2].body.messages[1].reasoning_details[0].data, 'opaque');
});

test('main effort changes do not overwrite an independent vision route; explicit request controls are forwarded', async t => {
    const bodies = [];
    t.mock.method(globalThis, 'fetch', async (_url, init) => { bodies.push(JSON.parse(init.body)); return response(); });
    const client = clientFor(routedConfig());
    client.setThinking('disabled'); client.setEffort('max');
    await client.stream({ messages: imageMessages });
    await client.stream({ messages: imageMessages, thinking: 'disabled' });
    await client.stream({ messages: textMessages });
    assert.equal(bodies[0].reasoning, undefined);
    assert.deepEqual(bodies[1].reasoning, { enabled: false });
    assert.deepEqual(bodies[2].thinking, { type: 'disabled' });
});

test('vision auth failures propagate without retrying via the main provider', async t => {
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async () => { calls++; return new Response('unauthorized', { status: 401 }); });
    await assert.rejects(clientFor(routedConfig()).stream({ messages: imageMessages }), error => error.status === 401);
    assert.equal(calls, 1);
});

test('vision cancellation is forwarded without affecting concurrent text calls', async t => {
    let announce;
    const started = new Promise(resolve => { announce = resolve; });
    let calls = 0;
    t.mock.method(globalThis, 'fetch', async (url, init) => {
        calls++;
        if (!String(url).includes('openrouter')) return response();
        announce();
        return new Promise((resolve, reject) => init.signal.addEventListener('abort', () => reject(init.signal.reason), { once: true }));
    });
    const client = clientFor(routedConfig());
    const controller = new AbortController();
    const pending = assert.rejects(client.stream({ messages: imageMessages, signal: controller.signal }), /cancel vision/);
    await started;
    assert.equal((await client.stream({ messages: textMessages })).text, 'OK');
    controller.abort(new Error('cancel vision'));
    await pending;
    await assert.rejects(client.stream({ messages: imageMessages, signal: controller.signal }), /cancel vision/);
    assert.equal(calls, 2);
});
