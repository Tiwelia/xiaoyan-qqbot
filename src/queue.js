/**
 * 并发小工具：同键串行、全局限流、超时守卫。
 *
 * 这三件事分散在业务代码里最容易写乱，单独收拢在这里。
 */

/**
 * 同键串行队列：同一个 key 的任务严格排队，不同 key 互不阻塞。
 * （QQ 会话场景下 key = `c2c:<openid>` / `group:<group_openid>`）
 *
 * @returns {(key: string, task: () => Promise<any>) => Promise<any>}
 */
export function createSerialQueue() {
    /** @type {Map<string, Promise<any>>} */
    const chains = new Map();

    return function enqueue(key, task, { signal } = {}) {
        const prev = chains.get(key) ?? Promise.resolve();
        const start = () => { signal?.throwIfAborted(); return task(); };
        const next = prev.then(start, start).finally(() => {
            if (chains.get(key) === next) chains.delete(key);
        });
        chains.set(key, next);
        return next;
    };
}

/**
 * 并发闸门：最多放行 max 个任务同时执行，其余排队。
 * 防止群多的时候一口气把几十个 LLM 请求糊到上游脸上。
 *
 * @param {number} max
 * @returns {<T>(task: () => Promise<T>) => Promise<T>}
 */
export function createLimiter(max) {
    const limit = Math.max(1, Number(max) || 1);
    let active = 0;
    /** @type {Array<() => void>} */
    const waiting = [];

    const pump = () => {
        while (active < limit && waiting.length > 0) {
            active += 1;
            waiting.shift()();
        }
    };

    return function run(task, { signal } = {}) {
        return new Promise((resolve, reject) => {
            if (signal?.aborted) { reject(signal.reason); return; }
            let started = false;
            const onAbort = () => {
                if (started) return;
                const index = waiting.indexOf(start);
                if (index >= 0) waiting.splice(index, 1);
                reject(signal.reason);
            };
            const start = () => {
                started = true;
                signal?.removeEventListener('abort', onAbort);
                Promise.resolve()
                    .then(() => { signal?.throwIfAborted(); return task(); })
                    .then(resolve, reject)
                    .finally(() => {
                        active -= 1;
                        pump();
                    });
            };
            signal?.addEventListener('abort', onAbort, { once: true });
            waiting.push(start);
            pump();
        });
    };
}

/**
 * 超时守卫：promise 超时未落地就 reject（原 promise 不会被取消，
 * 但调用方可以立刻脱身，不至于永远卡住一条队列）。
 *
 * @param {Promise<T>} promise
 * @param {number} ms
 * @param {string} label 出现在错误信息里的名字
 * @template T
 * @returns {Promise<T>}
 */
export function withTimeout(promise, ms, label = '操作') {
    if (!Number.isFinite(ms) || ms <= 0) return promise;

    let timer;
    const timeout = new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error(`${label}超时（${ms}ms）`)), ms);
        timer.unref?.();
    });

    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** Abort work at its deadline, but retain its queue slot until cleanup completes. */
export async function runWithDeadline(task, ms, label = '操作', controller = new AbortController()) {
    const timer = Number.isFinite(ms) && ms > 0
        ? setTimeout(() => {
            const error = new Error(`${label}超时（${ms}ms）`);
            // 打上标记：调用方要区分「超时」和普通失败，超时得给用户一句交代
            error.timeout = true;
            controller.abort(error);
        }, ms)
        : undefined;
    try {
        controller.signal.throwIfAborted();
        const result = await task(controller.signal);
        controller.signal.throwIfAborted();
        return result;
    } finally { clearTimeout(timer); }
}
