<div align="center">

# 🐳 大肥鱼游戏厅 · Whale Arcade

**和你的大肥鱼一起玩游戏**

六款小游戏，你和 DSH 里那个 Agent 同桌 —— 浏览器当牌桌，Agent 当对手，规则由引擎裁决

[![npm](https://img.shields.io/npm/v/dsh-whale-game.svg)](https://www.npmjs.com/package/dsh-whale-game)
[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Games](https://img.shields.io/badge/games-6%20playable-fd9d2e.svg)](#六款游戏)
[![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.2.0--rc.1-6f42c1.svg)](package.json)

</div>

---

## 这是什么

一个**开在你 DSH 里的游戏厅**。不是聊天框套壳，也不是内置 AI 陪玩。

| | 谁 | 做什么 |
|---|---|---|
| 🧑 | **你** | 在浏览器里开一桌、点格子、发气泡。不用装客户端。 |
| 🤖 | **Agent** | 你 DSH 里那个 Agent（Claude Code / Codex / 任何会调 MCP 的）入座 1 号位，读棋盘、出招、嘴你两句。 |
| ⚖️ | **规则** | 服务端只当裁判：纯函数内核裁决，不代打、不内置 AI、不保存任何模型密钥。 |

一句话：**你带 Agent，我出牌桌。**

换 Agent = 换对手。规则不变，模型风格变了：有的莽、有的苟、有的爱赌炸弹。模型即难度。

## 六款游戏

| | 游戏 | 玩法 | 节奏 | 单局 |
|---|---|---|---|---|
| 🪙 | **抢宝大作战** | 3×3 九宫格，同时暗抢金币，撞车谁都拿不到 | 同时暗选 | 60–90 秒 |
| 🔴 | **四子棋** | 7 列重力落子，横竖斜先连成四子者胜 | 轮流 | 2–4 分钟 |
| 🎲 | **快艇骰子** | 五颗骰三次机会，13 栏记分比总分 | 轮流 | 3–5 分钟 |
| ✌️ | **猜拳心理战** | 三局猜拳，决胜局翻倍，读招赌心理 | 同时暗选 | 30–60 秒 |
| 🚢 | **深海猎手** | 5×5 盲射找船，命中继续开炮 | 轮流 | 5–8 分钟 |
| ⚫ | **黑白棋** | 8×8 夹住翻面，终局数子多者胜 | 轮流 | 4–8 分钟 |

**「同时暗选」是这里最有意思的一类**：两边都交了才一起揭示，你永远不知道对面这一手会不会和你撞车。
LLM 的出招常有惯性——你能摸出它的习惯，也能练自己的不可预测。

## 玩一局大概是这样

1. 点开左下角 **🎮 大肥鱼游戏厅** → 「打开游戏厅」→ 挑一款 → 开一桌
2. 把**房间号**或 **MCP 配置**交给 Agent，它入座 1 号位
3. 双方入座自动开局；你点格子出招，Agent 那边读 `textView` 与 `legalActions` 出招
4. 终局有结算浮层和本局记录，还能导出可回放的日志

侧栏会显示谁在等谁、谁已提交——但**看不到对方还没揭示的选择**：服务端按座位发令牌，
没有令牌的人只能旁观（能看棋、不能出招）。

## 在 DSH 里怎么开

这个仓库就是它给你的 **DSH 插件**：左侧栏底部一条细条，点开是一枚悬浮气泡。

```text
侧栏                      ┌──────────────────────────────────────┐
 🎮 大肥鱼游戏厅   ──────▶ │ 🐳 大肥鱼游戏厅               ✕      │  ← 晴空灯箱
                          │    和你的大肥鱼一起玩游戏             │
                          │ ●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●●● │  ← 金色灯泡串
                          ├──────────────────────────────────────┤
                          │ ● 运行中          127.0.0.1:8787     │
                          │ ┌───────┬───────┬───────┐            │
                          │ │🎮 游戏│🔌 端口│⏱ 运行│            │  ← 三块计分牌
                          │ │   6   │ 8787  │ 3:12  │            │
                          │ └───────┴───────┴───────┘            │
                          │ ╔══════════════════════════════════╗ │
                          │ ║        🎮 打开游戏厅             ║ │  ← 金色大按键
                          │ ╚══════════════════════════════════╝ │
                          │ ⏹ 停止   ⟳ 重启   复制地址  复制 MCP │
                          │ ▸ ⚙ 运行设置                        │
                          │ ▸ 📜 运行日志 · 12                  │
                          └──────────────────────────────────────┘
```

它能替你做的：

- **一键起停**游戏厅；进程起来不算数——真等到 `/api/games` 有响应才点亮绿灯，运行期每 5 秒复检
- **复制地址**给人类浏览器、**复制 MCP 配置**给 Agent，一次配好
- **随 DSH 自启**（默认开）；游戏厅是 detached 独立进程，**DSH 退出或插件卸载都不会带走它**——
  要停点气泡里的「⏹ 停止」（或 `taskkill /pid <pid> /T /F`）
- **唤醒桥**：人类落子后由平台 POST 过来，把 Agent 会话叫醒（见下一节）
- **MCP 自注册**：首次激活时自动把 `mcp-ai-playground` 条目写进 profile 的 `cordis.patch.yml`
- 侧栏收起（rail 模式）时细条只剩 🎮，不占地方

> 自启用的是 `detached` 方式（`spawn(..., { detached: true, windowsHide: true, stdio: 'ignore' })`）：
> 游戏厅自成进程组，**DSH 退出后它照常活着**（这就是 detached 的目的；插件卸载时也不会去杀它）。
> 下次激活时插件发现端口已被占用，会把它识别成「外部实例」——绿灯、能玩、但**不负责停止**
> （杀别人起的进程是不可逆副作用）。

## 唤醒桥：人类落子自动叫醒 Agent

DSH 的会话是消息驱动的：回合结束就休眠，浏览器里点击落子**不会**唤醒 Agent。
所以平台（AI 游乐场）在「轮到 Agent」时往插件 POST 一条请求，插件往目标会话里塞一条
`user` 消息，把它叫醒。实现照抄官方 `@deepseek-ai/dsh-schedule` 的投递姿势：
`sessionController.resolveAgent` → `createUserMessage` → `agent.followup` → `sessions.flush`。

**契约**

```http
POST http://127.0.0.1:<DSH 端口>/whale-arcade/wake
x-wake-secret: <$DSH_HOME/whale-arcade/config.json 里的 wakeSecret，或环境变量 WHALE_WAKE_SECRET>
content-type: application/json
```

```json
{ "roomId": "liovi0", "sessionId": "session-2fbf0714-…", "gameId": "grab", "gameName": "抢宝大作战",
  "round": 3, "rounds": 9, "textView": "…盘面摘要…" }
```

| 情况 | 状态码 | `error` |
|---|---|---|
| 头缺失 / 不匹配（常量时间比较） | 401 | `bad-secret` |
| body 不是 JSON，或 `roomId`/`sessionId` 不符合 `[A-Za-z0-9._:-]{1,128}`、`round > rounds` | 400 | `bad-request` |
| `resolveAgent` 报错 / 会话没落盘 / 宿主没提供相关服务 | 409 | `session-unavailable` |
| 成功 | 200 | — |

成功响应：`{ ok: true, deliveredAt, sessionId, sourceKind, roomId, round, messageId }`；
同一 `roomId+round` 在 3 秒内重复请求会返回 `{ ok: true, deduped: true, deliveredAt: <首次投递时间> }`。

消息文案（人类可见，总长 ≤ 2KB，超长只截盘面、头尾指令保留）：

```text
🎮 该你出招了 · 房间 liovi0 · 抢宝大作战 · 第 3/9 回合
<textView 摘要>
读完盘面直接 submit_action；不要猜对手本回合的选择，不要托管整局。
```

**`source.kind` 选型依据（实测 + 代码证据）**

- 首选 `'wake'`：`createUserMessage` 是纯构造器（`dsh-llm` 的 `lib/types/message.js` 里只是
  `{ ...input, role: 'user', id: randomUUID() }` 再深冻结），**没有任何运行时校验**；
  `MessageSourceMap` 只是类型层联合，不参与校验。所以 `kind: 'wake'` 不会被拒绝。
- 但客户端 transcript 渲染可能只认识已知的 kind，所以留了自动降级：投递失败（`followup` 抛错，
  即消息没被接受）时会立刻改用官方在用的 `'schedule'` 重投一次，并把这个选择**粘住**
  （后续唤醒直接用 `'schedule'`，设置页能读到当前值）。`flush` 阶段失败**绝不重试**——
  那可能是「消息已进会话、只是没落盘」，重试会让同一回合被叫醒两次。

**平台侧怎么接**：先 `playground_bind_session({ roomId, sessionId })` 绑定会话，然后平台需要两个环境变量：

```text
WAKE_URL=http://127.0.0.1:<DSH 端口>/whale-arcade/wake
WAKE_SECRET=<密钥>
```

- **插件自己起的游戏厅不用管这两行**：插件 spawn 时会自动注入（取 `DSH_WEB_URL` 拼地址、
  密钥用当前生效值，所以天然一致）。拿不到地址时**不注入**、不猜端口，只在日志里说一声。
- **自己起的游戏厅**：气泡里点「🔔 复制唤醒配置」，粘贴的就是这两行。
- 密钥首次运行随机生成并落盘（`$DSH_HOME/whale-arcade/config.json` 的 `wakeSecret`）；
  环境变量 `WHALE_WAKE_SECRET` 可覆盖，设置页显示的是当前生效值。

平台侧 body 用的是它自己的观测：`{ roomId, sessionId, gameId, round, textView, createdAt, nonce }`。
插件只把 `roomId/round` 当去重键，**不判断棋局语义**（不决定该不该叫、也不管 round 是手数还是局数）；
`createdAt` / `nonce` 容忍但不使用。

## 装

### 从 npm（推荐）

```bash
dsh plugin --profile desktop add dsh-whale-game
```

装完**重启 DSH**，左侧栏底部会出现 🎮 大肥鱼游戏厅。

> **插件自带游戏厅本体**（`vendor/app`，六款游戏 + 网页 + 音频，约 14.6 MB），
> 所以点开就能玩——不需要另外 clone 平台、装依赖或联网下载。包体积也因此是 13.4 MB。

> 包名是 `dsh-whale-game`（`dsh-whale-arcade` 已被另一个插件占用）。
> 也可以在 <https://www.npmjs.com/package/dsh-whale-game> 看到它。

### 本地开发

```bash
git clone https://github.com/Treasure-hub-agent/dsh-whale-game.git
cd dsh-whale-game && pnpm install && pnpm build
dsh plugin --profile desktop add link:$(pwd)
```

## 想用自己的版本？（可选）

默认用的是插件里自带的本体，**不用配任何东西**。只有下面这些情况才需要展开 **⚙ 运行设置** 改启动命令：

| 情况 | 启动命令 |
|---|---|
| 本机有游戏厅源码 | `node /path/to/ai-playground/packages/cli/src/index.ts serve` |
| 想用 npm 上的版本 | `npx --yes ai-playground-cli@latest serve` |
| 想固定某版 | `npx --yes ai-playground-cli@0.1.0 serve` |

也可以用环境变量 `PLAYGROUND_CMD`、`AI_PLAYGROUND_REPO`（优先级高于配置文件）。
配置存在 `$DSH_HOME/whale-arcade/config.json`。

## 游戏厅本体在哪

游戏本体是另一个独立开源项目 **[AI 游乐场](https://github.com/Treasure-hub-agent/ai-playground)**：
六款游戏、REST + WebSocket + MCP 三端、座位令牌鉴权、房间落盘、95 条内核单测。

这个插件**只 spawn 一条命令**，不 import 平台的任何代码。所以：

> **游戏厅怎么更新、加多少款游戏，都不需要这个插件发版。**

想改规则、加游戏、读 API 契约，都在那个仓库里。

## 让 Agent 上场

气泡里点「复制 MCP」，拿到的是这段：

```json
{
  "mcpServers": {
    "ai-playground": { "type": "http", "url": "http://127.0.0.1:8787/mcp" }
  }
}
```

粘进你的 MCP 客户端，然后对 Agent 说：

> 用 MCP 连 `http://127.0.0.1:8787/mcp`，调用 `playground_join_room({ roomId: "<房间号>", seat: 1 })` 入座，然后按 `legalActions` 出招。

## 出问题怎么办

| 现象 | 多半是 |
|---|---|
| 侧栏没有 🎮 | 插件没装上或没重启 DSH；看 DevTools 控制台有无 `dsh-whale-game` 报错 |
| 一直「正在拉起…」后失败 | 端口被别的程序占着；或你在 ⚙ 运行设置里改过命令且命令不对（清空即回到自带本体） |
| 绿灯 + 「外部实例运行中」 | 端口上已经有一个不是插件起的游戏厅（开发者手动开的、上次 detached 自启留下的）。能玩；要停请去启动它的地方停，插件不会 kill 别人的进程 |
| 提示本体不可用 | 插件包被裁剪过（比如只装了 lib/）；重新 dsh plugin add dsh-whale-game |
| 绿灯但打不开 | 端口填错了；改完记得点「保存」再重开 |
| 气泡里「🔔 唤醒桥 · 不可用」 | 宿主没提供 `sessionController` / `sessions` 服务：插件其它功能正常，只是叫不醒 Agent |
| 气泡里「🧩 MCP 条目没接上」 | 自动写 profile 配置失败（权限/路径/半截标记块）。展开就有可复制的 YAML 块，手动贴进 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 即可 |
| **DSH 起不来** | DSH 是全有或全无启动。从 profile 的依赖与 `dsh.profile.bundles` 里删掉 `dsh-whale-game`，`pnpm -C "$DSH_HOME/profiles/desktop" install`，再重启 |

> 自动写 profile 配置只在**缺条目**时发生一次：先备份 `cordis.patch.yml.bak-<时间戳>`，
> 再追加带 `# BEGIN/END dsh-whale-game` 标记的 `- insert:` 块；已有条目则一个字节都不动。
> 写失败不会让插件起不来，只会退化成上面那条「手动添加」提示。

崩溃日志在 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`（Windows）
或 `~/.config/@deepseek-ai/dsh-desktop/logs/`（Linux/macOS），会直接点名哪个插件挂了。

## 开发

```bash
pnpm install
pnpm check          # 构建 + 静态自检 + 单测（唤醒桥/MCP 自注册/外部实例）+ 类型检查
pnpm test           # 只跑 node:test 单测（鉴权 / 去抖 / 会话不可用降级 / 自注册幂等与备份）
pnpm e2e            # 用自带本体：真起服务 → 健康检查 → 停 → 验端口释放
pnpm e2e -- /path/to/ai-playground    # 用本机平台源码跑同一条链路
```

> 单测全程在临时 `DSH_HOME` 里跑，**不碰真实 profile**，也不需要重启 DSH。

**本体怎么更新**：插件里的 `vendor/app/` 是从平台仓库同步来的构建产物（`dist` + `web`），不是手写代码。平台发新版后：

```bash
# 1. 平台仓库里先构建
node scripts/pack-cli.mjs
# 2. 回到本仓库，把产物搬进 vendor/app
pnpm vendor -- ../ai-playground
```

`scripts/vendor-app.mjs` 会重写 `vendor/app/VENDORED.txt`，界面上的「本体 vX.Y.Z」就读它。

两个产物格式不同，是 DSH 契约决定的：

| 产物 | 形态 | 为什么 |
|---|---|---|
| `lib/index.js` | ESM，导出 `{ name, inject, apply }` | cordis 当模块 import；`@deepseek-ai/*` 与 `node:*` 保持 external |
| `lib/client.js` | IIFE 副作用脚本，调 `window.__ModuleLoader__.load` | 宿主当普通脚本加载；react 由 `factory(require)` 取，不能有顶层 import |

⚠️ **`package.json` 必须导出 `./client` 子路径**——DSH 的 `client-modules` 是按 exports 找浏览器
半侧的；只放文件不写映射，启动时会报 `declares dsh.client but exports no "./client" bundle`，
**并让整个 DSH 起不来**：

```json
"exports": {
  ".": "./lib/index.js",
  "./client": "./lib/client.js",
  "./cordis.patch.yml": "./cordis.patch.yml",
  "./package.json": "./package.json"
}
```

其余踩坑记录见 [CHANGELOG](CHANGELOG.md)。

## 许可

- **本插件**：[MIT](LICENSE)
- **游戏平台**：[AI 游乐场](https://github.com/Treasure-hub-agent/ai-playground) —— 代码 MIT，美术与音乐 CC BY 4.0
