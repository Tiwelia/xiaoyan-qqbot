/**
 * 入口：加载配置 → 组装依赖 → 起机器人 → 优雅退出。
 *
 * 组装之外的事都在各自模块里：
 *   config.js 配置 · logger.js 日志 · memory.js 记忆 · session.js 会话
 *   state.js 运行时状态 · tts.js 语音 · commands.js 指令
 *   llm.js 模型 · tools.js 工具 · bot.js QQ 接线 · conversation.js 对话流水线
 */
import fs from 'node:fs';

import { loadConfig, validateConfig } from './config.js';
import { createLogger } from './logger.js';
import { MemoryStore } from './memory.js';
import { SessionStore } from './session.js';
import { createStateStore } from './state.js';
import { createEvalLog } from './eval-log.js';
import { createSceneGenerator } from './scene.js';
import { createTts } from './tts.js';
import { createCommandHandler, humanDuration } from './commands.js';
import { TextModelRouter } from './model-router.js';
import { createToolkit, listAssets } from './tools.js';
import { createBot } from './bot.js';
import { createOwnerGuard } from './owner.js';
import { attachConsoleCommands } from './console.js';
import { createCompanion } from './companion.js';

async function main() {
    const config = loadConfig();
    const problems = validateConfig(config);
    const logger = createLogger({ debug: config.debug, name: 'xiaoyan', timeZone: problems.length ? 'Asia/Shanghai' : config.timezone });

    logger.info('小砚 QQ Bot 启动中……');
    logger.info(`数据目录：${config.dataDir}`);
    if (problems.length > 0) {
        logger.error('配置不完整，启动中止：');
        for (const p of problems) logger.error(`  - ${p}`);
        logger.error('提示：本地写进 .env；Altare 在 Startup 变量里配。');
        process.exit(1);
    }
    logger.info(
        `LLM：${config.llm.baseUrl} / ${config.llm.model}` +
            (config.llm.visionModel ? `（视觉：${config.llm.vision?.provider || config.llm.provider} / ${config.llm.visionModel}）` : '（视觉关闭）'),
    );

    const memory = new MemoryStore({
        dbPath: config.memory.dbPath,
        seedPath: config.memory.seedPath,
        maxContent: config.memory.maxContent,
        logger,
    });
    if (config.memory.enabled) {
        memory.init();
    } else {
        logger.info('记忆功能已关闭（MEMORY_ENABLED=false）');
    }

    const sessions = new SessionStore({
        dir: config.sessionDir,
        historyLimit: config.behavior.historyLimit,
        historyBytes: config.behavior.historyBytes,
        logger,
    });

    const state = createStateStore({ file: config.state.file, logger });
    const auth = createOwnerGuard({ config, logger });
    const evalLog = createEvalLog({ dir: config.eval.dir, enabled: config.eval.log, logger });
    if (evalLog.enabled) logger.info(`评分日志已开启：${config.eval.dir}（每轮对话落一份，供 scripts/eval.mjs 打分）`);

    const llm = new TextModelRouter({ config: config.llm, state, logger });
    logger.info(`当前文字模型：${llm.provider} / ${llm.model}；思考：${llm.effortLabel()}`);

    const tts = createTts({ config, logger });
    const scene = createSceneGenerator({ config, logger });
    if (tts.enabled) {
        tts.startSweeper();
        const use = tts.media.usage();
        logger.info(
            `语音就绪：${tts.engine} / 并发 ${config.tts.maxConcurrency} / 队列 ${config.tts.queueMax} / ` +
                `临时目录 ${config.tts.tmpDir}（现有 ${use.files} 个文件 ${(use.bytes / 1024).toFixed(1)} KB，上限 ${config.tts.tmpMaxMb} MB）`,
        );
    } else {
        logger.info(
            config.tts.engine === 'qwen'
                ? '语音功能未启用（TTS_ENABLED=false 或缺 TTS_QWEN_API_KEY）'
                : '语音功能未启用（TTS_ENABLED=false 或缺 TTS_API_KEY）',
        );
    }

    const runtime = {
        startedAt: Date.now(),
        uptimeText: () => humanDuration(Date.now() - runtime.startedAt),
        modelName: () => state.get('model', '') || config.llm.model,
        abortPeer: () => 0,
        activeTurns: () => 0,
        assets: [],
    };

    // 表情包素材：data/assets/ 下的图片，文件名就是它的名字
    if (config.assets.enabled) {
        try {
            fs.mkdirSync(config.assets.dir, { recursive: true });
        } catch (error) {
            logger.warn(`表情包目录建不出来：${error.message}`);
        }
        runtime.assets = listAssets(config.assets.dir, config.assets.maxBytes);
        logger.info(
            runtime.assets.length > 0
                ? `表情包素材就绪：${runtime.assets.length} 张（${runtime.assets.slice(0, 6).map((a) => a.name).join('、')}${runtime.assets.length > 6 ? '…' : ''}）`
                : `表情包目录为空：${config.assets.dir}（丢 .png/.jpg/.gif 进去，文件名就是名字）`,
        );
    }

    const commands = createCommandHandler({ config, logger, memory, sessions, state, tts, runtime, llm, auth });

    const toolkit = createToolkit({
        memory,
        logger,
        enabled: config.behavior.enableRememberTool,
        tts,
        groupWriteScope: config.memory.groupWriteScope,
        memoryStrict: config.memory.strict,
        assets: runtime.assets,
        scene,
        ttsEngine: config.tts.engine,
    });

    const bot = createBot({ config, logger, llm, memory, sessions, toolkit, tts, state, commands, runtime, auth, evalLog });
    runtime.bot = bot;
    runtime.companion = createCompanion({ config, state, auth, bot, llm, memory, sessions, runtime, logger });

    // ── 优雅退出 ────────────────────────────────────────────────────────────
    let stopping = false;
    const shutdown = async (signal) => {
        if (stopping) return;
        stopping = true;
        logger.info(`收到 ${signal}，正在收尾……`);
        const deadline = setTimeout(() => {
            sessions.flushAll();
            state.close();
            tts.media.sweep({ force: true });
            memory.close();
            process.exit(1);
        }, 15_000);
        deadline.unref();
        try {
            await bot.stop();
        } catch {
            /* 已经停了 */
        }
        await bot.drain();
        await runtime.companion?.stop();
        sessions.flushAll();
        state.close();
        tts.stop();
        // 退出时把临时音频清干净，别在云盘上攒垃圾。
        tts.media.sweep({ force: true });
        memory.close();
        clearTimeout(deadline);
        logger.info('已安全退出');
        process.exit(0);
    };
    process.on('SIGINT', () => shutdown('SIGINT'));
    process.on('SIGTERM', () => shutdown('SIGTERM'));

    process.on('unhandledRejection', (reason) => logger.error(`未处理的 Promise 拒绝：${reason?.stack || reason}`));
    process.on('uncaughtException', (error) => logger.error(`未捕获异常：${error?.stack || error}`));

    // 兜底刷盘：进程被强杀时最多丢 60 秒会话
    setInterval(() => sessions.flushAll(), 60_000).unref?.();

    // 面板控制台的输入框发的是 stdin：接上 clear / status / help
    const consoleCommands = attachConsoleCommands({ logger, runtime, tts, state });
    logger.info('控制台命令：输入 help 查看（clear 清屏 / status 看状态）');

    runtime.consoleCommands = consoleCommands;
    {
        const c = config.companion;
        logger.info(`主动聊天：${c.enabled ? '开' : '关'} · 每天最多 ${c.dailyMax} 条 · ${c.quietStart}:00～${c.quietEnd}:00 免打扰 · 空闲 ${Math.round(c.idleMinMs / 60000)}～${Math.round(c.idleMaxMs / 60000)} 分钟后考虑`);
    }
    logger.info('正在连接 QQ，确认上线后启动主动聊天');
    // SDK start() resolves only after stop(), not when READY arrives.
    try { await bot.start(); }
    finally { runtime.companion.setOnline(false); }
}

main().catch((error) => {
    console.error('[FATAL] 启动失败：', error?.stack || error);
    process.exit(1);
});





