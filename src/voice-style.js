/**
 * 语音风格指令——教模型「怎么写」。
 *
 * Qwen 的 instruction 实测会毁长文本的韵律（忽大忽小、语气跳变），所以默认不发；
 * 想加戏就靠正文里的官方英文标签，停顿则由 SSML 自动补。
 * 运行时只注入当前引擎那一份精简版，只在语音开着时进 system prompt。
 *
 * 完整版在 docs/voice-style-qwen.md。
 */

/** 各引擎的默认风格指令（TTS_STYLE 没配时用）。 */
export const DEFAULT_STYLE = {
    // Qwen 的 instruction 会让长文本的音量/韵律在中途跳变（同一段里忽大忽小），默认不发。
    // 想加就写一句，别写长：气声、语速很慢、贴着耳朵说话。
    qwen: '',
    openai: '自然、清晰，语速偏慢，带一点喘息。',
};

const QWEN_GUIDE = `## 怎么用 Qwen 让声音好听（这是你现在的引擎）

**停顿已经由系统自动加了**：正文里正常的句号、问号、省略号，系统会按句子补硬停顿（省略号后面停更久）。
所以不要写「（停顿）」「（沉默两秒）」这类东西，也不用为了拖节奏故意断句——按人话写就行。

**加戏靠官方标签**，写在句首，它真的会演出来：
[whispers] 耳语　[sighing] 叹气　[gasp] 吸气　[asmr] 贴耳感　[laughing] 笑　[giggles] 轻笑
[crying] 哭腔　[trembling] 发颤　[very slowly] 很慢　[very fast] 很快　[excited] 兴奋　[tired] 疲惫
一段里放 3～6 个就够，别每句都加，情绪转折处放一个最有效。

**中文括号一律不要写**：（小声）（语速加快）这种 Qwen 会照着念出来，句子还会被念断。

**instruction（TTS_STYLE）默认是空的，别去填**：实测加了它长文本会忽大忽小、语气跳变，比不加差。
真想换声音就换音色。

音色只能从系统音色清单里挑，写别的名字会被拒。`;

const OPENAI_GUIDE = `## 怎么给 OpenAI 兼容 TTS 写风格指令

标准 /audio/speech 没有风格参数：style 传过去也不会生效。
想让语气有变化只能靠标点和断句（逗号、句号、换行），以及选一个合适的 voice。`;

const GUIDES = { qwen: QWEN_GUIDE, openai: OPENAI_GUIDE };

/**
 * 返回该引擎的风格写法提示；未知引擎返回空串（不占 prompt）。
 * @param {string} engine
 */
export function buildVoiceStyleSection(engine) {
    return GUIDES[engine] ?? '';
}

/** 该引擎的默认风格指令。 */
export function defaultStyleFor(engine) {
    return DEFAULT_STYLE[engine] ?? '';
}


