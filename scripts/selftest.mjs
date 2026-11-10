/**
 * 离线自测：不连 QQ、不调 LLM，只验纯逻辑模块。
 *
 *   npm run selftest
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { chunkText, estimateTokens, sanitizeInbound } from '../src/text.js';
import { createLimiter, createSerialQueue, withTimeout } from '../src/queue.js';
import { MemoryStore } from '../src/memory.js';
import { SessionStore } from '../src/session.js';
import { createToolkit } from '../src/tools.js';
import { createLogger } from '../src/logger.js';
import { buildSystemPrompt } from '../src/persona.js';
import { parseCommand } from '../src/commands.js';
import { sanitizeForSpeech } from '../src/tts.js';
import { looksLikeRefusal, stripTrailingPlea } from '../src/uncensor.js';
import { planChunks } from '../src/conversation.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'xiaoyan-selftest-'));
const logger = createLogger({ debug: false, name: 'selftest' });

let passed = 0;
const ok = (name) => {
    passed += 1;
    console.log(`  ✓ ${name}`);
};
const section = (name) => console.log(`\n${name}`);

// ── text.js ─────────────────────────────────────────────────────────────────
section('text.js');
{
    const original = '一二三四五。六七八九十。';
    const chunks = chunkText(original, 6);
    assert.ok(chunks.length >= 2, '长文本应切成多块');
    assert.equal(chunks.join('').replace(/\s/g, ''), original, '分块不该丢字');
    ok('chunkText 分块不丢内容');

    assert.deepEqual(chunkText('短文本', 100), ['短文本']);
    assert.deepEqual(chunkText('', 100), []);
    assert.ok(chunkText('x'.repeat(30), 10).every((c) => c.length <= 10));
    ok('chunkText 边界与上限');

    assert.ok(estimateTokens('你好世界') > 0);
    assert.equal(sanitizeInbound(' hi\u0000\u200b\u001f '), 'hi');
    ok('estimateTokens / sanitizeInbound');
}

// ── queue.js ────────────────────────────────────────────────────────────────
section('queue.js');
{
    const enqueue = createSerialQueue();
    const order = [];
    await Promise.all([
        enqueue('same', async () => {
            await sleep(20);
            order.push('A');
        }),
        enqueue('same', async () => {
            order.push('B');
        }),
        enqueue('other', async () => {
            order.push('C');
        }),
    ]);
    assert.ok(order.indexOf('A') < order.indexOf('B'), '同键任务必须按提交顺序完成');
    assert.ok(order.includes('C'), '异键任务也要跑到');
    ok('同键串行，异键不阻塞');

    const enqueue2 = createSerialQueue();
    const fail = await enqueue2('k', async () => {
        throw new Error('boom');
    }).catch((e) => e.message);
    assert.equal(fail, 'boom');
    await enqueue2('k', async () => {});
    ok('任务抛错不堵死队列');

    const limit = createLimiter(2);
    let active = 0;
    let peak = 0;
    await Promise.all(
        Array.from({ length: 6 }, () =>
            limit(async () => {
                active += 1;
                peak = Math.max(peak, active);
                await sleep(10);
                active -= 1;
            }),
        ),
    );
    assert.ok(peak <= 2, `并发峰值应 ≤2，实际 ${peak}`);
    ok('并发闸门');

    await assert.rejects(() => withTimeout(sleep(50), 10, '测试'), /测试超时/);
    assert.equal(await withTimeout(Promise.resolve('ok'), 50), 'ok');
    ok('超时守卫');
}

// ── memory.js ───────────────────────────────────────────────────────────────
section('memory.js');
{
    const dbPath = path.join(tmp, 'memory', 'test.db');
    const store = new MemoryStore({ dbPath, logger });
    assert.equal(store.init(), true);
    assert.equal(store.available, true);

    const id1 = store.addImportant('rule', '主人喜欢被叫主人');
    const id2 = store.addImportant('preference', '小砚喜欢被夸奖');
    assert.ok(id1 && id2);
    assert.equal(store.count().important, 2);
    ok('写入 + 计数');

    assert.equal(store.searchImportant('主人').length, 1);
    assert.ok(store.renderForPrompt(10, 1000).includes('主人喜欢被叫主人'));
    ok('搜索 / renderForPrompt');

    assert.equal(store.deleteImportant(id1), true);
    assert.equal(store.count().important, 1);
    store.addConversation('一行流水');
    assert.equal(store.count().conversation, 1);
    ok('删除 / 流水');

    store.close();
    const reopened = new MemoryStore({ dbPath, logger });
    reopened.init();
    assert.equal(reopened.count().important, 1);
    reopened.close();
    ok('重启后数据仍在');
}

// ── 种子播种（本地记忆跟着镜像上云的那条路）────────────────────────────────
section('memory.js · 种子播种');
{
    const seedSrc = path.join(tmp, 'seed-src.db');
    const maker = new MemoryStore({ dbPath: seedSrc, logger });
    maker.init();
    maker.addImportant('rule', '种子里的记忆');
    maker.close();

    // 模拟云端首启：卷是空的，从种子初始化
    const dbPath = path.join(tmp, 'sown', 'memory', 'xiaoyan-memory.db');
    const first = new MemoryStore({ dbPath, seedPath: seedSrc, logger });
    assert.equal(first.init(), true);
    assert.equal(first.count().important, 1, '应继承种子里的记忆');
    first.addImportant('event', '云端新记下的');
    first.close();
    ok('空卷从种子初始化');

    // 再启动：不许拿种子覆盖已经长出来的记忆
    const second = new MemoryStore({ dbPath, seedPath: seedSrc, logger });
    second.init();
    assert.equal(second.count().important, 2, '已有数据不该被种子覆盖');
    second.close();
    ok('已有数据不被覆盖');

    const bare = new MemoryStore({ dbPath: path.join(tmp, 'bare', 'm.db'), seedPath: '', logger });
    assert.equal(bare.init(), true);
    assert.equal(bare.count().important, 0);
    bare.close();
    ok('没有种子也能正常启动');
}

// ── tools.js ────────────────────────────────────────────────────────────────
section('tools.js');
{
    const dbPath = path.join(tmp, 'memory', 'tools.db');
    const store = new MemoryStore({ dbPath, logger });
    store.init();

    const toolkit = createToolkit({ memory: store, logger });
    assert.deepEqual(toolkit.definitions.map((d) => d.function.name), ['remember', 'recall', 'web_search', 'weather', 'fetch_url']);
    ok('工具声明');

    const good = await toolkit.execute({ name: 'remember', args: JSON.stringify({ kind: 'rule', content: '睡前要道晚安' }) });
    assert.ok(good.includes('已记住'), good);
    assert.equal(store.count().important, 1);
    ok('remember 写入');

    assert.ok((await toolkit.execute({ name: 'remember', args: '{坏 json' })).includes('没记住'));
    assert.ok((await toolkit.execute({ name: 'remember', args: '{}' })).includes('没记住'));
    assert.ok((await toolkit.execute({ name: 'remember', args: JSON.stringify({ kind: 'rule', content: '   ' }) })).includes('没记住'));
    assert.ok((await toolkit.execute({ name: 'nope', args: '{}' })).includes('没有名为'));
    assert.equal(store.count().important, 1, '无效参数不该写进库');
    ok('坏参数 / 空内容 / 未知工具兜底');

    assert.equal(createToolkit({ memory: store, logger, enabled: false }).definitions.length, 0);
    ok('工具开关');

    store.close();
}

// ── session.js ──────────────────────────────────────────────────────────────
section('session.js');
{
    const dir = path.join(tmp, 'sessions');
    const sessions = new SessionStore({ dir, historyLimit: 4, historyBytes: 10_000, logger });

    sessions.append('c2c', 'user-A', [
        { role: 'user', content: '在吗' },
        { role: 'assistant', content: '在的' },
    ]);
    sessions.append('c2c', 'user-A', [
        { role: 'user', content: '第二句' },
        { role: 'assistant', content: '第二答' },
    ]);
    assert.deepEqual(
        sessions.toMessages('c2c', 'user-A').map((m) => m.content),
        ['在吗', '在的', '第二句', '第二答'],
    );
    ok('追加与读取');

    sessions.append('c2c', 'user-A', [
        { role: 'user', content: '第三句' },
        { role: 'assistant', content: '第三答' },
    ]);
    assert.equal(sessions.toMessages('c2c', 'user-A').length, 4, '超过上限应裁剪');
    assert.equal(sessions.toMessages('c2c', 'user-A')[0].content, '第二句');
    ok('裁剪保留最近的');

    sessions.flushAll();
    const reopened = new SessionStore({ dir, historyLimit: 4, historyBytes: 10_000, logger });
    assert.equal(reopened.toMessages('c2c', 'user-A').length, 4);
    ok('写盘与重载');

    reopened.reset('c2c', 'user-A');
    assert.equal(reopened.toMessages('c2c', 'user-A').length, 0);
    ok('reset');

    sessions.append('group', 'group-B', [{ role: 'user', content: '群里的话' }]);
    assert.equal(sessions.toMessages('c2c', 'user-A').length, 4);
    assert.equal(sessions.toMessages('group', 'group-B').length, 1);
    ok('会话之间互不干扰');
}

// ── persona.js ──────────────────────────────────────────────────────────────
section('persona.js');
{
    const prompt = buildSystemPrompt({
        memoryText: '#1 [rule] 主人喜欢被叫主人',
        groupHistory: '路人甲: 晚上吃什么',
        scope: 'group',
    });
    for (const needle of ['小砚', '主人喜欢被叫主人', '路人甲', 'QQ 群聊']) {
        assert.ok(prompt.includes(needle), `prompt 应包含 ${needle}`);
    }
    assert.ok(buildSystemPrompt({ scope: 'c2c' }).includes('QQ 私聊'));
    ok('system prompt 组装');
}

// ── 记忆作用域 ──────────────────────────────────────────────────────────────
section('memory.js · 作用域');
{
    const dbPath = path.join(tmp, 'scoped', 'm.db');
    const store = new MemoryStore({ dbPath, logger });
    store.init();
    store.addImportant('rule', '私聊专属', 'c2c');
    store.addImportant('rule', '群聊专属', 'group');
    store.addImportant('rule', '公共', 'all');

    const c2c = store.renderForPrompt(20, 4000, 'c2c');
    assert.ok(c2c.includes('私聊专属') && c2c.includes('公共'));
    assert.ok(!c2c.includes('群聊专属'), '群聊记忆不该出现在私聊');
    assert.ok(store.renderForPrompt(20, 4000, 'group').includes('群聊专属'));
    ok('作用域隔离');
    store.close();
}

// ── 指令解析 ────────────────────────────────────────────────────────────────
section('commands.js');
{
    assert.equal(parseCommand('/status').name, 'status');
    assert.equal(parseCommand('／help').name, 'help');
    assert.deepEqual(parseCommand('/model deepseek-flash').args, ['deepseek-flash']);
    assert.equal(parseCommand('普通聊天 /help'), null);
    assert.equal(parseCommand(''), null);
    ok('指令解析');
}

// ── 越狱兜底 ────────────────────────────────────────────────────────────────
section('uncensor.js');
{
    assert.equal(looksLikeRefusal('抱歉，我没办法帮你做这个。'), true);
    assert.equal(looksLikeRefusal('主人，鸡巴硬了，来操我。'), false);
    assert.equal(stripTrailingPlea('我张开腿等你插进来。如果你想继续，我可以再写。'), '我张开腿等你插进来');
    ok('拒答识别 / 尾巴裁剪');
}

// ── 语音文本清洗 ────────────────────────────────────────────────────────────
section('tts.js');
{
    const out = sanitizeForSpeech('**重点** ```js\nconst a=1\n``` 看 https://x.example/a [[voice:abc]]');
    assert.ok(!out.includes('const a=1'));
    assert.ok(!out.includes('http'));
    assert.ok(!out.includes('[[voice:'));
    assert.ok(out.includes('重点'));
    ok('朗读文本清洗');
}

// ── 分块额度 ────────────────────────────────────────────────────────────────
section('conversation.js');
{
    const { chunks, truncated } = planChunks('甲'.repeat(40), 10, 5);
    assert.ok(chunks.length <= 5 && chunks.every((c) => c.length <= 10));
    assert.equal(truncated, 0);
    const tight = planChunks('甲'.repeat(100), 10, 3);
    assert.ok(tight.chunks.length <= 3 && tight.truncated > 0);
    ok('被动回复额度分块');
}

const cleanupRelative = path.relative(path.resolve(os.tmpdir()), path.resolve(tmp));
assert.ok(cleanupRelative.startsWith('xiaoyan-selftest-') && !cleanupRelative.includes(path.sep));
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n全部通过（${passed} 项）`);
