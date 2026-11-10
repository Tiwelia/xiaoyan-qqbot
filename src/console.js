/**
 * 控制台 stdin 命令。
 *
 * 面板的控制台输入框发的是进程 stdin，不是面板命令；默认没人读，敲什么都石沉大海。
 * 这里接几条最常用的：清屏、看状态、看语音闸门。不接的话也不影响任何功能。
 *
 * 注意：清屏是往 stdout 写 ANSI 序列，面板的 xterm 会执行；不支持 ANSI 的终端会
 * 退化成打一堆空行——同样能把旧内容顶出去。
 */
import readline from 'node:readline';

const CLEAR = '\x1b[2J\x1b[3J\x1b[H';
const CLEAR_FALLBACK = '\n'.repeat(60);

const HELP = [
    '可用命令：',
    '  clear / cls   清屏（等价于面板的清空按钮）',
    '  status        运行时长、模型、语音闸门、临时盘',
    '  help          看这份说明',
].join('\n');

/**
 * @param {object} deps
 * @param {NodeJS.ReadableStream} [deps.input]
 * @param {NodeJS.WritableStream} [deps.output]
 * @param {object} deps.logger
 * @param {object} [deps.runtime]
 * @param {object} [deps.tts]
 * @param {object} [deps.state]
 * @returns {{ close: () => void, handle: (line: string) => string }}
 */
export function attachConsoleCommands({ input = process.stdin, output = process.stdout, logger, runtime, tts, state } = {}) {
    /** 处理一条命令，返回要打印的文本（测试里直接断言这个）。 */
    function handle(line) {
        const command = String(line ?? '').trim().toLowerCase();
        if (command === '') return '';
        if (command === 'clear' || command === 'cls' || command === '清屏') {
            output.write(CLEAR);
            output.write(CLEAR_FALLBACK);
            return '';
        }
        if (command === 'help' || command === '?' || command === '命令') return HELP;
        if (command === 'status' || command === '状态') {
            const stats = tts?.stats?.() ?? {};
            const use = tts?.media?.usage?.() ?? {};
            const voiceOn = state?.get?.('voice:c2c:console', false);
            return [
                `运行：${runtime?.uptimeText?.() ?? '?'}`,
                `模型：${runtime?.modelName?.() ?? '?'}`,
                `语音：${tts?.enabled ? `${stats.engine ?? 'on'} / 并发 ${stats.active ?? 0} / 排队 ${stats.queued ?? 0}` : '关闭'}`,
                `临时盘：${use.files ?? 0} 个文件 ${((use.bytes ?? 0) / 1024).toFixed(0)}KB / 上限 ${stats.tmpMaxBytes ? (stats.tmpMaxBytes / 1024 / 1024).toFixed(0) : '?'}MB`,
                `控制台语音开关：${voiceOn ? '开' : '关'}`,
            ].join('\n');
        }
        return `不认识的命令：${line.trim()}（输入 help 看可用命令）`;
    }

    let rl = null;
    try {
        rl = readline.createInterface({ input, terminal: false });
        rl.on('line', (line) => {
            const text = handle(line);
            if (text) logger?.info(`\n${text}`);
        });
    } catch (error) {
        logger?.debug?.(`控制台命令没挂上：${error?.message || error}`);
    }

    return { handle, close: () => rl?.close() };
}
