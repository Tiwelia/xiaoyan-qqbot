/**
 * LLM 客户端 —— OpenAI 兼容的 /chat/completions，流式 + 工具调用。
 *
 * 默认指向 DeepSeek 官方 API（https://api.deepseek.com），
 * 换 baseUrl / model 就能接任何兼容的服务。
 */
import { estimateMessagesTokens } from './text.js';

export class LlmError extends Error {
    constructor(message, { status = 0, body = '' } = {}) {
        super(message);
        this.name = 'LlmError';
        this.status = status;
        this.body = body;
    }
}

export class LlmClient {
    constructor({ baseUrl, apiKey, model, provider = 'auto', visionModel = '', vision = null, thinking = 'auto', effort = '', maxTokens = 4096, temperature = 1.0, timeoutMs = 180_000, logger }) {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
        this.provider = provider === 'auto'
            ? ({ 'api.deepseek.com': 'deepseek', 'openrouter.ai': 'openrouter', 'api.openai.com': 'openai' })[new URL(this.baseUrl).hostname] || 'generic'
            : provider;
        this.unsupportedParameters = new Map();
        this.apiKey = apiKey;
        this.model = model;
        this.visionModel = visionModel;
        this.thinking = thinking;
        this.effort = effort;
        this.maxTokens = maxTokens;
        this.temperature = temperature;
        this.timeoutMs = timeoutMs;
        this.logger = logger;
        // Keep credentials, rejected-parameter caches and reasoning controls isolated.
        this.visionClient = vision && visionModel ? new LlmClient({
            baseUrl: vision.baseUrl, apiKey: vision.apiKey, provider: vision.provider,
            model: visionModel, maxTokens, temperature, timeoutMs, logger,
        }) : null;
    }

    get chatUrl() {
        return `${this.baseUrl}/chat/completions`;
    }

    /**
     * 单轮流式请求。
     *
     * @param {object} opts
     * @param {Array}  opts.messages
     * @param {Array}  [opts.tools]
     * @param {string} [opts.model]
     * @param {(deltaText: string, fullText: string) => void} [opts.onDelta]
     * @param {AbortSignal} [opts.signal]
     * @param {number} [opts.maxTokens] Per-request cap, never larger than the configured cap.
     * @param {'auto'|'enabled'|'disabled'} [opts.thinking] Does not change other concurrent requests.
     * @returns {Promise<{text: string, toolCalls: Array, finishReason: string, usage: object|null}>}
     */
    /** 运行时改思考深度：low / high / max，空串 = 服务默认。 */
    setEffort(value) {
        this.effort = String(value ?? '').trim();
        return this.effort;
    }

    /** 直接关掉思考（thinking: disabled），effort 也就没意义了。 */
    setThinking(value) {
        const next = ['auto', 'enabled', 'disabled'].includes(value) ? value : 'auto';
        this.thinking = next;
        return next;
    }

    getThinking() {
        return this.thinking;
    }

    getEffort() {
        return this.effort;
    }

