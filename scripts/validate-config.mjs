import { loadConfig, validateConfig } from '../src/config.js';
const problems = validateConfig(loadConfig());
if (problems.length) {
    console.error('启动配置检查未通过：');
    for (const problem of problems) console.error(`- ${problem}`);
    process.exitCode = 1;
} else console.log('启动配置检查通过（未连接 QQ，未调用模型）。');
