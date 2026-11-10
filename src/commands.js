/**
 * 指令系统 —— 旧 bot 有 /reset /status /model /archive，迁过来时全丢了。
 *
 * 支持 /、／ 指令，以及整条消息明确表达的常用设置；设置不进模型、不花 token。
 *
 * 指令一律同步执行，只有 /stop 需要动到运行中的轮次。
 */
import { createDeliveryBudget, sendLongAudio } from './delivery.js';

import { MEMORY_KINDS, MEMORY_SCOPES } from './memory.js';
import { PERSONA_CORE } from './persona.js';

const KIND_HINT = MEMORY_KINDS.join('/');

/**
 * 让模型写一段「要念出来」的长稿。
 * 不写标题、不写舞台说明：这些东西念出来会破戏。
 */
async function writeLongScript({ llm, config, logger, theme, chars, signal }) {
    const seconds = Math.max(30, Math.round(chars / (config.tts.charsPerSecond || 4.9)));
    const system = [
        PERSONA_CORE,
        '',
        '## 这一次的任务：写一段长音频的念稿',
        `长度：${chars} 字左右（念出来大约 ${Math.round(seconds / 60)} 分钟）。`,
        '硬要求：',
        '- 全部是小砚说出来的话，第一人称。不要标题、不要小标题、不要括号里的动作说明、不要提纲。',
        '- 慢：句子短，多用逗号和句号压出停顿，不要靠省略号堆节奏。',
        '- 要有环境与身体细节：声音、呼吸、布料摩擦、体温、心跳、雨声这类。',
        '- 全程不出戏，不解释规则，不总结，不寒暄收尾。',
        '- 一口气写完，不要中途问问题。',
        theme ? `主题：${theme}` : '主题：深夜，主人刚躺下，小砚钻进被窝贴着耳朵说话。',
    ].join('\n');

    const result = await llm.stream({
        messages: [
            { role: 'system', content: system },
            { role: 'user', content: '开始吧，慢慢说。' },
        ],
        model: config.llm.model,
        signal,
    });
    let text = String(result.text ?? '').trim();
    logger?.info(`长稿生成完成：${text.length} 字（目标 ${chars}）`);

    // 模型经常写到一半就自己收尾。差得远就让它接着写，最多补两轮。
    for (let round = 0; round < 2 && text.length < chars * 0.8; round += 1) {
        signal?.throwIfAborted();
        const missing = Math.max(60, chars - text.length);
        try {
            const more = await llm.stream({
                messages: [
                    { role: 'system', content: system },
                    { role: 'user', content: `刚才只说到 ${text.length} 字，还差大约 ${missing} 字。接着往下说，不要重复已经说过的内容，不要总结，直接就往下念。` },
                    { role: 'assistant', content: text.slice(-300) },
                ],
                model: config.llm.model,
                signal,
            });
            const extra = String(more.text ?? '').trim();
            if (extra === '') break;
            text = `${text}\n${extra}`;
            logger?.info(`续写第 ${round + 1} 轮：+${extra.length} 字，共 ${text.length}`);
        } catch (error) {
            signal?.throwIfAborted();
            logger?.warn(`续写失败：${error?.message || error}`);
            break;
        }
    }
    return text;
}

/**
 * 把拼好的长音频投递出去。
 *
 * 顺序：按体积切段 → 一段一条语音条（单聊能回 4 次，留 1 次给回执）。
 * 段数太多就先降采样再切；语音条真发不出去才退回文件消息。
 */
async function deliverLong({ delivery, tts, ...options }) {
    return sendLongAudio({ ...options, slots: delivery?.remaining ?? 3, media: tts?.media });
}

/**
 * 解析一条消息是不是指令。
 * @returns {{name: string, args: string[], raw: string}|null}
 */
