/**
 * 配置加载 —— 全部走环境变量，容器 / Altare / 本地一套逻辑。
 *
 * 变量名沿用既有约定（QQBOT_APPID / QQBOT_SECRET / DEEPSEEK_API_KEY），
 * 换环境时直接照抄，不用重新记一套名字。
 *
 * 服务器基线：6 GiB 内存 / 150% CPU / 10 GB 磁盘 / 最多 4 个实例。
 * 并发、临时盘、语音闸门的默认值都按这个基线给，留足余量。
 */
import path from 'node:path';

import { defaultStyleFor } from './voice-style.js';

function str(v, fallback = '') {
    return typeof v === 'string' && v.trim() !== '' ? v.trim() : fallback;
}

function int(v, fallback) {
    return v === undefined || String(v).trim() === '' ? fallback : Number(v);
}

function bool(v, fallback) {
    if (v === undefined || v === null || v === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(String(v).trim().toLowerCase());
}

function list(v) {
    return str(v) === '' ? [] : str(v).split(',').map((s) => s.trim()).filter(Boolean);
}

export function loadConfig(env = process.env) {
    const dataDir = str(env.DATA_DIR, path.join(process.cwd(), 'data'));
    const tmpRoot = path.join(dataDir, 'tmp');
    let llmBaseUrl = str(env.LLM_BASE_URL, 'https://api.deepseek.com').replace(/\/+$/, '');
    let host = '';
    try { host = new URL(llmBaseUrl).hostname; } catch { /* validateConfig reports invalid URLs. */ }
    const provider = str(env.LLM_PROVIDER, 'auto') === 'auto'
        ? ({ 'api.deepseek.com': 'deepseek', 'openrouter.ai': 'openrouter', 'api.openai.com': 'openai' })[host] || 'generic'
        : str(env.LLM_PROVIDER);
    if (llmBaseUrl === 'https://openrouter.ai') llmBaseUrl += '/api/v1';
    const providerKeys = { deepseek: env.DEEPSEEK_API_KEY, openrouter: env.OPENROUTER_API_KEY, openai: env.OPENAI_API_KEY };
    const providerKey = providerKeys[provider];
    const apiKey = str(env.LLM_API_KEY) || str(providerKey);
    // A separate vision route must never borrow a different service's credentials.
    const independentVision = Boolean(str(env.LLM_VISION_PROVIDER) || str(env.LLM_VISION_BASE_URL) || str(env.LLM_VISION_API_KEY));
    const visionBaseOverride = str(env.LLM_VISION_BASE_URL).replace(/\/+$/, '');
    let visionHost = '';
    try { visionHost = new URL(visionBaseOverride).hostname; } catch { /* Validated below. */ }
    const visionProvider = str(env.LLM_VISION_PROVIDER, 'auto') === 'auto'
        ? (visionBaseOverride
            ? ({ 'api.deepseek.com': 'deepseek', 'openrouter.ai': 'openrouter', 'api.openai.com': 'openai' })[visionHost] || 'generic'
            : provider)
        : str(env.LLM_VISION_PROVIDER);
    let visionBaseUrl = visionBaseOverride || (visionProvider === provider ? llmBaseUrl
        : { deepseek: 'https://api.deepseek.com', openrouter: 'https://openrouter.ai/api/v1', openai: 'https://api.openai.com/v1' }[visionProvider] || '');
    if (visionBaseUrl === 'https://openrouter.ai') visionBaseUrl += '/api/v1';
    const visionKey = str(env.LLM_VISION_API_KEY)
        || (visionProvider === provider && visionBaseUrl === llmBaseUrl ? apiKey : str(providerKeys[visionProvider]));

    const config = {
        qq: {
            appId: str(env.QQBOT_APPID),
            appSecret: str(env.QQBOT_SECRET),
            markdown: bool(env.QQBOT_MARKDOWN, true),
            /** 测试用：覆盖 API 域名 */
            baseUrl: str(env.QQBOT_BASE_URL, ''),
        },
        llm: {
            baseUrl: llmBaseUrl,
            provider,
            apiKey,
            /** Only text switching uses these routes; credentials never enter state.json. */
            textProviders: {
                deepseek: { baseUrl: 'https://api.deepseek.com', apiKey: str(env.DEEPSEEK_API_KEY) },
                openrouter: { baseUrl: 'https://openrouter.ai/api/v1', apiKey: str(env.OPENROUTER_API_KEY) },
            },
            /**
             * DeepSeek 当前线上型号（2026-11 实测 /models）：
             *   deepseek-flash     DeepSeek-V4.1-Flash，1M 上下文，输入支持 text + image
             *   deepseek-v4-pro    DeepSeek-V4-Pro，1M 上下文，输入只有 text
             */
            model: str(env.LLM_MODEL, 'deepseek-flash'),
            /** 视觉模型（留空 = 不做图片理解）。拿 DeepSeek 的话只能是支持图片的 flash。 */
            visionModel: env.LLM_VISION_MODEL === undefined ? (visionProvider === 'deepseek' ? 'deepseek-flash' : '') : str(env.LLM_VISION_MODEL),
            /** Optional independent endpoint; null retains the existing same-service route. */
            vision: independentVision ? { provider: visionProvider, baseUrl: visionBaseUrl, apiKey: visionKey } : null,
            thinking: str(env.LLM_THINKING, 'auto'),
            /** low / high / max；留空沿用服务默认（high） */
            effort: str(env.LLM_EFFORT, ''), // '' = 按 high 处理；/effort 四档：off/low/high/max
            maxTokens: int(env.LLM_MAX_TOKENS, 8192),
            temperature: env.LLM_TEMPERATURE === undefined || String(env.LLM_TEMPERATURE).trim() === ''
                ? 1.0 : Number(env.LLM_TEMPERATURE),
            timeoutMs: int(env.LLM_TIMEOUT_MS, 180_000),
            maxToolRounds: int(env.LLM_MAX_TOOL_ROUNDS, 4),
        },
        behavior: {
            requireMentionInGroup: bool(env.REQUIRE_MENTION, true),
            streaming: bool(env.STREAMING, true),
            historyLimit: int(env.HISTORY_LIMIT, 20),
            historyBytes: int(env.HISTORY_BYTES, 64_000),
            groupHistoryLimit: int(env.GROUP_HISTORY_LIMIT, 10),
            textChunkLimit: int(env.TEXT_CHUNK_LIMIT, 4_500),
            /** 普通聊天和长语音分别限制生成耗时，均保留 /stop 取消。 */
            replyTimeoutMs: int(env.REPLY_TIMEOUT_MS, 240_000),
            longReplyTimeoutMs: int(env.LONG_REPLY_TIMEOUT_MS, 900_000),
            typingIndicator: bool(env.TYPING_INDICATOR, false),
            /** 允许模型调用 remember 工具写长期记忆 */
            enableRememberTool: bool(env.ENABLE_REMEMBER_TOOL, true),
            /** 每条消息处理完把一行摘要写进 conversation 流水 */
            logConversation: bool(env.LOG_CONVERSATION, false),
            maxConcurrency: int(env.MAX_CONCURRENCY, 4),
            /** 同一 peer 两条消息之间的最小间隔（0 = 关闭），防刷 */
            peerCooldownMs: int(env.PEER_COOLDOWN_MS, 800),
            /** 单 peer 每分钟最多处理多少条（0 = 关闭） */
            peerRatePerMin: int(env.PEER_RATE_PER_MIN, 12),
        },
        /** 评分用：把每轮对话原样记一份，供 scripts/eval.mjs 打分 */
        eval: {
            log: bool(env.EVAL_LOG, false),
            dir: str(env.EVAL_LOG_DIR, path.join(dataDir, 'eval')),
            judgeModel: str(env.EVAL_JUDGE_MODEL, ''),
        },

        companion: {
            natural: bool(env.CHAT_NATURAL, true),
            enabled: bool(env.PROACTIVE_ENABLED, true),
            dailyMax: int(env.PROACTIVE_DAILY_MAX, 4),
            idleMinMs: int(env.PROACTIVE_MIN_IDLE_MINUTES, 90) * 60_000,
            idleMaxMs: int(env.PROACTIVE_MAX_IDLE_MINUTES, 180) * 60_000,
            quietStart: int(env.PROACTIVE_QUIET_START, 23),
            quietEnd: int(env.PROACTIVE_QUIET_END, 9),
            checkEveryMs: 60_000,
            timeoutMs: 60_000,
            maxChars: 240,
        },
        access: {
            ownerOpenid: str(env.OWNER_OPENID),
            c2cMode: str(env.C2C_MODE, 'open'),
            c2cAllow: list(env.C2C_ALLOW),
            groupMode: str(env.GROUP_MODE, 'disabled'),
            groupAllow: list(env.GROUP_ALLOW),
        },
        /**
         * 用户明确仅供自己私聊使用；保留旧配置键用于检查误配置。
         */
        scope: {
            mode: str(env.SCOPE_MODE, 'c2c'),
        },
        memory: {
            enabled: bool(env.MEMORY_ENABLED, true),
            dbPath: str(env.MEMORY_DB, path.join(dataDir, 'memory', 'xiaoyan-memory.db')),
            /** 首次启动时用来初始化的种子库（镜像里带一份，本地通常为空路径）。 */
            seedPath: str(env.MEMORY_SEED, ''),
            /**
             * 严格写入：禁掉 event 类型（流水账都在这档）、加禁止清单、加长度封顶。
             * 旧版最大的毛病就是聊天里什么都往里塞。
             */
            strict: bool(env.MEMORY_STRICT, true),
            /** 单条记忆最多多少字，超了截断 */
            maxContent: int(env.MEMORY_MAX_CONTENT, 200),
            injectLimit: int(env.MEMORY_INJECT_LIMIT, 30),
            injectMaxChars: int(env.MEMORY_INJECT_MAX_CHARS, 8_000),
            /** 老会话每轮注入的压缩记忆（条数 / 字符） */
            warmInjectLimit: int(env.MEMORY_WARM_INJECT_LIMIT, 8),
            warmInjectChars: int(env.MEMORY_WARM_INJECT_CHARS, 1_200),
            /** 群聊里的记忆作用域：off 不注入 / limited 只注入 all+group / full 全量 */
            groupMode: str(env.MEMORY_GROUP_MODE, 'limited'),
            /** remember 工具在群聊里默认写入的作用域 */
            groupWriteScope: str(env.MEMORY_GROUP_WRITE_SCOPE, 'group'),
        },
        tts: {
            enabled: bool(env.TTS_ENABLED, false),
            engine: str(env.TTS_ENGINE, 'qwen'),
            defaultVoice: str(env.TTS_VOICE, ''),
            style: str(env.TTS_STYLE, defaultStyleFor(str(env.TTS_ENGINE, 'qwen'))),
            /**
             * 通义 Qwen-Audio-TTS（阿里云百炼 / DashScope）
             *   qwen-audio-3.1-tts-flash  默认：88 个音色全支持、更快
             *   qwen-audio-3.1-tts-plus   质量档，但只认 longanlingxin / longanhuan / longanfengyue 三个音色
             * 走 /api/v1/services/audio/tts/SpeechSynthesizer，非流式返回音频 URL。
             */
            qwenBaseUrl: str(env.TTS_QWEN_BASE_URL, 'https://dashscope.aliyuncs.com/api/v1').replace(/\/+$/, ''),
            qwenModel: str(env.TTS_QWEN_MODEL, 'qwen-audio-3.1-tts-flash'),
            qwenVoice: str(env.TTS_QWEN_VOICE, 'longanlingxin_v3.1'),
            qwenSampleRate: int(env.TTS_QWEN_SAMPLE_RATE, 24000),
            /** 用 SSML 给句子之间塞硬停顿：纯文本念快了会挤在一起 */
            ssml: bool(env.TTS_SSML, true),
            pauseMs: int(env.TTS_PAUSE_MS, 600),
            qwenApiKey: str(env.TTS_QWEN_API_KEY) || str(env.DASHSCOPE_API_KEY),
            /** openai 兼容 /audio/speech */
            openaiBaseUrl: str(env.TTS_OPENAI_BASE_URL, 'https://api.openai.com/v1').replace(/\/+$/, ''),
            openaiModel: str(env.TTS_OPENAI_MODEL, 'tts-1'),
            openaiVoice: str(env.TTS_OPENAI_VOICE, 'alloy'),
            apiKey: str(env.TTS_API_KEY) || str(env.OPENAI_API_KEY),
            /** 资源闸门：同时合成 / 排队上限 / 单次超时。单聊无人抢，给得比群聊宽。 */
            maxConcurrency: int(env.TTS_MAX_CONCURRENCY, 3),
            queueMax: int(env.TTS_QUEUE_MAX, 8),
            timeoutMs: int(env.TTS_TIMEOUT_MS, 30_000),
            /** 单次合成最多多少字（超出截断，不报错） */
            maxChars: int(env.TTS_MAX_CHARS, 8000),
            /** 合成结果字节上限，超出丢弃 */
            maxBytes: int(env.TTS_MAX_BYTES, 16 * 1024 * 1024),
            /** 同一 peer 两次语音之间的冷却 */
            cooldownMs: int(env.TTS_COOLDOWN_MS, 2_000),
            /** 新会话默认就开语音（不用每次 /voice） */
            defaultOn: bool(env.TTS_DEFAULT_ON, true),
            /** 上游单次合成分段字数，用于控制延迟和体积；200 字通常约 45 秒。 */
            segmentChars: int(env.TTS_SEGMENT_CHARS, 600),
            /** 一轮最多发几条语音条，用来拼「长语音」 */
            segmentsMax: int(env.TTS_SEGMENTS_MAX, 3),
            /** 长语音：最多多少分钟、段间留白、投递方式（voice / file / auto） */
            longMaxMinutes: int(env.TTS_LONG_MAX_MINUTES, 15),
            longGapMs: int(env.TTS_LONG_GAP_MS, 250),
            longDelivery: str(env.TTS_LONG_DELIVERY, 'auto'),
            /** 拼好的整条音频体积上限（15 分钟 wav 约 42MB） */
            longMaxBytes: int(env.TTS_LONG_MAX_MB, 64) * 1024 * 1024,
            /**
             * QQ 语音条的软上限是 20MB（超了平台自动降级成文件卡片）。
             * 这里留点余量：先按原音质分条，条数超出发送额度时再尝试降采样。
             */
            voiceSoftLimitBytes: int(env.TTS_VOICE_SOFT_LIMIT_MB, 18) * 1024 * 1024,
            /** 语速估算：每秒多少字（冰糖实测约 4.9），用来把「分钟」换算成字数 */
            charsPerSecond: Number(str(env.TTS_CHARS_PER_SECOND, '4.9')) || 4.9,
            /** 临时音频：目录 / 保留时长 / 目录总大小上限 */
            tmpDir: str(env.TTS_TMP_DIR, path.join(tmpRoot, 'tts')),
            ttlMinutes: int(env.TTS_TTL_MINUTES, 60),
            tmpMaxMb: int(env.TTS_TMP_MAX_MB, 256),
            sweepMs: int(env.TTS_SWEEP_MS, 5 * 60_000),
            /** 克隆音色目录：丢进去就自动成为可调用音色 */
            voiceDir: path.join(dataDir, 'voice'),
        },
        commands: {
            enabled: bool(env.COMMANDS_ENABLED, true),
            /** 允许的指令前缀 */
            prefixes: list(env.COMMAND_PREFIXES).length > 0 ? list(env.COMMAND_PREFIXES) : ['/', '／'],
        },
        uncensor: {
            /** 输出侧拒答检测 + 一次重生成 */
            enabled: bool(env.UNCENSOR_ENABLED, true),
            retries: int(env.UNCENSOR_RETRIES, 3),
            /** 被上游内容过滤掐断时重试 */
            retryOnFilter: bool(env.UNCENSOR_RETRY_ON_FILTER, true),
        },
        state: {
            file: str(env.STATE_FILE, path.join(dataDir, 'state.json')),
        },
        /**
         * 场景音频生成（阿里云百炼 qwen-audio-3.1-tts-next）：
         * 一段描述里同时写台词、语气、雨声/呼吸/床单摩擦，一次出一条带环境的音频。
         * 单次上限 120 秒，生成耗时约等于音频时长 ×1.3。
         */
        scene: {
            enabled: bool(env.SCENE_ENABLED, false),
            model: str(env.SCENE_MODEL, 'qwen-audio-3.1-tts-next'),
            baseUrl: str(env.SCENE_BASE_URL, str(env.TTS_QWEN_BASE_URL, 'https://dashscope.aliyuncs.com/api/v1')).replace(/\/+$/, ''),
            apiKey: str(env.SCENE_API_KEY) || str(env.TTS_QWEN_API_KEY) || str(env.DASHSCOPE_API_KEY),
            /** 一次最多生成多少秒（模型自己决定长度，这里只是给提示和兜底） */
            maxSeconds: int(env.SCENE_MAX_SECONDS, 120),
            /** 场景描述最多多少字 */
            maxPromptChars: int(env.SCENE_MAX_PROMPT_CHARS, 1500),
            /** 单次下载的体积上限 */
            maxBytes: int(env.SCENE_MAX_MB, 32) * 1024 * 1024,
            /** 生成超时：120 秒音频大约 160 秒出，留足余量 */
            timeoutMs: int(env.SCENE_TIMEOUT_MS, 300_000),
            sampleRate: int(env.SCENE_SAMPLE_RATE, 24_000),
            tmpDir: str(env.SCENE_TMP_DIR, path.join(tmpRoot, 'scene')),
            voiceSoftLimitBytes: int(env.TTS_VOICE_SOFT_LIMIT_MB, 18) * 1024 * 1024,
        },
        /** 表情包 / 图片素材：丢进 data/assets/，文件名就是它的名字 */
        assets: {
            enabled: bool(env.ASSETS_ENABLED, true),
            dir: str(env.ASSETS_DIR, path.join(dataDir, 'assets')),
            maxBytes: int(env.ASSETS_MAX_MB, 20) * 1024 * 1024,
        },
        /** 日志与「现在几点」用的时区；容器常是 UTC，所以显式带上 */
        timezone: str(env.TZ, 'Asia/Shanghai'),
        dataDir,
        sessionDir: str(env.SESSION_DIR, path.join(dataDir, 'sessions')),
        debug: bool(env.DEBUG, false),
    };

    // qwen 用自己的 key；没配就退回通用 key
    if (config.tts.engine === 'qwen' && config.tts.qwenApiKey) config.tts.apiKey = config.tts.qwenApiKey;

    // 默认音色跟着引擎走：旧配置里的 MiMo 音色名（冰糖/茉莉…）在 qwen 上会被拒
    const legacyVoices = new Set(['冰糖', '茉莉', '苏打', '白桦', 'Mia', 'Chloe', 'Milo', 'Dean', 'mimo_default']);
    if (config.tts.defaultVoice === '' || legacyVoices.has(config.tts.defaultVoice)) {
        config.tts.defaultVoice = config.tts.engine === 'qwen' ? config.tts.qwenVoice : 'alloy';
    }

    return config;
}

/** 启动前自检，把「配错了但跑到半夜才发现」的问题挡在门口。 */
export function validateConfig(config) {
    const problems = [];
    if (!config.qq.appId) problems.push('QQBOT_APPID 未设置（QQ 机器人 AppID）');
    if (!config.qq.appSecret) problems.push('QQBOT_SECRET 未设置（QQ 机器人 AppSecret）');
    if (!config.llm.apiKey) problems.push('模型 API Key 未设置：填写当前服务专用 key 或 LLM_API_KEY');
    if (!['deepseek', 'openrouter', 'openai', 'generic'].includes(config.llm.provider)) problems.push('LLM_PROVIDER 只能是 auto / deepseek / openrouter / openai / generic');
    if (!config.llm.model) problems.push('LLM_MODEL 为空');
    try { new Intl.DateTimeFormat('zh-CN', { timeZone: config.timezone }); }
    catch { problems.push('TZ 必须是有效时区，例如 Asia/Shanghai'); }
    if (!Number.isSafeInteger(config.companion.dailyMax) || config.companion.dailyMax < 1 || config.companion.dailyMax > 24) problems.push('PROACTIVE_DAILY_MAX 必须为 1 到 24 的整数');
    for (const [name, value] of [['PROACTIVE_MIN_IDLE_MINUTES', config.companion.idleMinMs], ['PROACTIVE_MAX_IDLE_MINUTES', config.companion.idleMaxMs]]) {
        if (!Number.isSafeInteger(value) || value < 60_000 || value > 7 * 86_400_000) problems.push(`${name} 必须为 1 到 10080 之间的分钟数`);
    }
    if (config.companion.idleMinMs > config.companion.idleMaxMs) problems.push('PROACTIVE_MIN_IDLE_MINUTES 不得大于 PROACTIVE_MAX_IDLE_MINUTES');
    for (const [name, value] of [['PROACTIVE_QUIET_START', config.companion.quietStart], ['PROACTIVE_QUIET_END', config.companion.quietEnd]]) {
        if (!Number.isSafeInteger(value) || value < 0 || value > 23) problems.push(`${name} 必须为 0 到 23 的整数`);
    }
    if (config.companion.quietStart === config.companion.quietEnd) problems.push('主动聊天免打扰的开始和结束小时不能相同');
    for (const [name, value] of Object.entries({
        LLM_MAX_TOKENS: config.llm.maxTokens, LLM_TIMEOUT_MS: config.llm.timeoutMs,
        LLM_MAX_TOOL_ROUNDS: config.llm.maxToolRounds, HISTORY_LIMIT: config.behavior.historyLimit,
        HISTORY_BYTES: config.behavior.historyBytes, GROUP_HISTORY_LIMIT: config.behavior.groupHistoryLimit,
        TEXT_CHUNK_LIMIT: config.behavior.textChunkLimit, REPLY_TIMEOUT_MS: config.behavior.replyTimeoutMs,
        LONG_REPLY_TIMEOUT_MS: config.behavior.longReplyTimeoutMs,
        MAX_CONCURRENCY: config.behavior.maxConcurrency, MEMORY_INJECT_LIMIT: config.memory.injectLimit,
        MEMORY_INJECT_MAX_CHARS: config.memory.injectMaxChars, TTS_MAX_CONCURRENCY: config.tts.maxConcurrency,
        TTS_QUEUE_MAX: config.tts.queueMax, TTS_TIMEOUT_MS: config.tts.timeoutMs,
        TTS_MAX_CHARS: config.tts.maxChars, TTS_MAX_BYTES: config.tts.maxBytes,
        TTS_LONG_MAX_BYTES: config.tts.longMaxBytes, TTS_VOICE_SOFT_LIMIT_BYTES: config.tts.voiceSoftLimitBytes,
        SCENE_MAX_SECONDS: config.scene.maxSeconds, SCENE_MAX_PROMPT_CHARS: config.scene.maxPromptChars,
        SCENE_MAX_BYTES: config.scene.maxBytes, SCENE_TIMEOUT_MS: config.scene.timeoutMs, SCENE_SAMPLE_RATE: config.scene.sampleRate,
        TTS_TTL_MINUTES: config.tts.ttlMinutes, TTS_TMP_MAX_MB: config.tts.tmpMaxMb,
        TTS_SWEEP_MS: config.tts.sweepMs,
    })) {
        if (!Number.isSafeInteger(value) || value <= 0) problems.push(`${name} 必须为正整数`);
    }
    // 允许 0 = 关闭的开关
    for (const [name, value] of Object.entries({
        PEER_COOLDOWN_MS: config.behavior.peerCooldownMs, PEER_RATE_PER_MIN: config.behavior.peerRatePerMin,
        TTS_COOLDOWN_MS: config.tts.cooldownMs,
    })) {
        if (!Number.isSafeInteger(value) || value < 0) problems.push(`${name} 必须为非负整数（0 = 关闭）`);
    }
    for (const [name, value] of Object.entries({
        MEMORY_WARM_INJECT_LIMIT: config.memory.warmInjectLimit,
        MEMORY_WARM_INJECT_CHARS: config.memory.warmInjectChars,
        TTS_SEGMENT_CHARS: config.tts.segmentChars,
        TTS_SEGMENTS_MAX: config.tts.segmentsMax,
        TTS_LONG_MAX_MINUTES: config.tts.longMaxMinutes,
        TTS_LONG_GAP_MS: config.tts.longGapMs,
        MEMORY_MAX_CONTENT: config.memory.maxContent,
    })) {
        if (!Number.isSafeInteger(value) || value <= 0) problems.push(`${name} 必须为正整数`);
    }
    if (!Number.isFinite(config.llm.temperature) || config.llm.temperature < 0 || config.llm.temperature > 2) problems.push('LLM_TEMPERATURE 必须在 0 到 2 之间');
    if (!['auto', 'enabled', 'disabled'].includes(config.llm.thinking)) problems.push('LLM_THINKING 只能是 auto / enabled / disabled');
    if (!['', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].includes(config.llm.effort)) problems.push('LLM_EFFORT 必须是 none / minimal / low / medium / high / xhigh / max（留空 = 服务默认；具体档位以模型目录为准）');
    if (config.scope.mode !== 'c2c') problems.push('个人专用版仅支持 SCOPE_MODE=c2c（只接受主人私聊）');
    // deepseek-v4-pro 的输入只有 text，拿它当视觉模型会一直 400
    if (config.llm.visionModel === 'deepseek-v4-pro') {
        problems.push('LLM_VISION_MODEL=deepseek-v4-pro 不支持图片输入，请改成 deepseek-flash');
    }
    if (config.llm.vision) {
        const vision = config.llm.vision;
        if (!['deepseek', 'openrouter', 'openai', 'generic'].includes(vision.provider)) problems.push('LLM_VISION_PROVIDER 只能是 auto / deepseek / openrouter / openai / generic');
        try {
            const url = new URL(vision.baseUrl);
            if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
        } catch { problems.push('LLM_VISION_BASE_URL 必须为不含账号密码的 HTTP(S) 地址'); }
        if (config.llm.visionModel && !vision.apiKey) problems.push('独立视觉模型缺少密钥：填写对应服务专用 key 或 LLM_VISION_API_KEY');
        if (vision.provider === 'openrouter' && config.llm.visionModel && !config.llm.visionModel.includes('/')) {
            problems.push('OpenRouter 的 LLM_VISION_MODEL 需要完整的组织/模型 ID');
        }
    }
    if (config.access.groupMode !== 'disabled') {
        problems.push('个人专用版 GROUP_MODE 必须是 disabled（不接收群聊）');
    }
    if (!['off', 'limited', 'full'].includes(config.memory.groupMode)) problems.push('MEMORY_GROUP_MODE 只能是 off / limited / full');
    if (!['all', 'c2c', 'group'].includes(config.memory.groupWriteScope)) problems.push('MEMORY_GROUP_WRITE_SCOPE 只能是 all / c2c / group');
    if (!['qwen', 'openai'].includes(config.tts.engine)) problems.push('TTS_ENGINE 只能是 qwen / openai');
    if (!['voice', 'file', 'auto'].includes(config.tts.longDelivery)) problems.push('TTS_LONG_DELIVERY 只能是 voice / file / auto');
    if (!Number.isFinite(config.tts.charsPerSecond) || config.tts.charsPerSecond <= 0 || config.tts.charsPerSecond > 20) {
        problems.push('TTS_CHARS_PER_SECOND 必须是 0 到 20 之间的数字');
    }
    if (config.behavior.longReplyTimeoutMs > 55 * 60_000) problems.push('LONG_REPLY_TIMEOUT_MS 不得超过 3300000，需为单聊回复有效期留出余量');
    if (config.tts.enabled && !config.tts.apiKey) {
        problems.push(config.tts.engine === 'qwen'
            ? 'TTS_ENABLED=true 且 TTS_ENGINE=qwen，但缺少 TTS_QWEN_API_KEY（或 DASHSCOPE_API_KEY / TTS_API_KEY）'
            : 'TTS_ENABLED=true 但缺少 TTS_API_KEY（或 OPENAI_API_KEY）');
    }
    if (config.tts.segmentChars > config.tts.maxChars) problems.push('TTS_SEGMENT_CHARS 不得大于 TTS_MAX_CHARS，以免分段正文被截断');
    const tmp = path.resolve(config.tts.tmpDir);
    for (const protectedPath of [process.cwd(), config.dataDir, config.sessionDir, config.memory.dbPath, config.state.file, config.tts.voiceDir, config.assets.dir, path.join(config.dataDir, 'owner.json')]) {
        const relative = path.relative(tmp, path.resolve(protectedPath));
        if (relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))) {
            problems.push('TTS_TMP_DIR 必须是独立临时目录，不能包含项目、配置、记忆、会话或音源目录');
            break;
        }
    }
    try {
        const url = new URL(config.llm.baseUrl);
        if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error();
    } catch { problems.push('LLM_BASE_URL 必须为不含账号密码的 HTTP(S) 地址'); }
    if (config.tts.enabled) {
        for (const [name, value] of [['TTS_OPENAI_BASE_URL', config.tts.openaiBaseUrl]]) {
            try {
                const url = new URL(value);
                if (!['https:', 'http:'].includes(url.protocol)) throw new Error();
            } catch { problems.push(`${name} 必须为 HTTP(S) 地址`); }
        }
    }
    for (const key of ['c2cMode', 'groupMode']) {
        const v = config.access[key];
        if (!['open', 'allowlist', 'disabled'].includes(v)) {
            problems.push(`访问控制 ${key}=${v} 非法，只能是 open / allowlist / disabled`);
        }
    }
    return problems;
}
















