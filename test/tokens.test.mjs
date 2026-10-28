// Token 用量聚合测试：用临时会话日志验证「今日 / 7 天 / 30 天」的按天归集。
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { test } from 'node:test';

import { collectTokenUsage } from '../index.js';

/** 造一条 v4 会话日志：两帧拼接，覆盖多帧解压路径。 */
function writeSessionLog(home, workspace, sessionId, events) {
  const dir = path.join(home, 'sessions', workspace, sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = events.map((event) => JSON.stringify(event)).join('\n') + '\n';
  const half = Math.floor(lines.length / 2);
  const first = zlib.zstdCompressSync(Buffer.from(lines.slice(0, half), 'utf8'));
  const second = zlib.zstdCompressSync(Buffer.from(lines.slice(half), 'utf8'));
  fs.writeFileSync(path.join(dir, 'session.v4.jsonl.zstd'), Buffer.concat([first, second]));
}

function usageEvent(time, input, output, cacheRead) {
  return {
    type: 'assistant/message',
    seq: 1,
    time,
    data: {
      message: { role: 'assistant', content: [] },
      usage: { inputTokens: input, outputTokens: output, totalTokens: input + output + cacheRead, cacheReadTokens: cacheRead },
    },
  };
}

function localDayStart(back = 0) {
  const date = new Date();
  date.setHours(0, 0, 0, 0);
  return date.getTime() - back * 86_400_000;
}

function makeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quota-tokens-'));
  writeSessionLog(home, '--ws--', 'session-a', [
    { type: 'session', seq: 0, time: localDayStart(0), data: {} },
    usageEvent(localDayStart(0) + 1000, 100, 10, 900),
    { type: 'user/message', seq: 2, time: localDayStart(0) + 2000, data: {} },
    usageEvent(localDayStart(0) + 3000, 200, 20, 1800),
    usageEvent(localDayStart(3) + 5000, 300, 30, 2700), // 3 天前
  ]);
  writeSessionLog(home, '--ws--', 'session-b', [
    { type: 'session', seq: 0, time: localDayStart(0), data: {} },
    usageEvent(localDayStart(0) + 4000, 400, 40, 3600),
    usageEvent(localDayStart(10) + 6000, 500, 50, 4500), // 10 天前
  ]);
  return home;
}

test('today：只统计今天的事件', async () => {
  const home = makeHome();
  const data = await collectTokenUsage({ home, range: 'today' });
  assert.equal(data.ok, true);
  assert.equal(data.daily.length, 1);
  assert.equal(data.totals.requests, 3); // 100+200+400 三条
  assert.equal(data.totals.input, 700);
  assert.equal(data.totals.output, 70);
  assert.equal(data.totals.cacheRead, 6300);
  assert.equal(data.totals.total, 7000 + 70);
  assert.equal(data.totals.cacheHit, Math.round((6300 / (7000 + 70 - 70)) * 1000) / 10);
});

test('7d：包含 3 天前、排除 10 天前', async () => {
  const home = makeHome();
  const data = await collectTokenUsage({ home, range: '7d' });
  assert.equal(data.daily.length, 7);
  assert.equal(data.totals.requests, 4);
  assert.equal(data.totals.input, 1000);
  // 3 天前落在 daily 数组的倒数第 4 项
  assert.equal(data.daily[3].requests, 1);
  assert.equal(data.daily[6].requests, 3);
});

test('30d：包含 10 天前的事件，按天归集', async () => {
  const home = makeHome();
  const data = await collectTokenUsage({ home, range: '30d' });
  assert.equal(data.daily.length, 30);
  assert.equal(data.totals.requests, 5);
  assert.equal(data.totals.input, 1500);
  assert.equal(data.daily[19].requests, 1); // 30 - 1 - 10 = 第 19 项 = 10 天前
});

test('空目录：返回零值而不是抛错', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-quota-empty-'));
  const data = await collectTokenUsage({ home, range: '7d' });
  assert.equal(data.ok, true);
  assert.equal(data.totals.total, 0);
  assert.equal(data.totals.requests, 0);
  assert.equal(data.totals.cacheHit, null);
  assert.equal(data.daily.length, 7);
});

test('未知区间回落到 7 天', async () => {
  const home = makeHome();
  const data = await collectTokenUsage({ home, range: 'nope' });
  assert.equal(data.days, 7);
});
