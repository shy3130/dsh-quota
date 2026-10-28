/**
 * 套餐额度状态栏插件 —— 宿主侧（支持智谱 GLM 与 OpenCode Go）。
 *
 * 输入框下方的状态栏（conversation.composer.dock）由 client.js 渲染；
 * 它轮询本插件在 DSH webServer 上挂的两个路由取数：
 *
 *   GET /quota/active    当前模型对应的额度来源（跟随模型选择切换）
 *   GET /quota/config    界面偏好（指示器形态：柱状条 bar / 环状条 ring）
 *   GET /quota/tokens    Token 用量统计（今日 / 7 天 / 30 天，读本机会话日志）
 *   GET /quota/zhipu     智谱 GLM Coding Plan
 *   GET /quota/opencode  OpenCode Go 订阅
 *
 * 两者都归一化成同一份 JSON：
 *   { ok, fetchedAt, level?, windows: [{ key, percent, resetsAt }], tools?: {...} }
 *
 * 上游接口：
 *   智谱      GET {baseUrl}/api/monitor/usage/quota/limit   （TOKENS_LIMIT / TIME_LIMIT）
 *   OpenCode  GET {baseUrl}/zen/go/v1/usage                 （rolling / weekly / monthly）
 * 认证都是 Authorization: Bearer <API Key>。
 *
 * API Key 从 DSH 的凭据服务按引用名读取（默认 ZAI_CODING_CN_API_KEY /
 * OPENCODE_GO_API_KEY，与 llm-pi-ai 里各路由的 apiKeyEnv 一致），
 * 密钥只在宿主进程里使用，绝不进入返回给浏览器的 JSON。
 *
 * 路由带登录门：有 connection 服务时走 DSH 登录校验，没有时只放行本机回环请求。
 */

import fs from 'node:fs';
import nodePath from 'node:path';
import os from 'node:os';
import zlib from 'node:zlib';

export const name = '@local/dsh-quota';
export const inject = ['webServer'];

/** 成功结果缓存时长：轮询间隔 60s，缓存 55s 让页面刷新时能复用一次。 */
const CACHE_OK_MS = 55_000;
/** 失败结果缓存时长：避免上游故障时每次轮询都打接口。 */
const CACHE_FAIL_MS = 10_000;
/** 上游请求超时。 */
const TIMEOUT_MS = 12_000;

const LOOPBACK_HOST = /^(localhost|127\.0\.0\.1|\[::1\])(?::\d+)?$/i;
const LOOPBACK_IP = /^(::1|127\.\d+\.\d+\.\d+|::ffff:127\.\d+\.\d+\.\d+)$/;

function clampPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return undefined;
  return Math.max(0, Math.min(100, Math.round(n)));
}

