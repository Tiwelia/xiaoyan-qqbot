/** Owner-only proactive chat. No model work happens on ordinary timer ticks. */
import { buildSystemPrompt } from './persona.js';
import { buildChatStyle } from './chat-style.js';
import { looksLikeRefusal } from './uncensor.js';

const KEY = 'companion';
const DAY_MS = 86_400_000;
const MINUTE = 60_000;

export function localClock(at, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
    }).formatToParts(new Date(at));
    const get = (name) => parts.find((p) => p.type === name)?.value;
    return { day: `${get('year')}-${get('month')}-${get('day')}`, hour: Number(get('hour')) };
}

export function isQuietHour(hour, start, end) {
    return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

export function chatPreference(text) {
    const s = String(text ?? '').trim().replace(/[。！!～~\s]+$/g, '');
    if (/^(?:关闭|暂停|停止)主动聊天$/.test(s)) return 'off';
    if (/^(?:你)?(?:先)?(?:别|不要|不用)(?:再)?主动(?:来)?(?:找我(?:聊天)?|给我发消息)(?:了)?$/.test(s)) return 'off';
    if (/^(?:你)?(?:可以|恢复|开启)(?:主动聊天|主动找我(?:聊天)?|主动给我发消息)(?:了)?$/.test(s)) return 'on';
    if (/^(?:我)?(?:先去忙了|先忙了|去忙了|要开会了|晚点聊)$/.test(s)) return 'busy';
    if (/^(?:我)?(?:要睡了|去睡了|睡觉了|晚安)$/.test(s)) return 'sleep';
    return null;
}

export function createCompanion({ config, state, auth, bot, llm, memory, sessions, runtime, logger,
    now = () => Date.now(), random = Math.random }) {
    const cfg = config.companion;
    const timeZone = config.timezone || 'Asia/Shanghai';
    let online = false, stopped = false, timer = null, running = null, controller = null;
    let revision = 0;
    const read = () => {
        const saved = state.get(KEY, {});
        const data = saved && typeof saved === 'object' && !Array.isArray(saved) ? { ...saved } : {};
        const day = localClock(now(), timeZone).day;
        const view = data.day === day ? { ...data } : { ...data, day, attempts: 0, sent: 0 };
        // 发送结果未知（pending）又一直等不到回复：24 小时后放开，别让机器人永久闭嘴。
        if (view.awaitingReply && view.lastPushAt && now() - view.lastPushAt > DAY_MS) {
            view.awaitingReply = false;
            if (view.pushStatus === 'pending') view.pushStatus = 'stale';
        }
        return view;
    };
    const save = (data, flush = false) => { state.set(KEY, data); if (flush) state.flush?.(); };
    const delay = () => cfg.idleMinMs + Math.floor(Math.max(0, Math.min(1, random())) * (cfg.idleMaxMs - cfg.idleMinMs));
    const quiet = () => isQuietHour(localClock(now(), timeZone).hour, cfg.quietStart, cfg.quietEnd);
    const enabled = (data) => cfg.enabled && data.enabled !== false;
    function cancel() {
        revision += 1;
        controller?.abort(Object.assign(new Error('新消息或关闭操作中止主动聊天'), { interrupt: true }));
    }

    function observe(msg) {
        if (msg?.kind !== 'c2c' || !auth.isOwner(msg.senderId)) return;
        cancel();
        const old = read();
        const data = old.ownerId === msg.senderId ? old : { day: old.day, attempts: old.attempts, sent: old.sent };
        const at = now();
        const preference = chatPreference(msg.content);
        let snoozeUntil = 0;
        if (preference === 'busy') snoozeUntil = at + 2 * 60 * MINUTE;
        if (preference === 'sleep') {
            // Find the next local quiet-window end, including when bedtime is unusually early.
            snoozeUntil = at + 30 * MINUTE;
            while (snoozeUntil < at + 30 * 60 * MINUTE && localClock(snoozeUntil, timeZone).hour !== cfg.quietEnd) snoozeUntil += 30 * MINUTE;
        }
        save({ ...data, ownerId: msg.senderId, previousUserAt: data.lastUserAt || 0,
            lastUserAt: at, awaitingReply: false, nextAt: at + delay(), snoozeUntil }, true);
    }

    function handleControl(text, ownerId) {
        if (!auth.isOwner(ownerId)) return null;
        const preference = chatPreference(text);
        if (!['on', 'off'].includes(preference)) return null;
        cancel();
        save({ ...read(), enabled: preference === 'on', nextAt: now() + delay(),
            ...(preference === 'on' ? { blockedUntil: 0 } : {}) }, true);
        return preference === 'off'
            ? '好，先不主动找你了。你想聊的时候发我就行。'
            : cfg.enabled ? '好呀，有合适的话题就来找你。你忙或者睡觉的时候，我会等着。' : '主动聊天的服务器总开关还关着，需要先打开 PROACTIVE_ENABLED。';
    }

    function onReply(ownerId) {
        if (!auth.isOwner(ownerId)) return;
        const data = read();
        if (data.ownerId !== ownerId) return;
        save({ ...data, lastReplyAt: now(), nextAt: Math.max(data.nextAt || 0, now() + delay()) });
    }

    function eligible(data) {
        return online && !stopped && enabled(data) && data.ownerId && auth.isOwner(data.ownerId)
            && data.lastUserAt > 0 && !data.awaitingReply && !quiet()
            && now() >= (data.nextAt || Infinity) && now() >= (data.snoozeUntil || 0)
            && now() >= (data.blockedUntil || 0) && now() - data.lastUserAt >= cfg.idleMinMs
            // 生成尝试给到 3 倍：模型说「没话题」不该把一天的机会全耗光
            && (data.attempts || 0) < cfg.dailyMax * 3 && (data.sent || 0) < cfg.dailyMax
            && (runtime.activeTurns?.() ?? 0) === 0;
    }

    async function generateAndSend(data, signal, version) {
        const ownerId = data.ownerId;
        const memoryText = config.memory.enabled && memory?.available !== false
            ? memory?.renderForPrompt?.(config.memory.warmInjectLimit, config.memory.warmInjectChars, 'c2c') || '' : '';
        const history = sessions.toMessages('c2c', ownerId).slice(-10);
        const system = buildSystemPrompt({ memoryText, scope: 'c2c', voice: false,
            now: new Date(now()), timeZone, model: state.get('model', '') || config.llm.model });
        const style = buildChatStyle({ config, state, peerKey: `c2c:${ownerId}`, now: now() });
        const result = await llm.stream({
            model: state.get('model', '') || config.llm.model, maxTokens: 512, signal,
            // Short check-ins should not spend their whole output budget on DeepSeek reasoning.
            thinking: new URL(config.llm.baseUrl).hostname === 'api.deepseek.com' ? 'disabled' : undefined,
            messages: [{ role: 'system', content: [system, style].filter(Boolean).join('\n\n') }, ...history,
                { role: 'system', content: '这是内部定时触发的主动聊天，不是对方刚发了一条新消息。结合最近的真实话题或记忆，写一条自然的简短消息，通常一到两句。不要每天机械早安晚安、催回复、查岗或重复上一条主动消息；不要编造对方的近况、约定或你现实中的活动。只输出要发出的正文，不要工具、标签或说明。没有合适的新话题、对方说要忙或休息，就只输出 [[skip]]。最多 200 字。' }],
        });
        signal.throwIfAborted();
        const latest = read();
        if (revision !== version || !online || stopped || !enabled(latest) || quiet()
            || (runtime.activeTurns?.() ?? 0) > 0 || !auth.isOwner(ownerId)) return;
        const text = String(result?.text ?? '').trim();
        // Reject oversized drafts instead of cutting a sentence or generating another paid draft.
        const skipReason = !text ? '模型给了空文本'
            : text.includes('[[skip]]') ? '模型判断没话题'
                : result.toolCalls?.length ? '模型想调工具'
                    : text.length > cfg.maxChars ? '草稿太长'
                        : /\[\[(?:voice|image)(?::|\]\])|```/.test(text) ? '草稿带了媒体标记'
                            : looksLikeRefusal(text) ? '草稿像拒答'
                                : text === latest.lastPushText ? '和上一条重复' : '';
        if (skipReason) {
            // 跳过也花了 token，记一笔；但半小时后可以再试，不把当天额度锁死
            save({ ...latest, attempts: latest.attempts, lastSkipAt: now(), lastSkipReason: skipReason,
                nextAt: now() + 30 * MINUTE }, true);
            logger?.info(`主动聊天跳过：${skipReason}`);
            return;
        }

        // Reserve before network I/O. Unknown send outcomes must never be blindly retried after a restart.
        save({ ...latest, sent: (latest.sent || 0) + 1, awaitingReply: true,
            lastPushAt: now(), lastPushText: text, pushStatus: 'pending' }, true);
        try {
            await bot.send({ target: { scope: 'c2c', targetId: ownerId }, msgType: 0, content: text });
            save({ ...read(), lastPushAt: now(), lastPushText: text, pushStatus: 'sent' }, true);
            logger?.info('主动聊天已发送一条，等待主人回复');
        } catch (error) {
            const code = error?.code ?? error?.status ?? 'unknown';
            save({ ...read(), pushStatus: 'failed', blockedUntil: now() + DAY_MS }, true);
            logger?.warn(`QQ 主动消息发送失败（${code}），暂停主动发送 24 小时；请检查 QQ 的允许主动发送开关和机器人权限`);
        }
    }

    function tick() {
        if (running) return running;
        const data = read();
        if (!eligible(data)) return Promise.resolve(false);
        save({ ...data, attempts: (data.attempts || 0) + 1, nextAt: now() + delay() }, true);
        const version = revision;
        const taskController = new AbortController();
        controller = taskController;
        const deadline = setTimeout(() => taskController.abort(new Error('主动聊天生成超时')), cfg.timeoutMs);
        running = generateAndSend(data, taskController.signal, version).catch((error) => {
            if (!taskController.signal.aborted) logger?.warn(`主动聊天生成未完成（${error?.name || 'Error'}），稍后再检查`);
        }).finally(() => {
            clearTimeout(deadline);
            controller = null;
            running = null;
        });
        return running;
    }

    return {
        observe, handleControl, onReply, tick, cancel,
        start() {
            if (timer || stopped) return;
            timer = setInterval(() => { void tick(); }, cfg.checkEveryMs);
            timer.unref?.();
        },
        setOnline(value) { online = Boolean(value); if (!online) cancel(); },
        async stop() { stopped = true; online = false; if (timer) clearInterval(timer); timer = null; cancel(); await running; },
        stats() {
            const data = read();
            return { enabled: enabled(data), dailyMax: cfg.dailyMax, sent: data.sent || 0,
                attempts: data.attempts || 0, awaitingReply: Boolean(data.awaitingReply),
                quiet: quiet(), quietStart: cfg.quietStart, quietEnd: cfg.quietEnd,
                pushStatus: data.pushStatus || '', lastPushAt: data.lastPushAt || 0,
                lastSkipReason: data.lastSkipReason || '', lastSkipAt: data.lastSkipAt || 0,
                blockedUntil: data.blockedUntil || 0 };
        },
    };
}

