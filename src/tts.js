/**
 * 语音合成 —— 把文字变成能塞进 QQ 语音条的音频。
 *
 * 云上跑的三个硬约束，全部在这里兜住：
 *   1. 并发：同时合成最多 maxConcurrency 个，排队超过 queueMax 直接拒绝，
 *      不让音频任务把模型请求的 CPU / 内存挤掉。
 *   2. 体积：单次结果超 maxBytes 就丢；临时目录超 tmpMaxMb 先清扫再决定。
 *   3. 清理：发送完立刻删；崩了由定时清扫按 ttlMinutes 兜底；启动时全清。
 *
 * 引擎：qwen（阿里云百炼 Qwen-Audio-TTS）/ openai（/audio/speech 兼容）。
 * 不引任何 npm 依赖，只用 fetch + node:fs。
 */
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import { concatWav } from './audio.js';
import { createLimiter } from './queue.js';
import { chunkText } from './text.js';

const OPENAI_VOICES = [
    { id: 'alloy', name: 'Alloy', gender: '中性', locale: 'en-US' },
    { id: 'echo', name: 'Echo', gender: '男', locale: 'en-US' },
    { id: 'fable', name: 'Fable', gender: '中性', locale: 'en-US' },
    { id: 'onyx', name: 'Onyx', gender: '男', locale: 'en-US' },
    { id: 'nova', name: 'Nova', gender: '女', locale: 'en-US' },
    { id: 'shimmer', name: 'Shimmer', gender: '女', locale: 'en-US' },
];

/** 通义 Qwen-Audio-TTS 系统音色（2026-11 抓自官方音色列表，id|名称|性别）。 */
const QWEN_VOICE_TABLE = 'longanlingxin_v3.1|龙安灵心|女 xunanchuan_v3.1|许南川|男 longanhuan_v3.1|龙安欢|女 longanfengyue_v3.1|龙安风悦|女 yuxiaoyun_v3.1|于小云|女 qiaoxiaojiao_v3.1|乔小娇|女 xiaxiaochen_v3.1|夏小晨|女 anmingyuan_v3.1|安明远|男 wenhuaiqing_v3.1|温怀清|女 anxiaolan_v3.1|安小岚|女 xieshurou_v3.1|谢舒柔|女 baiqinglan_v3.1|白清岚|女 xuyuyuan_v3.1|许玉远|女 anruorou_v3.1|安若柔|女 wenhuaizhi_v3.1|闻怀之|女 xiaoxingzhi_v3.1|萧行之|女 guyunshu_v3.1|顾云舒|女 huozhuoshi_v3.1|霍拙石|男 yeqinghe_v3.1|叶清禾|女 yunhuanhuan_v3.1|云欢欢|女 xuxiaoqiao_v3.1|徐小俏|女 baianran_v3.1|白安然|女 xuyanchu_v3.1|许言初|女 yezhiqing_v3.1|叶知晴|女 andi_v3.1|安迪|男 anyuqing_v3.1|安语晴|女 linxiaoling_v3.1|林小灵|女 longfeifei_v3.1|龙菲菲|女 longjing_v3.1|龙婧|女 longqiang_v3.1|龙嫱|女 longyan_v3.1|龙颜|女 longxiaobai_v3.1|龙小白|女 longyue_v3.1|龙悦|女 longcheng_v3.1|龙橙|男 longlaotie_v3.1|龙老铁|男 longshao_v3.1|龙邵|男 longshu_v3.1|龙书|男 longze_v3.1|龙泽|男 longhao_v3.1|龙浩|男 longjin_v3.1|龙津|男 longnan_v3.1|龙楠|男 longshuo_v3.1|龙硕|男 longtian_v3.1|龙天|男 longxiaocheng_v3.1|龙小诚|男 longke_v3.1|龙可|— loongbella_v3.1|Bella|女 Emily_v3.1|Emily|女 Luna_v3.1|Luna|女 Eric_v3.1|Eric|男 Luca_v3.1|Luca|男 Abby_v3.1|Abby|女 Annie_v3.1|Annie|女 Ava_v3.1|Ava|女 Beth_v3.1|Beth|女 Betty_v3.1|Betty|女 Cally_v3.1|Cally|女 Cindy_v3.1|Cindy|女 Donna_v3.1|Donna|女 Andy_v3.1|Andy|男 Brian_v3.1|Brian|男 David_v3.1|David|男 longanyuanfei_v3.1|龙安元妃|女 longjielidou_v3.1|龙杰力豆|男 longanlingxi_v3.1|龙安灵希|女 longhuohuo_v3.1|龙火火|男 longyingtao_v3.1|龙应桃|女 longanya_v3.1|龙安雅|女 longwan_v3.1|龙婉|女 longxing_v3.1|龙星|女 longhua_v3.1|龙华|女 longhan_v3.1|龙寒|男 longanzhi_v3.1|龙安智|男 longzhe_v3.1|龙哲|男 longanyang_v3.1|龙安洋|男 libai_v3.1|李白|男 longling_v3.1|龙铃|女 longniuniu_v3.1|龙牛牛|男 longshanshan_v3.1|龙闪闪|男 longpaopao_v3.1|龙泡泡|女 loongstella_v3.1|loongstella|女 longyuan_v3.1|龙媛|女 longmiao_v3.1|龙妙|女 longsanshu_v3.1|龙三叔|男 longanli_v3.1|龙安莉|女 longanwen_v3.1|龙安温|女 longanlang_v3.1|龙安朗|男 longxiaoxia_v3.1|龙小夏|女 longanchong_v3.1|龙安冲|男';