function epoch(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

/** ISO 时间字符串 → epoch 毫秒。 */
function isoEpoch(value) {
  if (typeof value !== 'string') return undefined;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/** 数字解析：接受数值或数字字符串。 */
function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

/** 重置时间 → epoch 毫秒：秒级/毫秒级时间戳与 ISO 字符串都能吃。 */
function resetEpoch(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 1e12 ? value : value * 1000;
  if (typeof value === 'string') {
    const n = Number(value);
    if (Number.isFinite(n)) return n > 1e12 ? n : n * 1000;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? ms : undefined;
  }
  return undefined;
}

/** 由 used/limit（或 limit/remaining）推出已用百分比。 */
function percentOf(used, limit, remaining) {
  if (typeof limit !== 'number' || limit <= 0) return undefined;
  const consumed = typeof used === 'number' ? used : typeof remaining === 'number' ? limit - remaining : undefined;
  return consumed === undefined ? undefined : clampPercent((consumed / limit) * 100);
}

/**
 * 智谱：把一条 limit 归一化成界面要用的窗口。
 *   TOKENS_LIMIT unit=3 number=5 → 5 小时滚动窗口（percentage）
 *   TOKENS_LIMIT unit=6 number=1 → 每周窗口（percentage）
 *   TIME_LIMIT   unit=5 number=1 → 每月工具额度（usage/currentValue/remaining）
 */
function normalizeLimit(limit) {
  if (limit === null || typeof limit !== 'object') return undefined;
  const type = limit.type;
  const unit = limit.unit;
  const number = limit.number;
  if (type === 'TOKENS_LIMIT') {
    if (unit === 3 && number === 5) return { kind: 'tokens', key: 'h5', percent: clampPercent(limit.percentage), resetsAt: epoch(limit.nextResetTime) };
    if (unit === 6) return { kind: 'tokens', key: 'week', percent: clampPercent(limit.percentage), resetsAt: epoch(limit.nextResetTime) };
    return { kind: 'tokens', key: 'other', percent: clampPercent(limit.percentage), resetsAt: epoch(limit.nextResetTime) };
  }
  if (type === 'TIME_LIMIT') {
    return {
      kind: 'tools',
      key: 'tools',
      percent: clampPercent(limit.percentage),
      resetsAt: epoch(limit.nextResetTime),
      used: Number.isFinite(limit.currentValue) ? limit.currentValue : undefined,
      total: Number.isFinite(limit.usage) ? limit.usage : undefined,
      remaining: Number.isFinite(limit.remaining) ? limit.remaining : undefined,
      details: Array.isArray(limit.usageDetails)
        ? limit.usageDetails.flatMap((row) => {
            if (row === null || typeof row !== 'object' || typeof row.modelCode !== 'string') return [];
            return [{ code: row.modelCode, usage: Number.isFinite(row.usage) ? row.usage : 0 }];
          })
        : undefined,
    };
  }
  return undefined;
}

/** 智谱接口返回体 → 统一 JSON。 */
function normalizeZhipu(body) {
  const data = body !== null && typeof body === 'object' && body.data !== null && typeof body.data === 'object' ? body.data : {};
  const limits = Array.isArray(data.limits) ? data.limits : [];
  const normalized = limits.map(normalizeLimit).filter((row) => row !== undefined);
  return {
    ok: true,
    fetchedAt: Date.now(),
    level: typeof data.level === 'string' ? data.level : undefined,
    windows: normalized.filter((row) => row.kind === 'tokens'),
    tools: normalized.find((row) => row.kind === 'tools'),
  };
}

/**
 * OpenCode Go 接口返回体 → 统一 JSON。
 * 形状：{ usage: { rolling: {status, percent, resetsAt}, weekly: {...}, monthly: {...} } }
 * rolling 是滚动窗口，weekly / monthly 是本周 / 本月。
 */
function normalizeOpencode(body) {
  const usage = body !== null && typeof body === 'object' && body.usage !== null && typeof body.usage === 'object' ? body.usage : {};
  const mapping = [['rolling', 'rolling'], ['weekly', 'week'], ['monthly', 'month']];
  const windows = [];
  for (const [upstreamKey, key] of mapping) {
    const item = usage[upstreamKey];
    if (item === null || typeof item !== 'object') continue;
    windows.push({ key, percent: clampPercent(item.percent), resetsAt: isoEpoch(item.resetsAt) });
  }
  return { ok: true, fetchedAt: Date.now(), windows };
}

/**
 * Kimi For Coding：GET https://api.kimi.com/coding/v1/usages（Bearer：KIMI_API_KEY 或 Kimi OAuth）
 * 形状：{ user:{membership:{level}},
 *        usage:{limit,used,remaining,resetTime}                    // 本周汇总
 *        limits:[{window:{duration,timeUnit}, detail:{...}}] }     // 滚动窗口（如 5 小时）
 */
function normalizeKimi(body) {
  const root = body !== null && typeof body === 'object' ? body : {};
  const windows = [];
  const push = (key, detail) => {
    if (detail === null || typeof detail !== 'object') return;
    const used = num(detail.used);
    const total = num(detail.limit);
    const percent = percentOf(used, total, num(detail.remaining)) ?? clampPercent(detail.percent);
    if (percent === undefined && total === undefined) return;
    windows.push({ key, percent, resetsAt: resetEpoch(detail.resetTime), used, total });
  };
  push('week', root.usage);
  const limits = Array.isArray(root.limits) ? root.limits : [];
  for (const entry of limits) {
    if (entry === null || typeof entry !== 'object') continue;
    const info = entry.window !== null && typeof entry.window === 'object' ? entry.window : {};
    const duration = num(info.duration) ?? 0;
    const unit = String(info.timeUnit ?? '').toUpperCase();
    const hours = unit.includes('MINUTE') ? duration / 60 : unit.includes('HOUR') ? duration : unit.includes('DAY') ? duration * 24 : duration;
    const key = Math.abs(hours - 5) < 0.6 ? 'h5' : hours >= 24 * 6 ? 'week' : 'other';
    if (windows.some((row) => row.key === key)) continue;
    push(key, entry.detail ?? entry);
  }
  const order = { h5: 0, week: 1, other: 2 };
  windows.sort((a, b) => (order[a.key] ?? 9) - (order[b.key] ?? 9));
  const level = root.user?.membership?.level;
  return {
    ok: true,
    fetchedAt: Date.now(),
    level: typeof level === 'string' ? level.replace(/^LEVEL_/, '').toLowerCase() : undefined,
    windows,
  };
}

/**
 * 小米 Token 套餐：GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage
 * 认证是浏览器 SSO Cookie（tp- 开头的 API Key 查不了），Cookie 通过
 * XIAOMI_MIMO_SESSION_COOKIE 提供。
 * 形状：{ code:0, data:{ usage:{items:[{name:'plan_total_token',used,limit,percent},
 *        {name:'compensation_total_token',...}]}, monthUsage:{items:[{name:'month_total_token',...}]} } }
 */
function normalizeXiaomi(body) {
  const root = body !== null && typeof body === 'object' ? body : {};
  const data = root.data !== null && typeof root.data === 'object' ? root.data : {};
  const itemsOf = (group) => (group !== null && typeof group === 'object' && Array.isArray(group.items) ? group.items : []);
  const windows = [];
  const add = (key, item) => {
    if (item === null || typeof item !== 'object') return;
    const used = num(item.used);
    const total = num(item.limit);
    let percent = percentOf(used, total);
    if (percent === undefined) {
      const raw = num(item.percent);
      if (raw !== undefined) percent = clampPercent(raw > 0 && raw <= 1 ? raw * 100 : raw);
    }
    if (percent === undefined && total === undefined) return;
    windows.push({ key, percent, used, total });
  };
  const planItems = itemsOf(data.usage);
  add('plan', planItems.find((row) => row?.name === 'plan_total_token'));
  add('compensation', planItems.find((row) => row?.name === 'compensation_total_token'));
  add('month', itemsOf(data.monthUsage).find((row) => row?.name === 'month_total_token'));
  return { ok: true, fetchedAt: Date.now(), windows };
}

/** 模型 provider → 额度来源。 */
const PROVIDER_SOURCES = {
  'zai-coding-cn': 'zhipu',
  zai: 'zhipu',
  'opencode-go': 'opencode',
  opencode: 'opencode',
  'kimi-coding': 'kimi',
  kimi: 'kimi',
  'xiaomi-token-plan-cn': 'xiaomi',
  'xiaomi-token-plan-ams': 'xiaomi',
  'xiaomi-token-plan-sgp': 'xiaomi',
  xiaomi: 'xiaomi',
};

/** 上游额度源：路由、地址、凭据引用与归一化函数。 */
const SOURCES = {
  zhipu: {
    route: '/quota/zhipu',
    baseUrl: 'https://open.bigmodel.cn',
    path: '/api/monitor/usage/quota/limit',
    credentialRef: 'ZAI_CODING_CN_API_KEY',
    validate: (body) => body !== null && typeof body === 'object' && body.success === true,
    normalize: normalizeZhipu,
  },
  opencode: {
    route: '/quota/opencode',
    baseUrl: 'https://opencode.ai',
    path: '/zen/go/v1/usage',
    credentialRef: 'OPENCODE_GO_API_KEY',
    normalize: normalizeOpencode,
  },
  kimi: {
    route: '/quota/kimi',
    baseUrl: 'https://api.kimi.com',
    path: '/coding/v1/usages',
    credentialRef: 'KIMI_API_KEY',
    /** 优先用 DSH 里 Kimi OAuth 登录存的 access token，其次 KIMI_API_KEY。 */
    readSecret: async (ctx) => {
      try {
        const credentials = ctx.get('credentials');
        if (credentials === undefined || typeof credentials.readRecord !== 'function') return undefined;
        const record = await credentials.readRecord('llm-pi-ai/kimi-coding');
        const payload = record !== null && typeof record === 'object' ? record.payload : undefined;
        const token = payload?.access ?? payload?.accessToken ?? payload?.token;
        return typeof token === 'string' && token.length > 0 ? token : undefined;
      } catch {
        return undefined;
      }
    },
    headers: (key) => ({ authorization: `Bearer ${key}`, accept: 'application/json', 'user-agent': 'KimiCLI/1.5' }),
    normalize: normalizeKimi,
  },
  xiaomi: {
    route: '/quota/xiaomi',
    baseUrl: 'https://platform.xiaomimimo.com',
    path: '/api/v1/tokenPlan/usage',
    credentialRef: 'XIAOMI_MIMO_SESSION_COOKIE',
    headers: (key) => ({
      cookie: key,
      accept: 'application/json',
      referer: 'https://platform.xiaomimimo.com/console/plan-manage',
    }),
    validate: (body) => body !== null && typeof body === 'object' && body.code === 0,
    normalize: normalizeXiaomi,
  },
};

// ---------- Token 用量统计 ----------
//
// 数据来源：本机会话日志 $DSH_HOME/sessions/<工作区>/<会话>/session*.jsonl(.zstd)。
// 每个 assistant/message 事件带 data.usage（inputTokens / outputTokens /
// totalTokens / cacheReadTokens）与事件时间；按本地自然日聚合，不联网、不上传。

/** zstd 帧魔数（小端 28 b5 2f fd）：会话日志由多帧首尾拼接，需逐帧解压。 */
const ZSTD_MAGIC = [0x28, 0xb5, 0x2f, 0xfd];
const DAY_MS = 86_400_000;
/** 区间定义：today=今天，7d=最近 7 个自然日，30d=最近 30 个自然日。 */
const TOKEN_RANGES = { today: 1, '7d': 7, '30d': 30 };
const TOKEN_CACHE_MS = 60_000;

/** Node 的一次性 zstd API 只解一帧，所以按魔数切帧后分别解压。 */
function decodeZstdFrames(buffer) {
  const pieces = [];
  let start = -1;
  for (let index = 0; index + 4 <= buffer.length; index += 1) {
    if (buffer[index] === ZSTD_MAGIC[0] && buffer[index + 1] === ZSTD_MAGIC[1] && buffer[index + 2] === ZSTD_MAGIC[2] && buffer[index + 3] === ZSTD_MAGIC[3]) {
      if (start >= 0) pieces.push(zlib.zstdDecompressSync(buffer.subarray(start, index)));
      start = index;
      index += 3;
    }
  }
  if (start >= 0) pieces.push(zlib.zstdDecompressSync(buffer.subarray(start)));
  return pieces;
}

function localDayStart(time) {
  const date = new Date(time);
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

function dayKeyOf(dayStart) {
  const date = new Date(dayStart);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

/** 递归列出会话日志文件（只认 jsonl / jsonl.zstd）。 */
async function listSessionLogs(root) {
  const logs = [];
  const walk = async (dir) => {
    let entries;
    try {
      entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = nodePath.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.name.endsWith('.jsonl.zstd') && !entry.name.endsWith('.jsonl')) continue;
      try {
        const stats = await fs.promises.stat(full);
        logs.push({ path: full, mtimeMs: stats.mtimeMs, size: stats.size });
      } catch {
        /* 读取竞态：跳过 */
      }
    }
  };
  await walk(root);
  return logs;
}

/** 单文件 usage 事件缓存：按 mtime+size 判断是否需要重读。 */
const tokenEventCache = new Map();

async function readFileUsageEvents(log) {
  const signature = `${Math.round(log.mtimeMs)}:${log.size}`;
  const cached = tokenEventCache.get(log.path);
  if (cached !== undefined && cached.signature === signature) return cached.events;
  let raw;
  try {
    raw = await fs.promises.readFile(log.path);
  } catch {
    tokenEventCache.set(log.path, { signature, events: [] });
    return [];
  }
  let chunks;
  try {
    chunks = log.path.endsWith('.zstd') ? decodeZstdFrames(raw) : [raw];
  } catch {
    chunks = [];
  }
  const events = [];
  // 一次记录可能跨 zstd 帧：按帧解压后拼成一个字节流再按行切，末行不完整（可能正在写）先丢掉。
  let pending = '';
  const consume = (text, final) => {
    const rows = (pending + text).split('\n');
    pending = final ? '' : rows.pop();
    for (const line of rows) {
      if (!line.includes('"usage"')) continue;
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      const usage = event !== null && typeof event === 'object' ? event.data?.usage : undefined;
      if (event?.type !== 'assistant/message' || usage === null || typeof usage !== 'object' || typeof event.time !== 'number') continue;
      const input = num(usage.inputTokens) ?? 0;
      const output = num(usage.outputTokens) ?? 0;
      const cacheRead = num(usage.cacheReadTokens) ?? 0;
      events.push({ time: event.time, input, output, cacheRead, total: num(usage.totalTokens) ?? input + output + cacheRead });
    }
  };
  for (let index = 0; index < chunks.length; index += 1) consume(chunks[index].toString('utf8'), index === chunks.length - 1);
  if (pending.length === 0 && chunks.length === 0) pending = '';
  tokenEventCache.set(log.path, { signature, events });
  return events;
}

/** 按区间聚合 Token 用量；导出让测试可以直接调用。 */
export async function collectTokenUsage({ home, range = '7d', now = Date.now() } = {}) {
  const days = TOKEN_RANGES[range] ?? TOKEN_RANGES['7d'];
  const todayStart = localDayStart(now);
  const from = todayStart - (days - 1) * DAY_MS;
  const buckets = new Map();
  const logs = await listSessionLogs(nodePath.join(home ?? '', 'sessions'));
  let scannedFiles = 0;
  for (const log of logs) {
    // 最后写入早于区间起点 → 区间内不可能有事件，直接跳过。
    if (log.mtimeMs < from) continue;
    scannedFiles += 1;
    for (const event of await readFileUsageEvents(log)) {
      if (event.time < from || event.time > now) continue;
      const key = dayKeyOf(localDayStart(event.time));
      const bucket = buckets.get(key) ?? { day: key, input: 0, output: 0, cacheRead: 0, total: 0, requests: 0 };
      bucket.input += event.input;
      bucket.output += event.output;
      bucket.cacheRead += event.cacheRead;
      bucket.total += event.total;
      bucket.requests += 1;
      buckets.set(key, bucket);
    }
  }
  const daily = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    const key = dayKeyOf(todayStart - back * DAY_MS);
    daily.push(buckets.get(key) ?? { day: key, input: 0, output: 0, cacheRead: 0, total: 0, requests: 0 });
  }
  const totals = { input: 0, output: 0, cacheRead: 0, total: 0, requests: 0 };
  for (const item of daily) {
    totals.input += item.input;
    totals.output += item.output;
    totals.cacheRead += item.cacheRead;
    totals.total += item.total;
    totals.requests += item.requests;
  }
  const promptTokens = totals.total - totals.output;
  const cacheHit = promptTokens > 0 ? Math.round((totals.cacheRead / promptTokens) * 1000) / 10 : null;
  return {
    ok: true,
    range,
    days,
    from,
    to: now,
    generatedAt: Date.now(),
    scannedFiles,
    totals: { ...totals, cacheHit },
    daily,
  };
}

/** $DSH_HOME 解析：插件 config.home > 环境变量 > ~/.dsh。 */
function resolveHome(config) {
  if (config !== null && typeof config === 'object' && typeof config.home === 'string' && config.home.length > 0) return config.home;
  const fromEnv = process.env.DSH_HOME;
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv;
  return nodePath.join(os.homedir(), '.dsh');
}

/** 区间结果缓存（60s）+ 在途去重。 */
const tokenCache = new Map();
const tokenInflight = new Map();

/** 本机回环 + 同源兜底校验：没有 DSH 登录服务时只放行本机页面。 */
function fallbackRejection(req) {
  const address = req.socket?.remoteAddress ?? '';
  if (!LOOPBACK_IP.test(address)) return 403;
  if (!LOOPBACK_HOST.test(req.headers.host ?? '')) return 403;
  const origin = req.headers.origin;
  if (origin === undefined) return undefined;
  try {
    const host = new URL(origin).hostname;
    return LOOPBACK_HOST.test(host) ? undefined : 403;
  } catch {
    return 403;
  }
}

export function apply(ctx, config = {}) {
  const connection = () => {
    try {
      return ctx.get('connection');
    } catch {
      return undefined;
    }
  };

  /** 每个源一套缓存 + 在途请求，互不影响。 */
  const readers = Object.entries(SOURCES).map(([id, source]) => {
    const override = config.sources !== undefined && config.sources !== null && typeof config.sources[id] === 'object' ? config.sources[id] : {};
    const baseUrl = (typeof override.baseUrl === 'string' && override.baseUrl ? override.baseUrl : source.baseUrl).replace(/\/+$/, '');
    const credentialRef = typeof override.credentialRef === 'string' && override.credentialRef ? override.credentialRef : source.credentialRef;
    /** @type {{ at: number, payload: object } | null} */
    let cache = null;
    let inflight = null;

    /** 读凭据；凭据服务优先（与 Models 页写入的是同一份），没有就退回环境变量。 */
    const readKey = async () => {
      if (typeof source.readSecret === 'function') {
        try {
          const secret = await source.readSecret(ctx);
          if (typeof secret === 'string' && secret.length > 0) return secret;
        } catch {
          /* 记录读取失败时回落到 ref / 环境变量 */
        }
      }
      let credentials;
      try {
        credentials = ctx.get('credentials');
      } catch {
        credentials = undefined;
      }
      if (credentials !== undefined && typeof credentials.resolve === 'function') {
        try {
          const hit = await credentials.resolve(credentialRef);
          if (hit !== undefined && typeof hit.value === 'string' && hit.value.length > 0) return hit.value;
        } catch {
          /* 凭据服务异常时继续走环境变量 */
        }
      }
      const env = process.env[credentialRef];
      return typeof env === 'string' && env.length > 0 ? env : undefined;
    };

    const query = async () => {
      const key = await readKey();
      if (key === undefined) return { ok: false, error: 'missing-credential', credentialRef };
      let response;
      try {
        response = await fetch(`${baseUrl}${source.path}`, {
          method: 'GET',
          headers: typeof source.headers === 'function' ? source.headers(key) : { authorization: `Bearer ${key}`, accept: 'application/json' },
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
      } catch (error) {
        return { ok: false, error: 'network', detail: String(error?.message ?? error) };
      }
      if (!response.ok) return { ok: false, error: 'http', status: response.status };
      let body;
      try {
        body = await response.json();
      } catch {
        return { ok: false, error: 'parse' };
      }
      // 成功标志各家不同：智谱 {success:true}、小米 {code:0}、Kimi/OpenCode 直接给数据。
      if (typeof source.validate === 'function' && !source.validate(body)) {
        return {
          ok: false,
          error: 'upstream',
          code: body !== null && typeof body === 'object' ? (body.code ?? body.message) : undefined,
        };
      }
      try {
        return source.normalize(body);
      } catch (error) {
        return { ok: false, error: 'parse', detail: String(error?.message ?? error) };
      }
    };

    /** 带缓存取数：并发请求共用一个在途 Promise。 */
    const snapshot = async () => {
      const now = Date.now();
      if (cache !== null && now - cache.at < (cache.payload.ok ? CACHE_OK_MS : CACHE_FAIL_MS)) return cache.payload;
      if (inflight !== null) return inflight;
      inflight = (async () => {
        try {
          const payload = await query();
          cache = { at: Date.now(), payload };
          return payload;
        } finally {
          inflight = null;
        }
      })();
      return inflight;
    };

    return { route: source.route, snapshot };
  });

  /** 当前模型选择 → 额度来源。每次切换模型 DSH 都会更新 agentDefaultModel。 */
  const resolveActive = () => {
    let selection;
    try {
      const model = ctx.get('agentDefaultModel');
      if (model !== undefined && typeof model.currentSelection === 'function') selection = model.currentSelection();
    } catch {
      selection = undefined;
    }
    const provider = selection !== undefined && typeof selection.provider === 'string' ? selection.provider : undefined;
    const source = provider === undefined ? undefined : PROVIDER_SOURCES[provider];
    return {
      ok: true,
      provider,
      model: selection !== undefined && typeof selection.model === 'string' ? selection.model : undefined,
      source: source ?? null,
    };
  };

  for (const reader of readers) {
    const handler = async (req, res) => {
      const send = (code, payload) => {
        res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
        res.end(JSON.stringify(payload));
      };
      if (req.method !== 'GET') return send(405, { ok: false, error: 'method-not-allowed' });
      const conn = connection();
      const rejection = conn !== undefined && typeof conn.requestRejection === 'function' ? conn.requestRejection(req) : fallbackRejection(req);
      if (rejection !== undefined) return send(rejection === 401 ? 401 : rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' });
      let payload;
      try {
        payload = await reader.snapshot();
      } catch (error) {
        payload = { ok: false, error: 'internal', detail: String(error?.message ?? error) };
      }
      return send(200, payload);
    };
    ctx.effect(() => ctx.webServer.register({
      kind: 'exact',
      path: reader.route,
      handler,
    }), `dsh-quota: ${reader.route}`);
  }

  const activeHandler = (req, res) => {
    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== 'GET') return send(405, { ok: false, error: 'method-not-allowed' });
    const conn = connection();
    const rejection = conn !== undefined && typeof conn.requestRejection === 'function' ? conn.requestRejection(req) : fallbackRejection(req);
    if (rejection !== undefined) return send(rejection === 401 ? 401 : rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' });
    return send(200, resolveActive());
  };
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/quota/active',
    handler: activeHandler,
  }), 'dsh-quota: /quota/active');

  // 界面偏好：插件行 config.indicator 可设默认值（bar | ring），客户端可在面板里临时切换。
  const indicator = config.indicator === 'ring' ? 'ring' : 'bar';
  const configHandler = (req, res) => {
    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== 'GET') return send(405, { ok: false, error: 'method-not-allowed' });
    const conn = connection();
    const rejection = conn !== undefined && typeof conn.requestRejection === 'function' ? conn.requestRejection(req) : fallbackRejection(req);
    if (rejection !== undefined) return send(rejection === 401 ? 401 : rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' });
    return send(200, { ok: true, indicator });
  };
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/quota/config',
    handler: configHandler,
  }), 'dsh-quota: /quota/config');

  // Token 用量：读本机会话日志聚合，按区间缓存 60s。
  const tokenHandler = async (req, res) => {
    const send = (code, payload) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
      res.end(JSON.stringify(payload));
    };
    if (req.method !== 'GET') return send(405, { ok: false, error: 'method-not-allowed' });
    const conn = connection();
    const rejection = conn !== undefined && typeof conn.requestRejection === 'function' ? conn.requestRejection(req) : fallbackRejection(req);
    if (rejection !== undefined) return send(rejection === 401 ? 401 : rejection, { ok: false, error: rejection === 401 ? 'unauthorized' : 'forbidden' });
    let range = '7d';
    try {
      range = new URL(req.url ?? '/', 'http://dsh.invalid').searchParams.get('range') ?? '7d';
    } catch {
      range = '7d';
    }
    if (!Object.prototype.hasOwnProperty.call(TOKEN_RANGES, range)) return send(400, { ok: false, error: 'bad-range' });
    const now = Date.now();
    const cached = tokenCache.get(range);
    if (cached !== undefined && now - cached.at < TOKEN_CACHE_MS) return send(200, cached.payload);
    let pending = tokenInflight.get(range);
    if (pending === undefined) {
      pending = collectTokenUsage({ home: resolveHome(config), range })
        .then((payload) => {
          tokenCache.set(range, { at: Date.now(), payload });
          return payload;
        })
        .catch((error) => ({ ok: false, error: 'internal', detail: String(error?.message ?? error) }))
        .finally(() => tokenInflight.delete(range));
      tokenInflight.set(range, pending);
    }
    return send(200, await pending);
  };
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: '/quota/tokens',
    handler: tokenHandler,
  }), 'dsh-quota: /quota/tokens');
}
