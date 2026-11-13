/**
 * QQ 接线：建 QQBot、挂中间件、把事件交给会话流水线。
 *
 * 所有业务逻辑都不在这里 —— 只负责「谁该被回复」「怎么排队」两件事：
 *   · messageFilter 自回声 / 重复推送
 *   · accessPolicy  白名单 / 开关
 *   · quoteRef      引用消息解析（旧 bot 有，迁移时丢了）
 *   · 限流          人级滑动窗口 + 冷却
 *   · 同一个会话串行处理，全局再压一道并发闸门
 */
import { QQBot, accessPolicy, messageFilter, quoteRef } from '@tencent-connect/qqbot-nodejs';

import { parseCommand, wantsTextReply } from './commands.js';
import { handleMessage } from './conversation.js';
import { createLimiter, createSerialQueue, runWithDeadline } from './queue.js';
import { createOwnerGuard } from './owner.js';
import { createDeliveryBudget } from './delivery.js';

/**
 * 滑动窗口限流：每个 peer 每分钟最多 N 条 + 两次之间最少隔 M 毫秒。
 * 放在 enqueue 之前，被拦下的消息连队列都进不去。
 */
export function createPeerGuard({ perMin = 12, cooldownMs = 800, now = () => Date.now(), maxKeys = 500 } = {}) {
    const hits = new Map();
    const last = new Map();

    /** 单聊场景 key 会一直增长（换号、群、测试），超上限就丢最老的一条。 */
    const prune = (map) => {
        while (map.size > maxKeys) {
            const oldest = map.keys().next().value;
            map.delete(oldest);
        }
    };

    return function allow(key) {
        const ts = now();
        if (cooldownMs > 0) {
            const prev = last.get(key);
            if (prev !== undefined && ts - prev < cooldownMs) return { ok: false, reason: 'cooldown' };
        }
        if (perMin > 0) {
            const window = (hits.get(key) ?? []).filter((t) => ts - t < 60_000);
            if (window.length >= perMin) {
                hits.set(key, window);
                return { ok: false, reason: 'rate' };
            }
            window.push(ts);
            hits.set(key, window);
        }
        last.set(key, ts);
        prune(last);
        prune(hits);
        return { ok: true };
    };
}

/**
 * @param {object} deps
 * @param {object} deps.config
 * @param {object} deps.logger
 * @param {object} deps.llm
 * @param {object} deps.memory
 * @param {object} deps.sessions
 * @param {object} deps.toolkit
 * @param {object} [deps.runtime]
 */
