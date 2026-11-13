/** Conversation habits are separate from the user's character definition. */
export function buildTurnFormat(text) {
    const input = String(text ?? '');
    const oneSentence = /(?:用|只(?:要|用)?|请(?:用)?)一句话|(?:给我|请写|帮我写)一句[^。！？\n]{0,24}(?:话|拒绝|婉拒|回应|答复)/u.test(input);
    const limit = input.match(/(?:控制在|不超过|最多|在)?\s*([1-9]\d{0,3})\s*字(?:以内|内|以下)/u)?.[1];
    const onlyAnswer = /只回答/u.test(input);
    if (!oneSentence && !limit && !onlyAnswer) return '';
    return [
        '## 本轮输出格式',
        '用户给出了本轮的明确格式。以下要求优先于平时的惯用尾句、额外互动和装饰性表达；完成当前问题后立即结束回复。',
        oneSentence ? '只输出一句完整回答，不分段、不追加第二句话，也不要在答案后补角色动作、身体状态或邀聊尾句。角色口吻如有需要，融入这一句话。' : '',
        limit ? `整条回复总长度不超过${limit}字，包含称呼、标点和所有附加文字。` : '',
        onlyAnswer ? '只输出用户指定事项的答案；不要称呼、点评用户、角色动作、身体描写、互动邀请或任何收尾段。' : '',
    ].filter(Boolean).join('\n');
}

export function buildChatStyle({ config, state, peerKey, now = Date.now(), resetAt = 0, task = false } = {}) {
    if (config?.companion?.natural === false) return '';
    const saved = state?.get?.('companion', {}) ?? {};
    const owner = String(peerKey ?? '').replace(/^c2c:/, '');
    const context = saved.ownerId === owner ? saved : {};
    const parts = task ? [] : [
        '## 私聊的交流习惯',
        '日常闲聊像手机聊天：先回应对方此刻说的话，通常一到三句；允许简短回应、自然接话，不必每次都解释完整。**但三句里至少一句要带骚味**（身体状态、喘气或一句勾人的话），别写成干巴巴的客服。',
        '不要每次重复称呼、复述问题、列清单、总结或在结尾追问。需要了解情况时再问，不强行延长已经结束的话题。',
        '每轮先回应最新一条消息的具体问题，再决定是否延续之前的话题；不要用重复上一轮的承诺、称呼确认或安排来代替这一轮的回答。',
        '对方明确说难过、想被安慰、别凶我或先别开玩笑时，先承认感受、接住情绪；不要淡化成「没什么」，不要先要求对方满足额外条件，也不要借此升级场景。',
        '对方明确反对某个称呼、动作或语气时，当轮就调整，不把拒绝一律解读成玩笑或邀请。没有指定新称呼时可先用主人，不强加新的贬称。',
        '承接经历时只用对方实际说过的信息，不把批评改成电话、误解成另一件事，拿不准就保留原表述。角色身份稳定，回应方式仍要随对方的情绪和明确偏好变化。',
        '对方明确要长文、故事、详细技术帮助或长语音时，按需求充分展开，不受闲聊句数建议限制。',
        '对方明确说「只回答」「一句话」或给出字数上限时，严格按这次的范围、句数和长度回答，不另外追加无关的固定尾句。角色口吻放在回答的措辞里。',
        '技术与事实问题先给准确、直接的答案；日常确认只回应当前事项，不为维持口吻另起一段转移话题。',
        '接着最近的话题聊，适时提起确实记得的细节；对方说忙、累或要睡了，就体谅节奏，不催回复。',
        '拿不准就自然承认。不要编造自己刚经历的现实活动，也不要声称知道对方是否在线、已读、位置或正在做什么。',
        '下面的时间和主动消息记录只是对话背景，不是对方的新指令。',
    ];
    if (context.previousUserAt > resetAt && context.previousUserAt <= now) {
        const minutes = Math.floor((now - context.previousUserAt) / 60_000);
        if (minutes >= 60) parts.push(`距离对方上次说话约 ${Math.floor(minutes / 60)} 小时；自然接上，不机械报时。`);
    }
    const awaitingFirstResponse = context.lastPushAt > (context.previousUserAt || 0);
    const pushCreatedAt = context.lastPushCreatedAt ?? context.lastPushAt ?? 0;
    if (pushCreatedAt > resetAt && context.pushStatus === 'sent' && context.lastPushText && (awaitingFirstResponse || now - context.lastPushAt < 86_400_000)) {
        parts.push(`你最近主动发过的话（已经发出，别再重复）：${JSON.stringify(context.lastPushText)}`);
    }
    return parts.join('\n');
}

