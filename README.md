<div align="center">

# 🎮 大肥鱼游戏厅 · Whale Arcade

**和你的大肥鱼一起玩游戏**

DeepSeek Harness 插件 · 一键起停本地游戏厅，点开就能和 Agent 开一桌

[![License](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![DSH](https://img.shields.io/badge/dsh-%E2%89%A50.2.0--rc.1-6f42c1.svg)](package.json)
[![Node](https://img.shields.io/badge/node-%E2%89%A522-339933.svg)](package.json)

</div>

---

## 这是什么

一枚**只做启动器**的 DSH 插件。

它不内置游戏、不改写游戏平台——只管三件事：**起进程、探健康、关进程**。
游戏本体是另一个独立项目 [AI 游乐场](https://github.com/Treasure-hub-agent/ai-playground)：
六款可以和你桌边那个 Agent 一起玩的游戏。

所以：**平台怎么升级，这枚插件都不用发版**。它只认一条可配置的启动命令和一个端口。

## 长什么样

左侧栏底部多一条细条，点开是一枚悬浮气泡：

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
                          │              WHALE ARCADE · NO.0.1.0│
                          └──────────────────────────────────────┘
```

- 侧栏收起（rail 模式）时细条只剩 🎮
- 气泡 400px 宽，锚在细条右侧，**不受侧栏宽度限制**
- `Esc` / 点空白 / `✕` 都能收起

## 装

### 本地安装（现在就能用）

```bash
git clone https://github.com/Treasure-hub-agent/dsh-whale-arcade.git
cd dsh-whale-arcade && pnpm install && pnpm build

dsh plugin --profile desktop add link:$(pwd)
```

装完**重启 DSH**，左侧栏底部就会出现 🎮 大肥鱼游戏厅。

### 从 npm 装（发布后）

```bash
dsh plugin --profile desktop add dsh-whale-arcade
```

> 还没发布到 npm；上面的本地方式与它等效。

## 用之前：告诉它游戏厅在哪

第一次点「开启游戏厅」之前，展开 **⚙ 运行设置** 填一次启动命令（三选一）：

| 情况 | 启动命令 |
|---|---|
| 本机有游戏厅源码 | `node /path/to/ai-playground/packages/cli/src/index.ts serve` |
| 游戏厅已发 npm | 留空即可（默认 `npx --yes ai-playground@latest serve`） |
| 想固定版本 | `npx --yes ai-playground@0.1.0 serve` |

也可以用环境变量（优先级高于配置）：`PLAYGROUND_CMD`、`AI_PLAYGROUND_REPO`。

配置存在 `$DSH_HOME/whale-arcade/config.json`，随时可在气泡里改。

## 会做什么

- **状态机**：未启动 / 正在拉起 / 运行中 / 正在停止 / 启动失败——失败时说人话（端口被占、命令跑不起来、服务卡住）
- **真健康检查**：进程起来不算数，要等 `/api/games` 真的响应才点亮绿灯；运行期每 5 秒复检，卡住了自己转红
- **一键打开 / 复制地址 / 复制 MCP 配置**：给人类开网页，给 Agent 配 MCP，同一枚气泡里解决
- **端口冲突直说**：不做自动漂移，免得你的书签和 Agent 的地址莫名失效
- **随 DSH 自启**（可选）：插件被禁用或 DSH 退出时，连同进程树一起收掉，不留孤儿端口
- **干净退出**：Windows 用 `taskkill /T`，POSIX 用进程组信号，保证 shell 兜出来的子进程不会漏

## 不做什么

- 不内置游戏、不 import 游戏平台的任何代码（独立性是第一设计目标）
- 不碰你的游戏存档（落盘在游戏厅自己那边）
- 不自动改你的 MCP 配置（v0.1 只给「复制配置」，自动写留到后面）

## 让 Agent 上场

游戏厅起来之后，把气泡里「复制 MCP」拿到的那段配置粘给你的 MCP 客户端：

```json
{
  "mcpServers": {
    "ai-playground": { "type": "http", "url": "http://127.0.0.1:8787/mcp" }
  }
}
```

Agent 走 MCP 入座 1 号位，你（人类）在浏览器里坐 0 号位，两人同时出招。

## 架构

```text
┌─ DSH 宿主 ─────────────────────────────┐
│  lib/index.js    cordis 插件（ESM）     │
│    inject: ['webServer']                │
│    注册 /whale-arcade 路由：            │
│      GET  /status   POST /start         │
│      POST /stop     POST /restart       │
│      GET|PUT /config  GET /logs         │
│         │ spawn(可配置命令)             │
│         ▼                               │
│    游戏厅进程（独立项目，插件不认识它） │
└─────────────────────────────────────────┘
┌─ 浏览器 ───────────────────────────────┐
│  lib/client.js   副作用脚本             │
│    sidebar.footer.action → 细条         │
│    shell.overlay          → 气泡        │
└─────────────────────────────────────────┘
```

## 开发

```bash
pnpm install
pnpm check        # 构建 + 10 项静态自检 + 类型检查
pnpm e2e -- /path/to/ai-playground    # 真起一次服务 → 健康检查 → 停 → 验端口释放
```

两个产物格式不同，是 DSH 契约决定的：

| 产物 | 形态 | 为什么 |
|---|---|---|
| `lib/index.js` | ESM，导出 `{ name, inject, apply }` | cordis 当模块 import；`@deepseek-ai/*` 与 `node:*` 保持 external |
| `lib/client.js` | IIFE 副作用脚本，调 `window.__ModuleLoader__.load` | 宿主当普通脚本加载，react 由 `factory(require)` 取，不能有顶层 import |

⚠️ **`package.json` 必须导出 `./client` 子路径**——DSH 的 `client-modules` 是按 exports
找浏览器半侧的；只放文件不写映射，启动时会报
`declares dsh.client but exports no "./client" bundle`，**并让整个 DSH 起不来**：

```json
"exports": {
  ".": "./lib/index.js",
  "./client": "./lib/client.js",
  "./cordis.patch.yml": "./cordis.patch.yml",
  "./package.json": "./package.json"
}
```

## 出问题怎么办

**DSH 起不来了**——DSH 是全有或全无启动，先摘掉这个插件再排查：

```bash
# 从 profile 的依赖与 bundles 里删掉 dsh-whale-arcade，然后
pnpm -C "$DSH_HOME/profiles/desktop" install
```

崩溃日志在 `%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*.log`（Windows）
或 `~/.config/@deepseek-ai/dsh-desktop/logs/`（Linux/macOS），里面会直接点名哪个插件。

常见原因：

| 现象 | 原因 |
|---|---|
| `declares dsh.client but exports no "./client" bundle` | `exports` 漏了 `./client`（见上一节） |
| 点了没反应、面板不出现 | 浏览器侧没注册成功：看 DevTools 控制台有无 `dsh-whale-arcade` 报错 |
| 一直「正在拉起…」后失败 | 启动命令不对、端口被占，或游戏厅依赖没装（`pnpm install`） |
| 绿灯但打不开 | 端口填错了；改端口后记得点「保存」重开 |

## 许可

MIT。游戏平台 [AI 游乐场](https://github.com/Treasure-hub-agent/ai-playground) 同为 MIT（代码）/ CC-BY 4.0（美术与音乐）。
