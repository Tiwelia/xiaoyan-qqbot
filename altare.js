/** Altare 的主文件入口：直接运行 node altare.js 也会读取同目录 .env。 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const root = path.dirname(fileURLToPath(import.meta.url));
process.chdir(root);

if (Number(process.versions.node.split('.')[0]) < 24) {
    console.error('需要 Node.js 24 或更高版本，请先在 Altare 的 Startup 中切换运行镜像。');
    process.exitCode = 1;
} else {
    const envFile = path.join(root, '.env');
    if (fs.existsSync(envFile)) {
        process.loadEnvFile(envFile);
        // 容器常把 TZ 设成 UTC：环境变量优先，loadEnvFile 不会覆盖，所以这里手动读 .env 的 TZ 强设一次，
        // 否则日志和「现在几点」会差好几个小时（实测差 8 小时）。
        const tz = parseEnv(fs.readFileSync(envFile, 'utf8')).TZ;
        if (tz) process.env.TZ = tz;
    }
    const { loadConfig, validateConfig } = await import('./src/config.js');
    const config = loadConfig();
    const problems = validateConfig(config);
    // Altare 的持久数据应保存在应用目录内，拦住 Railway 的 /data 或 Windows 绝对路径。
    for (const [name, value] of Object.entries({
        DATA_DIR: config.dataDir, SESSION_DIR: config.sessionDir, MEMORY_DB: config.memory.dbPath,
        MEMORY_SEED: config.memory.seedPath, STATE_FILE: config.state.file,
        TTS_TMP_DIR: config.tts.tmpDir, TTS_VOICE_DIR: config.tts.voiceDir,
        SCENE_TMP_DIR: config.scene.tmpDir,
    })) {
        if (!value) continue;
        const relative = path.relative(root, path.resolve(value));
        if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
            problems.push(`${name} 必须指向项目目录内，请参考 ALTARE.md 修改旧平台的数据路径`);
        }
    }
    if (problems.length) {
        console.error('Altare 启动配置检查未通过：');
        for (const problem of problems) console.error(`- ${problem}`);
        process.exitCode = 1;
    } else if (process.argv.includes('--check')) {
        console.log('Altare 配置检查通过（未连接 QQ、未调用模型）。');
    } else {
        await import('./src/index.js');
    }
}

