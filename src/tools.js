/**
 * 模型可调用的工具。
 *
 *   remember   写长期记忆（带作用域：私聊档 / 群聊档）
 *   recall     搜长期记忆（注入只给最近 N 条，老账靠它翻）
 *   tts_speak  合成语音条（受并发闸门、字数上限、临时盘配额管着）
 *   tts_voices 列音色
 *
 * 加新工具只需要往 definitions 里塞声明、在 execute 里接一档分支。
 */
import fs from 'node:fs';
import { webSearch, weather as fetchWeather, fetchPage, htmlToText } from './web.js';
import path from 'node:path';

import { MEMORY_KINDS } from './memory.js';

const REMEMBER_DESC_BASE =
    '把涉及主人/小砚自身的长期事实写入长期记忆库。一次只写一句话，不要写“用户说”这类包装。';

/** 严格模式：把「什么不许写」摊开说明，并禁掉最容易塞流水账的 event。 */
const REMEMBER_DESC_STRICT = `${REMEMBER_DESC_BASE}

只在这几种情况下调用：主人明确让你记住；出现了称呼、生日、禁忌、规矩、约定、长期喜好、人设设定。
以下一律不要写：
- 一次性的情绪、吐槽、天气、吃了什么、今天做了什么；
- 临时安排（几点睡、明天再说这种）；
- 技术排查记录、报错、配置、模型名、代码细节；
- 别人的八卦和身份信息（主人以外的人）；
- 你自己已经写在记忆清单里的内容，或换了个说法的同一句话。
拿不准就不写。宁可漏记，也不要往里塞垃圾。`;

const REMEMBER_DESC_NORMAL = `${REMEMBER_DESC_BASE}闲聊和技术调试记录不要写。`;

function buildRememberTool({ strict = true } = {}) {
    return {
        type: 'function',
        function: {
            name: 'remember',
            description: strict ? REMEMBER_DESC_STRICT : REMEMBER_DESC_NORMAL,
            parameters: {
                type: 'object',
                properties: {
                    kind: {
                        type: 'string',
                        enum: strict ? MEMORY_KINDS.filter((k) => k !== 'event') : MEMORY_KINDS,
                        description: strict
                            ? 'user_fact=关于主人的事实；rule=规矩约定；preference=喜好；identity=身份设定'
                            : 'user_fact=关于主人的事实；rule=规矩约定；preference=喜好；identity=身份设定；event=值得长期记住的事件',
                    },
                    content: {
                        type: 'string',
                        description: '一句话写清楚，控制在 200 字以内，不要罗列',
                    },
                },
                required: ['kind', 'content'],
            },
        },
    };
}


const WEB_SEARCH = {
    type: 'function',
    function: {
        name: 'web_search',
        description: '联网搜索。天气、新闻、价格、地址、实时信息都先用它；返回标题、链接和摘要。',
        parameters: {
            type: 'object',
            properties: { query: { type: 'string', description: '搜索词，例如「福州闽侯 今天 天气」' } },
            required: ['query'],
        },
    },
};

const WEATHER = {
    type: 'function',
    function: {
        name: 'weather',
        description: '查某个城市现在的天气和今天的气温/降水。查天气优先用这个，比搜索准。',
        parameters: {
            type: 'object',
            properties: { city: { type: 'string', description: '城市或区县名，例如「福州闽侯」' } },
            required: ['city'],
        },
    },
};

const FETCH_URL = {
    type: 'function',
    function: {
        name: 'fetch_url',
        description: '抓一个网页的正文文本（最多约 2500 字）。搜索结果里看不出细节时用它。',
        parameters: {
            type: 'object',
            properties: { url: { type: 'string', description: 'http/https 网址' } },
            required: ['url'],
        },
    },
};

const RECALL = {
    type: 'function',
    function: {
        name: 'recall',
        description: '在长期记忆库里按关键词搜索已经记下的事。脑子里的清单只有最近几条，翻旧账用这个。',
        parameters: {
            type: 'object',
            properties: {
                keyword: { type: 'string', description: '关键词，尽量短，一两个词最好' },
            },
            required: ['keyword'],
        },
    },
};

const STYLE_HINT = {
    qwen: '一句话写清：气息、语速、音量、情绪、收尾；不要在正文里写括号标签，会被念出来',
    openai: '标准接口不认风格参数，靠标点和断句控制节奏',
};