export const QWEN_VOICES = QWEN_VOICE_TABLE.split(' ')
    .map((pair) => pair.split('|'))
    .filter((parts) => parts.length === 3)
    .map(([id, name, gender]) => ({
        id,
        name,
        gender,
        locale: /^[\x00-\x7F]+$/.test(name) ? 'en-US' : 'zh-CN',
    }));





/** undici 的 fetch 失败只说 "fetch failed"，真正原因在 error.cause 里。 */
export function describeFetchError(error, url = '') {
    const cause = error?.cause;
    const code = cause?.code || cause?.errno || '';
    const host = (() => {
        try {
            return new URL(url).host;
        } catch {
            return '';
        }
    })();
    const detail = [code, cause?.syscall, cause?.hostname || host].filter(Boolean).join(' ');
    return detail ? `${error?.message || error}（${detail}）` : String(error?.message || error);
}

/** 只有网络层错误才值得重试；4xx/5xx 交给调用方处理。 */
export function isTransientFetchError(error) {
    const code = error?.cause?.code || '';
    return (
        error?.name === 'TypeError' ||
        ['ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_SOCKET', 'EPIPE'].includes(code)
    );
}

/** Qwen TTS 官方支持的情感/拟声标签（写在正文里，形如 [whispers]）。 */
export const QWEN_TAGS = new Set([
    'amazed', 'angry', 'asmr', 'bored', 'clears throat', 'cough', 'crying', 'curious',
    'deep and loud shouting', 'empathetic', 'excited', 'gasp', 'giggles', 'laughing',
    'like dracula', 'mischievously', 'panicked', 'reluctantly', 'sad', 'sarcastic',
    'scornful', 'serious', 'shouting', 'sighing', 'snorts', 'tired', 'trembling',
    'very fast', 'very slowly', 'whispers',
]);

/** 中文舞台提示的关键词：只有命中这些才当成「提示」，不然「（含税）」这种正文会被误删。 */
const DIRECTION_WORDS = [
    '小声', '低语', '耳语', '放低', '压低', '语速', '加快', '放慢', '深呼吸', '叹气', '叹息',
    '喘', '呼吸', '停顿', '沉默', '咳嗽', '吞咽', '笑', '哭', '颤', '紧张', '兴奋', '疲惫',
    '温柔', '冷淡', '嘲', '加重', '轻轻', '哼', '气声', '拖长',
];

const isDirection = (inner) => {
    const s = String(inner ?? '').trim();
    if (s === '' || s.length > 12) return false;
    if (/\d/.test(s)) return false; // 「（含税100%）」这类别动
    return DIRECTION_WORDS.some((w) => s.includes(w));
};

/**
 * 按引擎整理朗读文本。
 *
 * - Qwen / OpenAI 兼容：官方支持 `[whispers]` `[asmr]` 这类英文标签，保留；
 *   中文「（小声）」它只会照念出来（实测同文本 3.68s → 5.92s），所以只剥**看起来像提示**的括号，
 *   「100元（含税）」这种正文原样留着。
 *
 * @param {string} text
 * @param {'qwen'|'openai'} engine
 */
