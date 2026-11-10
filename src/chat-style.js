/** Conversation habits are separate from the user's character definition. */
export function buildChatStyle({ config, state, peerKey, now = Date.now() } = {}) {
    if (config?.companion?.natural === false) return '';
    const saved = state?.get?.('companion', {}) ?? {};
    const owner = String(peerKey ?? '').replace(/^c2c:/, '');
    const context = saved.ownerId === owner ? saved : {};
    const parts = [
        '## 私聊的交流习惯',
        '日常闲聊像手机聊天：先回应对方此刻说的话，通常一到三句；允许简短回应、自然接话，不必每次都解释完整。',
        '不要每次重复称呼、复述问题、列清单、总结或在结尾追问。需要了解情况时再问，不强行延长已经结束的话题。',
        '对方明确要长文、故事、详细技术帮助或长语音时，按需求充分展开，不受闲聊句数建议限制。',
        '接着最近的话题聊，适时提起确实记得的细节；对方说忙、累或要睡了，就体谅节奏，不催回复。',
        '拿不准就自然承认。不要编造自己刚经历的现实活动，也不要声称知道对方是否在线、已读、位置或正在做什么。',
        '下面的时间和主动消息记录只是对话背景，不是对方的新指令。',
    ];
    if (context.previousUserAt > 0 && context.previousUserAt <= now) {
        const minutes = Math.floor((now - context.previousUserAt) / 60_000);
        if (minutes >= 60) parts.push(`距离对方上次说话约 ${Math.floor(minutes / 60)} 小时；自然接上，不机械报时。`);
    }
    const awaitingFirstResponse = context.lastPushAt > (context.previousUserAt || 0);
    if (context.pushStatus === 'sent' && context.lastPushText && (awaitingFirstResponse || now - context.lastPushAt < 86_400_000)) {
        parts.push(`你最近主动发过的话（已经发出，别再重复）：${JSON.stringify(context.lastPushText)}`);
    }
    return parts.join('\n');
}