function buildSpeakTool(engine) {
    return {
        type: 'function',
        function: {
            name: 'tts_speak',
            description:
                '把一段文字合成 QQ 语音条发出去。主人要听、要你念、要语音播报时才用，不要每句都念。',
            parameters: {
                type: 'object',
                properties: {
                    text: { type: 'string', description: '要念的内容，短一点，别把整段代码念出来' },
                    voice: { type: 'string', description: '音色（可选）。清单见 tts_voices，只能是清单里的 id 或复刻名' },
                    // qwen 的 instruction 实测会把长文本的韵律弄崩（忽大忽小、甚至 400），
                    // 干脆不向模型暴露这个参数；加戏靠正文里的官方标签 [whispers]/[sighing]。
                    ...(engine === 'qwen'
                        ? {}
                        : {
                            style: {
                                type: 'string',
                                description: `语气风格（可选）。当前引擎写法：${STYLE_HINT[engine] ?? STYLE_HINT.qwen}`,
                            },
                        }),
                },
                required: ['text'],
            },
        },
    };
}

const TTS_VOICES = {
    type: 'function',
    function: {
        name: 'tts_voices',
        description: '列出当前可用的语音音色清单。',
        parameters: { type: 'object', properties: {} },
    },
};

const AUDIO_SCENE = {
    type: 'function',
    function: {
        name: 'audio_scene',
        description:
            '按一段场景描述生成带环境音的音频（雨声、雷、呼吸、床单摩擦、耳语），直接作为语音条发出去。' +
            '描述里同时写清楚：谁在说话、什么语气、背景里有什么声音。一次最多 120 秒，一轮只能发一条。',
        parameters: {
            type: 'object',
            properties: {
                prompt: {
                    type: 'string',
                    description: '场景描述，写具体：人物的年龄性别音色、语气（气声/喘/低语）、台词、背景音效、大致时长',
                },
            },
            required: ['prompt'],
        },
    },
};
const SEND_IMAGE = {
    type: 'function',
    function: {
        name: 'send_image',
        description:
            '发一张图 / 表情包出去。优先用本地素材名（清单见系统提示里的「表情包」），也可以直接给图片 URL。一轮最多发一张。',
        parameters: {
            type: 'object',
            properties: {
                name: { type: 'string', description: '本地素材名（不带扩展名），例如「猫猫头」' },
                url: { type: 'string', description: '图片直链（http/https），本地没有素材时用' },
            },
        },
    },
};

const IMAGE_EXT = /\.(png|jpe?g|gif|webp)$/i;

/** 扫一遍素材目录，返回 [{ name, path, bytes }]。 */
export function listAssets(dir, maxBytes = 20 * 1024 * 1024) {
    let entries = [];
    try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
        return [];
    }
    const out = [];
    for (const entry of entries) {
        if (!entry.isFile() || !IMAGE_EXT.test(entry.name)) continue;
        const full = path.join(dir, entry.name);
        try {
            const st = fs.statSync(full);
            if (st.size > maxBytes) continue;
            out.push({ name: entry.name.replace(/\.[^.]+$/, ''), path: full, bytes: st.size });
        } catch { /* 读不到就跳过 */ }
    }
    return out.sort((a, b) => a.name.localeCompare(b.name));
}

/** 按名字（可带可不带扩展名）找素材。 */
export function findAsset(assets, name) {
    const wanted = String(name ?? '').trim().replace(IMAGE_EXT, '');
    if (wanted === '') return null;
    return assets.find((a) => a.name === wanted || a.name.toLowerCase() === wanted.toLowerCase()) ?? null;
}

/**
 * @param {object} opts
 * @param {import('./memory.js').MemoryStore} opts.memory
 * @param {object} opts.logger
 * @param {boolean} [opts.enabled]
 * @param {object} [opts.tts]  createTts() 的返回值（不传就不挂语音工具）
 * @param {'all'|'c2c'|'group'} [opts.groupWriteScope]
 */