export function createBot(deps, { Bot = QQBot } = {}) {
    const { config, logger } = deps;
    const auth = deps.auth ?? createOwnerGuard({ config, logger });

    const bot = new Bot({
        appId: config.qq.appId,
        appSecret: config.qq.appSecret,
        logger,
        markdownSupport: config.qq.markdown,
        transport: 'websocket',
        ...(config.qq.baseUrl ? { baseUrl: config.qq.baseUrl, tokenBaseUrl: config.qq.baseUrl } : {}),
    });

    bot.use(messageFilter({ skipSelfEcho: true, dedup: { windowMs: 5_000 } }));
    bot.use(async (ctx, next) => {
        if (ctx.message && ctx.message.kind !== 'c2c') return;
        if (ctx.message && !await auth.check(ctx.message, bot)) return;
        await next();
    });

    bot.use(
        accessPolicy({
            c2c: { mode: config.access.c2cMode, allow: config.access.c2cAllow },
            group: { mode: 'disabled', allow: [] },
            onBlock: (ctx, reason) => logger.info(`拦截消息（${reason}）来自 ${ctx.message?.senderId ?? '?'}`),
        }),
    );

    // 引用：记录每条消息 + 解析被引用的那条，结果在 ctx.state.quote
    bot.use(quoteRef({ maxSize: 500, contentLimit: 1000 }));

    // ── 事件 ────────────────────────────────────────────────────────────────
    const enqueue = createSerialQueue();
    const limit = createLimiter(config.behavior.maxConcurrency);
    const allowPeer = createPeerGuard({
        perMin: config.behavior.peerRatePerMin,
        cooldownMs: config.behavior.peerCooldownMs,
    });
    const tasks = new Set();
    /** peerKey -> Set<AbortController>，同时覆盖排队和正在执行的轮次。 */
    const controllers = new Map();
    let stopping = false;

    const runtime = deps.runtime ?? {};
    runtime.abortPeer = (key) => {
        let killed = 0;
        for (const controller of controllers.get(key) ?? []) {
            controller.abort(new Error('/stop'));
            killed += 1;
        }
        return killed;
    };
    runtime.activeTurns = () => [...controllers.values()].reduce((n, group) => n + group.size, 0);
    bot.runtime = runtime;

    bot.drain = async () => {
        stopping = true;
        runtime.companion?.cancel();
        for (const group of controllers.values()) for (const controller of group) controller.abort(new Error('机器人正在退出'));
        await Promise.allSettled([...tasks, runtime.companion?.stop()]);
    };

    bot.on('message', async (ctx, msg) => {
        if (stopping) return;
        // 个人单聊模式：群里被拉进去也不应答，连旁听都不记。
        if (msg.kind !== 'c2c') {
            logger.debug('忽略非私聊消息（个人专用机器人）');
            return;
        }
        if (!await auth.check(msg, bot) || stopping) return;
        const key = sessionKeyOf(msg);
        runtime.companion?.observe(msg);

        // 主人发新消息就等于「别说了，听我说」：直接打断上一轮，不用记任何指令。
        // 排队中的任务也一并取消，避免「说了停下它还在跑」。
        const running = controllers.get(key);
        let interrupted = false;
        if (running && running.size > 0) {
            const reason = new Error('新的消息打断了上一轮');
            reason.interrupt = true;
            for (const controller of [...running]) controller.abort(reason);
            interrupted = true;
            logger.info(`新消息打断上一轮（${running.size} 个任务）：${key}`);
        }

        // /stop 保留成兜底写法（不想说别的话时用），行为与打断一致。
        if (config.commands.enabled) {
            const parsed = parseCommand(msg.content, config.commands.prefixes);
            if (parsed?.name === 'stop') {
                const killed = runtime.abortPeer(key);
                logger.info(`/stop：中止 ${killed} 个在跑的轮次（${key}）`);
                void bot.sendText(msg.replyTarget, killed > 0 ? '掐了，这轮不答了。' : '这会儿没在跑的东西。')
                    .catch((error) => logger.warn(`回复 /stop 失败：${error?.message || error}`));
                return;
            }
            if (['reset', 'new'].includes(parsed?.name) && typeof deps.commands?.handle === 'function') {
                // Reset is a synchronous local commit before its first await. Do not queue it
                // behind cancelled network work, rate-limit it, or let a follow-up undo it.
                const delivery = createDeliveryBudget(bot, { isGroup: false });
                const task = handleMessage({ ...deps, bot: delivery.bot, delivery, auth, runtime }, ctx, msg)
                    .catch(error => logger.warn(`清空会话处理失败：${error?.message || error}`));
                tasks.add(task);
                try { await task; } finally { tasks.delete(task); }
                return;
            }
        }

        // 打断性的新消息要放行：不然刚说完「别说了」第二条反而被冷却丢掉。
        const gate = allowPeer(key);
        if (!gate.ok && !interrupted) {
            logger.debug(`限流丢弃（${gate.reason}）：${key}`);
            return;
        }
        // 同一会话串行（历史不打架），全局限流（不把上游打爆），再套一层超时
        const controller = new AbortController();
        if (!controllers.has(key)) controllers.set(key, new Set());
        controllers.get(key).add(controller);
        const receivedAt = Date.now();
        let delivery;
        const task = enqueue(key, () => limit(async () => {
            if (stopping) return;
            const command = config.commands.enabled ? parseCommand(msg.content, config.commands.prefixes) : null;
            // 语音开着的一轮随时可能生成十几分钟的长语音，用长超时；普通文字聊天仍是短超时
            const voiceOn = !wantsTextReply(msg.content) && Boolean(deps.state?.get?.(`voice:${key}`, deps.tts?.defaultOn ?? false));
            const timeoutMs = command?.name === 'long' || voiceOn
                ? config.behavior.longReplyTimeoutMs : config.behavior.replyTimeoutMs;
            const remainingMs = timeoutMs - (Date.now() - receivedAt);
            if (remainingMs <= 0) throw Object.assign(new Error('消息在队列中已过期'), { timeout: true });
            delivery = createDeliveryBudget(bot, { isGroup: msg.kind === 'group', signal: controller.signal });
            return runWithDeadline(
                (signal) => handleMessage({ ...deps, bot: delivery.bot, delivery, auth, runtime }, ctx, msg, { signal }),
                remainingMs, '消息处理', controller,
            );
        }, { signal: controller.signal }), { signal: controller.signal }).catch(async (error) => {
            if (error?.interrupt || String(error?.message || '').includes('/stop')) {
                logger.info(`会话 ${key} 的这轮被打断了`);
                return;
            }
            // 超时不能静默吞掉：用户在那儿干等，至少给一句交代
            if (error?.timeout) {
                logger.error(`处理超时，已中止：${error.message}`);
                try {
                    // The turn signal is already aborted; only a bounded timeout notice may use this slot.
                    if (!delivery || delivery.remaining > 0) await bot.sendText(msg.replyTarget, '……这轮卡太久了，我掐了。你再说一遍，我重来。');
                } catch (sendError) {
                    logger.warn(`超时提示发送失败：${sendError?.message || sendError}`);
                }
                return;
            }
            logger.error(`处理消息失败：${error?.message || error}`);
        }).finally(() => {
            const group = controllers.get(key);
            group?.delete(controller);
            if (group?.size === 0) controllers.delete(key);
        });
        tasks.add(task);
        void task.finally(() => tasks.delete(task));
        return task;
    });

    // 按钮点击：先应答掉，免得 QQ 那边一直转
    bot.on('interaction', (ctx, event) => {
        logger.debug(`收到交互事件 ${event?.id ?? '?'}，当前没有交互按钮在用`);
        if (event?.id && typeof bot.acknowledgeInteraction === 'function') {
            void bot.acknowledgeInteraction(event.id, 0).catch(() => {});
        }
    });

    bot.on('ready', () => {
        runtime.companion?.setOnline(true);
        runtime.companion?.start();
        logger.info(`QQ 机器人已上线（appId=${config.qq.appId}）`);
    });
    bot.on('resumed', () => {
        runtime.companion?.setOnline(true);
        runtime.companion?.start();
        logger.info('WebSocket 会话已恢复（RESUME）');
    });
    bot.on('error', (error) => logger.error(`QQ SDK 错误：${error?.message || error}`));

    return bot;
}

/** 会话键：私聊按用户，群聊按群（同一个群共用一段上下文）。 */
function sessionKeyOf(msg) {
    const isGroup = msg.kind === 'group';
    const id = isGroup ? msg.groupOpenid ?? msg.senderId : msg.senderId;
    return `${isGroup ? 'group' : 'c2c'}:${id}`;
}


