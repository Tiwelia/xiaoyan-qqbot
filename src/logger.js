/**
 * 轻量日志：带时间戳与级别，支持 DEBUG 开关。
 * 同时满足 QQ SDK 的 Logger 接口（info/warn/error/debug）。
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

function ts(timeZone) {
    return new Intl.DateTimeFormat('zh-CN', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hour12: false,
    })
        .format(new Date())
        .replace(/\//g, '-');
}

export function createLogger({ debug = false, name = 'qqbot', timeZone = 'Asia/Shanghai' } = {}) {
    const threshold = debug ? LEVELS.debug : LEVELS.info;

    const emit = (level, args) => {
        if (LEVELS[level] < threshold) return;
        const line = `[${ts(timeZone)}] [${level.toUpperCase()}] [${name}]`;
        const target = level === 'error' ? console.error : level === 'warn' ? console.warn : console.log;
        target(line, ...args);
    };

    const logger = {
        debug: (...a) => emit('debug', a),
        info: (...a) => emit('info', a),
        warn: (...a) => emit('warn', a),
        error: (...a) => emit('error', a),
    };

    return logger;
}