    async stream({ messages, tools, model, onDelta, signal, maxTokens, thinking }) {
        signal?.throwIfAborted();
        const hasImages = messages.some(m => Array.isArray(m.content) && m.content.some(p => p?.type === 'image_url'));
        if (hasImages && this.visionClient) {
            return this.visionClient.stream({ messages, tools, model: this.visionModel, onDelta, signal, maxTokens, thinking });
        }
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('LLM 请求超时')), this.timeoutMs);
        const onAbort = () => controller.abort(signal?.reason);
        signal?.addEventListener('abort', onAbort, { once: true });

        const body = {
            model: this.visionModel && hasImages
                ? this.visionModel : model || this.model,
            messages,
            stream: true,
            max_tokens: Number.isSafeInteger(maxTokens) && maxTokens > 0 ? Math.min(this.maxTokens, maxTokens) : this.maxTokens,
            temperature: this.temperature,
        };
        const requestThinking = ['auto', 'enabled', 'disabled'].includes(thinking) ? thinking : this.thinking;
        if (this.provider === 'deepseek') {
            if (requestThinking !== 'auto') body.thinking = { type: requestThinking };
            if (this.effort && requestThinking !== 'disabled') body.reasoning_effort = this.effort;
        } else if (this.provider === 'openrouter') {
            if (requestThinking === 'disabled') body.reasoning = { enabled: false };
            else if (this.effort || requestThinking === 'enabled') body.reasoning = {
                ...(requestThinking === 'enabled' ? { enabled: true } : {}),
                ...(this.effort ? { effort: this.effort } : {}),
            };
        } else {
            if (requestThinking === 'disabled') body.reasoning_effort = 'none';
            else if (this.effort) body.reasoning_effort = this.effort;
        }
        for (const parameter of this.unsupportedParameters.get(body.model) ?? []) {
            // Disabling is an explicit user request. Never silently fall back to a model's
            // potentially reasoning-enabled default when this control was rejected before.
            if (requestThinking === 'disabled' && parameter !== 'temperature') continue;
            delete body[parameter];
        }
        if (tools && tools.length > 0) {
            body.tools = tools;
            body.tool_choice = 'auto';
        }

        this.logger?.debug(`LLM 请求：model=${body.model} messages=${messages.length} tokens≈${estimateMessagesTokens(messages)}`);

        try {
            const started = Date.now();
            const send = () => fetch(this.chatUrl, {
                method: 'POST',
                headers: {
                    'content-type': 'application/json',
                    authorization: `Bearer ${this.apiKey}`,
                    accept: 'text/event-stream',
                },
                body: JSON.stringify(body),
                signal: controller.signal,
            });

            let response = await send();

            if (!response.ok) {
                const text = await response.text().catch(() => '');
                const snippet = (this.apiKey ? text.replaceAll(this.apiKey, '[REDACTED]') : text).slice(0, 800);
                const unknownParameter = /(?:unknown|unrecognized|unexpected|unsupported)[_ ]*(?:parameter|field)|(?:parameter|field)[\s\S]{0,100}(?:not supported|unsupported|not allowed)/i.test(text);
                const rejected = ['reasoning_effort', 'thinking', 'reasoning', 'temperature'].find(p =>
                    Object.hasOwn(body, p) && new RegExp(`\\b${p}\\b`, 'i').test(text));
                // Only a parameter-schema rejection may be retried. Unsupported effort VALUES,
                // auth, balance and server errors must not silently change the requested behavior.
                const disablingRejected = requestThinking === 'disabled' && rejected !== 'temperature';
                if ([400, 422].includes(response.status) && unknownParameter && rejected && !disablingRejected) {
                    delete body[rejected];
                    this.logger?.warn(`模型 ${body.model} 不接受参数 ${rejected}，本轮去掉此参数重试`);
                    response = await send();
                    if (!response.ok) {
                        const text2 = await response.text().catch(() => '');
                        throw new LlmError(`LLM HTTP ${response.status}`, { status: response.status, body: text2.slice(0, 800) });
                    }
                    if (!this.unsupportedParameters.has(body.model)) this.unsupportedParameters.set(body.model, new Set());
                    this.unsupportedParameters.get(body.model).add(rejected);
                } else {
                    throw new LlmError(`LLM HTTP ${response.status}`, { status: response.status, body: snippet });
                }
            }

            const result = await this.#consumeSse(response, onDelta);
            controller.signal.throwIfAborted();
            this.logger?.debug(
                `LLM 完成：${Date.now() - started}ms text=${result.text.length}字 toolCalls=${result.toolCalls.length} finish=${result.finishReason}`,
            );
            return result;
        } finally {
            clearTimeout(timer);
            signal?.removeEventListener('abort', onAbort);
        }
    }

    async #consumeSse(response, onDelta) {
        if (!response.body) throw new LlmError('LLM 响应没有流式正文');
        let text = '', finishReason = '', usage = null, buffer = '', doneEvent = false;
        let eventLines = [], eventBytes = 0, reasoningContent = '';
        const reasoningAcc = new Map();
        const toolAcc = new Map();
        const reader = response.body.getReader();
        const decoder = new TextDecoder('utf-8');
        const dispatch = (final = false) => {
            if (!eventLines.length) return;
            const payload = eventLines.join('\n').trim();
            eventLines = [];
            eventBytes = 0;
            // 空 payload = 上游心跳 / keep-alive，不是错误
            if (payload === '') return;
            if (payload === '[DONE]') { doneEvent = true; return; }
            let json;
            try { json = JSON.parse(payload); }
            catch {
                // A trailing, truncated usage event cannot invalidate an already terminal answer.
                if (final && ['stop', 'tool_calls'].includes(finishReason)) return;
                throw new LlmError('LLM 流包含无法解析的数据，回复未完成');
            }
            if (json.error) throw new LlmError('LLM 返回流内错误，回复未完成');
            if (json.usage) usage = json.usage;
            const choice = json.choices?.[0];
            if (!choice) return;
            if (choice.error || choice.finish_reason === 'error') throw new LlmError('LLM 返回流内错误，回复未完成');
            const delta = choice.delta ?? {};
            reasoningContent += delta.reasoning_content ?? delta.reasoning ?? '';
            for (const detail of delta.reasoning_details ?? []) {
                const key = detail.index ?? detail.id ?? 0;
                const current = reasoningAcc.get(key) ?? {};
                for (const [name, value] of Object.entries(detail)) {
                    current[name] = ['text', 'summary', 'data'].includes(name) && typeof value === 'string'
                        ? (current[name] ?? '') + value : value;
                }
                reasoningAcc.set(key, current);
            }
            if (typeof delta.content === 'string' && delta.content) {
                text += delta.content;
                onDelta?.(delta.content, text);
            }
            for (const tc of delta.tool_calls ?? []) {
                const key = tc.index ?? 0;
                const cur = toolAcc.get(key) ?? { id: '', name: '', args: '' };
                if (tc.id) cur.id = tc.id;
                if (tc.function?.name) cur.name += tc.function.name;
                if (tc.function?.arguments) cur.args += tc.function.arguments;
                toolAcc.set(key, cur);
            }
            if (choice.finish_reason) finishReason = choice.finish_reason;
        };
        const line = (raw) => {
            raw = raw.replace(/\r$/, '');
            if (!raw.trim()) dispatch();
            else if (raw.startsWith('data:')) {
                eventBytes += Buffer.byteLength(raw);
                if (eventBytes > 8 * 1024 * 1024) throw new LlmError('LLM 流事件过大');
                eventLines.push(raw.slice(5).trimStart());
            }
        };
        try {
            for (;;) {
                const { done, value } = await reader.read();
                buffer += done ? decoder.decode() : decoder.decode(value, { stream: true });
                let index;
                while ((index = buffer.indexOf('\n')) >= 0) {
                    line(buffer.slice(0, index));
                    buffer = buffer.slice(index + 1);
                    if (doneEvent) break;
                }
                if (done || doneEvent) {
                    if (!doneEvent) { if (buffer) line(buffer); dispatch(true); }
                    break;
                }
                if (buffer.length > 8 * 1024 * 1024) throw new LlmError('LLM 流单行过大');
            }
        } finally {
            await reader.cancel().catch(() => {});
            reader.releaseLock();
        }
        const toolCalls = [...toolAcc.entries()].sort((a,b)=>a[0]-b[0]).map(([,v])=>v);
        const reasoning = {
            ...(reasoningContent ? { reasoningContent } : {}),
            ...(reasoningAcc.size ? { reasoningDetails: [...reasoningAcc.values()] } : {}),
        };
        // 撞到长度上限但已经有正文：把写好的部分交出去，别让整轮作废
        if (finishReason === 'length' && String(text).trim() !== '' && toolCalls.length === 0) {
            return { text, toolCalls: [], finishReason, usage, truncated: true, ...reasoning };
        }
        if (!['stop', 'tool_calls'].includes(finishReason)) {
            const reason = finishReason === 'length' ? '输出达到长度上限'
                : finishReason === 'content_filter' ? '服务过滤了输出' : '连接提前结束';
            const error = new LlmError('LLM 回复未完成：' + reason);
            // 让上层知道是「被上游掐了」还是「单纯断了」，重试策略不一样。
            if (finishReason === 'content_filter') error.filtered = true;
            if (finishReason === 'length') { error.truncated = true; error.emptyTruncated = String(text ?? '').trim() === ''; }
            throw error;
        }
        if ((finishReason === 'tool_calls') !== (toolCalls.length > 0) || toolCalls.some(t=>!t.name || !t.id)) {
            throw new LlmError('LLM 工具调用不完整');
        }
        if (finishReason === 'stop' && !text.trim()) throw new LlmError('LLM 未返回正文');
        return { text, toolCalls, finishReason, usage, ...reasoning };
    }
}

