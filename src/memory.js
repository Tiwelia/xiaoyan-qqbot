/**
 * 长期记忆 —— 直接复用原来的 xiaoyan-memory.db，schema 向后兼容。
 *
 * 两张表：
 *   important(id, created_at, kind, content, scope)   重要事实，注入 system prompt
 *   conversation(id, created_at, content)             对话流水，只归档不注入
 *
 * kinds: user_fact / event / rule / preference / identity
 * scope: all / c2c / group —— 群里说过的话不会原样飘到别人私聊里
 *
 * 数据库不可用时全部降级为空操作 —— 记忆坏了也不许拖垮机器人。
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export const MEMORY_KINDS = ['user_fact', 'event', 'rule', 'preference', 'identity'];
export const MEMORY_SCOPES = ['all', 'c2c', 'group'];

/** `--type rule` 这种被早期 CLI 写反的行，靠它认出来。 */
const SWAPPED_CONTENT = /^--type\s+([a-z_]+)\s*$/;

/** 近似去重用的归一化：去掉标点、空白、大小写差异。 */
function normalizeForCompare(text) {
    return String(text ?? '')
        .toLowerCase()
        .replace(/[\s，,。.！!？?、；;：:'"“”‘’「」『』（）()【】\[\]{}<>《》\-—_~·]/g, '');
}

export class MemoryStore {
    constructor({ dbPath, seedPath = '', logger, maxContent = 200 }) {
        this.dbPath = dbPath;
        this.seedPath = seedPath;
        this.logger = logger;
        this.maxContent = Math.max(20, Number(maxContent) || 200);
        this.db = null;
        this.disabled = false;
    }

    init() {
        if (this.disabled) return false;
        try {
            this.#sowSeed();
            fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
            this.db = new DatabaseSync(this.dbPath);
            this.db.exec(`CREATE TABLE IF NOT EXISTS important (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                kind TEXT NOT NULL,
                content TEXT NOT NULL
            )`);
            this.db.exec(`CREATE TABLE IF NOT EXISTS conversation (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
                content TEXT NOT NULL
            )`);
            // 老库迁移：memories -> important
            const hasOld = this.db
                .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='memories'")
                .get();
            if (hasOld) {
                this.db.exec('BEGIN IMMEDIATE');
                try {
                    this.db.exec('INSERT INTO important (created_at, kind, content) SELECT created_at, kind, content FROM memories');
                    this.db.exec('DROP TABLE memories');
                    this.db.exec('COMMIT');
                } catch (error) { this.db.exec('ROLLBACK'); throw error; }
                this.logger?.info('记忆库迁移完成：memories -> important');
            }
            this.#ensureScopeColumn();
            this.#repairSwappedRows();
            const n = this.count();
            this.logger?.info(`记忆库就绪：${this.dbPath}（important=${n.important} conversation=${n.conversation}）`);
            return true;
        } catch (error) {
            this.close();
            this.disabled = true;
            this.logger?.warn(`记忆库不可用，已降级为无记忆模式：${error.message}`);
            return false;
        }
    }

    /** 作用域列：新库直接建，老库 ALTER 补，两边都当 'all'。 */
    #ensureScopeColumn() {
        const columns = this.db.prepare('PRAGMA table_info(important)').all().map((c) => c.name);
        if (!columns.includes('scope')) {
            this.db.exec("ALTER TABLE important ADD COLUMN scope TEXT NOT NULL DEFAULT 'all'");
            this.logger?.info("记忆库升级：important 增加 scope 列（历史记录归入 'all'）");
        }
        this.db.exec('CREATE INDEX IF NOT EXISTS idx_important_scope ON important (scope, id)');
    }

    /**
     * 早期 `memory add "内容" --type preference` 被解析反了：kind 里存正文、
     * content 里存 `--type preference`。还有反向的脏数据（flag 落在 kind）。
     *
     * 四种情况分开处理，修完两边都不会再以 `--type` 开头，所以重复启动是幂等的：
     *   1. content 是 flag、kind 是正文      → 换回来
     *   2. kind 是 flag、content 是正文      → 把 flag 解析成 kind
     *   3. content 是 flag、kind 也合法      → 内容已丢失，删掉这行
     *   4. kind 和 content 都是 flag         → 没有任何信息，删掉这行
     */
    #repairSwappedRows() {
        let rows;
        try {
            rows = this.db.prepare('SELECT id, kind, content FROM important').all();
        } catch (error) {
            this.logger?.warn(`记忆自检失败：${error.message}`);
            return;
        }
        let fixed = 0;
        let dropped = 0;
        const normalize = (flag) => (MEMORY_KINDS.includes(flag) ? flag : 'user_fact');

        for (const row of rows) {
            const kind = String(row.kind ?? '').trim();
            const content = String(row.content ?? '').trim();
            const kindFlag = SWAPPED_CONTENT.exec(kind);
            const contentFlag = SWAPPED_CONTENT.exec(content);
            if (!kindFlag && !contentFlag) continue;

            try {
                if (kindFlag && contentFlag) {
                    this.db.prepare('DELETE FROM important WHERE id = ?').run(row.id);
                    dropped += 1;
                } else if (contentFlag && !MEMORY_KINDS.includes(kind)) {
                    this.db.prepare('UPDATE important SET kind = ?, content = ? WHERE id = ?')
                        .run(normalize(contentFlag[1]), kind, row.id);
                    fixed += 1;
                } else if (contentFlag) {
                    this.db.prepare('DELETE FROM important WHERE id = ?').run(row.id);
                    dropped += 1;
                } else {
                    this.db.prepare('UPDATE important SET kind = ?, content = ? WHERE id = ?')
                        .run(normalize(kindFlag[1]), content, row.id);
                    fixed += 1;
                }
            } catch (error) {
                this.logger?.warn(`记忆 #${row.id} 修复失败：${error.message}`);
            }
        }
        if (fixed > 0) this.logger?.info(`记忆库自检：修复 ${fixed} 条字段错位记录`);
        if (dropped > 0) this.logger?.info(`记忆库自检：清掉 ${dropped} 条没有内容的残留记录`);
    }

    /**
     * 首次启动播种：目标库还不存在时，用镜像里带的种子初始化一次。
     */
    #sowSeed() {
        if (!this.seedPath) return;
        if (fs.existsSync(this.dbPath)) return;
        if (!fs.existsSync(this.seedPath)) return;
        fs.mkdirSync(path.dirname(this.dbPath), { recursive: true });
        fs.copyFileSync(this.seedPath, this.dbPath);
        this.logger?.info(`首次启动：用种子记忆库初始化（${this.seedPath} → ${this.dbPath}）`);
    }

    /** 数据库是否可用（不可用时机器人照跑，只是没有记忆）。 */
    get available() {
        return this.db !== null;
    }

    /** 作用域过滤：当前的 scope 能看见 'all' 加自己这一档。 */
    #scopeFilter(scope) {
        if (!scope || !MEMORY_SCOPES.includes(scope) || scope === 'all') return { sql: '', params: [] };
        return { sql: ' AND scope IN (?, ?)', params: ['all', scope] };
    }

    listImportant(limit = 30, scope = '') {
        if (!this.db) return [];
        try {
            const bound = Math.max(1, Math.min(500, limit));
            const filter = this.#scopeFilter(scope);
            if (filter.sql === '') {
                return this.db
                    .prepare('SELECT id, created_at, kind, content, scope FROM important ORDER BY id DESC LIMIT ?')
                    .all(bound);
            }
            return this.db
                .prepare(`SELECT id, created_at, kind, content, scope FROM important WHERE 1=1${filter.sql} ORDER BY id DESC LIMIT ?`)
                .all(...filter.params, bound);
        } catch (error) {
            this.logger?.warn(`读取记忆失败：${error.message}`);
            return [];
        }
    }

    searchImportant(keyword, limit = 20, scope = '') {
        if (!this.db) return [];
        try {
            const filter = this.#scopeFilter(scope);
            return this.db
                .prepare(`SELECT id, created_at, kind, content, scope FROM important WHERE content LIKE ?${filter.sql} ORDER BY id DESC LIMIT ?`)
                .all(`%${keyword}%`, ...filter.params, Math.max(1, Math.min(100, limit)));
        } catch (error) {
            this.logger?.warn(`搜索记忆失败：${error.message}`);
            return [];
        }
    }

    get(id) {
        if (!this.db) return null;
        try {
            return this.db.prepare('SELECT id, created_at, kind, content, scope FROM important WHERE id = ?').get(Number(id)) ?? null;
        } catch {
            return null;
        }
    }

    addImportant(kind, content, scope = 'all') {
        if (!this.db) return null;
        const k = MEMORY_KINDS.includes(kind) ? kind : 'user_fact';
        const s = MEMORY_SCOPES.includes(scope) ? scope : 'all';
        let text = String(content ?? '').trim();
        if (text === '') return null;
        // 长度封顶：不许把整段对话塞成一条记忆
        if (text.length > this.maxContent) {
            text = text.slice(0, this.maxContent);
            this.logger?.info(`记忆超长已截断到 ${this.maxContent} 字`);
        }
        try {
            const existing = this.db
                .prepare('SELECT id FROM important WHERE kind = ? AND content = ? AND scope = ? LIMIT 1')
                .get(k, text, s);
            if (existing) return Number(existing.id);

            // 近似去重：忽略标点空格大小写，同一句话换个标点也别想再写一条
            const near = this.#findNearDuplicate(text, s);
            if (near !== null) {
                this.logger?.info(`记忆已存在近似条目 #${near}，这次不重复写`);
                return near;
            }

            const info = this.db.prepare('INSERT INTO important (kind, content, scope) VALUES (?, ?, ?)').run(k, text, s);
            this.logger?.info(`写入记忆 #${info.lastInsertRowid} [${k}/${s}] ${text.length} 字`);
            return Number(info.lastInsertRowid);
        } catch (error) {
            this.logger?.warn(`写入记忆失败：${error.message}`);
            return null;
        }
    }

    /** 在当前作用域能看见的条目里找「去标点后完全相同」的那条。 */
    #findNearDuplicate(text, scope) {
        const target = normalizeForCompare(text);
        if (target === '') return null;
        try {
            const rows = this.db
                .prepare("SELECT id, content FROM important WHERE scope IN ('all', ?)")
                .all(scope);
            for (const row of rows) {
                if (normalizeForCompare(row.content) === target) return Number(row.id);
            }
        } catch (error) {
            this.logger?.warn(`近似去重失败：${error.message}`);
        }
        return null;
    }

    deleteImportant(id) {
        if (!this.db) return false;
        try {
            const info = this.db.prepare('DELETE FROM important WHERE id = ?').run(Number(id));
            return Number(info.changes) > 0;
        } catch (error) {
            this.logger?.warn(`删除记忆失败：${error.message}`);
            return false;
        }
    }

    /** 对话流水：只归档，注入时不用。 */
    addConversation(content) {
        if (!this.db) return;
        try {
            this.db.prepare('INSERT INTO conversation (content) VALUES (?)').run(String(content ?? ''));
            this.pruneConversation(7, 300);
        } catch (error) {
            this.logger?.warn(`写入流水失败：${error.message}`);
        }
    }

    listConversation(limit = 10) {
        if (!this.db) return [];
        try {
            return this.db
                .prepare('SELECT id, created_at, content FROM conversation ORDER BY id DESC LIMIT ?')
                .all(Math.max(1, Math.min(200, limit)));
        } catch {
            return [];
        }
    }

    pruneConversation(days = 7, keep = 300) {
        if (!this.db) return;
        try {
            this.db
                .prepare(
                    `DELETE FROM conversation WHERE id NOT IN (
                        SELECT id FROM conversation ORDER BY id DESC LIMIT ?
                    ) OR created_at < datetime('now','localtime','-${Number(days)} days')`,
                )
                .run(Number(keep));
        } catch (error) {
            this.logger?.warn(`清理流水失败：${error.message}`);
        }
    }

    /** 拼出注入 system prompt 的记忆块（新的排前面，按字符上限截断）。 */
    renderForPrompt(limit = 30, maxChars = 8000, scope = '') {
        const rows = this.listImportant(limit, scope);
        if (rows.length === 0) return '';
        const lines = [];
        let used = 0;
        for (const r of rows) {
            const tag = r.scope && r.scope !== 'all' ? `${r.kind}/${r.scope}` : r.kind;
            const line = `#${r.id} [${tag}] ${String(r.content).replace(/\s+/g, ' ')}`;
            if (used + line.length > maxChars) break;
            lines.push(line);
            used += line.length + 1;
        }
        return lines.join('\n');
    }

    count(scope = '') {
        if (!this.db) return { important: 0, conversation: 0 };
        try {
            const filter = this.#scopeFilter(scope);
            const important = filter.sql === ''
                ? this.db.prepare('SELECT COUNT(*) AS n FROM important').get().n
                : this.db.prepare(`SELECT COUNT(*) AS n FROM important WHERE 1=1${filter.sql}`).get(...filter.params).n;
            return {
                important,
                conversation: this.db.prepare('SELECT COUNT(*) AS n FROM conversation').get().n,
            };
        } catch {
            return { important: 0, conversation: 0 };
        }
    }

    close() {
        try {
            this.db?.close();
        } catch {
            /* 忽略 */
        }
        this.db = null;
    }
}
