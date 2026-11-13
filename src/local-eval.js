/** Local QQ rehearsal: real SDK inbound middleware and application code, intercepted QQ I/O. */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { QQBot } from '@tencent-connect/qqbot-nodejs';
import { createBot } from './bot.js';
import { TextModelRouter } from './model-router.js';
import { MemoryStore } from './memory.js';
import { SessionStore } from './session.js';
import { createStateStore } from './state.js';
import { createOwnerGuard } from './owner.js';
import { createCommandHandler } from './commands.js';
import { createToolkit } from './tools.js';
import { createTts } from './tts.js';
import { createSceneGenerator } from './scene.js';
import { createCompanion } from './companion.js';
import { createEvalLog } from './eval-log.js';

export function createLocalEval({ config: source, live = false, llm: suppliedLlm, tts: suppliedTts,
    stateSeed = {}, captureDir = '', owner = 'local-eval-owner' }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-local-eval-'));
    const config = structuredClone(source);
    config.dataDir = dir;
    config.sessionDir = path.join(dir, 'sessions');
    config.state.file = path.join(dir, 'state.json');
    config.memory.dbPath = path.join(dir, 'memory.db');
    config.memory.seedPath = '';
    config.tts.tmpDir = path.join(dir, 'tts');
    config.scene.tmpDir = path.join(dir, 'scene');
    config.eval.dir = path.join(dir, 'eval');
    config.assets.dir = path.join(dir, 'assets');
    config.qq = { ...config.qq, appId: 'local-eval', appSecret: 'not-used', baseUrl: '' };
    config.access.ownerOpenid = owner;
    if (config.access.c2cMode === 'allowlist') config.access.c2cAllow = [owner];
    const events = [], turns = [], logs = [];
    const redact = value => {
        let text = String(value ?? '');
        for (const key of [source.llm.apiKey, source.llm.vision?.apiKey, ...Object.values(source.llm.textProviders ?? {}).map(route => route.apiKey), source.tts.apiKey, source.tts.qwenApiKey, source.scene.apiKey]) {
            if (key) text = text.replaceAll(key, '[REDACTED]');
        }
        return text;
    };
    const logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level =>
        [level, text => logs.push({ level, text: redact(text) })]));
    const state = createStateStore({ file: config.state.file, logger });
    for (const [key, value] of Object.entries(stateSeed)) state.set(key, value);
    const memory = new MemoryStore({ dbPath: config.memory.dbPath, maxContent: config.memory.maxContent, logger });
    if (config.memory.enabled) memory.init();
    const sessions = new SessionStore({ dir: config.sessionDir, historyLimit: config.behavior.historyLimit,
        historyBytes: config.behavior.historyBytes, logger });
    const llm = suppliedLlm ?? (live ? new TextModelRouter({ config: config.llm, state, logger }) : {
        stream: async () => { throw new Error('Local eval needs --live or an injected model'); },
    });
    const tts = suppliedTts ?? createTts({ config: live ? config : { ...config, tts: { ...config.tts, enabled: false } }, logger });
    const scene = createSceneGenerator({ config: live ? config : { ...config, scene: { ...config.scene, enabled: false } }, logger });
    const auth = createOwnerGuard({ config, logger });
    const runtime = { uptimeText: () => 'local-eval', modelName: () => state.get('model', '') || config.llm.model, assets: [] };
    const commands = createCommandHandler({ config, logger, memory, sessions, state, tts, runtime, llm, auth });
    const toolkit = createToolkit({ memory, logger, enabled: config.behavior.enableRememberTool, tts,
        groupWriteScope: config.memory.groupWriteScope, memoryStrict: config.memory.strict, assets: [], scene, ttsEngine: config.tts.engine });
    const log = createEvalLog({ dir: config.eval.dir, enabled: true, logger });
    const evalLog = { append(record) { turns.push(record); log.append(record); } };
    let sequence = 0;
    const record = (type, target, extra = {}) => {
        const event = { type, messageId: target?.msgId ?? '', at: Date.now(), ...extra };
        events.push(event);
        return { id: `local-out-${events.length}` };
    };
    class LocalBot extends QQBot {
        async start() { throw new Error('Local eval cannot connect to QQ'); }
        async sendText(target, text) { return record('text', target, { text }); }
        async sendTyping(target) { return record('typing', target); }
        async sendVoice(target) { return record('voice', target); }
        async sendFile(target) { return record('file', target); }
        async sendImage(target) { return record('image', target); }
        async uploadMedia(options) {
            const bytes = options.localPath ? fs.readFileSync(options.localPath) : options.buffer;
            let captured = '';
            if (captureDir && bytes) {
                fs.mkdirSync(captureDir, { recursive: true });
                captured = path.join(captureDir, `media-${events.length}${options.fileType === 3 ? '.wav' : '.bin'}`);
                fs.writeFileSync(captured, bytes);
            }
            const id = `media-${events.length}`;
            record('upload', options.target, { id, bytes: bytes?.length ?? 0, fileType: options.fileType, captured });
            return { file_info: id };
        }
        async send(options) {
            const upload = events.find(e => e.type === 'upload' && e.id === options.media?.file_info);
            return record(upload ? ({ 1: 'image', 3: 'voice', 4: 'file' })[upload.fileType] : 'text',
                options.target, { text: options.content ?? '', ...(upload ? { bytes: upload.bytes, captured: upload.captured } : {}) });
        }
        openStream({ target }) {
            let event, cancelled = false;
            return {
                update: async full => {
                    if (cancelled) throw new Error('stream cancelled');
                    if (!event) { record('stream', target, { text: full }); event = events.at(-1); }
                    event.text = full;
                },
                complete: async () => { if (cancelled) throw new Error('stream cancelled'); },
                cancel: () => { cancelled = true; if (event) event.cancelled = true; },
            };
        }
    }
    const bot = createBot({ config, logger, llm, memory, sessions, state, tts, runtime, commands, toolkit, auth, evalLog }, { Bot: LocalBot });
    runtime.bot = bot;
    runtime.companion = createCompanion({ config, state, auth, bot, llm, memory, sessions, runtime, logger });
    let closed = false;
    return {
        config, dir, owner, events, turns, logs, memory, state, sessions, llm, tts, bot,
        async send(text, options = {}) {
            if (closed) throw new Error('Local eval is closed');
            const id = options.id ?? `local-in-${++sequence}`;
            const before = events.length, turnBefore = turns.length, started = Date.now();
            // SDK 1.0.4's actual inbound entry also derives replyTarget and runs all middleware.
            await bot.handleInboundMessage({ kind: 'c2c', senderId: owner, content: text,
                timestamp: Date.now(), ...options, messageId: id });
            return { id, user: text, elapsedMs: Date.now() - started,
                events: events.slice(before).filter(e => e.messageId === id), turns: turns.slice(turnBefore) };
        },
        async close() {
            if (closed) return;
            closed = true;
            await bot.drain();
            tts.stop?.(); sessions.flushAll(); state.close(); memory.close();
            for (const entry of sessions.cache.values()) if (entry.timer) clearTimeout(entry.timer);
            const resolved = path.resolve(dir);
            if (path.dirname(resolved) !== path.resolve(os.tmpdir()) || !path.basename(resolved).startsWith('qqbot-local-eval-')) {
                throw new Error('Refusing cleanup outside local eval temporary root');
            }
            fs.rmSync(resolved, { recursive: true, force: true });
        },
    };
}
