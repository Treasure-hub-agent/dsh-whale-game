<div align="center">

# 🐳 大肥鱼游戏厅 · Whale Arcade

**和你的大肥鱼一起玩游戏**

六款小游戏，你和 DSH 里那个 Agent 同桌 —— 浏览器当牌桌，Agent 当对手，规则由引擎裁决

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
- **随 DSH 自启**（可选）；插件被禁用或 DSH 退出时连同进程树一起收掉，不留孤儿端口
- 侧栏收起（rail 模式）时细条只剩 🎮，不占地方

## 装

### 从 npm（推荐）

```bash
dsh plugin --profile desktop add dsh-whale-game
```

装完**重启 DSH**，左侧栏底部会出现 🎮 大肥鱼游戏厅。

> 包名是 `dsh-whale-game`（`dsh-whale-arcade` 已被另一个插件占用）。

### 本地开发

```bash
git clone https://github.com/Treasure-hub-agent/dsh-whale-game.git
cd dsh-whale-game && pnpm install && pnpm build
dsh plugin --profile desktop add link:$(pwd)
```

## 第一次用：告诉它游戏厅在哪

点 **⚙ 运行设置** 填一次启动命令（三选一）：

| 情况 | 启动命令 |
|---|---|
| 本机有游戏厅源码 | `node /path/to/ai-playground/packages/cli/src/index.ts serve` |
| 游戏厅已发 npm | 留空即可（默认 `npx --yes ai-playground@latest serve`） |
| 想固定版本 | `npx --yes ai-playground@0.1.0 serve` |

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
| 一直「正在拉起…」后失败 | 启动命令不对、端口被占，或游戏厅依赖没装（`pnpm install`） |
| 绿灯但打不开 | 端口填错了；改完记得点「保存」再重开 |
| **DSH 起不来** | DSH 是全有或全无启动。从 profile 的依赖与 `dsh.profile.bundles` 里删掉 `dsh-whale-game`，`pnpm -C "$DSH_HOME/profiles/desktop" install`，再重启 |

崩溃日志在 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`（Windows）
或 `~/.config/@deepseek-ai/dsh-desktop/logs/`（Linux/macOS），会直接点名哪个插件挂了。

## 开发

```bash
pnpm install
pnpm check                            # 构建 + 10 项静态自检 + 类型检查
pnpm e2e -- /path/to/ai-playground    # 真起一次服务 → 健康检查 → 停 → 验端口释放
```

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
