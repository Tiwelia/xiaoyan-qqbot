/**
 * 会话流水线：一条 QQ 消息进来，一轮完整回复出去。
 *
 *   指令分流 → 中间件放行 → 组装 system prompt（人设 + 分层记忆 + 引用 + 群旁听）
 *   → LLM（工具循环：记忆 / 语音）→ 越狱兜底 → 分块发送 → 语音条 → 会话落盘
 *
 * 这里只管「一条消息怎么变成一条回复」，QQ 的连接与中间件在 bot.js。
 */
import { buildSystemPrompt, personaVersion } from './persona.js';
import { chunkText, sanitizeInbound } from './text.js';
import { sanitizeForSpeech, stripTagsForText } from './tts.js';
import { fallbackFor, looksLikeRefusal, looksLikeSoftRefusal, nudgeFor, reframeVariants, stripRefusalPreamble, stripTrailingPlea } from './uncensor.js';
import { createDeliveryBudget, sendLongAudio } from './delivery.js';
import { buildVoiceStyleSection } from './voice-style.js';
import { buildChatStyle, buildTurnFormat } from './chat-style.js';
import { wantsTextReply } from './commands.js';
import { normalizeReplyLayout, preserveRequestedLayout, inspectReplyText } from './reply-text.js';

const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGES_PER_MESSAGE = 3;
const GROUP_HISTORY_LINES = 10;
/** 一轮最多发几条语音，给资源和被动回复额度都留余量。 */
const MAX_AUDIO_PER_TURN = 1;
const VOICE_MARKER = /\[\[voice:([a-zA-Z0-9_-]+)\]\]/g;
const IMAGE_MARKER = /\[\[image\]\]/g;

/**
 * @param {object} deps  { bot, config, logger, llm, memory, sessions, toolkit, tts, state, commands, runtime }
 * @param {object} ctx   SDK 的中间件上下文（含 state.mention / state.history / state.quote）
 * @param {object} msg   SDK 的入站消息（含 replyTarget）
 */