export function createToolkit({ memory, logger, enabled = true, tts = null, groupWriteScope = 'group', memoryStrict = true, assets = [], scene = null, ttsEngine = 'qwen' }) {
    const definitions = [];
    if (enabled) definitions.push(buildRememberTool({ strict: memoryStrict }), RECALL, WEB_SEARCH, WEATHER, FETCH_URL);
    if (tts?.enabled) definitions.push(buildSpeakTool(ttsEngine), TTS_VOICES);
    if (Array.isArray(assets) && assets.length > 0) definitions.push(SEND_IMAGE);
    if (scene?.enabled && tts?.enabled) definitions.push(AUDIO_SCENE);

    const scopeFor = (scope) => (scope === 'group' ? groupWriteScope : 'c2c');

    /**
     * 执行一次工具调用，返回塞回模型的结果文本。
     * @param {{name: string, args?: string}} call
     * @param {{scope?: 'c2c'|'group'}} [ctx]
     */
    async function execute(call, ctx = {}) {
        ctx.signal?.throwIfAborted();
        const scope = ctx.scope === 'group' ? 'group' : 'c2c';

        if (call.name === 'remember') {
            if (!enabled) return '记忆工具已关闭，这次没记住。';
            let args;
            try {
                args = JSON.parse(call.args || '{}');
            } catch {
                return '参数解析失败，这次没记住。';
            }
            const kind = String(args?.kind ?? '').trim();
            const content = String(args?.content ?? '').trim();
            if (content === '') return '内容为空，这次没记住。';
            // 严格模式不接受流水账式的短断言（"嗯""好的""今天累"）
            if (memoryStrict && content.replace(/[\s，,。.！!？?]/g, '').length < 4) {
                return '太短了，算不上长期事实，这次没记住。';
            }
            const id = memory.addImportant(kind || 'user_fact', content, scopeFor(scope));
            return id ? `已记住 #${id}` : '记忆库不可用，这次没记住。';
        }

        if (call.name === 'recall') {
            if (!enabled) return '记忆工具已关闭。';
            let args;
            try {
                args = JSON.parse(call.args || '{}');
            } catch {
                return '参数解析失败。';
            }
            const keyword = String(args?.keyword ?? '').trim();
            if (keyword === '') return '关键词为空。';
            const rows = memory.searchImportant(keyword, 10, scope);
            if (rows.length === 0) return `没搜到含「${keyword}」的记忆。`;
            return rows.map((r) => `#${r.id} [${r.kind}] ${r.content}`).join('\n');
        }

        if (call.name === 'web_search' || call.name === 'weather' || call.name === 'fetch_url') {
            let args;
            try { args = JSON.parse(call.args || '{}'); } catch { return '参数解析失败，这次没查到。'; }
            ctx.signal?.throwIfAborted();
            try {
                if (call.name === 'web_search') {
                    const query = String(args?.query ?? '').trim();
                    if (!query) return '搜索词为空。';
                    const rows = await webSearch(query, { limit: 5, signal: ctx.signal });
                    if (rows.length === 0) return '搜到的是空结果，换个说法再搜一次。';
                    return rows.map((r, i) => `${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`).join('\n');
                }
                if (call.name === 'weather') {
                    const city = String(args?.city ?? '').trim();
                    if (!city) return '城市为空。';
                    return await fetchWeather(city, { signal: ctx.signal });
                }
                const url = String(args?.url ?? '').trim();
                if (!url) return '网址为空。';
                const page = await fetchPage(url, { signal: ctx.signal });
                const text = htmlToText(page.body).slice(0, 2500);
                return text || '这个页面没抓到正文（可能是图片或需要登录）。';
            } catch (error) {
                ctx.signal?.throwIfAborted();
                logger?.warn(`联网工具失败（${call.name}）：${error?.message || error}`);
                return `联网失败：${error?.message || error}。如实跟主人说这次没查到，别编。`;
            }
        }

        if (call.name === 'tts_speak') {
            if (!tts?.enabled) return '语音没开。';
            ctx.signal?.throwIfAborted();
            if (ctx.delivery && ctx.delivery.remaining < 2) return '本轮回复额度不足，请用文字回答。';
            let args;
            try {
                args = JSON.parse(call.args || '{}');
            } catch {
                return '参数解析失败，这次没合成。';
            }
            const text = String(args?.text ?? '').trim();
            if (text === '') return '要念的内容为空。';
            try {
                const result = await tts.synthesize({
                    text,
                    voice: String(args?.voice ?? '').trim() || undefined,
                    style: String(args?.style ?? '').trim() || undefined,
                    peerKey: ctx.peerKey ?? '',
                    signal: ctx.signal,
                });
                const kb = (result.bytes / 1024).toFixed(1);
                return `语音条已由系统发出（${kb} KB，音色 ${result.voice}）。[[voice:${result.id}]]\n不要在回复正文里提这件事，也不要写「语音已发送」「已录音」之类的字样——用户自己会收到。直接接着说话。`;
            } catch (error) {
                ctx.signal?.throwIfAborted();
                logger?.warn(`语音合成失败：${error?.message || error}`);
                if (ctx.turn) ctx.turn.voiceFailed = true;
                // 关键：别再让模型编"引擎坏了/没出声"的剧情——正文最后到底会不会念出来，
                // 取决于这轮语音开关，工具这边如实告诉它。
                return ctx.autoSpeak
                    ? '这条工具语音没合成出来，但你这轮回复的正文最后仍会自动朗读一遍。别跟主人解释合成失败的事，正常说话就行。'
                    : '语音没合成出来，这轮用文字说（别解释引擎问题，正常聊）。';
            }
        }

        if (call.name === 'tts_voices') {
            if (!tts?.enabled) return '语音没开。';
            const list = tts.listVoices();
            return [`共 ${list.length} 个音色：`, ...list.map((v) => `- ${v.id}（${v.locale}/${v.gender}）`)].join('\n');
        }

        if (call.name === 'audio_scene') {
            if (!scene?.enabled || !tts?.enabled) return '场景音频没开。';
            if (ctx.allowVoice === false) return '这一轮已经发过语音/场景了，下轮再说。';
            let args;
            try {
                args = JSON.parse(call.args || '{}');
            } catch {
                return '参数解析失败，这次没生成。';
            }
            const prompt = String(args?.prompt ?? '').trim();
            if (prompt === '') return '场景描述是空的。';
            try {
                const result = await scene.generate({ prompt, signal: ctx.signal });
                let id;
                try {
                    id = tts.adopt(result.path, result);
                } catch (error) {
                    // 收编失败就别把文件留在临时目录
                    scene.remove?.(result.path);
                    throw error;
                }
                const secs = (result.durationMs / 1000).toFixed(1);
                logger?.info(`场景音频：${secs} 秒 / ${(result.bytes / 1024 / 1024).toFixed(2)} MB`);
                return `场景音频生成好了（${secs} 秒），已经作为语音条发出去。[[voice:${id}]]`;
            } catch (error) {
                logger?.warn(`场景音频失败：${error?.message || error}`);
                return `场景音频没生成出来：${error?.message || error}`;
            }
        }
        if (call.name === 'send_image') {
            ctx.signal?.throwIfAborted();
            if (ctx.delivery && ctx.delivery.remaining < 2) return '本轮回复额度不足，请用文字回答。';
            let args;
            try {
                args = JSON.parse(call.args || '{}');
            } catch {
                return '参数解析失败，这次没发。';
            }
            if (!ctx.bot || !ctx.target) return '这会儿发不了图。';
            if (ctx.allowImage === false) return '这一轮已经发过图了，下轮再说。';
            const asset = findAsset(assets, args?.name);
            const url = String(args?.url ?? '').trim();
            try {
                if (asset) {
                    await ctx.bot.sendImage(ctx.target, { localPath: asset.path });
                    logger?.info(`发送素材图：${asset.name}（${(asset.bytes / 1024).toFixed(0)} KB）`);
                    return `已发图：${asset.name} [[image]]`;
                }
                if (/^https?:\/\//.test(url)) {
                    await ctx.bot.sendImage(ctx.target, { url });
                    logger?.info(`发送外链图：${url.slice(0, 80)}`);
                    return '已发图（外链）[[image]]';
                }
                const names = assets.map((a) => a.name).slice(0, 12).join('、');
                return `没这张图。手上有：${names || '（空）'}`;
            } catch (error) {
                logger?.warn(`发图失败：${error?.message || error}`);
                return `图没发出去：${error?.message || error}`;
            }
        }

        logger?.warn(`未知工具调用：${call.name}`);
        return `没有名为 ${call.name} 的工具。`;
    }

    return { definitions, execute };
}








