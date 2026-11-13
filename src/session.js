/**
 * 会话管理 —— 每个会话对象（私聊用户 / 群）一个 JSON 文件。
 *
 *   data/sessions/c2c-<openid>.json
 *   data/sessions/group-<group_openid>.json
 *
 * 结构：
 *   { version, scope, targetId, createdAt, updatedAt, resetAt?, messages: [{role, content, ts}] }
 *
 * 写入是防抖的（默认 300ms 合并一次），并在进程退出时强制 flush。
 */
import fs from 'node:fs';
import path from 'node:path';

const VERSION = 1;

function safeName(s) {
    return String(s ?? '').replace(/[^A-Za-z0-9_.-]/g, '_').slice(0, 120) || 'unknown';
}

export class SessionStore {
    constructor({ dir, historyLimit = 20, historyBytes = 64_000, logger, flushDelayMs = 300, maxCached = 200 }) {
        this.dir = dir;
        this.historyLimit = historyLimit;
        this.historyBytes = historyBytes;
        this.logger = logger;
        this.flushDelayMs = flushDelayMs;
        this.maxCached = Math.max(1, maxCached);

        /** @type {Map<string, {data: object, timer: NodeJS.Timeout|null, dirty: boolean}>} */
        this.cache = new Map();

        fs.mkdirSync(this.dir, { recursive: true });
    }

    key(scope, targetId) {
        return `${scope}:${targetId}`;
    }

    filePath(scope, targetId) {
        return path.join(this.dir, `${scope}-${safeName(targetId)}.json`);
    }

    load(scope, targetId) {
        const key = this.key(scope, targetId);
        const cached = this.cache.get(key);
        if (cached) return cached.data;

        let data = {
            version: VERSION,
            scope,
            targetId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            messages: [],
        };

        const file = this.filePath(scope, targetId);
        if (fs.existsSync(file)) {
            try {
                const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
                if (parsed && Array.isArray(parsed.messages)) {
                    data = {
                        version: parsed.version ?? VERSION,
                        scope,
                        targetId,
                        createdAt: parsed.createdAt ?? Date.now(),
                        updatedAt: parsed.updatedAt ?? Date.now(),
                        resetAt: Number.isSafeInteger(parsed.resetAt) && parsed.resetAt > 0 ? parsed.resetAt : 0,
                        messages: parsed.messages.filter(
                            (m) => m && typeof m.role === 'string' && typeof m.content === 'string',
                        ),
                    };
                }
            } catch (error) {
                this.logger?.warn(`会话文件损坏，已重建：${file}（${error.message}）`);
                try {
                    fs.renameSync(file, `${file}.corrupt-${Date.now()}`);
                } catch {
                    /* 备份失败就算了 */
                }
            }
        }

        this.trim(data);
        this.cache.set(key, { data, timer: null, dirty: false });
        this.#evictIfNeeded(key);
        return data;
    }

    /** 内存里的会话数封顶：先刷盘再丢掉最老的一份，别让单聊跑一年后吃满内存。 */
    #evictIfNeeded(keepKey) {
        while (this.cache.size > this.maxCached) {
            const oldest = this.cache.keys().next().value;
            if (oldest === keepKey) break;
            const [scope, ...rest] = oldest.split(':');
            this.flushOne(scope, rest.join(':'));
            const entry = this.cache.get(oldest);
            if (entry?.timer) clearTimeout(entry.timer);
            this.cache.delete(oldest);
        }
    }

    /** 追加一轮消息（user + assistant），然后裁剪。 */
    append(scope, targetId, entries) {
        const data = this.load(scope, targetId);
        for (const e of entries) {
            if (!e || !e.role || typeof e.content !== 'string') continue;
            data.messages.push({ role: e.role, content: e.content, ts: Date.now() });
        }
        data.updatedAt = Date.now();
        this.trim(data);
        this.markDirty(scope, targetId);
        return data;
    }

    /** 按条数 + 字节数双重裁剪，永远保留最近的。 */
    trim(data) {
        const max = this.historyLimit;
        if (data.messages.length > max) {
            data.messages = data.messages.slice(-max);
        }
        let bytes = data.messages.reduce((n, m) => n + Buffer.byteLength(m.content, 'utf8'), 0);
        while (bytes > this.historyBytes && data.messages.length > 0) {
            const dropped = data.messages.shift();
            bytes -= Buffer.byteLength(dropped.content, 'utf8');
        }
        // Never retain an answer whose user message was already trimmed away.
        while (data.messages[0]?.role === 'assistant') data.messages.shift();
    }

    /** 取出可直接喂给 LLM 的历史（最近的排后面）。 */
    toMessages(scope, targetId) {
        const data = this.load(scope, targetId);
        return data.messages.map((m) => ({ role: m.role, content: m.content }));
    }

    reset(scope, targetId) {
        const data = this.load(scope, targetId);
        data.messages = [];
        data.updatedAt = Date.now();
        data.resetAt = data.updatedAt;
        this.markDirty(scope, targetId);
        if (!this.flushOne(scope, targetId)) {
            throw new Error('会话已在内存中清空，但尚未保存；重启可能恢复旧记录，请检查存储后重试 /reset。');
        }
        return data;
    }

    /** Persistent boundary for transient context kept outside the message history. */
    getResetAt(scope, targetId) {
        return this.load(scope, targetId).resetAt || 0;
    }

    /** 还没有任何历史 —— 记忆快照只在这种时候全量注入。 */
    isFresh(scope, targetId) {
        return this.load(scope, targetId).messages.length === 0;
    }

    turnCount(scope, targetId) {
        const messages = this.load(scope, targetId).messages;
        return messages.filter((m) => m.role === 'user').length;
    }

    /** 会话规模统计，/status 用。 */
    stats() {
        let messages = 0;
        for (const entry of this.cache.values()) messages += entry.data.messages.length;
        return { sessions: this.cache.size, messages };
    }

    markDirty(scope, targetId) {
        const key = this.key(scope, targetId);
        const entry = this.cache.get(key);
        if (!entry) return;
        entry.dirty = true;
        if (entry.timer) return;
        entry.timer = setTimeout(() => {
            entry.timer = null;
            this.flushOne(scope, targetId);
        }, this.flushDelayMs);
        entry.timer.unref?.();
    }

    flushOne(scope, targetId) {
        const key = this.key(scope, targetId);
        const entry = this.cache.get(key);
        if (!entry || !entry.dirty) return true;
        try {
            const file = this.filePath(scope, targetId);
            const tmp = `${file}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify(entry.data, null, 2), 'utf8');
            fs.renameSync(tmp, file);
            entry.dirty = false;
            return true;
        } catch (error) {
            this.logger?.warn(`会话写盘失败：${error.message}`);
            return false;
        }
    }

    flushAll() {
        for (const [key] of this.cache) {
            const [scope, ...rest] = key.split(':');
            this.flushOne(scope, rest.join(':'));
        }
    }
}
