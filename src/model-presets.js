/** Explicit model names. Add future text presets here; never assign a vendor to a moving default. */
export const MODEL_PRESETS = [
    {
        command: 'ernie-5.5-flash-preview-free', name: 'ERNIE-5.5-Flash-Preview（免费）',
        provider: 'openrouter', model: 'baidu/ernie-5.5-flash-preview:free',
        reasoning: 'mandatory-high', billing: '免费',
    },
    {
        command: 'deepseek-v4.1-flash', name: 'DeepSeek-V4.1-Flash',
        provider: 'deepseek', model: 'deepseek-flash', billing: '按官方用量计费',
    },
    {
        command: 'deepseek-v4-pro', name: 'DeepSeek-V4-Pro',
        provider: 'deepseek', model: 'deepseek-v4-pro', billing: '按官方用量计费',
    },
    {
        command: 'mimo-v2.6-flash', name: 'MiMo-V2.6-Flash',
        provider: 'openrouter', model: 'xiaomi/mimo-v2.6-flash',
        reasoning: 'toggle', billing: '付费，按 OpenRouter 用量计费',
    },
];

export const AMBIGUOUS_MODEL_NAMES = new Set(['baidu', '百度', 'ernie', 'deepseek', 'flash', 'pro', 'mimo', '小米']);

export function findModelPreset(provider, model) {
    return MODEL_PRESETS.find(preset => preset.provider === provider && preset.model === model);
}
