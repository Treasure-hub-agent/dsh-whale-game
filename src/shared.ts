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
  /**
   * 唤醒桥的共享密钥：平台 POST /whale-arcade/wake 时必须带 `x-wake-secret`。
   * 首次运行由插件生成随机值并落盘；环境变量 WHALE_WAKE_SECRET 可覆盖（覆盖时这里仍保留落盘值）。
   * 空串 = 还没生成（插件激活时会补上）。
   */
  wakeSecret: string;
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

/**
 * 谁在提供服务：
 *   'plugin'   = 本插件 spawn 的子进程（插件负责起停）
 *   'external' = 端口上已经有人先跑起来了（开发者手动开的、命令行开的…），插件**不负责停止**它
 *   null       = 没在跑
 */
export type InstanceOwner = 'plugin' | 'external' | null;

/**
 * 唤醒桥：`source.kind` 的取值。
 * 优先 'wake'（语义正确、人类在 transcript 里一眼能看出不是自己说的话）；
 * 若宿主不接受，实现会在投递失败时自动降级成 'schedule'（官方定时提醒用的 kind，实测一定能过），
 * 并把实际使用的值回显出来——选型依据见 README「唤醒桥」一节。
 */
export type WakeSourceKind = 'wake' | 'schedule';

/** 唤醒桥的运行时快照，给设置页显示「平台该填什么、上次叫醒成没成」。 */
export interface WakeState {
  /** 宿主是否给了 sessionController + sessions（缺一个唤醒就不可用，但插件照常工作）。 */
  available: boolean;
  /** 实际用于投递的 source.kind（可能已经从 'wake' 降级）。 */
  sourceKind: WakeSourceKind;
  /** 平台侧要 POST 的完整地址（含 /whale-arcade/wake）。 */
  url: string;
  /** 生效的密钥（环境变量覆盖时的值），给用户复制到平台配置里。 */
  secret: string;
  /** 密钥来源：环境变量 / 配置文件。 */
  secretSource: 'env' | 'config';
  /** 最近一次成功投递时间（ISO）；从未成功为 null。 */
  lastDeliveredAt: string | null;
  /** 最近一次失败的人话原因；成功后清空。 */
  lastError: string | null;
  /** 累计成功投递次数。 */
  delivered: number;
  /** 累计失败次数（409：会话不可用 / 投递失败）。 */
  failed: number;
  /** 累计被 3 秒去抖吞掉的次数（平台重试很频繁时能一眼看出来）。 */
  debounced: number;
  /** 最近一次投递的房间/回合，便于对照平台日志。 */
  lastRoom: string | null;
  lastRound: number | null;
}

/** MCP 条目自注册的结果，给设置页显示「已写好 / 需要手动加」。 */
export interface McpState {
  /** present = 已经有这条；written = 本次写入（已备份）；failed = 没写成（看 detail）；skipped = 明确跳过。 */
  action: 'present' | 'written' | 'failed' | 'skipped';
  /** 目标 patch 文件绝对路径；解析不出来时是 null。 */
  path: string | null;
  /** 本次写入前的备份文件；没有写文件时为 null。 */
  backup: string | null;
  /** 人话说明（成功写给 HMR 提示，失败给原因）。 */
  detail: string;
  /** 可以直接粘进 cordis.patch.yml 的块（失败时给用户手动添加用）。 */
  snippet: string;
}

export interface LauncherState {
  status: LauncherStatus;
  config: LauncherConfig;
  /** 可直接打开的完整地址，例如 http://127.0.0.1:8787/ */
  url: string;
  /** MCP 端点，给「复制配置」用。 */
  mcpUrl: string;
  /** 谁在提供服务；external 时界面必须说明「插件不负责停机」。 */
  owner: InstanceOwner;
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
  /** 外部实例说明 / 其他需要摆到界面上的补充解释；null = 没有。 */
  notice: string | null;
  /** 唤醒桥状态。 */
  wake: WakeState;
  /** MCP 自注册状态。 */
  mcp: McpState;
}

/** 启动来源：自带本体 / 用户配置 / 环境变量 / 平台源码 / npx 兜底。 */
export type LaunchSource = 'config' | 'env' | 'repo' | 'bundled' | 'npx';

/**
 * 默认配置。
 * `autoStart: false` —— 2026-10-30 主人明确要求：**默认不随 DSH 自启**，
 * 由用户在气泡「运行设置 → 随 DSH 启动」里自己开。理由：后台常驻一个服务
 * 属于「用户该知情并选择」的行为，不该装完插件就悄悄占端口。
 * 唤醒桥不受影响：游戏厅没起时 MCP 客户端会持续重试，用户点「开启游戏厅」后自动接上。
 */
export const DEFAULT_CONFIG: LauncherConfig = {
  port: 8787,
  command: '',
  cwd: '',
  autoStart: false,
  openOnStart: false,
  wakeSecret: '',
};

/** 浏览器侧轮询间隔：状态页停留时用它刷新。 */
export const POLL_INTERVAL_MS = 2000;
