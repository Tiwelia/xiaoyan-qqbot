/** 联网查询：搜索、天气、抓网页。全部只读 HTTP GET，带超时和私网拦截。 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import http from 'node:http';
import https from 'node:https';
import { createGunzip, createInflate, createBrotliDecompress } from 'node:zlib';

const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 9000;

export function isPrivateHost(host) {
    const h = String(host ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!h || h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal')) return true;
    if (isIP(h) === 4) {
        const [a, b] = h.split('.').map(Number);
        return a === 0 || a === 10 || a === 127 || a >= 224
            || (a === 169 && b === 254) || (a === 192 && b === 168)
            || (a === 172 && b >= 16 && b <= 31) || (a === 100 && b >= 64 && b <= 127);
        // 198.18.0.0/15 不拦：Clash 的 TUN 模式拿它当 fake-ip，拦了本机所有域名都会被判成内网
    }
    if (isIP(h) === 6) {
        // URL normalization turns dotted IPv4-mapped addresses into two hexadecimal groups.
        const canonical = new URL(`http://[${h}]/`).hostname.slice(1, -1);
        const mapped = /^::ffff:([a-f0-9]+):([a-f0-9]+)$/.exec(canonical);
        if (mapped) {
            const n = parseInt(mapped[1], 16) * 65536 + parseInt(mapped[2], 16);
            return isPrivateHost([n >>> 24, (n >>> 16) & 255, (n >>> 8) & 255, n & 255].join('.'));
        }
        // Only global unicast addresses; reject loopback, unspecified, link/site-local and multicast.
        const first = parseInt(canonical.split(':')[0], 16);
        return !(first >= 0x2000 && first <= 0x3fff) || first === 0x2002;
    }
    return false; // A hostname such as fcdn.example is not an IPv6 address.
}

function abortable(promise, signal) {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const onAbort = () => reject(signal.reason);
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
    });
}

async function publicAddresses(url, signal, lookupImpl) {
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('只支持不含账号密码的 http/https 网址');
    const host = url.hostname.replace(/^\[|\]$/g, '');
    if (isPrivateHost(host)) throw new Error('拒绝访问内网地址');
    const addresses = isIP(host) ? [{ address: host, family: isIP(host) }]
        : await abortable(lookupImpl(host, { all: true }), signal);
    if (!addresses.length || addresses.some(a => !isIP(a.address) || isPrivateHost(a.address))) throw new Error('拒绝访问内网地址或无法解析的域名');
    return addresses;
}

async function requestPublic(url, addresses, signal, requestImpl) {
    // Pin the socket to the addresses just checked. Fetching after an independent DNS check
    // would resolve again and allow DNS rebinding between validation and connection.
    return new Promise((resolve, reject) => {
        const request = requestImpl || (url.protocol === 'https:' ? https.request : http.request);
        const req = request(url, {
            method: 'GET', signal, agent: false,
            lookup: (_host, opts, callback) => opts.all ? callback(null, addresses)
                : callback(null, addresses[0].address, addresses[0].family),
            headers: { 'user-agent': 'Mozilla/5.0 (compatible; xiaoyan/1.0)',
                accept: 'text/html,application/json;q=0.9,*/*;q=0.8', 'accept-encoding': 'gzip, deflate, br' },
        }, resolve);
        req.on('error', reject);
        req.end();
    });
}

async function readLimited(response, signal) {
    if (Number(response.headers['content-length']) > MAX_BYTES) throw new Error('网页超过读取字节上限');
    const decoder = { gzip: createGunzip, deflate: createInflate, br: createBrotliDecompress }[response.headers['content-encoding']];
    const body = decoder ? response.pipe(decoder()) : response;
    const forwardError = error => body.destroy(error);
    if (body !== response) response.on('error', forwardError);
    const chunks = [];
    let total = 0;
    try {
        for await (const chunk of body) {
            signal.throwIfAborted();
            total += chunk.length;
            if (total > MAX_BYTES) throw new Error('网页超过读取字节上限');
            chunks.push(chunk);
        }
        signal.throwIfAborted();
        return Buffer.concat(chunks, total).toString('utf8');
    } finally {
        if (body !== response) response.removeListener('error', forwardError);
        body.destroy();
    }
}

