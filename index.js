/**
 * 套餐额度状态栏插件 —— 宿主侧（支持智谱 GLM 与 OpenCode Go）。
 *
 * 输入框下方的状态栏（conversation.composer.dock）由 client.js 渲染；
 * 它轮询本插件在 DSH webServer 上挂的两个路由取数：
 *
 *   GET /quota/active    当前模型对应的额度来源（跟随模型选择切换）
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

/** 模型 provider → 额度来源。 */
const PROVIDER_SOURCES = {
  'zai-coding-cn': 'zhipu',
  'zai': 'zhipu',
  'opencode-go': 'opencode',
  'opencode': 'opencode',
};

/** 上游额度源：路由、地址、凭据引用与归一化函数。 */
const SOURCES = {
  zhipu: {
    route: '/quota/zhipu',
    baseUrl: 'https://open.bigmodel.cn',
    path: '/api/monitor/usage/quota/limit',
    credentialRef: 'ZAI_CODING_CN_API_KEY',
    normalize: normalizeZhipu,
  },
  opencode: {
    route: '/quota/opencode',
    baseUrl: 'https://opencode.ai',
    path: '/zen/go/v1/usage',
    credentialRef: 'OPENCODE_GO_API_KEY',
    normalize: normalizeOpencode,
  },
};

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
          headers: { authorization: `Bearer ${key}`, accept: 'application/json' },
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
      // 智谱用 {code:200, success:true}；OpenCode 直接返回 {usage:{...}}。
      if (id === 'zhipu' && (body === null || typeof body !== 'object' || body.success !== true)) {
        return { ok: false, error: 'upstream', code: body !== null && typeof body === 'object' ? body.code : undefined };
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
}