export function prepareSpeechText(text, engine) {
    const src = String(text ?? '');
    // 方括号：英文词的才算标签；支持的白名单保留，其余当无效标签去掉；含中文/数字的保留
    const withTags = src.replace(/[\[【]([^\[\]【】]{1,40})[\]】]/g, (all, inner) => {
        const s = String(inner ?? '').trim();
        if (!/^[a-zA-Z][a-zA-Z _-]*$/.test(s)) return all;
        return QWEN_TAGS.has(s.toLowerCase()) ? `[${s.toLowerCase()}]` : ' ';
    });

    // 圆括号 / 中文括号：只删「像提示」的
    return withTags
        .replace(/（([^（）]{1,40})）/g, (all, inner) => (isDirection(inner) ? ' ' : all))
        .replace(/\(([^()]{1,40})\)/g, (all, inner) => (isDirection(inner) ? ' ' : all))
        .replace(/[ \t]{2,}/g, ' ')
        .trim();
}

/**
 * 把正文包成 SSML，按句子补停顿。
 *
 * Qwen 的纯文本合成停顿是按标点自己猜的，念快了会挤在一起；SSML 的
 * `<break time="600ms"/>` 是硬停顿，实测同一段话从 48.1 秒变成 55.1 秒，
 * 多出来的就是该有的呼吸。句末、省略号后给更长一点。
 *
 * @param {string} text 已经过 prepareSpeechText 的正文（可含 [whispers] 这类标签）
 * @param {{ pauseMs?: number, leadMs?: number }} [opts]
 */
export function toSsml(text, { pauseMs = 600, leadMs = 400 } = {}) {
    const src = String(text ?? '').trim();
    if (src === '') return '';
    if (/^\s*<speak[\s>]/i.test(src)) return src; // 已经是 SSML 就别套娃
    const escaped = src.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const parts = escaped.split(/(?<=[。！？!?])/).filter((s) => s.trim() !== '');
    const body = parts
        .map((sentence, i) => {
            const gap = i === 0 ? leadMs : sentence.includes('……') ? Math.round(pauseMs * 1.5) : pauseMs;
            return `<break time="${gap}ms"/>${punchInterjection(sentence, pauseMs)}`;
        })
        .join('');
    return `<speak>${body}</speak>`;
}

/**
 * 拟声词和省略号的处理。
 *
 * 单念一个「嗯」再补停顿，听起来是「嗯。……」，不是拖长；所以把元音拉出来：
 *   嗯……   → 嗯—— <break 700ms/>
 *   啊……   → 啊—— <break 700ms/>
 *   其余 …  → 一次性停顿
 *   ～ / ~  → 半拍停顿
 *
 * 中文 TTS 对破折号的拖音比省略号自然，这是实测下来最像人喘气的一版。
 */
export function punchInterjection(sentence, pauseMs = 600) {
    const hold = Math.round(pauseMs * 1.15);
    const gap = Math.max(180, Math.round(pauseMs * 0.75));
    return sentence
        // 拟声词 + 省略号：先把音拉长，再停一拍
        .replace(/([嗯啊哈呜哦唔唉呀嘿嘤])\s*[…]{2,}/g, `$1——<break time="${hold}ms"/>`)
        // 剩下的省略号：只当停顿
        .replace(/[…]+/g, `<break time="${gap}ms"/>`)
        // 波浪：半拍
        .replace(/[～~]+/g, `<break time="${Math.round(pauseMs * 0.55)}ms"/>`);
}

/** 兼容旧名字：按 qwen 的规则整理（保留官方英文标签）。 */
export const stripInlineTags = (text) => prepareSpeechText(text, 'qwen');