export async function fetchPage(rawUrl, { timeoutMs = TIMEOUT_MS, signal, lookupImpl = lookup, requestImpl } = {}) {
    let url;
    try { url = new URL(rawUrl); } catch { throw new Error('网址格式不对'); }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('请求超时')), timeoutMs);
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    try {
        for (let redirects = 0; redirects <= 5; redirects++) {
            combined.throwIfAborted();
            const addresses = await publicAddresses(url, combined, lookupImpl);
            const res = await requestPublic(url, addresses, combined, requestImpl);
            try {
                if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
                    if (!res.headers.location) throw new Error('重定向缺少目标地址');
                    if (redirects === 5) throw new Error('网页重定向次数过多');
                    url = new URL(res.headers.location, url);
                    continue; // The next destination must pass the same protocol/IP/DNS checks.
                }
                if (res.statusCode < 200 || res.statusCode >= 300) throw new Error(`HTTP ${res.statusCode}`);
                const body = await readLimited(res, combined);
                return { url: url.href, contentType: res.headers['content-type'] || '', body };
            } finally { res.destroy(); }
        }
    } finally { clearTimeout(timer); }
}

/** 粗暴去标签，留可读文本。 */
export function htmlToText(html) {
    return String(html ?? '')
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ')
        .replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
        .replace(/\s+/g, ' ')
        .trim();
}

function ddgTarget(href) {
    try {
        const u = new URL(href, 'https://duckduckgo.com');
        const real = u.searchParams.get('uddg');
        return real ? decodeURIComponent(real) : u.href;
    } catch { return href; }
}

function bingResults(body, limit) {
    const out = [];
    const blocks = body.split('<li class="b_algo"').slice(1);
    for (const block of blocks) {
        if (out.length >= limit) break;
        const link = /<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
        if (!link) continue;
        const snippet = /<p[^>]*class="[^"]*b_lineclamp[^"]*"[^>]*>([\s\S]*?)<\/p>/i.exec(block)
            ?? /<p[^>]*>([\s\S]*?)<\/p>/i.exec(block);
        out.push({ title: htmlToText(link[2]), url: link[1], snippet: htmlToText(snippet?.[1] ?? '') });
    }
    return out;
}

function ddgResults(body, limit) {
    const out = [];
    const re = /<a[^>]+class="result__a"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?(?:class="result__snippet"[^>]*>([\s\S]*?)<\/a>)?/g;
    let m;
    while ((m = re.exec(body)) && out.length < limit) {
        const title = htmlToText(m[2]);
        if (title) out.push({ title, url: ddgTarget(m[1]), snippet: htmlToText(m[3] ?? '') });
    }
    return out;
}

/**
 * 搜索：Bing 优先（实测东南亚节点能通），DuckDuckGo 兜底。
 * 两个都挂就抛错，让模型如实说搜不到。
 */
export async function webSearch(query, { limit = 5, timeoutMs = TIMEOUT_MS, signal } = {}) {
    const q = String(query ?? '').trim();
    if (!q) throw new Error('搜索词为空');
    const attempts = [
        [`https://www.bing.com/search?q=${encodeURIComponent(q)}&setlang=zh-CN`, bingResults],
        [`https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`, ddgResults],
    ];
    let lastError;
    for (const [url, parse] of attempts) {
        try {
            const { body } = await fetchPage(url, { timeoutMs, signal });
            const results = parse(body, limit);
            if (results.length > 0) return results;
            lastError = new Error('没有解析到结果');
        } catch (error) {
            signal?.throwIfAborted();
            lastError = error;
        }
    }
    throw lastError ?? new Error('搜索失败');
}

export async function weather(city, { signal } = {}) {
    const place = String(city ?? '').trim() || 'Beijing';
    const url = `https://wttr.in/${encodeURIComponent(place)}?format=j1&lang=zh`;
    const { body } = await fetchPage(url, { timeoutMs: 12_000, signal });
    const data = JSON.parse(body);
    const cur = data.current_condition?.[0] ?? {};
    const today = data.weather?.[0] ?? {};
    const desc = cur.lang_zh?.[0]?.value || cur.weatherDesc?.[0]?.value || '';
    const area = data.nearest_area?.[0]?.areaName?.[0]?.value ?? place;
    const lines = [
        `${area} 现在 ${cur.temp_C ?? '?'}°C，${desc}，体感 ${cur.FeelsLikeC ?? '?'}°C，湿度 ${cur.humidity ?? '?'}%，风 ${cur.winddir16Point ?? ''} ${cur.windspeedKmph ?? '?'}km/h。`,
        `今天 ${today.mintempC ?? '?'}~${today.maxtempC ?? '?'}°C。`,
    ];
    const hours = (today.hourly ?? []).filter((h) => ['900', '1200', '1500', '1800', '2100'].includes(h.time));
    for (const h of hours) {
        const d = h.lang_zh?.[0]?.value || h.weatherDesc?.[0]?.value || '';
        lines.push(`${String(Number(h.time) / 100).replace(/\.0$/, '')}:00 ${h.tempC}°C ${d} 降水${h.chanceofrain ?? '?'}%`);
    }
    return lines.join('\n');
}

