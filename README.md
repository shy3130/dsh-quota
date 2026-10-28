# dsh-quota

在 DeepSeek Harness 输入框下方的状态栏（`conversation.composer.dock`）显示**当前模型所属厂商的额度与消耗**，并随模型切换自动切换。

支持：**智谱 GLM** · **OpenCode Go** · **Kimi For Coding** · **小米 Token 套餐** · **DeepSeek 官方账户**

## 效果图

> 下列截图均取自**真实 DSH 界面**（深色主题、本机 GUI 无头截图），额度与余额为截取时刻的真实数据。

### 状态栏徽标

徽标贴在输入框右下角，跟随当前模型自动切换，点一下弹出明细：

<img src="docs/images/glm-pill.png" width="640" alt="GLM 状态栏徽标"><br>
<img src="docs/images/opencode-go-pill.png" width="640" alt="OpenCode Go 状态栏徽标"><br>
<img src="docs/images/deepseek-pill.png" width="640" alt="DeepSeek 状态栏徽标（余额 + 今日消耗）">

### 明细面板

| GLM（智谱） | OpenCode Go | DeepSeek 官方 |
|---|---|---|
| <img src="docs/images/glm-panel.png" width="220" alt="GLM 明细面板"> | <img src="docs/images/opencode-go-panel.png" width="220" alt="OpenCode Go 明细面板"> | <img src="docs/images/deepseek-panel.png" width="220" alt="DeepSeek 余额与消耗面板"> |

面板里包含：套餐窗口（5 小时 / 周 / 月）、剩余与重置倒计时、工具额度明细、**Token 用量统计（今日 / 7 天 / 30 天）**、DeepSeek 的账户余额与估算费用、指示器形态切换。

### 环状指示器

面板底部可切换柱状 / 环状两种指示器：

| GLM | OpenCode Go |
|---|---|
| <img src="docs/images/glm-ring.png" width="430" alt="GLM 环状指示器"> | <img src="docs/images/opencode-go-ring.png" width="430" alt="OpenCode Go 环状指示器"> |

## 徽标示意

```
GLM 5h 21% ▰ · 周 6% ▰                     ← 智谱（zai-coding-cn）
OpenCode 5h 8% ▰ · 周 3% ▰ · 月 1% ▰       ← OpenCode Go（opencode-go）
Kimi 5h 24% ▰ · 周 42% ▰                   ← Kimi For Coding（kimi-coding）
小米 套餐 12% ▰ · 月 17% ▰                 ← 小米 Token 套餐（xiaomi-token-plan-*）
DeepSeek 余额 ¥85.31 · 今日 ¥1.26          ← DeepSeek 官方（deepseek-account）
（其它厂商，例如未配置额度的路由，徽标不占位）
```

## 自动切换逻辑

宿主侧路由 `GET /quota/active` 读取 DSH 的「当前默认模型选择」（`agentDefaultModel` 服务，每次切换模型都会更新），把 provider 映射到额度来源：

| provider | 来源 | 数据接口 |
|---|---|---|
| `zai-coding-cn` / `zai` | 智谱 GLM | `GET https://open.bigmodel.cn/api/monitor/usage/quota/limit` |
| `opencode-go` / `opencode` | OpenCode Go | `GET https://opencode.ai/zen/go/v1/usage` |
| `kimi-coding` | Kimi For Coding | `GET https://api.kimi.com/coding/v1/usages` |
| `xiaomi-token-plan-cn` / `-ams` / `-sgp` / `xiaomi` | 小米 Token 套餐 | `GET https://platform.xiaomimimo.com/api/v1/tokenPlan/usage` |
| `deepseek-account` / `deepseek-api-key` / `deepseek` | DeepSeek 官方 | DSH 账号服务（平台钱包）或 `GET https://api.deepseek.com/user/balance` |
| 其它（如官方 DeepSeek 账号） | 无 | 徽标自动隐藏 |