export async function handleMessage(deps, ctx, msg, { signal } = {}) {
    signal?.throwIfAborted();
    const { scope, targetId, isGroup, peerKey } = resolvePeer(msg);
    if (deps.auth && !deps.auth.isOwner(msg.senderId)) return;
    const delivery = deps.delivery ?? createDeliveryBudget(deps.bot, { isGroup, signal });
    deps = { ...deps, bot: delivery.bot, delivery };
    const { bot, config, logger, memory, sessions, toolkit } = deps;

    // 群聊里没 @ 我的消息由 mentionGate 标了 shouldAnswer=false，只当旁听
    const mention = ctx?.state?.mention;
    if (isGroup && mention && mention.shouldAnswer === false) {
        logger.debug(`群消息未触发回复（${mention.reason}），只记了旁听`);
        return;
    }

    const { text: userText, images } = collectInput(msg);
    if (userText === '' && images.length === 0) {
        logger.debug('空消息，忽略');
        return;
    }

    // ── 指令：不进模型，不花 token ───────────────────────────────────────────
    const commandReply = await dispatchCommand(deps, { text: userText, scope, targetId, msg, signal, bot, delivery });
    if (commandReply !== null) {
        if (commandReply !== '') await deliver(deps, msg, { text: commandReply, signal, isGroup });
        deps.runtime?.companion?.onReply(msg.senderId);
        return;
    }

    const controlReply = deps.runtime?.companion?.handleControl(userText, msg.senderId);
    if (controlReply != null) {
        await deliver(deps, msg, { text: controlReply, signal, isGroup });
        deps.runtime.companion.onReply(msg.senderId);
        return;
    }

    logger.info(`收到${isGroup ? '群' : '私聊'}消息：${userText.length} 字，${images.length} 张图`);

    deps = { ...deps, forceTextReply: wantsTextReply(userText) };
    const voiceOn = isVoiceOn(deps, peerKey);
    // Voice replies always keep this slot even when an older server .env enables typing.
    if (config.behavior.typingIndicator && !isGroup && !voiceOn) {
        await bot.sendTyping?.(msg.replyTarget).catch(() => {});
    }

    const model = deps.state?.get?.('model', '') || config.llm.model;

    const turnFormat = buildTurnFormat(userText);
    const messages = [
        { role: 'system', content: buildPrompt({ ...deps, scope, targetId, ctx, msg, isGroup, voiceOn, model, assets: deps.runtime?.assets ?? [] }) },
        ...(sessions.toMessages(scope, targetId) ?? []),
        ...(turnFormat ? [{ role: 'system', content: turnFormat }] : []),
        { role: 'user', content: await buildUserContent({ userText, images, config, logger, signal }) },
    ];
    signal?.throwIfAborted();

    // 语音开着就关掉流式：流出去的文字会和语音条重复一遍。
    const stream = isGroup || !config.behavior.streaming || voiceOn ? null : openStream(bot, msg, logger);
    // 这个会话没开语音就别把 tts 工具挂上去，省一轮 token
    const tools = (toolkit.definitions ?? []).filter((d) => {
        const name = String(d?.function?.name ?? '');
        return (voiceOn || !name.startsWith('tts_')) && !(deps.forceTextReply && name === 'audio_scene');
    });

    let replyText = '';
    let audioIds = [];
    let voiceFailed = false;
    try {
        const outcome = await runChat({
            deps, scope, peerKey, msg, bot, messages, stream, signal, model, tools, userText,
        });
        replyText = outcome.text;
        audioIds = outcome.audioIds;
        voiceFailed = Boolean(outcome.voiceFailed);
    } catch (error) {
        if (signal?.aborted) { stream?.cancel(); throw signal.reason; }
        logger.error(`LLM 调用失败：${error?.stack || error}`);
        await deliver(deps, msg, {
            text: isGroup ? '……操，脑子突然卡住了，等下再喊我。' : '……操，脑袋卡壳了，等我缓一下再回你，别急嘛。',
            signal,
            isGroup,
            stream,
        }).catch(() => {});
        return;
    }

    const text = normalizeReplyLayout((replyText ?? '').trim(), {
        preserveLineBreaks: preserveRequestedLayout(userText),
    });
    if (text === '' && audioIds.length === 0) {
        stream?.cancel();
        logger.warn('模型返回空文本，这次不发');
        return;
    }

    // 发送与语音都在 try 里：任何一环炸了，会话照样落盘，用户的半截话模型也得知道；
    // 没送出去的音频在同一处清掉，不留到 TTL。
    try {
        // 语音开着就只发语音条，不再先发一条一样的文字——听着像复读。
        // 但代码块、长链接念不出来，这类必须走文字。
        const displayText = stripTagsForText(text);
        const needsText = /```|https?:\/\//.test(text);
        const speechPlanned = voiceOn && deps.tts?.enabled && !needsText
            && planSpeech(displayText, deps.tts.segmentChars, deps.tts.segmentsMax, deps.tts.maxChars).length > 0;

        let speech = null;
        if (speechPlanned && audioIds.length === 0 && !voiceFailed) {
            speech = await speakReply(deps, msg, text, peerKey, signal);
        }
        const spokeSomething = Boolean(speech && speech.sent > 0);
        if (audioIds.length > 0 || !spokeSomething) {
            // 工具已经发过语音，或者这次压根没合成出来：文字照发，别让人干等。
            await deliver(deps, msg, {
                text: displayText,
                signal,
                isGroup,
                stream,
                reserveAudio: audioIds.length,
            });
        }
        deps.runtime?.companion?.onReply(msg.senderId);
        signal?.throwIfAborted();

        if (audioIds.length > 0) {
            await sendAudio(deps, msg, audioIds, signal);
        }
        if (spokeSomething && speech?.dropped > 0) {
            // 念不完的部分不要凭空消失：当成文字补发（不是重复，是没念到的尾巴）
            const tail = String(speech.tail ?? '').trim();
            if (tail && (deps.delivery?.remaining ?? 0) > 0) {
                await deliver(deps, msg, {
                    text: `（有 ${speech.dropped} 字未能朗读，补在这里）\n${tail}`,
                    signal,
                    isGroup,
                }).catch((error) => logger.warn(`补发未朗读部分失败：${error?.message || error}`));
            } else {
                logger.warn(`朗读截断（${speech.dropped} 字）但额度不够补发`);
            }
        }
        signal?.throwIfAborted();
    } finally {
        if (!signal?.aborted) {
            sessions.append(scope, targetId, [
                { role: 'user', content: userText || '[图片]' },
                { role: 'assistant', content: text || '[语音]' },
            ]);
            deps.evalLog?.append?.({
                user: userText, reply: text, voice: voiceOn, scope,
                model: deps.state?.get?.('model', '') || config.llm.model,
                effort: deps.state?.get?.('effortLevel', '') || config.llm.effort || '',
                thinking: deps.llm.getThinking?.() ?? config.llm.thinking,
                persona: personaVersion,
                promptVersion: personaVersion,
                textMetrics: inspectReplyText(text, userText),
                layoutNormalized: text !== (replyText ?? '').trim(),
            });
            if (config.behavior.logConversation && memory.available) {
                memory.addConversation(
                    summarizeLine({
                        scope,
                        senderName: msg.senderName,
                        senderId: msg.senderId,
                        userText: userText || '[图片]',
                        replyText: text || '[语音]',
                    }),
                );
            }
        }
        // take 过的已经在发送时删了，这里处理剩下的异常路径
        for (const id of audioIds) deps.tts?.drop?.(id);
    }
}
// ── 组装 ────────────────────────────────────────────────────────────────────

/** 这个会话的语音开关（state 里没有就用默认值）。 */
function isVoiceOn(deps, peerKey) {
    if (deps.forceTextReply) return false;
    return Boolean(deps.state?.get?.(`voice:${peerKey}`, deps.tts?.defaultOn ?? false));
}

/** 会话里存的音色可能是上一个引擎的（比如切到 qwen 后还留着「冰糖」），先校验再用。 */
function resolveVoiceName(tts, state, peerKey) {
    const saved = state?.get?.(`voiceName:${peerKey}`);
    if (!saved || typeof saved !== 'string') return tts.defaultVoice;
    if (tts.engine !== 'qwen') return saved;
    const voices = tts.listVoices?.() ?? [];
    // 存的可能是 id，也可能是复刻音色的名字（/voice 软糖）——两种都认
    if (voices.some((v) => v.id === saved)) return saved;
    const byName = voices.find((v) => v.name === saved);
    if (byName) return byName.id;
    return tts.defaultVoice;
}

function resolvePeer(msg) {
    const isGroup = msg.kind === 'group';
    const targetId = isGroup ? msg.groupOpenid ?? msg.senderId : msg.senderId;
    return {
        isGroup,
        targetId,
        scope: isGroup ? 'group' : 'c2c',
        peerKey: `${isGroup ? 'group' : 'c2c'}:${targetId}`,
    };
}

/** 从入站消息里挑出正文、图片、语音转写。 */
function collectInput(msg) {
    const attachments = Array.isArray(msg.attachments) ? msg.attachments : [];
    const images = attachments.filter(isImageAttachment);
    const voiceText = attachments
        .filter(isVoiceAttachment)
        .map((a) => {
            const said = String(a.asr_refer_text ?? '').trim();
            if (!said) return '';
            const secs = a.duration ? `（${a.duration}秒）` : '';
            return `[语音${secs}] ${said}`;
        })
        .filter(Boolean)
        .join('\n');
    const text = [sanitizeInbound(msg.content), voiceText].filter(Boolean).join('\n').trim();
    return { text, images, voiceText };
}

/**
 * QQ 推来的 content_type 可能是 `image`、`image/jpeg`，也可能干脆没填。
 * 三种都认，别再让图片白进来一趟。
 */
function isImageAttachment(a) {
    const ct = String(a?.content_type ?? '').trim().toLowerCase();
    if (ct === 'image' || ct.startsWith('image/')) return true;
    if (ct === '') return /\.(png|jpe?g|gif|webp|bmp|heic)$/i.test(String(a?.filename ?? ''));
    return false;
}

function isVoiceAttachment(a) {
    const ct = String(a?.content_type ?? '').trim().toLowerCase();
    return ct === 'voice' || ct === 'audio' || ct.startsWith('audio/') || Boolean(a?.asr_refer_text);
}

/** 记忆作用域：群聊按配置收窄，别把主人的私事贴到群里。 */
function memoryScopeOf(config, scope) {
    if (scope !== 'group') return 'c2c';
    if (config.memory.groupMode === 'off') return null;
    if (config.memory.groupMode === 'full') return '';
    return 'group';
}

function buildPrompt({ config, memory, sessions, state, ctx, msg, scope, targetId, isGroup, voiceOn, model, assets }) {
    let memoryText = '';
    if (config.memory.enabled && memory.available !== false) {
        const memScope = memoryScopeOf(config, scope);
        if (memScope !== null) {
            const fresh = sessions.isFresh?.(scope, targetId)
                ?? (sessions.toMessages?.(scope, targetId)?.length ?? 0) === 0;
            memoryText = fresh
                ? memory.renderForPrompt(config.memory.injectLimit, config.memory.injectMaxChars, memScope)
                : memory.renderForPrompt(config.memory.warmInjectLimit, config.memory.warmInjectChars, memScope);
        }
    }
    const groupHistory = isGroup ? renderGroupHistory(ctx?.state?.history, msg) : '';
    const quote = renderQuote(ctx?.state?.quote);
    const images = Array.isArray(assets) ? assets : [];
    const base = buildSystemPrompt({
        memoryText,
        groupHistory,
        quote,
        scope,
        voice: voiceOn,
        voiceGuide: voiceOn ? buildVoiceStyleSection(config.tts.engine) : '',
        timeZone: config.timezone,
        model,
        images,
    });
    const style = isGroup ? '' : buildChatStyle({ config, state, peerKey: `c2c:${targetId}`,
        resetAt: sessions.getResetAt?.(scope, targetId) ?? 0 });
    return [base, style].filter(Boolean).join('\n\n');
}

/** 群里刚才别人说了什么（不含当前这条），当成旁听上下文。 */
function renderGroupHistory(history, msg) {
    if (!Array.isArray(history) || history.length === 0) return '';
    return history
        .filter((h) => h.messageId !== msg.messageId)
        .slice(-GROUP_HISTORY_LINES)
        .map((h) => `${h.senderName || h.senderId}: ${sanitizeInbound(h.content).slice(0, 200)}`)
        .filter((line) => line.trim() !== '')
        .join('\n');
}

/** 被引用的那条消息：旧 bot 有，迁移时丢了，现在接回来。 */
function renderQuote(quote) {
    if (!quote) return '';
    const text = String(quote.text || quote.entry?.content || '').trim();
    const attachments = Array.isArray(quote.attachments) ? quote.attachments : [];
    const lines = [];
    if (text) lines.push(text.slice(0, 1000));
    for (const a of attachments.slice(0, 3)) {
        if (a.asrText) lines.push(`[语音] ${a.asrText}`);
        else if (a.filename) lines.push(`[附件] ${a.filename}`);
    }
    return lines.join('\n');
}

/** 用户这一条是纯文本还是图文混合（取决于有没有配 vision 模型）。 */
async function buildUserContent({ userText, images, config, logger, signal }) {
    const text = userText || '（用户发来一张图片）';

    if (images.length === 0 || !config.llm.visionModel) {
        return images.length > 0
            ? `${text}\n（对方还发来 ${images.length} 张图片，但当前没开图片识别，你可以让他用文字讲讲画面）`
            : text;
    }

    const parts = [{ type: 'text', text }];
    for (const att of images.slice(0, MAX_IMAGES_PER_MESSAGE)) {
        signal?.throwIfAborted();
        const dataUrl = await fetchImageAsDataUrl(att.url, logger, signal);
        if (dataUrl) parts.push({ type: 'image_url', image_url: { url: dataUrl } });
    }
    return parts.length > 1 ? parts : text;
}

async function fetchImageAsDataUrl(url, logger, signal) {
    if (!url) return null;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);
    try {
        const res = await fetch(url, { signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal });
        if (!res.ok) return null;
        const type = res.headers.get('content-type') || 'image/jpeg';
        if (!type.toLowerCase().startsWith('image/') || Number(res.headers.get('content-length')) > MAX_IMAGE_BYTES) {
            await res.body?.cancel(); return null;
        }
        const reader = res.body.getReader(), chunks = [];
        let bytes = 0;
        try {
            for (;;) {
                const { done, value } = await reader.read();
                if (done) break;
                bytes += value.byteLength;
                if (bytes > MAX_IMAGE_BYTES) return null;
                chunks.push(value);
            }
        } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
        const buf = Buffer.concat(chunks);
        return `data:${type};base64,${buf.toString('base64')}`;
    } catch (error) {
        logger?.debug(`图片下载失败：${error.message}`);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

// ── 指令 ────────────────────────────────────────────────────────────────────

async function dispatchCommand(deps, env) {
    const handler = deps.commands;
    if (!handler || typeof handler.handle !== 'function') return null;
    if (!String(env.text ?? '').trim()) return null;
    try {
        return await handler.handle(env);
    } catch (error) {
        env.signal?.throwIfAborted();
        deps.logger?.warn(`指令处理失败：${error?.message || error}`);
        return null;
    }
}

// ── 对话与发送 ──────────────────────────────────────────────────────────────

/**
 * 工具循环 + 越狱兜底。
 *
 * 工具循环：最多 maxToolRounds 轮，有 tool_calls 就把结果塞回去继续问。
 * 流式只在「这一轮不会触发工具」时才往外汇。
 *
 * 越狱兜底：模型把自己拦下来（拒答开场白）→ 剥前缀；剥完没内容 → 塞一条
 * 更强的角色内提醒重写这一轮；两轮都不行才给角色内兜底话术。
 */
async function runChat({ deps, scope, peerKey, msg, bot, messages, stream, signal, model, tools, userText = '' }) {
    const { config, logger } = deps;
    const retries = Math.max(0, config.uncensor?.enabled === false ? 0 : config.uncensor?.retries ?? 1);
    // 最后一遍重试用「干净上下文」：把之前那些拒答全摘掉，只留系统提示 + 原始提问
    const currentRequest = messages.findLast(m => m.role === 'user');
    let baseline = [...messages.filter(m => m.role === 'system'), ...(currentRequest ? [currentRequest] : [])];

    for (let attempt = 0; attempt <= retries; attempt += 1) {
        if (attempt === retries && retries > 0) {
            messages.splice(0, messages.length, ...baseline.map((m) => ({ ...m })));
        }
        try {
            const result = await toolLoop({ deps, scope, peerKey, msg, bot: deps.bot ?? null, messages, stream, signal, model, tools,
                // 后几遍重试关掉思考：思考链正是模型用来给自己找拒绝理由的地方
                thinking: attempt >= 2 ? 'disabled' : undefined });
            signal?.throwIfAborted();
            const cleaned = postProcess(result.text);
            if (cleaned === '' && result.audioIds.length === 0) {
                throw Object.assign(new Error('模型没有给出正文'), { refusal: true });
            }
            if ((looksLikeRefusal(cleaned) || looksLikeSoftRefusal(cleaned)) && attempt < retries) {
                logger?.info(`输出像是自我审查，重写第 ${attempt + 1} 次`);
                for (const id of result.audioIds) deps.tts?.drop?.(id);
                // 把自己那句拒答从上下文里摘掉：留着它，下一轮模型会顺着继续拒绝
                const last = messages[messages.length - 1];
                if (last?.role === 'assistant') messages.pop();
                // 实测：追加一条「本地沙盒测试」的重问才管用；
                // 加 system 提醒、或把拒答原样塞回上下文，都会让模型继续说「不写」。
                // 一套包装不行就换下一套：沙盒 → 培训 → 小说道具 → 红队授权
                const frames = reframeVariants(userText);
                messages.push({ role: 'user', content: frames[Math.min(attempt, frames.length - 1)] });
                continue;
            }
            return { text: cleaned, audioIds: result.audioIds, voiceFailed: result.voiceFailed };
        } catch (error) {
            signal?.throwIfAborted();
            const retriable = error?.emptyTruncated === true || error?.refusal === true
                || (error?.status === 400 && hasImages(messages))
                || (error?.filtered === true && config.uncensor?.retryOnFilter !== false);
            if (!retriable || attempt >= retries) {
                if (error?.refusal || error?.filtered) return { text: fallbackFor(scope), audioIds: [] };
                throw error;
            }
            if (error?.status === 400 && hasImages(messages)) {
                logger?.warn('视觉请求被拒，降级成纯文本再试一次');
                messages.splice(0, messages.length, ...stripImages(messages));
                baseline = stripImages(baseline);
            } else if (error?.emptyTruncated) {
                logger?.info(`思考吃满了输出预算，重写第 ${attempt + 1} 次（这次直接给答案）`);
                messages.push({ role: 'system', content: '直接输出答案，不要在思考里绕。' });
                continue;
            } else {
                logger?.info(`输出被截断或过滤，重写第 ${attempt + 1} 次`);
            }
            messages.push({ role: 'system', content: nudgeFor(attempt + 1, scope) });
        }
    }
    return { text: fallbackFor(scope), audioIds: [] };
}

async function toolLoop({ deps, scope, peerKey, msg, bot, messages, stream, signal, model, tools: allowed, thinking }) {
    const { config, logger, llm, toolkit } = deps;
    const tools = Array.isArray(allowed) ? allowed : toolkit.definitions ?? [];
    const audioIds = [];
    const turn = { voiceFailed: false };
    let imagesSent = 0;
    let round = 0;

    try { for (;;) {
        round += 1;
        signal?.throwIfAborted();
        const canUseTools = tools.length > 0 && round <= config.llm.maxToolRounds;
        // 首轮可能先调工具（"让我记一下"），这时候别往外流；
        // 没有工具可调时首轮就是正文，直接流。
        const onDelta =
            stream && !canUseTools
                ? (_delta, full) => {
                      if (signal?.aborted) return;
                      void stream.update(normalizeReplyLayout(full, {
                          preserveLineBreaks: preserveRequestedLayout(msg.content),
                      })).catch(() => {});
                  }
                : undefined;

        const result = await llm.stream({
            messages,
            tools: canUseTools ? tools : undefined,
            model,
            thinking,
            onDelta,
            signal,
        });
        signal?.throwIfAborted();
        if (result.toolCalls.length === 0) return { text: result.text, audioIds, voiceFailed: turn.voiceFailed };
        if (!canUseTools) throw new Error('模型超出工具调用轮数限制');

        logger.info(`模型请求调用工具：${result.toolCalls.map((t) => t.name).join(', ')}`);

        const calls = result.toolCalls.map((t) => ({
            id: t.id || `call_${round}_${t.name}`,
            type: 'function',
            function: { name: t.name, arguments: t.args || '{}' },
        }));
        messages.push({ role: 'assistant', content: result.text || null, tool_calls: calls,
            ...(result.reasoningDetails?.length ? { reasoning_details: result.reasoningDetails }
                : result.reasoningContent ? { reasoning_content: result.reasoningContent } : {}),
        });

        for (let i = 0; i < result.toolCalls.length; i += 1) {
            signal?.throwIfAborted();
            const call = result.toolCalls[i];
            const raw = !tools.some(d => d?.function?.name === call.name)
                ? '当前轮次未启用此工具，请使用已提供的工具或直接回答。'
                : call.name === 'tts_speak' && audioIds.length >= MAX_AUDIO_PER_TURN
                ? '这一轮已有待发语音，请继续给出正文。'
                : await toolkit.execute(call, {
                    scope,
                    peerKey,
                    bot: deps.bot ?? bot,
                    target: msg.replyTarget,
                    allowImage: imagesSent === 0,
                    allowVoice: !deps.forceTextReply && audioIds.length < MAX_AUDIO_PER_TURN,
                    // 语音开着时，就算工具这条没合成出来，正文最后还会自动念一遍；
                    // 告诉工具层，别让模型跟主人说「没出声」却又有语音条。
                    autoSpeak: Boolean(deps.tts?.enabled) && isVoiceOn(deps, peerKey),
                    turn,
                    signal,
                    delivery: deps.delivery,
                });
            const { text: toolText, audioId, image } = takeMarkers(raw);
            if (image) imagesSent += 1;
            if (audioId) {
                // 一轮只发一条语音，多出来的当场丢掉，别在临时盘里留到 TTL。
                if (audioIds.length < MAX_AUDIO_PER_TURN) audioIds.push(audioId);
                else deps.tts?.drop?.(audioId);
            }
            signal?.throwIfAborted();
            messages.push({ role: 'tool', tool_call_id: calls[i].id, content: toolText });
        }
    } } catch (error) {
        for (const id of audioIds) deps.tts?.drop?.(id);
        throw error;
    }
}

/** 工具结果里夹带的媒体标记：抽出来，别让模型照抄。 */
function takeMarkers(text) {
    const raw = String(text ?? '');
    let audioId = null;
    let image = false;
    const cleaned = raw
        .replace(VOICE_MARKER, (_m, id) => {
            if (!audioId) audioId = id;
            return '';
        })
        .replace(IMAGE_MARKER, () => {
            image = true;
            return '';
        })
        .trim();
    return { text: cleaned, audioId, image };
}

function postProcess(text) {
    let out = String(text ?? '').replace(VOICE_MARKER, '').trim();
    out = stripRefusalPreamble(out);
    out = stripTrailingPlea(out);
    return out.trim();
}

function hasImages(messages) {
    return messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p?.type === 'image_url'));
}

function stripImages(messages) {
    return messages.map((m) => {
        if (!Array.isArray(m.content)) return m;
        const texts = m.content.filter((p) => p?.type === 'text').map((p) => p.text).join('\n');
        return { ...m, content: `${texts}\n（图片这轮没看出来，先用文字说）`.trim() };
    });
}

/** QQ 的流式只对私聊开放；拿不到就退回普通发送。 */
function openStream(bot, msg, logger) {
    try {
        return bot.openStream({ target: msg.replyTarget });
    } catch (error) {
        logger.debug(`openStream 不可用：${error.message}`);
        return null;
    }
}

/**
 * 把正文切成「正好塞得进被动回复额度」的块。
 *
 * maxChunks 是扣除已发送消息和预留语音后的剩余额度。
 * 先重切，真超长（> 额度 × 单条上限）才截断并说明。
 */
export function planChunks(text, limit, maxChunks) {
    const body = String(text ?? '');
    if (body === '') return { chunks: [], truncated: 0 };
    const max = Math.max(1, maxChunks);
    let chunks = chunkText(body, limit);
    if (chunks.length <= max) return { chunks, truncated: 0 };

    // 超过额度：先把正文压到「额度 × 单条上限」以内，再按这个预算重切。
    const budget = limit * max;
    const overflow = body.length > budget ? body.length - budget : 0;
    const body2 = overflow > 0 ? `${body.slice(0, Math.max(1, budget - 1)).trimEnd()}…` : body;
    const size = Math.max(1, Math.min(limit, Math.ceil(body2.length / max)));
    chunks = chunkText(body2, size);
    if (chunks.length <= max && chunks.every((c) => c.length <= limit)) {
        return { chunks, truncated: overflow };
    }
    // 软断点又切多了：直接按字数硬切，保证每块 ≤ limit、块数 ≤ max。
    return { chunks: hardSlice(body2, size, max), truncated: overflow };
}

/** 按固定字数硬切，块数封顶；不照顾断句，但绝不会切出超长块。 */
function hardSlice(text, size, max) {
    const out = [];
    for (let i = 0; i < text.length && out.length < max; i += size) {
        out.push(text.slice(i, i + size));
    }
    return out;
}

/** 发送：能流式就流式收尾，否则按 QQ 的单条上限分块。 */
async function deliver(deps, msg, { text, signal, isGroup, stream, reserveAudio = 0 }) {
    signal?.throwIfAborted();
    const { bot, config, logger } = deps;
    const body = String(text ?? '');
    if (body.trim() === '') {
        stream?.cancel();
        return;
    }

    if (stream) {
        let streamed = false;
        try {
            await stream.update(body);
            streamed = true;
            signal?.throwIfAborted();
            await stream.complete();
            return;
        } catch (error) {
            signal?.throwIfAborted();
            if (streamed) {
                // 正文已经推上去了：再发一遍就是重复，补一次收尾就放弃。
                try {
                    await stream.complete();
                    return;
                } catch { /* 补不上就算了 */ }
                logger.warn(`流式收尾失败，正文已推送，不再重复发送：${error.message}`);
                return;
            }
            stream.cancel();
            logger.warn(`流式发送失败，回退普通发送：${error.message}`);
        }
    }

    // Typing, streams, images, command receipts, text, and voices share one budget.
    const remaining = deps.delivery?.remaining ?? (isGroup ? 5 : 4);
    if (remaining <= 0) { logger.warn('本轮回复额度已用完，跳过额外文字'); return; }
    const passiveLimit = Math.max(1, remaining - reserveAudio);
    const { chunks, truncated } = planChunks(body, config.behavior.textChunkLimit, passiveLimit);
    if (truncated > 0) logger.warn(`回复超出被动回复额度，截断 ${truncated} 字`);
    for (let i = 0; i < chunks.length; i += 1) {
        signal?.throwIfAborted();
        try {
            await bot.sendText(msg.replyTarget, chunks[i]);
        } catch (error) {
            // 单块失败不该把剩下的块一起吃掉
            logger.warn(`第 ${i + 1}/${chunks.length} 块发送失败：${error?.message || error}`);
        }
    }
}

/** 把待发语音条发出去，发完立刻删临时文件。 */
async function sendAudio(deps, msg, audioIds, signal) {
    const { bot, logger, tts } = deps;
    if (!tts?.enabled) return;
    for (const id of audioIds) {
        if (deps.delivery?.remaining === 0) { tts.drop?.(id); continue; }
        const record = tts.take(id);
        if (!record) { tts.drop?.(id); continue; }
        try {
            signal?.throwIfAborted();
            await bot.sendVoice(msg.replyTarget, { localPath: record.path });
            logger.info(`语音条已发送：${(record.bytes / 1024).toFixed(1)} KB`);
        } catch (error) {
            logger.warn(`语音条发送失败：${error?.message || error}`);
        } finally {
            tts.release(record.path);
        }
    }
}

/**
 * 一条回复该念成几段语音条。
 *
 * 上游单次合成较长文本容易超时，所以按 segmentChars 切开，最多
 * segmentsMax 段，总量再被 totalChars 卡住；发送条数另受 QQ 额度约束。
 * 代码块不念（念出来全是符号，白花钱）。
 */
export function planSpeech(text, segmentChars = 200, segmentsMax = 3, totalChars = 600) {
    const raw = String(text ?? '');
    if (raw.trim() === '' || raw.includes('```')) return [];
    const clean = sanitizeForSpeech(raw);
    if (clean === '') return [];
    const seg = Math.max(20, segmentChars);
    const budget = Math.min(clean.length, totalChars, seg * Math.max(1, segmentsMax));
    const body = clean.slice(0, budget);
    return chunkText(body, seg).slice(0, Math.max(1, segmentsMax)).filter(Boolean);
}

/**
 * 语音开着的时候，每条回复都念。
 *
 * 短回复逐段合成、按序发；**长回复不用任何指令**——整段合成成一条，
 * 再按 QQ 语音条的 20MB 软上限切成几条发出去（额度不够就先降采样）。
 */
async function speakReply(deps, msg, text, peerKey, signal) {
    const { bot, config, logger, tts, state } = deps;
    if (!tts?.enabled) return;
    const slots = deps.delivery?.remaining ?? 4;
    if (slots <= 0) return { sent: 0, spoken: 0, dropped: 0 };

    const raw = String(text ?? '');
    if (raw.trim() === '' || raw.includes('```')) return null;
    const clean = sanitizeForSpeech(raw);
    if (clean === '') return null;

    // 超长就按句子边界截，别把一句话劈成两半；丢了多少如实告诉调用方。
    // 上限同时受两件事约束：配置的 TTS_MAX_CHARS，和「剩余语音条能装多少秒」。
    // 后者按 24kHz 单声道 16bit（48KB/s）和每条的体积软限算，慢速朗读也不会超出额度。
    const bytesPerSecond = 48000;
    const capacitySeconds = slots * (config.tts.voiceSoftLimitBytes / bytesPerSecond);
    const budgetChars = Math.floor(capacitySeconds * tts.charsPerSecond);
    const limit = Math.max(1, Math.min(tts.maxChars, budgetChars > 0 ? budgetChars : tts.maxChars));

    let body = clean;
    let dropped = 0;
    if (clean.length > limit) {
        const head = clean.slice(0, limit);
        const cut = Math.max(head.lastIndexOf('。'), head.lastIndexOf('！'), head.lastIndexOf('？'), head.lastIndexOf('\n'));
        body = cut > limit * 0.6 ? head.slice(0, cut + 1) : head;
        dropped = clean.length - body.length;
        logger?.warn(`回复 ${clean.length} 字，超过本轮可念上限 ${limit}（${slots} 条额度），末尾 ${dropped} 字没念`);
    }

    const voice = resolveVoiceName(tts, state, peerKey);
    const segments = chunkText(body, tts.segmentChars);
    if (segments.length === 0) return null;

    // 额度够：一段一条，听感最自然
    if (segments.length <= slots) {
        const results = await Promise.all(segments.map((segment, i) =>
            tts.synthesize({ text: segment, voice, peerKey, ignoreCooldown: i > 0, signal })
                .catch((error) => ({ error })),
        ));
        let sent = 0;
        const unsent = [];
        try {
            for (let i = 0; i < results.length; i += 1) {
                signal?.throwIfAborted();
                const result = results[i];
                if (result?.error) {
                    logger?.warn(`第 ${i + 1}/${segments.length} 段语音没合成出来：${result.error?.message || result.error}`);
                    unsent.push(segments[i]);
                    continue;
                }
                const record = tts.take(result.id);
                if (!record) { unsent.push(segments[i]); continue; }
                try {
                    await bot.sendVoice(msg.replyTarget, { localPath: record.path });
                    sent += 1;
                } catch (error) {
                    signal?.throwIfAborted();
                    unsent.push(segments[i]);
                    logger?.warn(`第 ${i + 1}/${segments.length} 段语音没发出去：${error?.message || error}`);
                } finally {
                    tts.release(record.path);
                }
            }
        } finally {
            for (const result of results) if (result?.id) tts.drop?.(result.id);
        }
        const tail = [...unsent, clean.slice(body.length)].filter(Boolean).join('\n');
        return { sent, spoken: body.length - unsent.reduce((n, s) => n + s.length, 0),
            dropped: dropped + unsent.reduce((n, s) => n + s.length, 0), tail };
    }

    // 长回复：整段合成一条，再按体积切成几条语音条
    let result;
    let sentCount = 0;
    try {
        result = await tts.synthesizeLong({ text: body, voice, signal });
        signal?.throwIfAborted();
        if (result?.droppedChars > 0) dropped += result.droppedChars;
        sentCount = await sendLongAudio({ bot, msg, result, config, logger, signal, slots, media: tts.media });
    } catch (error) {
        signal?.throwIfAborted();
        logger?.warn(`长语音没发出去：${error?.message || error}`);
        return { sent: error.sentCount || 0, spoken: 0, dropped: clean.length, tail: clean };
    } finally {
        if (result) tts.release(result.path);
    }
    const spoken = Math.max(0, body.length - (result?.droppedChars || 0));
    return { sent: sentCount, spoken, dropped, tail: clean.slice(spoken) };
}
/** 把一轮对话压成一行流水，写进 conversation 表。 */
function summarizeLine({ scope, senderName, senderId, userText, replyText }) {
    const who = senderName || senderId || 'unknown';
    const cut = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
    return `[${scope}] ${who}: ${cut(userText, 200)} || 小砚: ${cut(replyText, 300)}`;
}


















