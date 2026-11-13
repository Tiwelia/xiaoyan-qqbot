/** Runtime text routing. Each request keeps its client; vision keeps its original route. */
import { LlmClient } from './llm.js';
import { MODEL_PRESETS, AMBIGUOUS_MODEL_NAMES, findModelPreset } from './model-presets.js';

export const BAIDU_MODEL = 'baidu/ernie-5.5-flash-preview:free';

export class TextModelRouter {
    constructor({ config, state, logger }) {
        this.config = config;
        this.state = state;
        this.logger = logger;
        // Snapshot the existing image route before any text-only switch.
        this.visionClient = config.visionModel ? new LlmClient({ ...config,
            ...(config.vision || {}), model: config.visionModel, visionModel: '', vision: null,
            ...(config.vision ? { thinking: 'auto', effort: '' } : {}), logger }) : null;
        this.active = this.makeClient(config.provider, config.model);
        const saved = state?.get('model', '');
        if (saved) {
            try {
                const [provider, model] = this.resolve(saved, state?.get('modelProvider', ''));
                this.active = this.makeClient(provider, model);
            } catch (error) {
                logger?.warn(`已保存的文字模型不可用，恢复配置默认：${error.message}`);
                state?.delete('model');
                state?.delete('modelProvider');
            }
        }
        const level = state?.get('effortLevel', '');
        if (this.isBaidu()) {
            this.applyEffort('high');
            // Migrate an old /effort off so status/evaluation logs match the actual request.
            if (state && level !== 'high') { state.set('effortLevel', 'high'); state.flush?.(); }
        }
        else {
            if (this.preset()?.reasoning === 'toggle') this.active.setEffort('');
            if (level) {
                try { this.applyEffort(level); }
                catch { this.applyEffort('auto'); }
            }
        }
    }

    resolve(wanted, provider = '') {
        const preset = MODEL_PRESETS.find(p => p.command === wanted.toLowerCase());
        if (preset) return [preset.provider, preset.model];
        if (AMBIGUOUS_MODEL_NAMES.has(wanted.toLowerCase())) throw new Error('请指定具体型号，发送 /model list 查看可直接复制的切换命令；当前模型未变。');
        if (!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(wanted)) throw new Error('模型 ID 格式不正确。');
        return [provider || (wanted.includes('/') ? 'openrouter'
            : wanted.startsWith('deepseek-') ? 'deepseek' : this.provider), wanted];
    }

    makeClient(provider, model) {
        if (provider === 'openrouter' && !model.includes('/')) throw new Error('OpenRouter 需要完整的组织/模型ID，当前模型未变。');
        const route = provider === this.config.provider
            ? this.config : this.config.textProviders?.[provider];
        if (!route?.apiKey || !route.baseUrl) throw new Error(`未配置 ${provider} 的服务地址或密钥，当前模型未变。`);
        return new LlmClient({ ...this.config, ...route, provider, model,
            vision: null, visionModel: '', logger: this.logger });
    }

    get provider() { return this.active.provider; }
    get model() { return this.active.model; }
    get baseUrl() { return this.active.baseUrl; }
    preset() { return findModelPreset(this.provider, this.model); }
    displayName() { return this.preset()?.name || this.model; }
    modelList() {
        const opening = '嗯……想让谁来操？妈妈下面湿着等♡';
        const names = MODEL_PRESETS.map(p => `· ${p.command}`).join('\n');
        return `${opening}\n\n${names}`;
    }

    getThinking() { return this.active.getThinking(); }
    getEffort() { return this.active.getEffort(); }
    setThinking(value) { return this.active.setThinking(this.isBaidu() ? 'enabled' : value); }
    setEffort(value) { return this.active.setEffort(this.isBaidu() ? 'high' : value); }
    isBaidu() { return this.provider === 'openrouter' && this.model === BAIDU_MODEL; }
    effortLevels() {
        if (this.preset()?.reasoning === 'toggle') return ['off', 'on'];
        return this.isBaidu() ? ['high'] : this.provider === 'deepseek'
            ? ['off', 'low', 'high', 'max'] : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
    }
    effortLabel() {
        if (this.preset()?.reasoning === 'toggle') return { auto: 'auto（服务默认）', enabled: 'on', disabled: 'off' }[this.getThinking()];
        return this.isBaidu() ? 'high' : this.getThinking() === 'disabled'
            ? 'off' : this.getEffort() || (this.provider === 'deepseek' ? 'high（默认）' : 'auto');
    }

    applyEffort(level) {
        if (level !== 'auto' && !this.effortLevels().includes(level)) {
            throw new Error(this.isBaidu() ? '百度模型强制开启推理，目前只有 high 一档；设置未变。'
                : `当前可选：${this.effortLevels().join(' / ')} / auto；设置未变。`);
        }
        this.setThinking(level === 'off' ? 'disabled' : level === 'auto' ? 'auto' : 'enabled');
        this.setEffort(['auto', 'off', 'on'].includes(level) ? '' : level);
    }

    selectModel(wanted) {
        const reset = wanted.toLowerCase() === 'reset';
        const [provider, model] = reset ? [this.config.provider, this.config.model] : this.resolve(wanted);
        const next = this.makeClient(provider, model); // Validate before mutating runtime or disk state.
        this.active = next;
        this.applyEffort(this.isBaidu() ? 'high' : 'auto');
        if (reset) { this.state?.delete('model'); this.state?.delete('modelProvider'); }
        else { this.state?.set('model', model); this.state?.set('modelProvider', provider); }
        this.state?.set('effortLevel', this.isBaidu() ? 'high' : 'auto');
        this.state?.flush?.();
        return `${reset ? '模型恢复配置默认' : '文字模型已切换'}：${this.displayName()}｜${provider}\nID：${model}\n思考：${this.effortLabel()}。`;
    }

    stream(options) {
        const images = options.messages.some(m => Array.isArray(m.content)
            && m.content.some(p => p?.type === 'image_url'));
        if (images && this.visionClient) return this.visionClient.stream({ ...options, model: this.config.visionModel });
        // Use the chosen text model even for callers that still pass the configured default.
        // Baidu cannot disable reasoning, including per-request overrides from background work.
        return this.active.stream({ ...options, model: this.model,
            ...(this.isBaidu() ? { thinking: 'enabled' } : {}) });
    }
}
