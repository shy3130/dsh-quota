/**
 * 套餐额度状态栏 —— 浏览器侧（智谱 GLM / OpenCode Go 自动切换）。
 *
 * 在输入框下方的统计栏（conversation.composer.dock）右端加一枚可点击的额度徽标：
 *
 *   GLM 5小时 19% ▰▰ · 本周 6% ▰        ← 当前模型在智谱
 *   OpenCode 滚动 6% ▰▰ · 本周 2% ▰     ← 当前模型在 OpenCode Go
 *
 * 徽标显示哪一家，由宿主侧 GET /quota/active 决定：它读取 DSH 的
 * "当前默认模型选择"（每次切换模型都会更新），把 provider 映射到额度来源。
 * 数据来自对应来源的路由（/quota/zhipu、/quota/opencode）。
 *
 * 点击弹出明细面板（样式对齐官方「上下文已用」面板）：各窗口的已用、剩余、
 * 重置时间（倒计时用 <1m / 42m / 3h 24m / 6d 21h），工具额度与分项明细。
 */
window.__ModuleLoader__.load({
  id: '@local/dsh-quota',
  factory(require) {
    const React = require('react');
    const ReactDOM = (() => {
      try {
        return require('react-dom');
      } catch {
        return null;
      }
    })();
    const h = React.createElement;
    const { useEffect, useState, useRef } = React;

    const NS = '@local/dsh-quota';
    const ACTIVE_ROUTE = '/quota/active';
    /** 当前模型所属厂商的检查间隔：宿主只读内存，1s 一次开销可忽略。 */
    const ACTIVE_POLL_MS = 1_000;

    /** 设置文档变化（含模型选择保存）→ 通知所有徽标立刻重新取数。 */
    const refreshListeners = new Set();
    function notifyRefresh() {
      for (const listener of refreshListeners) {
        try {
          listener();
        } catch {
          /* 单个监听器失败不影响其他实例 */
        }
      }
    }
    /** 同一来源的额度刷新间隔（宿主侧还有 55s 缓存）。 */
    const QUOTA_TTL_MS = 55_000;

    /**
     * 徽标贴右端：dock 是居中 flex 行，`margin-left:auto` 会吸收空白把自己推到最右。
     * 官方「上下文已用」是紧随 slot 内容的兄弟节点，不带 auto 外边距时会被一起拖到右边，
     * 所以同时用 `order:1` 把徽标排到它之后——上下文计量留在左侧统计群里。
     */
    const ALIGN_RIGHT = true;

    /** 两家额度来源的展示配置。 */
    const SOURCES = {
      zhipu: {
        route: '/quota/zhipu',
        brand: 'GLM',
        titleKey: 'titleZhipu',
        pillKeys: ['h5', 'week'],
        shortLabels: { h5: '5h', week: '周' },
      },
      opencode: {
        route: '/quota/opencode',
        brand: 'OpenCode',
        titleKey: 'titleOpencode',
        pillKeys: ['rolling', 'week', 'month'],
        /** 三个窗口挤在徽标里，用最短标签：5h / 周 / 月。 */
        shortLabels: { rolling: '5h', week: '周', month: '月' },
      },
      kimi: {
        route: '/quota/kimi',
        brand: 'Kimi',
        titleKey: 'titleKimi',
        pillKeys: ['h5', 'week'],
        shortLabels: { h5: '5h', week: '周' },
      },
      xiaomi: {
        route: '/quota/xiaomi',
        brand: '小米',
        titleKey: 'titleXiaomi',
        pillKeys: ['plan', 'month'],
        shortLabels: { plan: '套餐', month: '月' },
      },
    };

    const zh = {
      loading: '…',
      unavailable: '不可用',
      noCredential: '未配置 Key',
      window5h: '5小时',
      windowRolling: '5小时',
      windowWeek: '本周',
      windowMonth: '本月',
      windowPlan: '套餐',
      windowCompensation: '补偿',
      windowOther: '其他',
      titleZhipu: 'GLM 套餐额度',
      titleOpencode: 'OpenCode 套餐额度',
      title5h: '5 小时额度',
      titleRolling: '5 小时额度',
      titleWeek: '本周额度',
      titleMonth: '本月额度',
      titlePlan: '套餐额度',
      titleCompensation: '补偿额度',
      titleKimi: 'Kimi 套餐额度',
      titleXiaomi: '小米套餐额度',
      titleTools: '本月工具额度',
      used: '已用',
      remain: '剩余',
      reset: '重置',
      plan: '套餐',
      updated: '更新于',
      every60: '每 60 秒刷新',
      loadingPanel: '正在获取额度…',
      network: '网络不通',
      http: '接口异常',
      upstream: '接口拒绝',
      inDuration: '{d}',
    };
    const en = {
      loading: '…',
      unavailable: 'unavailable',
      noCredential: 'no key',
      window5h: '5h',
      windowRolling: '5h',
      windowWeek: 'week',
      windowMonth: 'month',
      windowPlan: 'plan',
      windowCompensation: 'bonus',
      windowOther: 'other',
      titleZhipu: 'GLM plan usage',
      titleOpencode: 'OpenCode plan usage',
      title5h: '5-hour quota',
      titleRolling: '5-hour quota',
      titleWeek: 'Weekly quota',
      titleMonth: 'Monthly quota',
      titlePlan: 'Plan quota',
      titleCompensation: 'Bonus quota',
      titleKimi: 'Kimi plan usage',
      titleXiaomi: 'Xiaomi plan usage',
      titleTools: 'Monthly tool quota',
      used: 'used',
      remain: 'left',
      reset: 'resets',
      plan: 'Plan',
      updated: 'updated',
      every60: 'refreshes every 60s',
      loadingPanel: 'Loading usage…',
      network: 'network error',
      http: 'bad response',
      upstream: 'rejected',
      inDuration: '{d}',
    };

    /** 套餐等级的中文名：接口返回 max / pro / lite 这类枚举。 */
    const LEVEL_ZH = { max: '最高', pro: '专业', lite: '轻量', free: '免费', none: '无' };

    /** 工具额度的分项名：接口返回 search-prime / web-reader / zread 这类编码。 */
    const TOOL_ZH = {
      'search-prime': '联网搜索',
      'web-reader': '网页阅读',
      zread: '文档阅读',
      search: '联网搜索',
      reader: '网页阅读',
    };

    // 尺寸/间距沿用官方统计徽标与上下文计量面板的规格。
    const CSS = [
      '.zq-anchor{flex:none;display:inline-flex;position:relative}',
      '.zq-anchor[data-align=end]{margin-left:auto;order:1}',
      '.zq-pill{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;flex:none;align-items:center;gap:6px;padding:1px 8px;display:inline-flex}',
      '.zq-pill:hover,.zq-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.zq-pill:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
      '.zq-part{display:inline-flex;align-items:center;gap:5px}',
      '.zq-bar{flex:none;width:26px;height:5px;border-radius:3px;background:var(--dsw-alias-border-l2,#dde1e7);overflow:hidden;display:inline-block}',
      '.zq-bar-fill{display:block;height:100%;border-radius:3px;min-width:4px}',
      '.zq-sep{color:var(--dsw-alias-separator-primary);margin:0 1px}',
      // —— 弹出面板（对齐 ContextMeter 面板） ——
      '.zp-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:min(264px,100vw - 24px);backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:10px 11px;font-size:12px;line-height:18px;position:fixed}',
      '.zp-head{align-items:center;gap:8px;display:flex}',
      '.zp-title{color:var(--dsw-alias-label-primary);font-weight:500}',
      '.zp-badge{margin-left:auto;color:var(--dsw-alias-label-tertiary)}',
      '.zp-rule{background:var(--dsw-alias-border-l1);height:.5px;margin:8px 0 6px;border:0}',
      '.zp-sec{margin-bottom:8px}',
      '.zp-sec:last-of-type{margin-bottom:0}',
      '.zp-row{align-items:baseline;justify-content:space-between;gap:12px;display:flex}',
      '.zp-label{color:var(--dsw-alias-label-secondary)}',
      '.zp-value{color:var(--dsw-alias-label-primary);font-variant-numeric:tabular-nums;font-weight:500;margin-left:auto}',
      '.zp-meter{background:var(--dsw-alias-interactive-bg-hover);border-radius:999px;height:3px;margin:4px 0 3px;display:flex;overflow:hidden}',
      '.zp-meter i{display:block;height:100%;border-radius:1px}',
      '.zp-sub{color:var(--dsw-alias-label-tertiary);display:flex;gap:6px;flex-wrap:wrap}',
      '.zp-sub b{color:var(--dsw-alias-label-secondary);font-weight:400;font-variant-numeric:tabular-nums}',
      '.zp-detail{margin:3px 0 0;color:var(--dsw-alias-label-tertiary);display:flex;flex-wrap:wrap;gap:2px 8px;font-variant-numeric:tabular-nums}',
      '.zp-foot{border-top:.5px solid var(--dsw-alias-border-l1);margin-top:8px;padding-top:6px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-caption,#8a8f98);display:flex;justify-content:space-between;gap:8px}',
      '.zp-empty{color:var(--dsw-alias-label-tertiary)}',
    ].join('');

    /** 按当前界面语言取词典。 */
    function pickLang() {
      const raw = (typeof document !== 'undefined' && document.documentElement.lang) || (typeof navigator !== 'undefined' && navigator.language) || 'zh';
      return String(raw).toLowerCase().startsWith('zh') ? 'zh' : 'en';
    }

    /** 回退翻译：没有 locale 服务时使用内置词典，并支持 {n} 插值。 */
    function fallbackTranslate(key, params) {
      const template = (pickLang() === 'zh' ? zh : en)[key] ?? key;
      if (params === undefined) return template;
      return template.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match));
    }

    /** 把 React 元素树里的可见文字摊平成字符串，供 aria-label 使用。 */
    function flattenText(node, out = []) {
      if (node === null || node === undefined || node === false) return out;
      if (typeof node === 'string' || typeof node === 'number') {
        out.push(String(node));
        return out;
      }
      if (Array.isArray(node)) {
        for (const child of node) flattenText(child, out);
        return out;
      }
      if (typeof node === 'object' && node.props !== undefined) return flattenText(node.props.children, out);
      return out;
    }

    /** 大数字紧凑显示：中文用 万 / 亿，英文用 K / M / B。 */
    function formatCount(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return String(value);
      const abs = Math.abs(n);
      const zh = pickLang() === 'zh';
      const trim = (text) => text.replace(/\.0$/, '');
      if (zh) {
        if (abs >= 1e8) return `${trim((n / 1e8).toFixed(1))}亿`;
        if (abs >= 1e4) return `${trim((n / 1e4).toFixed(abs >= 1e6 ? 0 : 1))}万`;
        return String(Math.round(n));
      }
      if (abs >= 1e9) return `${trim((n / 1e9).toFixed(1))}B`;
      if (abs >= 1e6) return `${trim((n / 1e6).toFixed(1))}M`;
      if (abs >= 1e3) return `${trim((n / 1e3).toFixed(1))}K`;
      return String(Math.round(n));
    }

    function formatClock(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return '--';
      try {
        const d = new Date(ms);
        const now = new Date();
        const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
        const hh = String(d.getHours()).padStart(2, '0');
        const mm = String(d.getMinutes()).padStart(2, '0');
        return sameDay ? `${hh}:${mm}` : `${d.getMonth() + 1}/${d.getDate()} ${hh}:${mm}`;
      } catch {
        return '--';
      }
    }

    /**
     * 距离重置还剩多久，用日期时长的短单位（小写 d / h / m）：
     * 「42m」「3h 24m」「6d 21h」；整点省略分钟，整天省略小时，不足 1 分钟 <1m。
     */
    function formatCountdown(t, ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return undefined;
      const delta = ms - Date.now();
      if (delta <= 0) return undefined;
      const totalMinutes = Math.round(delta / 60000);
      let duration;
      if (totalMinutes < 1) duration = '<1m';
      else if (totalMinutes < 60) duration = `${totalMinutes}m`;
      else {
        const hours = Math.floor(totalMinutes / 60);
        const minutes = totalMinutes % 60;
        if (hours < 24) duration = minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
        else {
          const days = Math.floor(hours / 24);
          const restHours = hours % 24;
          duration = restHours === 0 ? `${days}d` : `${days}d ${restHours}h`;
        }
      }
      return t('inDuration', { d: duration });
    }

    /** 条的填充色：绿 / ≥70% 琥珀 / ≥90% 红。 */
    function barColor(percent) {
      if (typeof percent !== 'number') return 'var(--dsw-alias-label-tertiary)';
      if (percent >= 90) return 'var(--dsw-alias-state-error-primary, #d13438)';
      if (percent >= 70) return 'var(--dsw-alias-state-warning-primary, #c98a00)';
      return 'var(--dsw-alias-state-success-primary, #2ea043)';
    }

    /** 轨道色：同色低透明度浅染，低用量时整条也是"彩色量规"。 */
    function trackColor(percent) {
      return `color-mix(in srgb, ${barColor(percent)} 18%, transparent)`;
    }

    /** 窗口 key → 短标签。 */
    function winLabel(t, key) {
      if (key === 'h5') return t('window5h');
      if (key === 'rolling') return t('windowRolling');
      if (key === 'week') return t('windowWeek');
      if (key === 'month') return t('windowMonth');
      if (key === 'plan') return t('windowPlan');
      if (key === 'compensation') return t('windowCompensation');
      return t('windowOther');
    }

    /** 窗口 key → 面板里的标题。 */
    function winTitle(t, key) {
      if (key === 'h5') return t('title5h');
      if (key === 'rolling') return t('titleRolling');
      if (key === 'week') return t('titleWeek');
      if (key === 'month') return t('titleMonth');
      if (key === 'plan') return t('titlePlan');
      if (key === 'compensation') return t('titleCompensation');
      return t('windowOther');
    }

    /** 套餐等级：中文名优先，未知等级原样显示。 */
    function levelLabel(level) {
      if (typeof level !== 'string' || level.length === 0) return undefined;
      if (pickLang() === 'zh') return LEVEL_ZH[level.toLowerCase()] ?? level;
      return level;
    }

    /** 工具分项：中文名优先，未收录的编码原样显示。 */
    function toolLabel(code) {
      if (typeof code !== 'string') return String(code);
      if (pickLang() === 'zh') return TOOL_ZH[code] ?? code;
      return code;
    }

    /** 面板里的一个额度区块：标题 + 已用% + 彩条 + 剩余/重置。 */
    function MeterSection(t, win) {
      const percent = typeof win.percent === 'number' ? win.percent : undefined;
      const left = typeof percent === 'number' ? 100 - percent : undefined;
      const sub = [];
      if (left !== undefined) sub.push(h('span', { key: 'left' }, `${t('remain')} `, h('b', null, `${left}%`)));
      if (win.used !== undefined && win.total !== undefined) {
        sub.push(h('span', { key: 'counts' }, `${t('used')} `, h('b', null, `${formatCount(win.used)} / ${formatCount(win.total)}`)));
      }
      if (win.resetsAt !== undefined) {
        const countdown = formatCountdown(t, win.resetsAt);
        sub.push(h('span', { key: 'reset' }, `${t('reset')} `, h('b', null, formatClock(win.resetsAt)), countdown === undefined ? null : ` · ${countdown}`));
      }
      return h('section', { key: `sec-${win.key}`, className: 'zp-sec' }, [
        h('div', { key: 'row', className: 'zp-row' }, [
          h('span', { key: 'label', className: 'zp-label' }, winTitle(t, win.key)),
          h('span', { key: 'value', className: 'zp-value' }, `${t('used')} ${percent ?? '--'}%`),
        ]),
        h('div', { key: 'meter', className: 'zp-meter', role: 'presentation', 'aria-hidden': true },
          typeof percent === 'number' ? h('i', { key: 'fill', style: { width: `${percent}%`, background: barColor(percent) } }) : null),
        h('div', { key: 'sub', className: 'zp-sub' }, sub),
      ]);
    }

    /** 面板里的工具额度区块：696 / 4000 + 分项明细。 */
    function ToolsSection(t, tools) {
      const used = tools.used;
      const total = tools.total;
      const remaining = tools.remaining;
      const percent = typeof tools.percent === 'number' ? tools.percent : undefined;
      const countdown = formatCountdown(t, tools.resetsAt);
      const headline = used !== undefined && total !== undefined ? `${used} / ${total}` : percent === undefined ? '--' : `${percent}%`;
      const details = tools.details ?? [];
      return h('section', { key: 'sec-tools', className: 'zp-sec' }, [
        h('div', { key: 'row', className: 'zp-row' }, [
          h('span', { key: 'label', className: 'zp-label' }, t('titleTools')),
          h('span', { key: 'value', className: 'zp-value' }, headline),
        ]),
        h('div', { key: 'meter', className: 'zp-meter', role: 'presentation', 'aria-hidden': true },
          percent === undefined ? null : h('i', { key: 'fill', style: { width: `${percent}%`, background: barColor(percent) } })),
        h('div', { key: 'sub', className: 'zp-sub' }, [
          h('span', { key: 'used' }, `${t('used')} `, h('b', null, percent === undefined ? '--' : `${percent}%`)),
          remaining === undefined ? null : h('span', { key: 'left' }, `${t('remain')} `, h('b', null, String(remaining))),
          h('span', { key: 'reset' }, `${t('reset')} `, h('b', null, formatClock(tools.resetsAt)), countdown === undefined ? null : ` · ${countdown}`),
        ]),
        details.length === 0 ? null : h('div', { key: 'details', className: 'zp-detail' }, details.map((row) => h('span', { key: row.code }, `${toolLabel(row.code)} ${row.usage}`))),
      ]);
    }

    /** 面板内容：标题 + 套餐等级 + 各额度区块 + 更新时间。 */
    function buildPanel(t, source, state) {
      const config = SOURCES[source];
      const data = state.phase === 'ready' ? state.data : undefined;
      const level = data !== undefined && data.ok === true ? levelLabel(data.level) : undefined;
      const children = [
        h('div', { key: 'head', className: 'zp-head' }, [
          h('span', { key: 'title', className: 'zp-title' }, t(config.titleKey)),
          level === undefined ? null : h('span', { key: 'badge', className: 'zp-badge' }, `${t('plan')} ${level}`),
        ]),
        h('hr', { key: 'rule', className: 'zp-rule' }),
      ];
      if (data === undefined || data.ok !== true) {
        const reason = data !== undefined && data.error === 'missing-credential'
          ? t('noCredential')
          : data !== undefined && data.error === 'network'
            ? t('network')
            : data !== undefined && data.error === 'http'
              ? t('http')
              : data !== undefined && data.error === 'upstream'
                ? t('upstream')
                : t('loadingPanel');
        children.push(h('div', { key: 'empty', className: 'zp-empty' }, reason));
        return children;
      }
      for (const win of data.windows ?? []) children.push(MeterSection(t, win));
      if (data.tools !== undefined) children.push(ToolsSection(t, data.tools));
      children.push(h('div', { key: 'foot', className: 'zp-foot' }, [
        h('span', { key: 'upd' }, `${t('updated')} ${formatClock(data.fetchedAt)}`),
        h('span', { key: 'hint' }, t('every60')),
      ]));
      return children;
    }

    /** 一个额度窗口片段：标签 + 已用百分比 + 进度条（条在数字后面，填充=已用）。 */
    function Segment(t, win, shortLabels) {
      const percent = typeof win.percent === 'number' ? Math.max(0, Math.min(100, win.percent)) : undefined;
      const label = shortLabels !== undefined && shortLabels[win.key] !== undefined ? shortLabels[win.key] : winLabel(t, win.key);
      return h('span', { key: `seg-${win.key}`, className: 'zq-part' }, [
        h('span', { key: 'tag' }, label),
        h('span', { key: 'num' }, `${win.percent ?? '--'}%`),
        h('span', { key: 'bar', className: 'zq-bar', role: 'presentation', 'aria-hidden': true, style: { background: trackColor(percent) } },
          percent !== undefined && percent > 0
            ? h('span', { key: 'fill', className: 'zq-bar-fill', style: { width: `${percent}%`, background: barColor(percent) } })
            : null),
      ]);
    }

    /** pill 内文：按来源挑两个窗口显示。 */
    function buildContent(t, source, state) {
      if (state.phase === 'loading') return [h('span', { key: 'load' }, t('loading'))];
      const data = state.data;
      if (data === undefined || data.ok !== true) {
        const reason = data !== undefined && data.error === 'missing-credential' ? t('noCredential') : t('unavailable');
        return [h('span', { key: 'err' }, reason)];
      }
      const config = SOURCES[source];
      const windows = (data.windows ?? []).filter((win) => config.pillKeys.includes(win.key));
      const nodes = [];
      windows.forEach((win, index) => {
        if (index > 0) nodes.push(h('span', { key: `sep-${win.key}`, className: 'zq-sep', 'aria-hidden': true }, '·'));
        nodes.push(Segment(t, win, config.shortLabels));
      });
      return nodes;
    }

    function QuotaPill(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
      const [state, setState] = useState({ phase: 'loading' });
      const [source, setSource] = useState(null);
      const [hidden, setHidden] = useState(false);
      const [open, setOpen] = useState(false);
      const [pos, setPos] = useState(null);
      const rootRef = useRef(null);
      const panelRef = useRef(null);
      const alive = useRef(true);
      const memo = useRef({ source: null, at: 0 });

      useEffect(() => {
        alive.current = true;
        let timer;
        const lastSource = { current: undefined };
        const tick = async () => {
          try {
            const active = await fetch(ACTIVE_ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' }).then((res) => res.json());
            if (!alive.current) return;
            const next = active !== null && active.ok === true && typeof active.source === 'string' ? active.source : null;
            // 来源没变就不动 React 状态，避免每秒重渲染；配额到 55s 才刷新。
            if (next === lastSource.current) {
              if (next === null || Date.now() - memo.current.at <= QUOTA_TTL_MS) return;
              const data = await fetch(SOURCES[next].route, { headers: { accept: 'application/json' }, cache: 'no-store' }).then((res) => res.json());
              if (!alive.current) return;
              memo.current = { source: next, at: Date.now() };
              setState({ phase: 'ready', data });
              return;
            }
            lastSource.current = next;
            setSource(next);
            setHidden(next === null);
            if (next === null) {
              setState({ phase: 'hidden' });
              return;
            }
            // 换了厂商：立刻把旧数据换成新来源的额度（宿主对同一来源还有 55s 缓存）。
            setState({ phase: 'loading' });
            const data = await fetch(SOURCES[next].route, { headers: { accept: 'application/json' }, cache: 'no-store' }).then((res) => res.json());
            if (!alive.current) return;
            memo.current = { source: next, at: Date.now() };
            setState({ phase: 'ready', data });
          } catch {
            if (!alive.current) return;
            lastSource.current = null;
            memo.current = { source: null, at: 0 };
            setState({ phase: 'ready', data: { ok: false, error: 'network' } });
          }
        };
        const schedule = () => {
          clearInterval(timer);
          timer = setInterval(tick, ACTIVE_POLL_MS);
        };
        const onVisible = () => {
          if (document.visibilityState === 'visible') {
            tick();
            schedule();
          }
        };
        tick();
        schedule();
        document.addEventListener('visibilitychange', onVisible);
        // 模型选择一保存就立刻重新取数，不等下一次轮询。
        const trigger = () => {
          if (document.visibilityState !== 'hidden') tick();
        };
        refreshListeners.add(trigger);
        return () => {
          alive.current = false;
          clearInterval(timer);
          refreshListeners.delete(trigger);
          document.removeEventListener('visibilitychange', onVisible);
        };
      }, []);

      // 面板定位：贴在触发按钮上方，右边缘对齐。
      useEffect(() => {
        if (!open) return undefined;
        const place = () => {
          const el = rootRef.current;
          if (el === null) return;
          const rect = el.getBoundingClientRect();
          setPos({
            bottom: Math.max(12, window.innerHeight - rect.top + 8),
            right: Math.max(12, window.innerWidth - rect.right),
          });
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        return () => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
        };
      }, [open]);

      // 点外部 / Escape 关闭。
      useEffect(() => {
        if (!open) return undefined;
        const onDown = (event) => {
          if (rootRef.current !== null && rootRef.current.contains(event.target)) return;
          if (panelRef.current !== null && panelRef.current.contains(event.target)) return;
          setOpen(false);
        };
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false);
        };
        document.addEventListener('mousedown', onDown);
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDown);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);

      // 当前模型没有额度来源（例如官方 DeepSeek 账号）：不占位。
      if (hidden) return null;
      const useSource = source === null ? 'zhipu' : source;
      const config = SOURCES[useSource];
      const nodes = buildContent(t, useSource, state);
      const label = [config.brand, ...flattenText(nodes)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const panel = open && ReactDOM !== null
        ? ReactDOM.createPortal(
            h('div', {
              key: 'panel',
              ref: panelRef,
              className: 'zp-panel',
              role: 'dialog',
              'aria-label': t(config.titleKey),
              style: pos === null ? { visibility: 'hidden' } : { bottom: pos.bottom, right: pos.right },
            }, buildPanel(t, useSource, state)),
            document.body,
          )
        : null;
      return h('span', {
        ref: rootRef,
        className: 'zq-anchor',
        'data-align': ALIGN_RIGHT ? 'end' : 'start',
        'data-composer-stat': 'dsh-quota',
      }, [
        h('style', { key: 'css' }, CSS),
        h('button', {
          key: 'pill',
          type: 'button',
          className: 'zq-pill',
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          'aria-label': label,
          onClick: () => setOpen((value) => !value),
        }, [
          h('span', { key: 'brand' }, config.brand),
          ...nodes,
        ]),
        panel,
      ]);
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const t = ctx.locale !== undefined && typeof ctx.locale.bind === 'function' ? ctx.locale.bind(NS) : fallbackTranslate;
        if (ctx.locale !== undefined && typeof ctx.locale.register === 'function') {
          ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'dsh-quota: 词典');
        }
        // 订阅设置文档更新（模型选择保存会走这条链路），做 120ms 去抖。
        let remote;
        try {
          remote = typeof ctx.get === 'function' ? ctx.get('remote') : ctx.remote;
        } catch {
          remote = undefined;
        }
        if (remote !== undefined && typeof remote.$on === 'function') {
          ctx.effect(() => {
            let debounce;
            const off = remote.$on('settings/document-updated', () => {
              clearTimeout(debounce);
              debounce = setTimeout(notifyRefresh, 120);
            });
            return () => {
              clearTimeout(debounce);
              if (typeof off === 'function') off();
            };
          }, 'dsh-quota: 设置变更刷新');
        }
        const reg = () => ctx.slots.register({
          name: 'conversation.composer.dock',
          id: 'dsh-quota',
          order: 2,
          locale: NS,
          inject: () => ({ t }),
        }, QuotaPill);
        ctx.effect(() => (typeof ctx.slots.inject === 'function' ? ctx.slots.inject('conversation.composer.dock', reg) : reg()), 'dsh-quota: 状态栏');
      },
    };
  },
});
