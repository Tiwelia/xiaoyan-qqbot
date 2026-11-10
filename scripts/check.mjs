/**
 * 语法检查：根目录入口与 src/、scripts/ 下所有 JavaScript 模块。
 *
 *   npm run check
 */
import { spawnSync } from 'node:child_process';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOTS = ['src', 'scripts'];
const targets = ['altare.js'];

for (const root of ROOTS) {
    (function walk(dir) {
        for (const name of readdirSync(dir)) {
            const full = join(dir, name);
            if (statSync(full).isDirectory()) walk(full);
            else if (/\.m?js$/.test(name)) targets.push(full);
        }
    })(root);
}

targets.sort();

let failed = 0;
for (const file of targets) {
    // stdio: 'inherit' —— 让 node 自己把错误打到终端，我们只看退出码
    const result = spawnSync(process.execPath, ['--check', file], { stdio: 'inherit' });
    if (result.status === 0) {
        console.log(`  ✓ ${file}`);
    } else {
        failed += 1;
    }
}

if (failed > 0) {
    console.error(`\n${failed} 个文件语法有误`);
    process.exit(1);
}
console.log(`\n语法检查通过（${targets.length} 个文件）`);
