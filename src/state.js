/**
 * 运行时状态小仓库 —— data/state.json。
 *
 * 只存「重启后还想留着、但不值得进记忆库」的东西：
 *   model            全局模型覆盖（/model 切的）
 *   voice:<key>      单个会话的语音开关
 *   voiceName:<key>  单个会话的音色
 *
 * 写入防抖 300ms，退出时 flush；文件坏了就当没有，绝不拖垮启动。
 */
import fs from 'node:fs';
import path from 'node:path';

export function createStateStore({ file, logger, flushDelayMs = 300 }) {
    let data = {};
    let timer = null;
    let dirty = false;

    try {
        if (fs.existsSync(file)) {
            const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
            if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) data = parsed;
        }
    } catch (error) {
        logger?.warn(`状态文件损坏，已重建：${file}（${error.message}）`);
        try { fs.renameSync(file, `${file}.corrupt-${Date.now()}`); } catch { /* 备份失败就算了 */ }
        data = {};
    }

    const flush = () => {
        if (!dirty) return;
        try {
            fs.mkdirSync(path.dirname(file), { recursive: true });
            const tmp = `${file}.tmp-${process.pid}`;
            fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
            fs.renameSync(tmp, file);
            dirty = false;
        } catch (error) {
            logger?.warn(`状态写入失败：${error.message}`);
        }
    };

    const schedule = () => {
        dirty = true;
        if (timer) return;
        timer = setTimeout(() => {
            timer = null;
            flush();
        }, flushDelayMs);
        timer.unref?.();
    };

    return {
        get(key, fallback = undefined) {
            return Object.hasOwn(data, key) ? data[key] : fallback;
        },
        set(key, value) {
            if (value === undefined) delete data[key];
            else data[key] = value;
            schedule();
            return value;
        },
        delete(key) {
            if (!Object.hasOwn(data, key)) return false;
            delete data[key];
            schedule();
            return true;
        },
        keys(prefix = '') {
            return Object.keys(data).filter((k) => k.startsWith(prefix));
        },
        all() {
            return { ...data };
        },
        flush,
        close() {
            if (timer) { clearTimeout(timer); timer = null; }
            flush();
        },
    };
}
