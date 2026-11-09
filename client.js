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
  id: '@wshylabs/dsh-quota',
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

    const NS = '@wshylabs/dsh-quota';
    const ACTIVE_ROUTE = '/quota/active';
    const CONFIG_ROUTE = '/quota/config';
    const TOKENS_ROUTE = '/quota/tokens';
    /** Token 统计区间：今日 / 最近 7 天 / 最近 30 天。 */
    const TOKEN_RANGES = ['today', '7d', '30d'];
    const TOKEN_TTL_MS = 60_000;
    /** 指示器形态偏好存本地：柱状条 / 环状条。 */
    const INDICATOR_KEY = 'dsh-quota:indicator';
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
      deepseek: {
        route: '/quota/deepseek',
        brand: 'DeepSeek',
        pillKeys: ['balance', 'today'],
        shortLabels: { balance: '余额', today: '今日' },
        titleKey: 'titleDeepseek',
        tokenProvider: 'deepseek',
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
      titleOpencode: 'OpenCode Go 套餐额度',
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
      indicator: '指示器',
      indicatorBar: '柱状',
      indicatorRing: '环状',
      tokensTitle: 'Token 用量',
      tokensToday: '今日',
      tokens7d: '7 天',
      tokens30d: '30 天',
      tokensTotal: '总量',
      tokensInput: '输入',
      tokensOutput: '输出',
      tokensCache: '缓存',
      tokensRequests: '{n} 次请求',
      tokensLoading: '统计中…',
      tokensEmpty: '暂无记录',
      titleDeepseek: 'DeepSeek 余额与消耗',
      dsBalance: '账户余额',
      dsTotal: '总余额',
      dsToppedUp: '充值',
      dsGranted: '赠送',
      dsCost: '估算费用',
      dsTodayCost: '今日消耗',
      dsNotSignedIn: '未登录 DeepSeek 账号',
      dsUnavailable: '余额不可用',
      balanceShort: '余额',
      todayShort: '今日',
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
      titleOpencode: 'OpenCode Go plan usage',
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
      indicator: 'Indicator',
      indicatorBar: 'Bars',
      indicatorRing: 'Rings',
      tokensTitle: 'Token usage',
      tokensToday: 'Today',
      tokens7d: '7 days',
      tokens30d: '30 days',
      tokensTotal: 'Total',
      tokensInput: 'in',
      tokensOutput: 'out',
      tokensCache: 'cached',
      tokensRequests: '{n} requests',
      tokensLoading: 'counting…',
      tokensEmpty: 'no records',
      titleDeepseek: 'DeepSeek balance & spend',
      dsBalance: 'Balance',
      dsTotal: 'Total',
      dsToppedUp: 'topped up',
      dsGranted: 'granted',
      dsCost: 'est. cost',
      dsTodayCost: 'today spend',
      dsNotSignedIn: 'DeepSeek account not signed in',
      dsUnavailable: 'balance unavailable',
      balanceShort: 'balance',
      todayShort: 'today',
      loadingPanel: 'Loading usage…',
      network: 'network error',
      http: 'bad response',
      upstream: 'rejected',
      inDuration: '{d}',
    };

    /** 套餐等级显示名：沿用官方命名（MAX / PRO / LITE / FREE），不做翻译。 */
    const LEVEL_LABEL = { max: 'MAX', pro: 'PRO', lite: 'LITE', free: 'FREE' };

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
      '.zq-pill{border-radius:var(--dsw-radius-sm);color:var(--dsw-alias-label-tertiary);font:inherit;font-size:calc(var(--dsh-content-font-size-secondary,13px) - 1px);font-variant-numeric:tabular-nums;line-height:calc(20px + var(--dsh-content-font-delta-secondary,0px));white-space:nowrap;cursor:pointer;background:0 0;border:none;flex:0 1 auto;min-width:0;max-width:100%;overflow:hidden;align-items:center;gap:7px;padding:1px 9px;display:inline-flex}',
      '.zq-pill:hover,.zq-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.zq-pill:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary));outline-offset:-2px}',
      '.zq-brand{flex:none}',
      '.zq-part{display:inline-flex;align-items:center;gap:5px;min-width:0}',
      '.zq-num{color:var(--dsw-alias-label-secondary);font-weight:500}',
      '.zq-unit{color:var(--dsw-alias-label-caption);margin-left:-2px;font-size:.92em}',
      '.zq-sronly{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0}',
      '.zq-bar{flex:none;width:26px;height:5px;border-radius:3px;background:var(--dsw-alias-border-l2,#dde1e7);overflow:hidden;display:inline-block}',
      '.zq-bar-fill{display:block;height:100%;border-radius:3px;min-width:4px}',
      '.zq-sep{color:var(--dsw-alias-label-caption);margin:0 1px}',
      // —— 弹出面板（对齐 ContextMeter 面板） ——
      '.zp-panel{z-index:1100;box-sizing:border-box;border-radius:var(--dsw-radius-lg);background:var(--dsw-specific-menu);width:min(264px,100vw - 24px);max-height:calc(100vh - 88px);overflow-y:auto;overscroll-behavior:contain;backdrop-filter:var(--dsw-menu-backdrop-filter);--dsw-elevation-stroke-color:var(--dsw-alias-border-l1);box-shadow:var(--dsw-elevation-prominent);color:var(--dsw-alias-label-secondary);cursor:default;border:0;padding:10px 11px;font-size:12px;line-height:18px;position:fixed}',
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
      '.zq-ring{display:inline-flex;flex:none;line-height:0}',
      '.zp-pref{border-top:.5px solid var(--dsw-alias-border-l1);margin-top:6px;padding-top:6px;align-items:center;justify-content:space-between;display:flex;gap:8px}',
      '.zp-pref-label{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px}',
      '.zp-toggle{display:inline-flex;align-items:center;gap:2px}',
      '.zp-toggle button{font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:0;border-radius:var(--dsw-radius-sm);padding:1px 6px;cursor:pointer}',
      '.zp-toggle button:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.zp-toggle button[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}',
      '.zp-tok{border-top:.5px solid var(--dsw-alias-border-l1);margin-top:8px;padding-top:6px}',
      '.zp-tokhead{align-items:center;display:flex;gap:8px;margin-bottom:2px}',
      '.zp-toktitle{color:var(--dsw-alias-label-secondary)}',
      '.zp-ranges{margin-left:auto;display:inline-flex;align-items:center;gap:2px}',
      '.zp-range{font:inherit;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary);background:0 0;border:0;border-radius:var(--dsw-radius-sm);padding:1px 5px;cursor:pointer}',
      '.zp-range:hover{background:var(--dsw-alias-interactive-bg-hover)}',
      '.zp-range[aria-pressed=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-primary)}',
      '.zp-tokrow{align-items:baseline;display:flex;gap:6px}',
      '.zp-tokrow .zp-toknum{color:var(--dsw-alias-label-primary);font-weight:500;font-variant-numeric:tabular-nums;margin-left:auto}',
      '.zp-tokcost{margin-top:2px}',
      '.zp-tokcost .zp-toknum{color:var(--dsw-alias-label-secondary);font-weight:400}',
      '.zp-toksub{color:var(--dsw-alias-label-tertiary);font-size:11px;line-height:16px;font-variant-numeric:tabular-nums}',
      '.zp-spark{display:flex;align-items:flex-end;gap:2px;height:30px;margin-top:6px;position:relative;padding-bottom:1px}',
      '.zp-spark:after{content:"";position:absolute;left:0;right:0;bottom:0;height:1px;background:var(--dsw-alias-border-l2);opacity:.75}',
      '.zp-spark i{flex:1;min-height:3px;border-radius:2px 2px 1px 1px;background:var(--dsw-alias-state-business-primary);background:linear-gradient(180deg,var(--dsw-alias-state-business-primary) 0%,color-mix(in srgb,var(--dsw-alias-state-business-primary) 55%,transparent) 100%);opacity:.8;transition:height .18s ease}',
      '.zp-spark i[data-peak=true],.zp-spark i[data-today=true]{opacity:1}',
      '.zp-spark i[data-empty=true]{opacity:.2}',
      // 7 天：柱子少，平分整行会又宽又扁 —— 限宽 14px 并两端对齐。
      '.zp-spark[data-range="7d"]{gap:6px;justify-content:space-between}',
      '.zp-spark[data-range="7d"] i{flex:0 1 16px;min-width:11px}',
      // 手机端（≤520px）：徽标更紧凑、弹层横向铺满并限制高度
      '@media (max-width:520px){'
        + '.zq-pill{gap:4px;padding:2px 7px}'
        + '.zq-part{gap:4px}'
        + '.zq-bar{width:18px}'
        + '.zq-sep{display:none}'
        // 窄屏只留总用量与余额，今日消耗在弹层里看，避免把余额挤出可视区。
        + '.zq-today{display:none}'
        + '.zp-panel{left:12px;right:12px;width:auto;max-height:min(calc(100vh - 96px),72vh);padding:12px}'
        + '}',
      // 超窄屏（≤344px）：省掉单位，只留数值与余额。
      '@media (max-width:344px){'
        + '.zq-unit{display:none}'
        + '.zq-pill{gap:3px;padding:2px 6px}'
        + '}',
    ].join('');

    /** 记住的指示器形态（无存储时返回 undefined）。 */
    function storedIndicator() {
      try {
        const value = typeof localStorage !== 'undefined' ? localStorage.getItem(INDICATOR_KEY) : null;
        return value === 'bar' || value === 'ring' ? value : undefined;
      } catch {
        return undefined;
      }
    }

    function storeIndicator(value) {
      try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(INDICATOR_KEY, value);
      } catch {
        /* 隐私模式下忽略 */
      }
    }

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

    /**
     * Token 数量按 K / M / B 换算（1000 进制，3 位有效数字）：
     * 1.4B / 33.5M / 128K / 968；尾随的 .0/.00 会去掉。
     */
    function formatTokens(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '--';
      const abs = Math.abs(n);
      const trim = (text) => text.replace(/(\.\d*?)0+$/, '$1').replace(/\.$/, '');
      if (abs >= 1e9) return `${trim((n / 1e9).toFixed(abs >= 10e9 ? 1 : 2))}B`;
      if (abs >= 1e6) return `${trim((n / 1e6).toFixed(abs >= 100e6 ? 0 : abs >= 10e6 ? 1 : 2))}M`;
      if (abs >= 1e3) return `${trim((n / 1e3).toFixed(abs >= 100e3 ? 0 : 1))}K`;
      return String(Math.round(n));
    }

    /** 精确整数（千分位），用于徽标的悬浮提示。 */
    function formatExact(value) {
      const n = Number(value);
      if (!Number.isFinite(n)) return '--';
      return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
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
    /** 金额符号：CNY 用 ¥，其它按 USD。 */
    function currencySymbol(currency) {
      return currency === 'USD' ? '$' : '¥';
    }

    /** 金额格式化：两位小数，太小的值显示 <0.01。 */
    function formatMoney(value, currency) {
      const amount = Number(value);
      if (!Number.isFinite(amount)) return '--';
      if (amount > 0 && amount < 0.005) return `${currencySymbol(currency)}<0.01`;
      return `${currencySymbol(currency)}${amount.toFixed(2)}`;
    }

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
      if (percent >= 70) return 'var(--dsw-alias-state-warn-primary, var(--dsw-alias-state-warning-primary, #c98a00))';
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

    /** 套餐等级：官方命名优先，未知等级原样显示。 */
    function levelLabel(level) {
      if (typeof level !== 'string' || level.length === 0) return undefined;
      const key = level.toLowerCase();
      if (key === 'none') return pickLang() === 'zh' ? '无' : 'none';
      return LEVEL_LABEL[key] ?? level;
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
    /** 区间按钮的词典键。 */
    function rangeLabelKey(value) {
      if (value === 'today') return 'tokensToday';
      if (value === '30d') return 'tokens30d';
      return 'tokens7d';
    }

    /** Token 用量区块：今日 / 7 天 / 30 天 切换 + 总量、输入输出、缓存命中、每日柱。 */
    function TokenSection(t, tokens, range, onRange) {
      const head = h('div', { key: 'head', className: 'zp-tokhead' }, [
        h('span', { key: 'title', className: 'zp-toktitle' }, t('tokensTitle')),
        h('span', { key: 'ranges', className: 'zp-ranges' },
          TOKEN_RANGES.map((value) => h('button', {
            key: value,
            type: 'button',
            className: 'zp-range',
            'aria-pressed': range === value,
            onClick: () => onRange(value),
          }, t(rangeLabelKey(value))))),
      ]);
      if (tokens !== undefined && tokens !== null && tokens.error === 'unsupported') return null;
      const children = [head];
      const data = tokens !== undefined && tokens !== null && tokens.ok === true ? tokens : undefined;
      if (data === undefined) {
        const failed = tokens !== undefined && tokens !== null && tokens.ok === false;
        children.push(h('div', { key: 'empty', className: 'zp-toksub' }, failed ? t('unavailable') : t('tokensLoading')));
        return h('section', { key: 'tokens', className: 'zp-tok' }, children);
      }
      // 展示口径：带 provider 过滤的响应同时带 all（全厂商合计），总用量以 all 为准；
      // totals 仅用于 DeepSeek 官方的估算费用行。
      const view = data.all ?? data;
      const totals = view.totals ?? {};
      const filtered = data.all !== undefined ? data.totals ?? {} : undefined;
      children.push(h('div', { key: 'total', className: 'zp-tokrow' }, [
        h('span', { key: 'label' }, t('tokensTotal')),
        h('span', { key: 'num', className: 'zp-toknum' }, formatTokens(totals.total ?? 0)),
      ]));
      if (filtered !== undefined && typeof filtered.currency === 'string' && typeof filtered.cost === 'number') {
        children.push(h('div', { key: 'cost', className: 'zp-tokrow zp-tokcost' }, [
          h('span', { key: 'label' }, t('dsCost')),
          h('span', { key: 'num', className: 'zp-toknum' }, formatMoney(filtered.cost, filtered.currency)),
        ]));
      }
      const cache = typeof totals.cacheHit === 'number' ? `${t('tokensCache')} ${totals.cacheHit}%` : undefined;
      const sub = [t('tokensInput'), formatTokens(totals.input ?? 0), '·', t('tokensOutput'), formatTokens(totals.output ?? 0)];
      if (cache !== undefined) sub.push('·', cache);
      children.push(h('div', { key: 'sub', className: 'zp-toksub' }, sub.join(' ')));
      children.push(h('div', { key: 'req', className: 'zp-toksub' }, t('tokensRequests', { n: formatCount(totals.requests ?? 0) })));
      const daily = Array.isArray(view.daily) ? view.daily : [];
      if (daily.length > 1) {
        const metric = (item) => Number(item.total ?? 0);
        let max = 0;
        for (const item of daily) max = Math.max(max, metric(item));
        // sqrt 缩放：单日峰值很大时，其余几天不会被压成一条线。
        const ratioOf = (value) => (max === 0 ? 0 : Math.sqrt(Math.max(0, value) / max));
        children.push(h('div', { key: 'spark', className: 'zp-spark', 'data-range': range },
          daily.map((item, index) => h('i', {
            key: `bar-${index}`,
            'data-empty': metric(item) === 0,
            'data-peak': max > 0 && metric(item) === max,
            'data-today': index === daily.length - 1,
            title: `${item.day} · ${formatTokens(item.total ?? 0)}`,
            style: { height: `${Math.max(10, Math.round(ratioOf(metric(item)) * 100))}%` },
          }))));
      }
      return h('section', { key: 'tokens', className: 'zp-tok' }, children);
    }

    /** DeepSeek 账户余额区块：总余额 + 充值/赠送分项。 */
    function BalanceSection(t, data) {
      if (data === undefined || data.ok !== true || data.signedIn !== true) {
        const reason = data !== undefined && data.ok === true && data.signedIn === false ? t('dsNotSignedIn') : t('dsUnavailable');
        return h('section', { key: 'balance', className: 'zp-sec' }, [
          h('div', { key: 'row', className: 'zp-row' }, [
            h('span', { key: 'label', className: 'zp-label' }, t('dsBalance')),
            h('span', { key: 'value', className: 'zp-value' }, reason),
          ]),
        ]);
      }
      const currency = data.currency ?? 'CNY';
      return h('section', { key: 'balance', className: 'zp-sec' }, [
        h('div', { key: 'row', className: 'zp-row' }, [
          h('span', { key: 'label', className: 'zp-label' }, t('dsTotal')),
          h('span', { key: 'value', className: 'zp-value' }, formatMoney(data.total, currency)),
        ]),
        h('div', { key: 'sub', className: 'zp-sub' }, [
          h('span', { key: 'topup' }, `${t('dsToppedUp')} `),
          h('b', { key: 'topup-value' }, formatMoney(data.toppedUp, currency)),
          h('span', { key: 'sep' }, '·'),
          h('span', { key: 'grant' }, `${t('dsGranted')} `),
          h('b', { key: 'grant-value' }, formatMoney(data.granted, currency)),
        ]),
      ]);
    }

    /** DeepSeek 面板：余额 + 消耗（费用/token）+ 区间切换 + 指示器。 */
    function buildDeepseekPanel(t, state, indicator, onToggle, tokens, tokenRange, onTokenRange) {
      const data = state.phase === 'ready' ? state.data : undefined;
      const children = [
        h('div', { key: 'head', className: 'zp-head' }, [
          h('span', { key: 'title', className: 'zp-title' }, t('titleDeepseek')),
        ]),
        h('hr', { key: 'rule', className: 'zp-rule' }),
        BalanceSection(t, data),
      ];
      if (typeof onTokenRange === 'function') children.push(TokenSection(t, tokens, tokenRange, onTokenRange));
      if (data !== undefined && typeof data.fetchedAt === 'number') {
        children.push(h('div', { key: 'foot', className: 'zp-foot' }, [
          h('span', { key: 'upd' }, `${t('updated')} ${formatClock(data.fetchedAt)}`),
          h('span', { key: 'hint' }, t('every60')),
        ]));
      }
      if (typeof onToggle === 'function') {
        const option = (value, labelKey) => h('button', {
          key: `opt-${value}`,
          type: 'button',
          'aria-pressed': indicator === value,
          onClick: () => onToggle(value),
        }, t(labelKey));
        children.push(h('div', { key: 'pref', className: 'zp-pref' }, [
          h('span', { key: 'label', className: 'zp-pref-label' }, t('indicator')),
          h('span', { key: 'toggle', className: 'zp-toggle' }, [option('bar', 'indicatorBar'), option('ring', 'indicatorRing')]),
        ]));
      }
      return children;
    }

    function buildPanel(t, source, state, indicator, onToggle, tokens, tokenRange, onTokenRange) {
      if (source === 'deepseek') return buildDeepseekPanel(t, state, indicator, onToggle, tokens, tokenRange, onTokenRange);
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
        if (typeof onTokenRange === 'function') children.push(TokenSection(t, tokens, tokenRange, onTokenRange));
        if (typeof onToggle === 'function') {
          const option = (value, labelKey) => h('button', {
            key: `opt-${value}`,
            type: 'button',
            'aria-pressed': indicator === value,
            onClick: () => onToggle(value),
          }, t(labelKey));
          children.push(h('div', { key: 'pref', className: 'zp-pref' }, [
            h('span', { key: 'label', className: 'zp-pref-label' }, t('indicator')),
            h('span', { key: 'toggle', className: 'zp-toggle' }, [option('bar', 'indicatorBar'), option('ring', 'indicatorRing')]),
          ]));
        }
        return children;
      }
      for (const win of data.windows ?? []) children.push(MeterSection(t, win));
      if (data.tools !== undefined) children.push(ToolsSection(t, data.tools));
      children.push(h('div', { key: 'foot', className: 'zp-foot' }, [
        h('span', { key: 'upd' }, `${t('updated')} ${formatClock(data.fetchedAt)}`),
        h('span', { key: 'hint' }, t('every60')),
      ]));
      if (typeof onTokenRange === 'function') children.push(TokenSection(t, tokens, tokenRange, onTokenRange));
      if (typeof onToggle === 'function') {
        const option = (value, labelKey) => h('button', {
          key: `opt-${value}`,
          type: 'button',
          'aria-pressed': indicator === value,
          onClick: () => onToggle(value),
        }, t(labelKey));
        children.push(h('div', { key: 'pref', className: 'zp-pref' }, [
          h('span', { key: 'label', className: 'zp-pref-label' }, t('indicator')),
          h('span', { key: 'toggle', className: 'zp-toggle' }, [option('bar', 'indicatorBar'), option('ring', 'indicatorRing')]),
        ]));
      }
      return children;
    }

    /** 环状指示器：12px 小环，弧长 = 已用百分比。 */
    function Ring(t, percent) {
      const value = typeof percent === 'number' ? Math.max(0, Math.min(100, percent)) : 0;
      const circumference = 2 * Math.PI * 5;
      return h('span', { key: 'ring', className: 'zq-ring', role: 'presentation', 'aria-hidden': true },
        h('svg', { key: 'svg', width: 12, height: 12, viewBox: '0 0 12 12' }, [
          h('circle', { key: 'track', cx: 6, cy: 6, r: 5, fill: 'none', stroke: trackColor(percent), strokeWidth: 2 }),
          h('circle', {
            key: 'fill',
            cx: 6,
            cy: 6,
            r: 5,
            fill: 'none',
            stroke: barColor(percent),
            strokeWidth: 2,
            strokeLinecap: 'round',
            strokeDasharray: `${(circumference * value) / 100} ${circumference}`,
            transform: 'rotate(-90 6 6)',
          }),
        ]));
    }

    /** 一个额度窗口片段：标签 + 已用百分比 + 指示器（柱状条或环状条，在数字后面）。 */
    function Segment(t, win, shortLabels, indicator) {
      const percent = typeof win.percent === 'number' ? Math.max(0, Math.min(100, win.percent)) : undefined;
      const label = shortLabels !== undefined && shortLabels[win.key] !== undefined ? shortLabels[win.key] : winLabel(t, win.key);
      const meter = indicator === 'ring'
        ? Ring(t, percent)
        : h('span', { key: 'bar', className: 'zq-bar', role: 'presentation', 'aria-hidden': true, style: { background: trackColor(percent) } },
            percent !== undefined && percent > 0
              ? h('span', { key: 'fill', className: 'zq-bar-fill', style: { width: `${percent}%`, background: barColor(percent) } })
              : null);
      return h('span', { key: `seg-${win.key}`, className: 'zq-part' }, [
        h('span', { key: 'tag' }, label),
        h('span', { key: 'num' }, `${win.percent ?? '--'}%`),
        meter,
      ]);
    }

    /**
     * pill 内文：DeepSeek 官方按「今日 Token 用量 → 今日消耗 → 余额」排；
     * 其他来源按可展示的额度窗口排。
     * 徽标固定展示「今日」的全厂商总用量（K/M/B），7 天 / 30 天在弹层里切换查看。
     */
    function buildContent(t, source, state, indicator, extra) {
      if (state.phase === 'loading') return [h('span', { key: 'load' }, t('loading'))];
      const data = state.data;
      if (source === 'deepseek') {
        const nodes = [];
        const today = extra !== undefined && extra !== null ? extra.dsToday : undefined;
        const todayReady = today !== undefined && today !== null && today.ok === true;
        const unsupported = today !== undefined && today !== null && today.ok === false && today.error === 'unsupported';
        // 旧版宿主没有 /quota/tokens：整个 Token 片段不占位。
        if (!unsupported) {
          // 固定展示今日全厂商总用量；带过滤的 totals 只用于 tooltip 里的 DeepSeek 官方分项。
          const total = todayReady ? Number(today.all?.totals?.total ?? today.totals?.total) : undefined;
          const own = todayReady && today.all !== undefined ? Number(today.totals?.total) : undefined;
          let usageText;
          if (total !== undefined && Number.isFinite(total)) usageText = formatTokens(total);
          else if (today === undefined || today === null) usageText = t('loading');
          else usageText = '--';
          let title;
          if (total !== undefined && Number.isFinite(total)) {
            title = `${t('tokensToday')} ${t('tokensTotal')} ${formatExact(total)}`;
            if (own !== undefined && Number.isFinite(own)) title += ` · DeepSeek ${formatExact(own)}`;
          }
          nodes.push(h('span', { key: 'tokens', className: 'zq-part', title }, [
            // 「今日 总量」只给读屏与悬浮提示，视觉上保持紧凑。
            h('span', { key: 'a11y', className: 'zq-sronly' }, `${t('tokensToday')} ${t('tokensTotal')}`),
            h('span', { key: 'num', className: 'zq-num' }, usageText),
            total !== undefined && Number.isFinite(total) ? h('span', { key: 'unit', className: 'zq-unit' }, 'tok') : null,
          ]));
        }
        if (todayReady && typeof today.totals?.cost === 'number') {
          nodes.push(h('span', { key: 'sep-today', className: 'zq-sep', 'aria-hidden': true }, '·'));
          nodes.push(h('span', { key: 'today', className: 'zq-part zq-today', title: t('dsTodayCost') }, [
            h('span', { key: 'tag' }, t('todayShort')),
            h('span', { key: 'num', className: 'zq-num' }, formatMoney(today.totals.cost, today.totals.currency ?? 'CNY')),
          ]));
        }
        const balanceReady = data !== undefined && data !== null && data.ok === true && data.signedIn === true;
        const reason = data !== undefined && data !== null && data.ok === true ? t('dsNotSignedIn') : t('dsUnavailable');
        if (balanceReady) {
          if (nodes.length > 0) nodes.push(h('span', { key: 'sep-balance', className: 'zq-sep', 'aria-hidden': true }, '·'));
          nodes.push(h('span', { key: 'balance', className: 'zq-part' }, [
            h('span', { key: 'tag' }, t('balanceShort')),
            h('span', { key: 'num', className: 'zq-num' }, formatMoney(data.total, data.currency ?? 'CNY')),
          ]));
        } else if (nodes.length > 0) {
          // 有其他数据时余额位保持短占位，原因留给悬浮提示与面板。
          nodes.push(h('span', { key: 'sep-balance', className: 'zq-sep', 'aria-hidden': true }, '·'));
          nodes.push(h('span', { key: 'balance', className: 'zq-part', title: reason }, [
            h('span', { key: 'tag' }, t('balanceShort')),
            h('span', { key: 'num', className: 'zq-num' }, '--'),
          ]));
        } else {
          return [h('span', { key: 'err' }, reason)];
        }
        return nodes;
      }
      if (data === undefined || data.ok !== true) {
        const reason = data !== undefined && data.error === 'missing-credential' ? t('noCredential') : t('unavailable');
        return [h('span', { key: 'err' }, reason)];
      }
      const config = SOURCES[source];
      const windows = (data.windows ?? []).filter((win) => config.pillKeys.includes(win.key));
      const nodes = [];
      windows.forEach((win, index) => {
        if (index > 0) nodes.push(h('span', { key: `sep-${win.key}`, className: 'zq-sep', 'aria-hidden': true }, '·'));
        nodes.push(Segment(t, win, config.shortLabels, indicator));
      });
      return nodes;
    }

    function QuotaPill(props) {
      const t = typeof props.t === 'function' ? props.t : fallbackTranslate;
      // 当前会话的模型选择：与输入框模型芯片同源（modelSelection 投影的 next ?? lastUsed）。
      // 切换会话时投影快照变化 → sessionProvider 变化 → 徽标跟着切换到对应厂商。
      const useProjectionHook = typeof props.useProjection === 'function' ? props.useProjection : null;
      const projection = useProjectionHook !== null ? useProjectionHook('modelSelection') : undefined;
      const picked = projection !== null && projection !== undefined ? (projection.next ?? projection.lastUsed) : undefined;
      const sessionProvider = picked !== null && picked !== undefined && typeof picked.provider === 'string' && picked.provider.length > 0 ? picked.provider : null;
      const [state, setState] = useState({ phase: 'loading' });
      const [source, setSource] = useState(null);
      const [indicator, setIndicator] = useState(() => storedIndicator() ?? 'bar');
      const [hidden, setHidden] = useState(false);
      const [open, setOpen] = useState(false);
      const [pos, setPos] = useState(null);
      const [tokens, setTokens] = useState(undefined);
      const [tokenRange, setTokenRange] = useState('7d');
      const [dsToday, setDsToday] = useState(undefined);
      const tokenMemo = useRef({ range: null, provider: undefined, at: 0 });
      /** 请求序号：只让最后一次 Token 请求落库，避免快速切换区间时旧响应覆盖新数据。 */
      const tokenSeq = useRef(0);
      const dsMemo = useRef({ at: 0 });
      const rootRef = useRef(null);
      const panelRef = useRef(null);
      const alive = useRef(true);
      const memo = useRef({ source: null, at: 0 });
      const sessionSelRef = useRef(null);
      const tickRef = useRef(null);
      const sourceRef = useRef(null);
      sourceRef.current = source;
      sessionSelRef.current = sessionProvider === null
        ? null
        : { provider: sessionProvider, model: typeof picked.model === 'string' ? picked.model : '' };

      useEffect(() => {
        alive.current = true;
        let timer;
        const lastSource = { current: undefined };
        const configTick = async () => {
          try {
            const config = await fetch(CONFIG_ROUTE, { headers: { accept: 'application/json' }, cache: 'no-store' }).then((res) => res.json());
            if (!alive.current) return;
            if (config !== null && config.ok === true && (config.indicator === 'bar' || config.indicator === 'ring') && storedIndicator() === undefined) {
              setIndicator(config.indicator);
            }
          } catch {
            /* 宿主未注册该路由（旧版本）时保持默认 */
          }
        };
        const tick = async () => {
          try {
            const sel = sessionSelRef.current;
            const activeUrl = sel === null
              ? ACTIVE_ROUTE
              : `${ACTIVE_ROUTE}?provider=${encodeURIComponent(sel.provider)}${sel.model === '' ? '' : `&model=${encodeURIComponent(sel.model)}`}`;
            const active = await fetch(activeUrl, { headers: { accept: 'application/json' }, cache: 'no-store' }).then((res) => res.json());
            if (!alive.current) return;
            const next = active !== null && active.ok === true && typeof active.source === 'string' ? active.source : null;
            sourceRef.current = next;
            // 来源没变就不动 React 状态，避免每秒重渲染；配额到 55s 才刷新。
            if (next === lastSource.current) {
              if (next === 'deepseek') {
                // 徽标上的今日 Token 用量 / 今日消耗：60s 复用，跨过零点也会刷新。
                loadDsToday();
              }
              if (next === null || Date.now() - memo.current.at <= QUOTA_TTL_MS) return;
              const data = await fetch(SOURCES[next].route, { headers: { accept: 'application/json' }, cache: 'no-store' }).then((res) => res.json());
              if (!alive.current) return;
              memo.current = { source: next, at: Date.now() };
              setState({ phase: 'ready', data });
              return;
            }
            lastSource.current = next;
            sourceRef.current = next;
            setSource(next);
            setHidden(next === null);
            if (next === null) {
              setState({ phase: 'hidden' });
              return;
            }
            // 换了厂商：立刻把旧数据换成新来源的额度（宿主对同一来源还有 55s 缓存）。
            setState({ phase: 'loading' });
            if (next === 'deepseek') loadDsToday();
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
        tickRef.current = tick;
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
        configTick();
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

      // 切换会话（或会话内换模型）时立即查询一次来源，不等下一个轮询周期。
      useEffect(() => {
        if (typeof tickRef.current === 'function') tickRef.current();
      }, [sessionProvider]);

      // 面板定位：桌面端贴在触发按钮上方、右缘对齐；窄屏（≤520px）左右铺满。
      useEffect(() => {
        if (!open) return undefined;
        const place = () => {
          const el = rootRef.current;
          if (el === null) return;
          const rect = el.getBoundingClientRect();
          const bottom = Math.max(12, window.innerHeight - rect.top + 8);
          if (window.innerWidth <= 520) {
            setPos({ bottom, left: 12, right: 12, width: 'auto' });
          } else {
            setPos({ bottom, right: Math.max(12, window.innerWidth - rect.right) });
          }
        };
        place();
        window.addEventListener('resize', place);
        window.addEventListener('scroll', place, true);
        const mq = typeof window.matchMedia === 'function' ? window.matchMedia('(max-width: 520px)') : null;
        const onMedia = () => place();
        if (mq !== null && typeof mq.addEventListener === 'function') mq.addEventListener('change', onMedia);
        return () => {
          window.removeEventListener('resize', place);
          window.removeEventListener('scroll', place, true);
          if (mq !== null && typeof mq.removeEventListener === 'function') mq.removeEventListener('change', onMedia);
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
        document.addEventListener('touchstart', onDown, { passive: true });
        document.addEventListener('keydown', onKey);
        return () => {
          document.removeEventListener('mousedown', onDown);
          document.removeEventListener('touchstart', onDown);
          document.removeEventListener('keydown', onKey);
        };
      }, [open]);

      /** DeepSeek 徽标上的「今日消耗」：只要今日费用，60s 内复用；失败也退避 60s。 */
      const loadDsToday = async (force = false) => {
        if (!force && Date.now() - dsMemo.current.at < TOKEN_TTL_MS) return;
        // 先记时间再取数：tick 每秒调用一次，失败时不能每秒重发。
        dsMemo.current = { at: Date.now() };
        try {
          const data = await fetch(`${TOKENS_ROUTE}?range=today&provider=deepseek`, { headers: { accept: 'application/json' }, cache: 'no-store' }).then((res) => (res.status === 404 ? { ok: false, error: 'unsupported' } : res.json()));
          if (!alive.current) return;
          setDsToday(data);
        } catch {
          // 首次失败显示占位「--」；已有数据则保留，下一轮 TTL 后再试。
          if (alive.current) setDsToday((current) => (current === undefined ? { ok: false, error: 'network' } : current));
        }
      };

      /** 取 Token 统计：同一区间 60s 内复用，失败显示不可用。 */
      const loadTokens = async (range, force = false) => {
        const now = Date.now();
        // 用 ref 读当前来源：tick 里的调用来自挂载时的闭包，不能依赖 render 时的 source。
        const provider = sourceRef.current === 'deepseek' ? SOURCES.deepseek.tokenProvider : undefined;
        if (!force && tokenMemo.current.range === range && tokenMemo.current.provider === provider && now - tokenMemo.current.at < TOKEN_TTL_MS) return;
        // 先记账再请求：404 / 失败也等一个 TTL 再试，避免 tick 每秒重发。
        tokenMemo.current = { range, provider, at: now };
        const seq = (tokenSeq.current += 1);
        setTokens((current) => (current !== undefined && current !== null && current.ok === true ? current : undefined));
        const providerQuery = provider === undefined ? '' : `&provider=${provider}`;
        const settle = (data) => {
          // 已被更新的请求取代：丢弃这次迟到的结果。
          if (seq !== tokenSeq.current) return;
          setTokens(data);
        };
        try {
          const response = await fetch(`${TOKENS_ROUTE}?range=${encodeURIComponent(range)}${providerQuery}`, { headers: { accept: 'application/json' }, cache: 'no-store' });
          if (response.status === 404) {
            // 旧版宿主还没这条路由：不显示该区块。
            if (alive.current) settle({ ok: false, error: 'unsupported' });
            return;
          }
          const data = await response.json();
          if (!alive.current) return;
          if (seq === tokenSeq.current) tokenMemo.current = { range, provider, at: Date.now() };
          settle(data);
        } catch {
          if (!alive.current) return;
          settle({ ok: false, error: 'network' });
        }
      };

      const pickTokenRange = (range) => {
        setTokenRange(range);
        loadTokens(range, true);
      };

      // 当前模型没有额度来源（例如官方 DeepSeek 账号）：不占位。
      if (hidden) return null;
      const useSource = source === null ? 'zhipu' : source;
      const config = SOURCES[useSource];
      const nodes = buildContent(t, useSource, state, indicator, { dsToday });
      const label = [config.brand, ...flattenText(nodes)].filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
      const panel = open && ReactDOM !== null
        ? ReactDOM.createPortal(
            h('div', {
              key: 'panel',
              ref: panelRef,
              className: 'zp-panel',
              role: 'dialog',
              'aria-label': t(config.titleKey),
              style: pos === null ? { visibility: 'hidden' } : pos,
            }, buildPanel(t, useSource, state, indicator, (value) => {
              storeIndicator(value);
              setIndicator(value);
            }, tokens, tokenRange, pickTokenRange)),
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
          onClick: () => {
            const next = !open;
            setOpen(next);
            if (next) loadTokens(tokenRange);
          },
        }, [
          h('span', { key: 'brand', className: 'zq-brand' }, config.brand),
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
        // 客户端模块可能被重新物化（HMR、设置页同步），上一实例的插槽注册未必已释放；
        // 同一 id 重复注册会抛 "already has an entry"，此时沿用已注册的那一条即可。
        const reg = () => {
          try {
            return ctx.slots.register({
              name: 'conversation.composer.dock',
              id: 'dsh-quota',
              order: 2,
              locale: NS,
              inject: () => ({ t }),
            }, QuotaPill);
          } catch (error) {
            const message = String((error && error.message) || error);
            if (!message.includes('already has an entry')) throw error;
            if (typeof console !== 'undefined' && typeof console.warn === 'function') {
              console.warn('[dsh-quota] composer dock 已由先前实例注册，跳过重复注册');
            }
            return () => {};
          }
        };
        ctx.effect(() => (typeof ctx.slots.inject === 'function' ? ctx.slots.inject('conversation.composer.dock', reg) : reg()), 'dsh-quota: 状态栏');
      },
    };
  },
});
