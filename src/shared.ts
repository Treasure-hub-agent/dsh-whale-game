/**
 * 插件与游戏厅之间的唯一契约。
 *
 * 这里**不 import 游戏厅的任何代码**——启动器与游戏平台是两个独立模块：
 * 启动器只知道「起一条命令、探一个 URL、关一个进程」。游戏厅怎么升级、
 * 有几十款游戏、要不要换端口，都通过下面这几个字段表达，插件不需要重新发版。
 */

/** 宿主侧路由前缀（浏览器同源直接 fetch）。 */
export const ROUTE_PREFIX = '/whale-arcade';

/** 插件自身版本，只用于界面角标。 */
export const PLUGIN_VERSION = '0.1.0';

/** 状态机：stopped → starting → running → stopping → stopped；失败进 failed。 */
export type LauncherStatus = 'stopped' | 'starting' | 'running' | 'stopping' | 'failed';

export interface LauncherConfig {
  /** 游戏厅监听端口；默认 8787（与游戏厅自己的默认一致）。 */
  port: number;
  /** 启动命令；空串 = 用内置默认（本机仓库里的 CLI，其次 npx）。 */
  command: string;
  /** 工作目录；空串 = 跟随宿主进程 cwd。 */
  cwd: string;
  /** 随 DSH 启动自动拉起游戏厅。 */
  autoStart: boolean;
  /** 拉起成功后自动打开浏览器。 */
  openOnStart: boolean;
}

/** 一次健康探测的结果：启动器借此判断「服务真的能玩」，而不只是进程起来了。 */
export interface HealthInfo {
  /** 游戏厅 `/api/games` 返回的游戏数；取不到为 null。 */
  games: number | null;
  /** 首个游戏 id，便于界面写「6 款 · grab…」这种细节。 */
  firstGame: string | null;
  /** 探测耗时（毫秒）。 */
  latencyMs: number | null;
}

export interface LauncherState {
  status: LauncherStatus;
  config: LauncherConfig;
  /** 可直接打开的完整地址，例如 http://127.0.0.1:8787/ */
  url: string;
  /** MCP 端点，给「复制配置」用。 */
  mcpUrl: string;
  pid: number | null;
  /** 启动时间戳（ms）；未运行为 null。 */
  startedAt: number | null;
  /** 最近一次失败原因（人话），成功后清空。 */
  error: string | null;
  health: HealthInfo;
  /** 日志尾部若干行。 */
  logs: string[];
  /** 插件版本。 */
  pluginVersion: string;
  /** 插件里自带的游戏厅本体（vendor/app）：装了就能直接用，不需要另外下载。 */
  platform: { available: boolean; version: string | null };
  /** 这次启动用的是哪条路；null = 还没启动过。 */
  launchSource: LaunchSource | null;
}

/** 启动来源：自带本体 / 用户配置 / 环境变量 / 平台源码 / npx 兜底。 */
export type LaunchSource = 'config' | 'env' | 'repo' | 'bundled' | 'npx';

export const DEFAULT_CONFIG: LauncherConfig = {
  port: 8787,
  command: '',
  cwd: '',
  autoStart: false,
  openOnStart: false,
};

/** 浏览器侧轮询间隔：状态页停留时用它刷新。 */
export const POLL_INTERVAL_MS = 2000;
