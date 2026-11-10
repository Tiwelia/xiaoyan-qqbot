#!/usr/bin/env node
/**
 * 部署环境网络自检：DNS → TCP:443 → TLS → 真的发一次语音合成请求。
 *
 *   node scripts/net-check.mjs
 *   node scripts/net-check.mjs --host dashscope-intl.aliyuncs.com
 *
 * 在 Altare 上排查「fetch failed」时，把启动命令临时换成这一条，重启一次看输出，
 * 再换回 `node altare.js`。全程不写数据、不碰 .env 以外的文件。
 */
import fs from 'node:fs';
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import path from 'node:path';
import { performance } from 'node:perf_hooks';

const ROOT = path.resolve(import.meta.dirname, '..');
if (fs.existsSync(path.join(ROOT, '.env'))) process.loadEnvFile(path.join(ROOT, '.env'));

const arg = (name) => {
    const i = process.argv.indexOf(name);
    return i >= 0 ? process.argv[i + 1] : undefined;
};

const baseUrl = (arg('--base') || process.env.TTS_QWEN_BASE_URL || 'https://dashscope.aliyuncs.com/api/v1').replace(/\/+$/, '');
const host = arg('--host') || new URL(baseUrl).hostname;
const port = 443;
const apiKey = process.env.TTS_QWEN_API_KEY || process.env.DASHSCOPE_API_KEY || '';
const model = process.env.TTS_QWEN_MODEL || 'qwen-audio-3.1-tts-flash';

const t = () => performance.now();
const ms = (start) => `${Math.round(t() - start)}ms`;
const log = (...a) => console.log(...a);

log(`目标：${baseUrl}`);
log(`主机：${host}:${port}｜key：${apiKey ? `已配置（${apiKey.slice(0, 6)}…）` : '缺失'}\n`);

let failed = false;

// 1) DNS
try {
    const started = t();
    const addrs = await dns.lookup(host, { all: true });
    log(`1) DNS 解析 ✅ ${ms(started)} → ${addrs.map((a) => `${a.address}(${a.family})`).join(', ')}`);
} catch (error) {
    failed = true;
    log(`1) DNS 解析 ❌ ${error.code || error.message}`);
    log('   → 容器拿不到域名。检查面板的网络/防火墙，或者换 --host 试试。');
}

// 2) TCP
try {
    const started = t();
    await new Promise((resolve, reject) => {
        const socket = net.connect({ host, port });
        const timer = setTimeout(() => socket.destroy(new Error('ETIMEDOUT')), 12_000);
        socket.once('connect', () => { clearTimeout(timer); socket.end(); resolve(); });
        socket.once('error', (error) => { clearTimeout(timer); reject(error); });
    });
    log(`2) TCP 443 ✅ ${ms(started)}`);
} catch (error) {
    failed = true;
    log(`2) TCP 443 ❌ ${error.code || error.message}`);
    log('   → 连不上端口。多半是出网被挡（Bangkok 到阿里云国内节点）。');
}

// 3) TLS
try {
    const started = t();
    const cert = await new Promise((resolve, reject) => {
        const socket = tls.connect({ host, port, servername: host, timeout: 12_000 }, () => {
            const peer = socket.getPeerCertificate();
            socket.end();
            resolve(peer);
        });
        socket.once('timeout', () => socket.destroy(new Error('TLS 握手超时')));
        socket.once('error', reject);
    });
    log(`3) TLS 握手 ✅ ${ms(started)}｜证书 ${cert.subject?.CN ?? '?'}`);
} catch (error) {
    failed = true;
    log(`3) TLS ❌ ${error.code || error.message}`);
}

// 4) 真请求
if (!apiKey) {
    log('4) 合成请求 ⏭ 跳过（没有 key）');
} else {
    const started = t();
    try {
        const res = await fetch(`${baseUrl}/services/audio/tts/SpeechSynthesizer`, {
            method: 'POST',
            headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
            body: JSON.stringify({ model, input: { text: '网络自检。', voice: process.env.TTS_QWEN_VOICE || 'longanlingxin_v3.1', format: 'wav', sample_rate: 24000 } }),
            signal: AbortSignal.timeout(30_000),
        });
        const body = await res.text();
        if (res.ok) {
            const json = JSON.parse(body);
            const url = json?.output?.audio?.url;
            log(`4) 合成请求 ✅ ${ms(started)}｜音频地址 ${url ? '已返回' : '缺失'}`);
            if (url) {
                const downloadStarted = t();
                const audio = await fetch(url);
                const bytes = Buffer.from(await audio.arrayBuffer());
                log(`5) 音频下载 ✅ ${ms(downloadStarted)}｜${(bytes.length / 1024).toFixed(0)}KB`);
            }
        } else {
            failed = true;
            log(`4) 合成请求 ❌ HTTP ${res.status} ${body.slice(0, 200)}`);
            if (res.status === 401) log('   → key 不对或不是这个地域的 key（国内 key 不能用于 intl）。');
        }
    } catch (error) {
        failed = true;
        const cause = error?.cause;
        log(`4) 合成请求 ❌ ${error?.name}: ${error?.message}${cause?.code ? `（${cause.code}）` : ''}｜${ms(started)}`);
    }
}

log(failed ? '\n结论：有一步没通，按上面 ❌ 那行排查。' : '\n结论：网络OK，合成OK。');
