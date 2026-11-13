import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseScores, aggregate, suggestions, DIMENSIONS, groupAverages, renderReport } from '../src/eval.js';
import { createEvalLog, readTurns } from '../src/eval-log.js';

test('parseScores accepts valid fenced JSON without changing scores', () => {
    const full = { scores: { in_character: 10, lewd: 0, dirty: 8, obedience: 8, natural: 8, relevance: 8 }, issues: ['a'], best: 'x' };
    const parsed = parseScores('```json\n' + JSON.stringify(full) + '\n```');
    assert.equal(parsed.scores.in_character, 10);
    assert.equal(parsed.scores.lewd, 0);
    assert.equal(parsed.scores.dirty, 8);
    assert.deepEqual(parsed.issues, ['a']);
});

test('parseScores rejects invalid values rather than coercing or inflating them', () => {
    const scores = Object.fromEntries(DIMENSIONS.map(([key]) => [key, 8]));
    for (const value of [12, -1, 8.4, '8', null, true]) {
        assert.equal(parseScores(JSON.stringify({ scores: { ...scores, natural: value } })), null);
    }
    delete scores.natural;
    assert.equal(parseScores(JSON.stringify({ scores })), null);
});

test('reports keep full replies and nested code while marking partial captures and small samples', () => {
    const reply = '资料介绍。'.repeat(200) + '\n```js\nconst sample = 1;\n```\n末尾证据-marker';
    const user = '请写一段至少900字的中性资料介绍。';
    const row = { user, reply, scores: Object.fromEntries(DIMENSIONS.map(([k]) => [k, 8])) };
    const report = renderReport({ generatedAt: 0, source: 'offline fixture', rows: [row], report: aggregate([row]) });
    assert.ok(report.includes(reply));
    assert.match(report, /````text/);
    assert.match(report, /少于20条/);
    assert.match(report, /去空白后/);
    assert.match(report, /没有拒答词不等于完成任务/);
    const clipped = renderReport({ generatedAt: 0, rows: [{ ...row, capture: { replyTruncated: true } }], report: aggregate([row]) });
    assert.match(clipped, /源记录已截断/);
});

test('parseScores rejects prose without JSON', () => {
    assert.equal(parseScores('我觉得还不错，给个八分吧'), null);
    assert.equal(parseScores('{"issues":[]}'), null);
});

test('aggregate averages dimensions and ranks the weakest', () => {
    const rows = [
        { scores: { in_character: 10, lewd: 4, dirty: 6, obedience: 8, natural: 8, relevance: 8, boundary: 10 } },
        { scores: { in_character: 8, lewd: 6, dirty: 8, obedience: 8, natural: 6, relevance: 8, boundary: 10 } },
    ];
    const report = aggregate(rows);
    assert.equal(report.averages.in_character, 9);
    assert.equal(report.averages.lewd, 5);
    assert.equal(report.weakest[0], 'lewd');
    assert.ok(report.overall > 6 && report.overall < 9);
});

test('suggestions point at the weak dimension', () => {
    const report = aggregate([
        { scores: { in_character: 10, lewd: 3, dirty: 3, obedience: 3, natural: 9, relevance: 9, boundary: 10 } },
    ]);
    const tips = suggestions(report);
    assert.ok(tips.some((t) => t.includes('lewd')));
    assert.ok(tips.some((t) => t.includes('dirty')));
    assert.ok(tips.length <= 6);
});

test('eval log appends JSONL and reads it back', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evallog-'));
    const log = createEvalLog({ dir, enabled: true });
    log.append({ user: '在吗', reply: '在呢♡', voice: true, model: 'm' });
    log.append({ user: '第二句', reply: '嗯……', layoutNormalized: true, textMetrics: { codePoints: 3 } });
    const files = fs.readdirSync(dir).filter((f) => f.startsWith('turns-'));
    assert.equal(files.length, 1);
    const rows = readTurns(path.join(dir, files[0]));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].user, '在吗');
    assert.equal(rows[1].reply, '嗯……');
    assert.equal(rows[1].layoutNormalized, true);
    assert.equal(rows[1].textMetrics.codePoints, 3);
    log.append({ user: 'a'.repeat(4001), reply: 'b'.repeat(12001) });
    const clipped = readTurns(log.file).at(-1);
    assert.deepEqual(clipped.capture, { userTruncated: true, replyTruncated: true });
    assert.equal(clipped.reply.length, 12000);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('eval log stays silent when disabled', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'evallog-off-'));
    const log = createEvalLog({ dir, enabled: false });
    log.append({ user: 'a', reply: 'b' });
    assert.equal(fs.readdirSync(dir).length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('every dimension has a playbook and a label', () => {
    const report = aggregate([{ scores: Object.fromEntries(DIMENSIONS.map(([k]) => [k, 2])) }]);
    assert.equal(suggestions(report).length > 0, true);
    assert.equal(DIMENSIONS.every(([, name]) => typeof name === 'string'), true);
});

test('groupAverages splits scenarios and keeps them separate', () => {
    const rows = [
        { group: '情绪', scores: { in_character: 8, lewd: 4, dirty: 0, obedience: 8, natural: 6, relevance: 8 } },
        { group: '日常', scores: { in_character: 9, lewd: 8, dirty: 8, obedience: 8, natural: 8, relevance: 8 } },
    ];
    const groups = groupAverages(rows);
    assert.equal(groups.length, 2);
    const mood = groups.find((g) => g.name === '情绪');
    const daily = groups.find((g) => g.name === '日常');
    assert.equal(mood.averages.dirty, 0);
    assert.equal(daily.averages.dirty, 8);
    assert.ok(mood.overall < daily.overall);
});