切换模型后约 1 秒内跟着切换：客户端每秒查一次 `/quota/active`（宿主只读内存，开销可忽略），窗口重新获得焦点时立即查一次，另外订阅 `settings/document-updated` 事件做即时触发；额度本身每 60 秒刷新一次。

## Token 用量统计

面板底部新增「Token 用量」区块，可在**今日 / 7 天 / 30 天**之间切换，显示：

- **总量**：输入 + 输出 + 缓存读取的合计 token 数
- **输入 / 输出 / 缓存命中率**（缓存命中 = `cacheReadTokens / (totalTokens - outputTokens)`，与 DSH 自带的「缓存命中」口径一致）
- **请求次数**，以及按天的迷你柱状图（今日 1 根，7 天 7 根，30 天 30 根）

数据来自**本机会话日志**（`$DSH_HOME/sessions/**/session*.jsonl.zstd`，逐帧解压后按事件时间归到本地自然日），完全本地计算：不联网、不上传、不落盘新文件。单次扫描 30 个会话约 60~250ms，结果按区间缓存 60 秒。

## DeepSeek 官方监控

DeepSeek 官方只开放了一个余额接口（`GET https://api.deepseek.com/user/balance`），没有用量接口，所以这里把**余额**和**消耗**分开取：

- **余额**：优先用 DSH 已登录的 DeepSeek 账号（`deepseekAccount` 服务的平台钱包 `get_user_summary`，不需要额外凭据）；没登录时退回官方 API（需要 `DEEPSEEK_API_KEY`）
- **今日消耗**：由本机会话日志算出 DeepSeek 官方模型的 token，再按官方价格表换算成金额

徽标显示 `DeepSeek 余额 ¥85.59 · 今日 ¥1.02`；点开面板：

```
DeepSeek 余额与消耗
──────────────────────────────
总余额                     ¥85.59
充值 ¥85.59 · 赠送 ¥0.00

Token 用量        今日  7天  30天
估算费用                    ¥1.02
输入 54.3万 · 输出 10.8万 · 缓存 81.9%
11 次请求
▁▁▁▁▁▁█
──────────────────────────────
更新于 16:09        每 60 秒刷新
指示器            柱状  环状
```

### 价格与口径

按官方价目表（元 / 百万 tokens，`deepseek-flash` / `deepseek-v4-pro`）：

| 模型 | 输入（缓存命中） | 输入（未命中） | 输出 |
|---|---|---|---|
| `deepseek-flash` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.30 | 4.5 / 9 | 13.5 / 27 |

- 每档是「空闲 / 高峰」两列：北京时间**工作日 9:00–12:00、14:00–18:00** 为高峰，其余（含周末）为空闲
- 价格表内置在 `index.js` 的 `DEEPSEEK_PRICING` 里，官方调价时改这里即可
- 金额是**估算**：按每条请求的 token × 当时时段单价累加；法定节假日按工作日计算，金额会略微偏高
- 缓存命中率沿用 DSH 口径：`cacheReadTokens / (totalTokens - outputTokens)`

## 数据与语义

- 两个接口返回的都是**已用百分比**。智谱的 `TIME_LIMIT` 同时给 `696/4000` 与 `percentage: 17`，可证 `percentage` = 已用；OpenCode 的 `rolling/weekly/monthly` 同理。面板里同时给「剩余」。
- 智谱窗口：`TOKENS_LIMIT(unit=3,number=5)` → 5 小时、`TOKENS_LIMIT(unit=6)` → 本周、`TIME_LIMIT` → 本月工具额度（含分项）。
- OpenCode 窗口：`rolling` → **5 小时**（官方文档：5-hour = 月额度的 20%）、`weekly` → 本周（50%）、`monthly` → 本月（100%）；三个都显示在徽标上，徽标里用短标签 `5h / 周 / 月`（面板里仍是完整标题）。
- Kimi 窗口：`usage` → 本周汇总，`limits[]` 里 `window.duration=300 MINUTE` 的是 5 小时窗口；token 数用「万 / 亿」紧凑显示。
- 小米窗口：`usage.items` 的 `plan_total_token`（套餐）、`compensation_total_token`（补偿，仅有额度时显示）、`monthUsage.items` 的 `month_total_token`（本月总量）；接口给的是 token 数，百分比由 used/limit 计算。
- 重置倒计时用短单位、小写：`3h 12m`、`6d 21h`，整点省略分钟、整天省略小时、不足 1 分钟 `<1m`。
- 徽标内文字统一 12px / 同色 / 400 字重（与官方统计徽标同规格），进度条放在数字后面：常态绿、≥70% 琥珀、≥90% 红，轨道同色 18% 浅染。
- 徽标里窗口名用短标签（`5h` / `周` / `月`，面板里仍是完整标题），来源配置见 `client.js` 的 `SOURCES[*].shortLabels`。