async function readLimited(res, maxBytes, signal) {
    if (Number(res.headers.get('content-length')) > maxBytes) {
        await res.body?.cancel();
        throw new Error('语音服务响应超过字节上限');
    }
    if (!res.body) throw new Error('语音服务返回空响应');
    const reader = res.body.getReader();
    const chunks = [];
    let size = 0;
    try {
        for (;;) {
            signal?.throwIfAborted();
            const { done, value } = await reader.read();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw new Error('语音服务响应超过字节上限');
            chunks.push(value);
        }
        signal?.throwIfAborted();
        return Buffer.concat(chunks, size);
    } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

/** 念出来之前先把不该念的东西剔掉：代码块、链接、markdown 记号。 */
/** 显示用的清洗：只去掉 Qwen 标签（[giggles] 这种），正文一个字都不动。 */
export function stripTagsForText(text) {
    // 模型偶尔会造标签（[breathtaking] 这种），文字里一律去掉；中文方括号和数字不算
    return String(text ?? '')
        .replace(/\[[a-zA-Z][a-zA-Z\s_-]{2,24}\]/g, '')
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

export function sanitizeForSpeech(text) {
    return String(text ?? '')
        .replace(/```[\s\S]*?```/g, ' ')
        .replace(/`[^`]*`/g, ' ')
        .replace(/\[\[voice:[^\]]*\]\]/g, ' ')
        .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
        .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/https?:\/\/\S+/g, ' ')
        .replace(/[*_>#~]+/g, ' ')
        .replace(/[|]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

/**
 * 临时音频仓库：负责落盘、计量、清扫。
 */
export function createMediaStore({ dir, ttlMinutes = 30, maxMb = 128, logger }) {
    const ttlMs = Math.max(1, ttlMinutes) * 60_000;
    const maxBytes = Math.max(1, maxMb) * 1024 * 1024;

    const ensure = () => fs.mkdirSync(dir, { recursive: true });

    const list = () => {
        try {
            return fs.readdirSync(dir, { withFileTypes: true })
                .filter((e) => e.isFile())
                .map((e) => {
                    const full = path.join(dir, e.name);
                    try {
                        const st = fs.statSync(full);
                        return { full, name: e.name, bytes: st.size, mtimeMs: st.mtimeMs };
                    } catch {
                        return null;
                    }
                })
                .filter(Boolean);
        } catch {
            return [];
        }
    };

    const usage = () => {
        const files = list();
        return { files: files.length, bytes: files.reduce((n, f) => n + f.bytes, 0) };
    };

    /** 删掉超过 TTL 的文件；force=true 时全删（启动 / 退出用）。 */
    const sweep = ({ force = false, now = Date.now() } = {}) => {
        let removed = 0;
        let freed = 0;
        for (const f of list()) {
            if (!force && now - f.mtimeMs < ttlMs) continue;
            try {
                fs.unlinkSync(f.full);
                removed += 1;
                freed += f.bytes;
            } catch { /* 别的进程先删了 */ }
        }
        if (removed > 0) logger?.info(`临时音频清理：删除 ${removed} 个文件，释放 ${(freed / 1024).toFixed(1)} KB`);
        return { removed, freed };
    };

    /** 落盘前留余量：超预算先清扫，还超就拒绝。 */
    const reserve = (needBytes = 0) => {
        ensure();
        let used = usage().bytes;
        if (used + needBytes <= maxBytes) return;
        sweep();
        used = usage().bytes;
        if (used + needBytes > maxBytes) {
            const mb = (used / 1024 / 1024).toFixed(1);
            throw new Error(`临时音频占用 ${mb} MB，已达上限 ${maxMb} MB`);
        }
    };

    const write = (buffer, ext) => {
        ensure();
        const file = path.join(dir, `${Date.now()}-${randomUUID().slice(0, 8)}.${ext}`);
        fs.writeFileSync(file, buffer);
        return file;
    };

    const remove = (file) => {
        if (!file) return false;
        try {
            fs.unlinkSync(file);
            return true;
        } catch {
            return false;
        }
    };

    return { dir, ensure, list, usage, sweep, reserve, write, remove, ttlMs, maxBytes };
}

export function createTts({ config, logger }) {
    const cfg = config.tts;
    const media = createMediaStore({
        dir: cfg.tmpDir,
        ttlMinutes: cfg.ttlMinutes,
        maxMb: cfg.tmpMaxMb,
        logger,
    });
    const limit = createLimiter(Math.max(1, cfg.maxConcurrency));
    /** 待发送的音频：id -> { path, bytes, voice, at } */
    const pending = new Map();
    /** peerKey -> 上次合成时间 */
    const lastAt = new Map();
    let active = 0;
    /** 已准入但还没结束的任务数（在跑 + 排队） */
    let inFlight = 0;
    let sweeper = null;
    let totalSynth = 0;
    let totalChars = 0;
    const shutdown = new AbortController();

    const ready = cfg.enabled && Boolean(cfg.apiKey);
    if (cfg.enabled && !cfg.apiKey) {
        logger?.warn('TTS_ENABLED=true 但缺少 TTS_API_KEY，语音功能按关闭处理');
    }

    /**
     * 自己复刻的音色（scripts/voice-clone.mjs 写进 data/voice/cloned.json）。
     * 复刻出来的是绑定在某个 qwen 模型上的 voice_id，直接当 voice 用。
     */
    const clonedVoices = () => {
        const file = path.join(cfg.voiceDir, 'cloned.json');
        try {
            const list = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (!Array.isArray(list)) return [];
            return list
                .filter((v) => typeof v?.voiceId === 'string' && v.voiceId !== '')
                .map((v) => ({ id: v.voiceId, name: v.name || v.voiceId, gender: '—', locale: 'zh-CN', cloned: true }));
        } catch {
            return [];
        }
    };
    const listVoices = () => {
        if (cfg.engine === 'qwen') return [...QWEN_VOICES, ...clonedVoices()];
        return OPENAI_VOICES;
    };

    /**
     * 通义 Qwen-Audio-TTS（阿里云百炼 / DashScope）。
     *
     * 非流式：POST 一次拿 `output.audio.url`，再 GET 下来（URL 24 小时有效）。
     * 返回 24kHz 单声道 16bit wav，和长语音拼接的假设一致。
     * 开了 TTS_SSML 就把正文包成 SSML 补硬停顿；失败了自动退回纯文本。
     */
    async function callQwen({ text, voice, style, signal }) {
        const body = {
            model: cfg.qwenModel,
            input: {
                text,
                voice: voice || cfg.qwenVoice,
                format: 'wav',
                sample_rate: cfg.qwenSampleRate,
            },
        };
        const instruction = style || cfg.style;
        if (instruction) body.input.instruction = instruction;

        if (cfg.ssml && !String(text).includes('<speak>')) {
            const ssml = toSsml(text, { pauseMs: cfg.pauseMs });
            if (ssml !== '') {
                body.input.text = ssml;
                body.input.enable_ssml = true;
            }
        }

        const endpoint = `${cfg.qwenBaseUrl}/services/audio/tts/SpeechSynthesizer`;
        // 网络层抖动（连不上、连接被重置、DNS 抽风）重试两次；HTTP 错误不重试
        const send = async (payload) => {
            let lastError;
            for (let attempt = 1; attempt <= 3; attempt += 1) {
                try {
                    return await fetch(endpoint, {
                        method: 'POST',
                        headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
                        body: JSON.stringify(payload),
                        signal,
                    });
                } catch (error) {
                    lastError = error;
                    if (signal?.aborted || !isTransientFetchError(error) || attempt === 3) break;
                    const wait = attempt === 1 ? 600 : 1800;
                    logger?.warn(`qwen TTS 第 ${attempt} 次连接失败：${describeFetchError(error, endpoint)}，${wait}ms 后重试`);
                    await new Promise((resolve) => setTimeout(resolve, wait));
                }
            }
            throw new Error(`qwen TTS 连不上 ${cfg.qwenBaseUrl}：${describeFetchError(lastError, endpoint)}`);
        };
        const detailOf = async (res) => (await readLimited(res, 4096, signal).catch(() => Buffer.alloc(0))).toString('utf8');
        const finish = async (res) => {
            const json = JSON.parse((await readLimited(res, 1024 * 1024, signal)).toString('utf8'));
            const url = json?.output?.audio?.url;
            if (!url) throw new Error('qwen TTS 未返回音频地址');
            let audioRes;
            try {
                audioRes = await fetch(url, { signal });
            } catch (error) {
                throw new Error(`qwen TTS 音频下载失败：${describeFetchError(error, url)}`);
            }
            if (!audioRes.ok) throw new Error(`qwen TTS 音频下载失败 HTTP ${audioRes.status}`);
            return { buffer: await readLimited(audioRes, cfg.maxBytes, signal), format: 'wav' };
        };

        let res = await send(body);
        if (res.ok) return finish(res);

        let detail = await detailOf(res);
        const engineError = () => res.status === 400 && /InvalidParameter|Engine error/.test(detail);

        // 1) SSML 把引擎弄崩（Engine error 411 / 明确说 ssml）：退回纯文本来一次
        if (res.status === 400 && body.input.enable_ssml && (/ssml|not support|不支持/i.test(detail) || engineError())) {
            logger?.warn(`SSML 被拒（${detail.slice(0, 60)}），改用纯文本：${body.input.voice}`);
            body.input.text = text;
            delete body.input.enable_ssml;
            res = await send(body);
            if (res.ok) return finish(res);
            detail = await detailOf(res);
        }
        // 2) 风格指令是雷区：去掉再来一次
        if (engineError() && body.input.instruction) {
            logger?.warn(`qwen 拒绝这条 instruction，去掉后重试：${String(body.input.instruction).slice(0, 40)}`);
            delete body.input.instruction;
            res = await send(body);
            if (res.ok) return finish(res);
            detail = await detailOf(res);
        }
        // 3) 这个端点没有该音色（国际站只认少数几个）：换默认音色
        if (engineError() && body.input.voice && body.input.voice !== cfg.qwenVoice) {
            logger?.warn(`qwen 端点不支持音色 ${body.input.voice}，改用默认音色 ${cfg.qwenVoice}`);
            body.input.voice = cfg.qwenVoice;
            res = await send(body);
            if (res.ok) return finish(res);
            detail = await detailOf(res);
        }
        // 4) plus 档只认三个音色：落回 flash
        if (engineError() && /-plus$/.test(body.model)) {
            body.model = body.model.replace(/-plus$/, '-flash');
            logger?.warn(`qwen plus 不支持音色 ${body.input.voice}，自动改用 ${body.model}`);
            res = await send(body);
            if (res.ok) return finish(res);
            detail = await detailOf(res);
        }
        // 5) 同样的请求原样再试一次：411 有时候是服务端瞬时故障
        if (engineError()) {
            logger?.warn(`qwen 报 Engine error，原样重试一次：${detail.slice(0, 60)}`);
            await new Promise((resolve) => setTimeout(resolve, 800));
            res = await send(body);
            if (res.ok) return finish(res);
            detail = await detailOf(res);
        }
        throw new Error(`qwen TTS HTTP ${res.status}：${detail.slice(0, 200)}`);
    }

    async function callOpenai({ text, voice, signal }) {
        const res = await fetch(`${cfg.openaiBaseUrl}/audio/speech`, {
            method: 'POST',
            headers: { authorization: `Bearer ${cfg.apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({
                model: cfg.openaiModel,
                input: text,
                voice: voice || cfg.openaiVoice,
                response_format: 'wav',
            }),
            signal,
        });
        if (!res.ok) {
            const detail = (await readLimited(res, 4096, signal).catch(() => Buffer.alloc(0))).toString('utf8');
            throw new Error(`openai TTS HTTP ${res.status}：${detail.slice(0, 200)}`);
        }
        const buffer = await readLimited(res, cfg.maxBytes, signal);
        if (buffer.length === 0) throw new Error('openai TTS 返回空音频');
        return { buffer, format: 'wav' };
    }

    /**
     * 合成一段语音，落盘后返回 id。调用方发完必须 take() 拿走并删文件。
     *
     * @returns {Promise<{id:string,path:string,bytes:number,voice:string,engine:string,textLength:number}>}
     */
    // 连续连不上就先熔断两分钟：否则每条回复都要白等三次重试（约二十秒）
    let netFails = 0;
    let voiceBlockedUntil = 0;
    const VOICE_BREAKER_MS = 120_000;

    async function synthesize({ text, voice, style, peerKey = '', ignoreCooldown = false, signal }) {
        if (!ready) throw new Error('语音功能未启用');
        signal?.throwIfAborted();
        shutdown.signal.throwIfAborted();
        const clean = sanitizeForSpeech(text);
        if (clean === '') throw new Error('没有可朗读的正文');
        const spoken0 = clean.length > cfg.maxChars ? clean.slice(0, cfg.maxChars) : clean;
        let spoken = spoken0;

        // 按引擎整理朗读文本：Qwen 保留官方英文标签、剥掉中文提示
        const prepared = prepareSpeechText(spoken0, cfg.engine);
        if (prepared !== spoken0 && prepared !== '') {
            logger?.debug?.(`朗读文本按 ${cfg.engine} 的标签规则整理过（${spoken0.length} → ${prepared.length} 字）`);
            spoken = prepared;
        }

        const picked = voice || cfg.defaultVoice;

        if (Date.now() < voiceBlockedUntil) {
            throw new Error('语音服务刚连续失败过，这两分钟先不发语音，直接用文字');
        }

        const now = Date.now();
        const last = lastAt.get(peerKey);
        if (!ignoreCooldown && peerKey && last && now - last < cfg.cooldownMs) {
            throw new Error(`语音冷却中（${Math.ceil((cfg.cooldownMs - (now - last)) / 1000)} 秒）`);
        }
        // 冷却在这里就记账，并发进来的第二条请求才拦得住（排队时不再重复计时）
        if (!ignoreCooldown && peerKey) {
            lastAt.set(peerKey, now);
            // 单聊也可能换号/多端，key 别无限涨
            while (lastAt.size > 500) lastAt.delete(lastAt.keys().next().value);
        }

        // 准入：在跑的 + 排队的超过「并发 + 队列上限」就直接拒，
        // 让模型立刻拿到「忙」而不是干等，也别把内存撑爆。
        if (inFlight >= cfg.maxConcurrency + cfg.queueMax) throw new Error('语音队列已满，稍后再试');
        inFlight += 1;
        const controller = new AbortController();
        const combined = AbortSignal.any([controller.signal, shutdown.signal, ...(signal ? [signal] : [])]);
        const timer = setTimeout(() => controller.abort(new Error('语音合成超时')), cfg.timeoutMs);
        try {
            return await limit(async () => {
                active += 1;
                try {
                    combined.throwIfAborted();
                    let result;
                    try {
                        result = cfg.engine === 'openai'
                            ? await callOpenai({ text: spoken, voice: picked, signal: combined })
                            : await callQwen({ text: spoken, voice: picked, style, signal: combined });
                        netFails = 0;
                    } catch (error) {
                        const net = isTransientFetchError(error) || /ECONNRESET|fetch failed|连不上/.test(String(error?.message));
                        if (net) {
                            netFails += 1;
                            if (netFails >= 3) {
                                voiceBlockedUntil = Date.now() + VOICE_BREAKER_MS;
                                logger?.warn(`语音连续 ${netFails} 次连不上，两分钟内不再尝试合成（直接走文字）`);
                            }
                        }
                        throw error;
                    }
                    combined.throwIfAborted();
                    if (result.buffer.length > cfg.maxBytes) {
                        throw new Error(`音频 ${(result.buffer.length / 1024).toFixed(0)} KB，超过单次上限`);
                    }
                    // 落盘前按实际大小查配额：超预算先清扫，还超就这次不合成。
                    media.reserve(result.buffer.length);
                    const file = media.write(result.buffer, result.format);
                    const id = randomUUID().slice(0, 12);
                    const record = {
                        path: file,
                        bytes: result.buffer.length,
                        voice: picked || cfg.defaultVoice,
                        at: Date.now(),
                    };
                    pending.set(id, record);
                    totalSynth += 1;
                    totalChars += spoken.length;
                    logger?.info(`语音合成完成：${(record.bytes / 1024).toFixed(1)} KB / ${spoken.length} 字 / ${record.voice}`);
                    return { id, ...record, engine: cfg.engine, textLength: spoken.length };
                } finally {
                    active -= 1;
                }
            }, { signal: combined });
        } finally {
            clearTimeout(timer);
            inFlight -= 1;
        }
    }

    /**
     * 长语音：把一整篇文本拆段合成，再拼成一个完整 WAV。
     *
     * 为什么必须拆：单次请求延迟随字数线性涨（实测 200 字约 9.4 秒，792 字直接超时），
     * 引擎没法一口气吃下十分钟。拆完并行合成、按顺序拼回，听感是连贯的一整条。
     *
     * 段与段之间插 longGapMs 静音，给 ASMR 那种"停顿"留呼吸。
     *
     * @returns {Promise<{path:string, bytes:number, durationMs:number, segments:number, textLength:number}>}
     */
    async function synthesizeLong({ text, voice, style, signal, onProgress }) {
        if (!ready) throw new Error('语音功能未启用');
        const clean = sanitizeForSpeech(text);
        if (clean === '') throw new Error('没有可朗读的正文');

        // 上限就是调用方给的 maxChars（默认 8000 字），不再按「15 分钟」二次偷偷裁：
        // 那会让 8000 字的正文只念到 4410 字，而且没有任何提示。
        const maxChars = cfg.maxChars;
        const body = clean.length > maxChars ? clean.slice(0, maxChars) : clean;
        const droppedChars = clean.length - body.length;
        if (droppedChars > 0) logger?.warn(`长语音正文 ${clean.length} 字，超过 ${maxChars} 字上限，末尾 ${droppedChars} 字没念`);
        const pieces = chunkText(body, cfg.segmentChars).filter(Boolean);
        if (pieces.length === 0) throw new Error('切不出可合成的段落');

        // 分段数太多会顶到准入上限，按「并发数」一批批来
        const wave = Math.max(1, cfg.maxConcurrency);
        const buffers = [];
        let totalBytes = 0;
        for (let i = 0; i < pieces.length; i += wave) {
            signal?.throwIfAborted();
            const batch = pieces.slice(i, i + wave);
            const batchAbort = new AbortController();
            const batchSignal = AbortSignal.any([batchAbort.signal, shutdown.signal, ...(signal ? [signal] : [])]);
            const jobs = batch.map((piece) =>
                synthesize({ text: piece, voice, style, peerKey: '', ignoreCooldown: true, signal: batchSignal })
                    .then((r) => {
                        const record = take(r.id);
                        if (!record) throw new Error('音频记录丢了');
                        try {
                            return fs.readFileSync(record.path);
                        } finally {
                            release(record.path);
                        }
                    }).catch((error) => { batchAbort.abort(error); throw error; }),
            );
            const settled = await Promise.allSettled(jobs);
            batchSignal.throwIfAborted();
            const failed = settled.find((r) => r.status === 'rejected');
            if (failed) throw failed.reason;
            const results = settled.map((r) => r.value);
            totalBytes += results.reduce((n, b) => n + b.length, 0);
            if (totalBytes > cfg.longMaxBytes) throw new Error('长语音累计音频超过字节上限');
            buffers.push(...results);
            onProgress?.({ done: Math.min(i + wave, pieces.length), total: pieces.length });
        }

        signal?.throwIfAborted();
        shutdown.signal.throwIfAborted();
        const merged = concatWav(buffers, { gapMs: cfg.longGapMs, logger });
        if (merged.bytes > cfg.longMaxBytes) {
            throw new Error(`拼好的音频 ${(merged.bytes / 1024 / 1024).toFixed(1)} MB，超过长语音上限 ${(cfg.longMaxBytes / 1024 / 1024).toFixed(0)} MB`);
        }
        // Keep the original samples. Delivery splits by size and its remaining send budget.
        media.reserve(merged.buffer.length);
        const file = media.write(merged.buffer, 'wav');
        const durationMs = merged.durationMs;
        totalSynth += 1;
        totalChars += body.length;
        logger?.info(
            `长语音合成完成：${(merged.buffer.length / 1024 / 1024).toFixed(2)} MB / ` +
                `${(durationMs / 1000).toFixed(1)} 秒 / ${pieces.length} 段 / ${body.length} 字 / ${merged.format.sampleRate}Hz`,
        );
        return {
            path: file,
            bytes: merged.buffer.length,
            durationMs,
            segments: merged.segments,
            textLength: body.length,
            droppedChars,
            sampleRate: merged.format.sampleRate,
            downgraded: false,
        };
    }

    /**
     * 收编一条外部生成的音频（比如场景音频），交给同一套「待发 → 发送 → 删除」流程。
     * 返回 id，调用方把它塞进 [[voice:id]] 标记里就行。
     */
    function adopt(file, { bytes, durationMs } = {}) {
        if (!file || !fs.existsSync(file)) throw new Error('要收编的音频不存在');
        const id = randomUUID().slice(0, 12);
        const record = {
            path: file,
            bytes: bytes ?? fs.statSync(file).size,
            voice: 'scene',
            at: Date.now(),
            durationMs,
        };
        pending.set(id, record);
        return id;
    }
    /** 取出待发送音频（不删文件，发送方负责删）。 */
    function take(id) {
        const record = pending.get(id);
        if (!record) return null;
        pending.delete(id);
        return record;
    }

    function drop(id) {
        const record = pending.get(id);
        if (!record) return false;
        pending.delete(id);
        return media.remove(record.path);
    }

    /** 发送完就删：语音条发出去之后本地不再留副本。 */
    function release(path_) {
        return media.remove(path_);
    }

    /** 定时清扫：TTL 过期文件 + 没人认领的待发音频。 */
    function sweepOnce() {
        const now = Date.now();
        for (const [id, record] of pending) {
            if (now - record.at > media.ttlMs) {
                pending.delete(id);
                media.remove(record.path);
            }
        }
        return media.sweep();
    }

    function startSweeper() {
        if (sweeper) return;
        media.ensure();
        sweepOnce();
        sweeper = setInterval(sweepOnce, Math.max(30_000, cfg.sweepMs));
        sweeper.unref?.();
    }

    function stop() {
        shutdown.abort(new Error('语音服务正在退出'));
        if (sweeper) { clearInterval(sweeper); sweeper = null; }
    }

    function stats() {
        const use = media.usage();
        return {
            enabled: ready,
            engine: cfg.engine,
            voices: listVoices().length,
            active,
            queued: Math.max(0, inFlight - active),
            pending: pending.size,
            files: use.files,
            tmpBytes: use.bytes,
            tmpMaxBytes: media.maxBytes,
            totalSynth,
            totalChars,
        };
    }

    return {
        enabled: ready,
        engine: cfg.engine,
        defaultVoice: cfg.defaultVoice,
        maxChars: cfg.maxChars,
        defaultOn: cfg.defaultOn,
        segmentChars: cfg.segmentChars,
        segmentsMax: cfg.segmentsMax,
        longMaxMinutes: cfg.longMaxMinutes,
        longGapMs: cfg.longGapMs,
        longDelivery: cfg.longDelivery,
        charsPerSecond: cfg.charsPerSecond,
        listVoices,
        clonedVoices,
        synthesize,
        synthesizeLong,
        adopt,
        take,
        drop,
        release,
        sweep: sweepOnce,
        startSweeper,
        stop,
        stats,
        media,
    };
}