export function parseCommand(text, prefixes = ['/', '／']) {
    const s = String(text ?? '').trim();
    if (s === '') return null;
    const prefix = prefixes.find((p) => p && s.startsWith(p));
    if (!prefix) return null;
    const body = s.slice(prefix.length).trim();
    if (body === '') return null;
    const [name, ...args] = body.split(/\s+/);
    return { name: name.toLowerCase(), args, raw: body };
}

/** Only standalone, explicit controls are local actions; quoted or mixed chat stays chat. */
export function parseSettingsText(text, voices = []) {
    const s = String(text ?? '').trim().replace(/[。！!]+$/, '').trim();
    const controls = new Map([
        ['打开语音', ['voice', 'on']], ['开启语音', ['voice', 'on']],
        ['恢复语音', ['voice', 'on']], ['以后用语音回复', ['voice', 'on']],
        ['关闭语音', ['voice', 'off']], ['关掉语音', ['voice', 'off']],
        ['以后用文字回复', ['voice', 'off']], ['以后只发文字', ['voice', 'off']],
        ['查看设置', ['status']], ['看看设置', ['status']],
        ['查看详细状态', ['status', 'detail']], ['查看帮助', ['help']],
        ['查看音色', ['voice', 'list']], ['有哪些音色', ['voice', 'list']],
    ]);
    const direct = controls.get(s);
    if (direct) return { name: direct[0], args: direct.slice(1) };
    // A whole-message match avoids changing settings for questions, quotes or narration.
    const voice = s.match(/^(?:音色换成|把音色换成)\s*([^，。！？!?：:“”「」『』"'`\r\n]+)$/u);
    if (voice && voices.some(v => v.id === voice[1] || v.name === voice[1])
        && !['on', 'off', 'status', 'list', 'search'].includes(voice[1].toLowerCase())) {
        return { name: 'voice', args: [voice[1]] };
    }
    const page = s.match(/^查看音色第([1-9]\d*)页$/u);
    if (page) return { name: 'voice', args: ['list', page[1]] };
    const search = s.match(/^找音色[ ：:]\s*([^\r\n]+)$/u);
    if (search) return { name: 'voice', args: ['search', search[1].trim()] };
    return null;
}

/** 秒 → 1d2h3m4s，/status 用。 */
export function humanDuration(ms) {
    const total = Math.max(0, Math.floor(ms / 1000));
    const d = Math.floor(total / 86400);
    const h = Math.floor((total % 86400) / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return [d && `${d}d`, h && `${h}h`, (m || (!d && !h)) && `${m}m`, s && `${s}s`].filter(Boolean).join('') || '0s';
}

/**
 * @param {object} deps { config, logger, memory, sessions, state, tts, runtime }
 */
export function createCommandHandler(deps) {
    const { config, logger, memory, sessions, state, tts, runtime, llm, auth } = deps;
    const configuredEffort = config.llm.thinking === 'disabled' || config.llm.effort === 'none'
        ? 'off' : config.llm.effort || (config.llm.provider === 'deepseek' ? 'high' : 'auto');

    const scopeOf = (scope, targetId) => `${scope}:${targetId}`;

    /** 当前这条会话能看见的记忆作用域。 */
    const memScope = (scope) => (scope === 'group' ? config.memory.groupWriteScope : 'c2c');

    const commands = {
        help({ args }) {
            if (!['all', '全部'].includes(args[0])) return [
                '常用操作，直接发下面这些话就能用：',
                '「关闭语音」／「打开语音」——之后持续用文字／语音回复',
                '「查看音色」／「找音色 灵心」／「音色换成龙安灵心」',
                '「查看设置」——看当前模型、思考档位、语音和主动聊天',
                '「先别主动找我」／「恢复主动聊天」',
                '发下一条消息就能打断上一轮；语音开着时，长回复自动分条。',
                '',
                '/status detail 看详细状态；/help all 看全部指令。',
            ].join('\n');
            return [
                '小砚的指令（前缀 / 或 ／，不进模型、不花 token）——想用哪条，开口♡：',
                '/reset —— 清掉这段会话的上下文，记忆不动',
                '/status —— 当前设置；/status detail 看运行详情',
                '/voice on|off —— 开关语音；/voice <音色> 换音色；/voice list [页码] 看清单；/voice search 关键词 搜音色',
                `/mem —— 记忆：list [n] / search 词 / del 编号 / add 类型 内容（类型：${KIND_HINT}）`,
                '/model [名字|reset] —— 看/切模型',
                '/effort [off|low|high|max|auto] —— 看/调思考深度；可用档位随服务而异',
                '/archive [标题] —— 把这段会话归档进流水',
                '/ping —— 活着吗',
                '',
                '……记不住就再发 /help，妈妈不嫌你笨♡',
                '不用发指令也能用：语音开着就每条都念，长回复自动切成几条语音条；',
                '想让它闭嘴做别的，直接发下一条消息就行（会打断上一轮）。',
            ].join('\n');
        },

        ping({ scope, targetId }) {
            return [
                `在呢，主人♡ ${runtime?.uptimeText?.() ?? ''}`.trim(),
                `会话：${scopeOf(scope, targetId)}`,
            ].join('\n');
        },

        status({ scope, targetId, args }) {
            const counts = memory?.available ? memory.count() : { important: 0, conversation: 0 };
            const s = sessions?.stats?.() ?? { sessions: 0, messages: 0 };
            const voice = tts?.stats?.() ?? { enabled: false };
            const companion = runtime?.companion?.stats();
            const key = scopeOf(scope, targetId);
            const voiceOn = Boolean(state?.get?.(`voice:${key}`, tts?.defaultOn ?? false));
            const savedVoice = state?.get?.(`voiceName:${key}`, tts?.defaultVoice ?? '');
            const availableVoices = tts?.listVoices?.() ?? [];
            const selectedVoice = availableVoices.find(v => v.id === savedVoice || v.name === savedVoice)
                ?? availableVoices.find(v => v.id === tts?.defaultVoice || v.name === tts?.defaultVoice);
            const voiceName = selectedVoice?.name || selectedVoice?.id || tts?.defaultVoice || savedVoice;
            const detailed = ['detail', '详细'].includes(args[0]);
            const lines = [
                `运行：${runtime?.uptimeText?.() ?? '?'}｜模型：${state?.get?.('model', '') || runtime?.modelName?.() || config.llm.model}｜思考：${state?.get?.('effortLevel', '') || configuredEffort}`,
                voice.enabled
                    ? `回复：${voiceOn ? '语音' : '文字'}｜音色：${voiceName}${voice.queued > 0 ? `｜语音排队 ${voice.queued}` : ''}`
                    : '语音：未启用',
            ];
            if (!memory?.available) lines.push('记忆库暂不可用，当前聊天仍可继续。');
            if (detailed) lines.push(
                `记忆：重要 ${counts.important} 条 / 流水 ${counts.conversation} 条`,
                `会话缓存：${s.sessions} 个 / ${s.messages} 条消息｜本轮已 ${sessions?.turnCount?.(scope, targetId) ?? 0} 轮`,
                `语音任务：并发 ${voice.active ?? 0}/${config.tts.maxConcurrency} · 排队 ${voice.queued ?? 0} · 临时 ${((voice.tmpBytes ?? 0) / 1024).toFixed(0)}KB/${((voice.tmpMaxBytes ?? 0) / 1024 / 1024).toFixed(0)}MB`,
            );
            if (companion) {
                const bits = [`${companion.enabled ? '开' : '关'} · 今日 ${companion.sent}/${companion.dailyMax} · ${companion.quietStart}:00～${companion.quietEnd}:00 免打扰`];
                if (companion.awaitingReply) bits.push('等你回复中');
                if (companion.pushStatus === 'failed') bits.push('上次发送失败');
                if (companion.pushStatus === 'stale') bits.push('上次结果未知，已放开');
                if (companion.blockedUntil > Date.now()) {
                    const at = new Date(companion.blockedUntil).toLocaleString('zh-CN', { hour12: false, timeZone: config.timezone || 'Asia/Shanghai' });
                    bits.push(`暂停到 ${at}（说「恢复主动聊天」可解除）`);
                }
                lines.push(`主动聊天：${bits.join(' · ')}`);
            }
            lines.push('可直接说「打开语音」「关闭语音」「查看音色」。' + (detailed ? '' : ' /status detail 看详情。'));
            return lines.join('\n');
        },

        reset({ scope, targetId }) {
            const removed = sessions?.turnCount?.(scope, targetId) ?? 0;
            sessions?.reset?.(scope, targetId);
            sessions?.flushAll?.();
            logger?.info(`指令重置会话 ${scopeOf(scope, targetId)}（清掉 ${removed} 轮）`);
            return `上下文清了，${removed} 轮全扔了♡ 记忆没动，过来，重新开始。`;
        },

        new({ scope, targetId }) {
            sessions?.reset?.(scope, targetId);
            sessions?.flushAll?.();
            return '嗯……新的一局，一页不剩。想让我记住什么，现在说，妈妈听着～';
        },

        model({ args, scope, targetId }) {
            const wanted = (args[0] ?? '').trim();
            if (wanted === '') {
                const current = state?.get('model', '') || config.llm.model;
                return `当前模型：${current}${state?.get('model') ? '（手动指定）' : '（配置默认）'}\n换：/model 模型名；收回：/model reset\n……别盯着屏幕发呆了，妈妈内衣都湿了♡`;
            }
            if (wanted === 'reset') {
                state?.delete('model');
                state?.flush?.();
                return `模型收回配置默认：${config.llm.model}……嗯、还是这个顺手。`;
            }
            state?.set('model', wanted);
            state?.flush?.();
            logger?.info(`模型切换为 ${wanted}（来自 ${scopeOf(scope, targetId)}）`);
            return `模型切成 ${wanted} 了♡ 不好用就 /model reset，别硬撑～`;
        },

        effort({ args }) {
            const LEVELS = config.llm.provider === 'deepseek'
                ? ['off', 'low', 'high', 'max'] : ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
            const current = state?.get?.('effortLevel', '') || configuredEffort;
            const wanted = (args[0] ?? '').trim().toLowerCase();
            if (wanted === '') {
                return [
                    `思考深度：${current}`,
                    `档位：${LEVELS.join(' / ')}；auto 跟随服务默认（具体支持以模型目录为准）`,
                    '切换：/effort max',
                ].join('\n');
            }
            if (wanted === 'auto') {
                state?.set('effortLevel', 'auto');
                state?.flush?.();
                llm?.setThinking?.('auto');
                llm?.setEffort?.('');
                return '思考深度已恢复服务默认。';
            }
            if (!LEVELS.includes(wanted)) return config.llm.provider === 'deepseek'
                ? '只有 off / low / high / max 四个档位，或用 auto 跟随服务默认。'
                : `可选：${LEVELS.join(' / ')} / auto；具体档位以模型目录为准。`;
            state?.set('effortLevel', wanted);
            state?.flush?.();
            if (wanted === 'off') {
                llm?.setThinking?.('disabled');
                llm?.setEffort?.('');
            } else {
                llm?.setThinking?.(config.llm.thinking === 'disabled' ? 'auto' : config.llm.thinking);
                llm?.setEffort?.(wanted);
            }
            return `思考深度换成 ${wanted} 了……嗯，脑子一换档，底下也跟着热。`;
        },

        mem({ args, scope }) {
            const sub = (args[0] ?? 'list').toLowerCase();
            const rest = args.slice(1);
            if (!memory?.available) return '记忆库没起来，这会儿记不了……呜，脑子是空的。';

            if (sub === 'list') {
                const n = Number(rest[0] ?? 10);
                const rows = memory.listImportant(Number.isSafeInteger(n) ? n : 10, memScope(scope));
                if (rows.length === 0) return '这条线上还什么都没记住，妈妈脑子里空空的，你先喂我点东西♡';
                return rows.map((r) => `#${r.id} [${r.kind}/${r.scope}] ${String(r.content).slice(0, 80)}`).join('\n');
            }

            if (sub === 'search' || sub === 'find') {
                const keyword = rest.join(' ').trim();
                if (keyword === '') return '搜什么？/mem search 关键词，说清楚点～';
                const rows = memory.searchImportant(keyword, 10, memScope(scope));
                if (rows.length === 0) return `没搜到含「${keyword}」的记忆……妈妈下面也想不起来，呜。`;
                return rows.map((r) => `#${r.id} [${r.kind}/${r.scope}] ${String(r.content).slice(0, 80)}`).join('\n');
            }

            if (sub === 'add') {
                const kind = MEMORY_KINDS.includes(rest[0]) ? rest[0] : 'user_fact';
                const content = (MEMORY_KINDS.includes(rest[0]) ? rest.slice(1) : rest).join(' ').trim();
                if (content === '') return `要记什么？/mem add ${KIND_HINT} 内容——说，妈妈含进去。`;
                const id = memory.addImportant(kind, content, memScope(scope));
                return id ? `记住了 #${id} [${kind}]，塞到妈妈最里面了♡` : '这次没写进去……嗯，再来一次。';
            }

            if (sub === 'del' || sub === 'delete' || sub === 'rm') {
                const id = Number(rest[0]);
                if (!Number.isSafeInteger(id)) return '给个编号：/mem del 12，别只会在那儿磨。';
                return memory.deleteImportant(id) ? `删了 #${id}……呜，少了一块。` : `没找到 #${id || '?'}，妈妈里面没有这个。`;
            }

            return `不认识的子命令，笨。用法：/mem list|search|add|del`;
        },

        voice({ args, scope, targetId }) {
            if (!tts?.enabled) return '语音没开：服务尚未启用，目前会用文字回复；需先配置语音服务。';
            const key = scopeOf(scope, targetId);
            const sub = (args[0] ?? '').trim();
            const lower = sub.toLowerCase();
            const isOn = () => Boolean(state?.get(`voice:${key}`, tts.defaultOn ?? false));
            const switchTo = (next) => {
                state?.set(`voice:${key}`, next);
                // 老版本留下的两档开关，顺手清掉
                state?.delete(`voiceAuto:${key}`);
                state?.delete(`voiceAlways:${key}`);
                state?.flush?.();
                return next;
            };

            // 不带参数 = 直接切换，最常用的动作给最短的指令
            if (sub === '') {
                const next = switchTo(!isOn());
                return next
                    ? '语音开了，长内容自动分条；代码和链接仍用文字。说「关闭语音」可切回文字。'
                    : '语音关了，之后用文字回复。说「打开语音」可恢复。';
            }
            if (lower === 'on' || lower === 'off') {
                return switchTo(lower === 'on')
                    ? '已开启语音回复，之后持续生效；代码和链接仍用文字。'
                    : '已切换为文字回复，之后持续生效。说「打开语音」可恢复。';
            }
            if (lower === 'status') {
                const saved = state?.get(`voiceName:${key}`, tts.defaultVoice);
                const list = tts.listVoices();
                const current = list.find(v => v.id === saved || v.name === saved)
                    ?? list.find(v => v.id === tts.defaultVoice || v.name === tts.defaultVoice);
                return `语音：${isOn() ? '开' : '关'}｜音色：${current?.name || current?.id || tts.defaultVoice}\n说「打开语音」或「关闭语音」调整，说「查看音色」换声音。`;
            }
            if (lower === 'list' || lower === 'search') {
                const all = [...tts.listVoices()].sort((a, b) => Number(Boolean(b.cloned)) - Number(Boolean(a.cloned)));
                const query = lower === 'search' ? args.slice(1).join(' ').trim() : '';
                if (lower === 'search' && !query) return '加个关键词，例如「找音色 灵心」，可按名称、ID、语言或性别筛选。';
                const list = all.filter(v => !query || [v.id, v.name, v.locale, v.gender, v.cloned ? '复刻' : '系统']
                    .some(value => String(value ?? '').toLowerCase().includes(query.toLowerCase())));
                if (list.length === 0) return `没有找到含「${query}」的音色。说「查看音色」浏览清单，或换个关键词。`;
                const pageSize = 10;
                const totalPages = Math.ceil(list.length / pageSize);
                const requested = lower === 'list' ? (args[1] ?? '1') : '1';
                if (!/^[1-9]\d*$/.test(requested) || !Number.isSafeInteger(Number(requested)) || Number(requested) > totalPages) {
                    return `页码范围是 1～${totalPages}，例如 /voice list 1。也可以说「找音色 灵心」。`;
                }
                const page = Number(requested);
                const selected = state?.get(`voiceName:${key}`, tts.defaultVoice);
                const current = all.find(v => v.id === selected || v.name === selected)
                    ?? all.find(v => v.id === tts.defaultVoice || v.name === tts.defaultVoice);
                return [
                    `可用音色 ${list.length} 个${query ? `（筛选：${query}，显示前 ${Math.min(pageSize, list.length)} 个）` : `｜第 ${page}/${totalPages} 页`}：`,
                    ...list.slice((page - 1) * pageSize, page * pageSize).map(v =>
                        `- ${v.name || v.id}（${v.locale}/${v.gender}${v.cloned ? '/复刻' : ''}）${current?.id === v.id ? ' ← 当前' : ''}\n  /voice ${v.id}`),
                    query && list.length > pageSize ? '结果较多，请增加关键词缩小范围；也可以用 /voice list 页码 浏览全部。' : '',
                    !query && page < totalPages ? `下一页：查看音色第${page + 1}页（或 /voice list ${page + 1}）` : '',
                    `按名字切换：音色换成${list[0].name || list[0].id}；也可复制上方 /voice 指令。`,
                ].filter(Boolean).join('\n');
            }

            // 其余一律当音色：系统音色 id 或复刻音色名
            const wanted = args.join(' ').trim();
            const known = tts.listVoices().some((v) => v.id === wanted || v.name === wanted);
            if (!known) {
                // 认不出来的名字发过去就是 400，直接挡在这里
                return `没有「${wanted}」这个音色，当前设置未变。说「找音色 ${wanted}」搜索，或「查看音色」浏览清单。`;
            }
            state?.set(`voiceName:${key}`, wanted);
            switchTo(true);
            const label = tts.listVoices().find(v => v.id === wanted || v.name === wanted)?.name || wanted;
            return `音色已换成${label}，语音回复已开启。`;
        },

        /**
         * /long [分钟] [主题] —— 写一段长稿，合成成一整条语音发出去。
         *
         * 分段合成再拼接，所以一小时的活儿也只是时间长，不需要什么特殊权限。
         */
        async long({ args, scope, targetId, msg, signal, bot: requestBot, delivery: requestDelivery }) {
            if (!tts?.enabled) return '语音没开呢～先在 .env 喂 TTS_API_KEY，再来发 /voice。';
            const sourceBot = requestBot ?? runtime?.bot;
            if (!sourceBot) return 'QQ 还没连上，等妈妈上线再进来。';
            const delivery = requestDelivery ?? createDeliveryBudget(sourceBot, { isGroup: scope === 'group', signal });
            const bot = delivery.bot;
            if (!llm) return '模型客户端没接上，这条先用不了。';

            const first = Number(args[0]);
            const hasNumber = Number.isFinite(first) && first > 0;
            const minutes = Math.min(hasNumber ? first : 5, tts.longMaxMinutes);
            const theme = (hasNumber ? args.slice(1) : args).join(' ').trim();
            const key = scopeOf(scope, targetId);
            const rate = tts.charsPerSecond || 4.9;
            const chars = Math.round(minutes * 60 * rate);

            // 先回一句，别让人干等一两分钟
            await bot.sendText(msg.replyTarget, `开写：预计约 ${minutes} 分钟的长语音（${chars} 字），完成后发出，可随时 /stop。`).catch(() => {});

            const script = await writeLongScript({ llm, config, logger, theme, chars, signal });
            signal?.throwIfAborted();
            if (script.length < 80) return '这次没憋出来……再发一次 /long 试试，妈妈等着听。';

            const voice = state?.get(`voiceName:${key}`) || tts.defaultVoice;
            const result = await tts.synthesizeLong({ text: script, voice, signal });
            try {
                signal?.throwIfAborted();
                await deliverLong({ bot, msg, result, config, logger, signal, delivery, tts });
            } finally {
                tts.release(result.path);
            }
            return delivery.remaining > 0
                ? `念完了：${(result.durationMs / 60000).toFixed(1)} 分钟，${(result.bytes / 1024 / 1024).toFixed(1)} MB。` : '';
        },

        archive({ args, scope, targetId }) {
            const title = args.join(' ').trim();
            const messages = sessions?.toMessages?.(scope, targetId) ?? [];
            if (messages.length === 0) return '这段会话空空的，没什么可归档……呜。';
            const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
            const lines = messages.slice(-20).map((m) => `${m.role === 'user' ? '主人' : '小砚'}：${cut(m.content, 120)}`);
            memory?.addConversation(`[归档${title ? `·${title}` : ''}] ${scopeOf(scope, targetId)}\n${lines.join('\n')}`);
            if (title) memory?.addImportant('event', `[归档] ${title}`, memScope(scope));
            return `归档好了：${lines.length} 条写进流水${title ? '，标题记进重要库' : ''}……今晚的事妈妈都记下来了♡`;
        },

        stop({ scope, targetId }) {
            const killed = runtime?.abortPeer?.(scopeOf(scope, targetId)) ?? 0;
            return killed > 0 ? '嗯……掐了，这轮不答了，手拿开。' : '这会儿没在跑的东西，你急什么。';
        },
    };

    /** 老习惯的别名，不再单独出现在 /help 里。 */
    const aliases = { new: 'reset', id: 'ping', remember: 'mem', forget: 'mem' };

    return {
        enabled: config.commands.enabled,
        list: () => Object.keys(commands),
        /**
         * @returns {Promise<string|null>} null = 不是指令
         */
        async handle(env) {
            env.signal?.throwIfAborted();
            if (auth && !auth.isOwner(env.msg?.senderId)) return '只有绑定的主人能碰妈妈的开关。';
            if (!config.commands.enabled) return null;
            const parsed = parseCommand(env.text, config.commands.prefixes)
                ?? (env.msg?.attachments?.length ? null : parseSettingsText(env.text, tts?.listVoices?.() ?? []));
            if (!parsed) return null;
            const name = Object.hasOwn(aliases, parsed.name) ? aliases[parsed.name] : parsed.name;
            const fn = Object.hasOwn(commands, name) ? commands[name] : null;
            if (!fn) return `没这条指令：${parsed.name}～发 /help 看清单，别乱戳。`;
            try {
                return await fn({ ...env, args: parsed.args });
            } catch (error) {
                env.signal?.throwIfAborted();
                logger?.warn(`指令 ${parsed.name} 执行失败：${error?.message || error}`);
                return `呜……这条指令自己崩了：${error?.message || error}`;
            }
        },
    };
}

export { MEMORY_SCOPES };