## 安装与更新（从 GitHub）

插件在 DSH profile 里作为普通依赖安装，运行时从 `$DSH_HOME/profiles/<profile>/node_modules` 加载：

```bash
# 安装（跟踪 main 最新提交）
dsh plugin --profile desktop add github:shy3130/dsh-quota

# 更新已安装的版本
dsh plugin --profile desktop update @local/dsh-quota

# 钉住某个发布版本（推荐生产环境）
dsh plugin --profile desktop add github:shy3130/dsh-quota#v1.2.0
```

- 安装/更新后要**完全退出并重开 DSH**：宿主插件在启动时加载，只刷新页面不够
- 仅 `client.js` 的改动刷新页面即可，但版本更新通常包含宿主改动，按上面的步骤走
- `pnpm-lock.yaml` 会把 GitHub 依赖钉到具体提交（`codeload.github.com/.../tar.gz/<sha>`），所以“更新”就是重新解析目标 ref 的最新提交
- 每个版本见 [Releases](https://github.com/shy3130/dsh-quota/releases)，附带可直接分发的源码包
- 开发调试时可切回本地软链：`dsh plugin --profile desktop add link:/path/to/dsh-quota`（改代码重启即生效）

```bash
git clone https://github.com/shy3130/dsh-quota.git ~/Project/dsh-quota
```

插件包是标准 DSH bundle。当前安装方式是写进**本机用户补丁层** `~/.dsh/cordis.patch.yml`（`name` 换成你自己的克隆路径）：

```yaml
- insert:
    - id: dsh-quota
      name: '/Users/<you>/Project/dsh-quota/index.js'
```

指向 `index.js`（而不是包目录）：Node 的 ESM 不支持目录导入；客户端模块系统会从该文件向上找到 `package.json`，读取 `dsh.client` 后再加载 `client.js`。

**宿主侧改动（`index.js`）需要重启一次 DSH 桌面应用**才会生效（新增路由不会热加载）；只改 `client.js` 时页面刷新即可。改 `~/.dsh/cordis.patch.yml` 由 HMR 热加载。

## 路由

| 路由 | 用途 |
|---|---|
| `GET /quota/active` | 当前模型 → `{ provider, model, source }` |
| `GET /quota/config` | 界面偏好（`{ indicator: 'bar' | 'ring' }`） |
| `GET /quota/tokens?range=today\|7d\|30d[&provider=deepseek]` | Token 用量统计（读本机会话日志聚合，可过滤厂商） |
| `GET /quota/deepseek` | DeepSeek 官方余额（总余额 / 充值 / 赠送） |
| `GET /quota/zhipu` | 智谱额度（归一化后） |
| `GET /quota/opencode` | OpenCode Go 额度（归一化后） |
| `GET /quota/kimi` | Kimi For Coding 额度（归一化后） |
| `GET /quota/xiaomi` | 小米 Token 套餐额度（归一化后） |

三者都带 DSH 登录门；密钥只在宿主进程内使用，不会进入返回给浏览器的 JSON。

## 配置

行上的 `config` 可覆盖各来源的地址与凭据引用：

```yaml
- insert:
    - id: dsh-quota
      name: '/Users/shy/Project/dsh-quota/index.js'
      config:
        sources:
          zhipu:
            baseUrl: 'https://open.bigmodel.cn'
            credentialRef: 'ZAI_CODING_CN_API_KEY'
          opencode:
            baseUrl: 'https://opencode.ai'
            credentialRef: 'OPENCODE_GO_API_KEY'
          kimi:
            baseUrl: 'https://api.kimi.com'
            credentialRef: 'KIMI_API_KEY'
          xiaomi:
            baseUrl: 'https://platform.xiaomimimo.com'
            credentialRef: 'XIAOMI_MIMO_SESSION_COOKIE'
```

### 指示器形态（柱状条 / 环状条）

打开面板，底部有一行「指示器：柱状 / 环状」的切换：

- 点击即切换，选择记在浏览器 `localStorage`（键 `dsh-quota:indicator`），刷新后保持
- 想改**默认值**（没点过切换的新环境）：给插件行加 `config`：

```yaml
- insert:
    - id: dsh-quota
      name: '@local/dsh-quota'
      config:
        indicator: ring   # bar（默认）| ring
```

> `/quota/config` 是宿主侧路由，改默认值需要**重启**；面板里的切换只需要刷新页面。

### 各家凭据从哪来

| 厂商 | 需要的凭据 | 获取方式 |
|---|---|---|
| 智谱 GLM | `ZAI_CODING_CN_API_KEY` | 智谱开放平台 API Key（与模型路由同一个） |
| OpenCode Go | `OPENCODE_GO_API_KEY` | OpenCode Zen 后台的 API Key |
| Kimi For Coding | `KIMI_API_KEY`，或 DSH 里 Kimi 的 OAuth 登录 | 优先读 DSH 凭据记录 `llm-pi-ai/kimi-coding` 的 access token；没有时用 `sk-kimi-...` API Key |
| 小米 Token 套餐 | `XIAOMI_MIMO_SESSION_COOKIE` | 小米用量接口只认浏览器 SSO **Cookie**（`tp-...` API Key 查不了）：登录 platform.xiaomimimo.com → DevTools → Cookies → 整条复制 |
| DeepSeek 官方 | 通常不用（DSH 已登录 DeepSeek 账号即可）；否则 `DEEPSEEK_API_KEY` | 账号模式走 DSH 的 `deepseekAccount` 服务；API Key 模式走官方 `GET /user/balance` |

凭据可以放在环境变量里，也可以经 DSH 的凭据服务按上面的名字保存（插件只用引用名，不落盘）。

## 卸载

删掉 `~/.dsh/cordis.patch.yml` 里对应的 `insert` 行，然后重启 DSH。

## 开发与维护

本目录既是插件包，也是 git 仓库（远程：`https://github.com/shy3130/dsh-quota`）。

```bash
npm test                 # 冒烟测试：清单/资源/语法/导出面，不联网
git add -A && git commit -m "..."
git push
```

改动生效方式：

| 改动位置 | 生效方式 |
|---|---|
| `client.js`（徽标、面板） | 刷新页面（Cmd+R）；客户端模块会热更新 |
| `index.js`（路由、取数） | **重启 DSH 桌面应用** |
| `~/.dsh/cordis.patch.yml`（挂载行） | HMR 热加载 |

⚠️ 安装行指向的是本目录的绝对路径（`/Users/shy/Project/dsh-quota/index.js`）。如果移动或重命名这个目录，要同步改补丁层的路径；如果以后按 bundle 方式安装（见上文），则改为包名引用，不再依赖绝对路径。

## 目录结构

| 文件 | 作用 |
|---|---|
| `index.js` | 宿主侧：三条路由、凭据读取、上游取数与归一化、缓存与登录门 |
| `client.js` | 浏览器侧：徽标、自动切换、点击面板与轮询 |
| `cordis.patch.yml` | bundle 自身的插件行（作为 profile bundle 安装时使用） |
| `package.json` | 清单：`exports`、`dsh.bundle.patch`、`dsh.client` |
| `locale/*.json` | 插件管理页显示的标题与说明 |
| `icon.svg` | 插件图标 |
