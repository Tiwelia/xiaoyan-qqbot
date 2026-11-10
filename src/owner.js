/** Personal bot ownership. A random, expiring console code is required for first binding. */
import fs from 'node:fs';
import path from 'node:path';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';

export function createOwnerGuard({ config, logger, now = () => Date.now(), makeCode = () => randomBytes(12).toString('hex') }) {
    const file = path.join(config.dataDir, 'owner.json');
    let owner = config.access.ownerOpenid || '';
    if (!owner && fs.existsSync(file)) {
        const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
        if (!saved?.openid || typeof saved.openid !== 'string') throw new Error('主人绑定文件损坏，请检查 data/owner.json');
        owner = saved.openid;
    }
    let code = owner ? '' : makeCode();
    const expires = now() + 10 * 60_000;
    if (code) logger?.warn(`尚未绑定主人。请在十分钟内用自己的 QQ 私聊发送：/bind ${code}（此码只应由控制台持有人使用）`);
    const isOwner = (senderId) => Boolean(owner && senderId && String(senderId) === owner);

    return {
        isOwner,
        async check(msg, bot) {
            if (owner) return isOwner(msg?.senderId);
            if (msg?.kind !== 'c2c') return false;
            const match = /^[/／]bind\s+(\S+)\s*$/i.exec(String(msg.content ?? '').trim());
            if (!match) return false;
            const digest = (v) => createHash('sha256').update(v).digest();
            if (!msg.senderId || now() >= expires || !timingSafeEqual(digest(match[1]), digest(code))) {
                await bot.sendText(msg.replyTarget, '绑定码无效或已过期，请从服务器控制台取得有效绑定码（过期后重启机器人）。').catch(() => {});
                return false;
            }
            // Persist before enabling any model, memory, or management access.
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const temp = `${file}.tmp-${randomBytes(8).toString('hex')}`;
            try {
                fs.writeFileSync(temp, JSON.stringify({ version: 1, openid: String(msg.senderId) }), { mode: 0o600, flag: 'wx' });
                fs.renameSync(temp, file);
            } finally { try { fs.unlinkSync(temp); } catch { /* renamed */ } }
            owner = String(msg.senderId);
            code = '';
            logger?.info(`主人绑定已保存：${owner}。后续消息只接受这个账号。`);
            logger?.info(`想以后免绑定（重装/换机器不用再 /bind），把这行写进 .env：OWNER_OPENID=${owner}`);
            await bot.sendText(msg.replyTarget, '主人绑定好了。以后只接受你的消息，重启后仍然有效。').catch(() => {});
            return false; // Binding messages must never enter history or the LLM.
        },
    };
}
