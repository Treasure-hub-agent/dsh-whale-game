/**
 * dsh-whale-game —— 宿主半侧（host half）
 *
 * 职责只有三件事：**起进程 / 探健康 / 关进程**，再把状态用一棵很小的 HTTP
 * 路由暴露给设置页。这里没有一行游戏逻辑——游戏厅是独立项目，插件不 import
 * 它的任何代码，只 spawn 一条可配置的命令。所以游戏厅怎么迭代都不用动插件。
 *
 * 路由（前缀 ROUTE_PREFIX）：
 *   GET  /status     → LauncherState（状态机 + 配置 + 日志尾 + 健康探测 + 唤醒桥/MCP 状态）
 *   POST /start      → 起进程并等健康检查通过
 *   POST /stop       → 优雅停；5s 不退强杀进程树（外部实例不杀）
 *   POST /restart    → stop + start
 *   GET  /config     → 当前配置
 *   PUT  /config     → 保存配置（端口 / 命令 / 工作目录 / 自动启动 / 启动后打开）
 *   GET  /logs       → 只取日志（设置页展开日志面板时用）
 *   POST /wake       → **唤醒桥**：平台在「轮到 Agent」时打进来，把目标会话叫醒
 *                      （鉴权 x-wake-secret；实现在 ./wake.ts）
 *
 * 生命周期：插件被禁用 / DSH 退出时，**不会**带走游戏厅——自启用的是 detached 独立
 * 进程组，这是「DSH 退出后仍存活」这个需求的前提；要停点气泡里的「停止」。
 * 下次激活时端口已被占用，会被识别成「外部实例」：绿灯、可玩、不去杀它。
 */
import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  DEFAULT_CONFIG,
  PLUGIN_VERSION,
  ROUTE_PREFIX,
  type HealthInfo,
  type InstanceOwner,
  type LauncherConfig,
  type LauncherState,
  type LauncherStatus,
  type McpState,
  type WakeState,
} from '../shared.ts';
import { ensureMcpEntry } from './mcp-register.ts';
import { generateWakeSecret, WakeBridge, type WakeRuntimeSnapshot, type WakeServices } from './wake.ts';

const CONFIG_FILE = 'config.json';
const LOG_LIMIT = 240;
const START_TIMEOUT_MS = 25_000;
const STOP_GRACE_MS = 5_000;

/** 剥掉终端 ANSI 颜色：日志要进 HTML，留着转义序列只会显示乱码。 */
function stripAnsi(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/\u001b\[[0-9;]*m/g, '');
}

/**
 * DSH 数据根。优先环境变量，其次官方 home-paths 包（软依赖，取不到就退回
 * 家目录下的 .dsh），最后兜底——配置写错位置只会影响「配置丢没丢」，不该
 * 让插件加载失败。
 */
async function resolveHome(): Promise<string> {
  const fromEnv = process.env.DSH_HOME?.trim();
  if (fromEnv) return fromEnv;
  try {
    // 用变量拼模块名：这个包是宿主提供的可选依赖，装插件的人不一定有它的类型声明，
    // 写成静态 import 会让 tsc 直接报「找不到模块」。
    const spec = '@deepseek-ai/dsh-home-paths';
    const mod = (await import(spec)) as { resolveDshHome?: () => string };
    if (typeof mod.resolveDshHome === 'function') return mod.resolveDshHome();
  } catch {
    // 宿主没提供这个包（或版本不同）：走兜底
  }
  return join(homedir(), '.dsh');
}

function clampPort(value: unknown, fallback: number): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1024 || n > 65535) return fallback;
  return n;
}

function normalizeConfig(raw: unknown): LauncherConfig {
  const input = (raw ?? {}) as Partial<LauncherConfig>;
  return {
    port: clampPort(input.port, DEFAULT_CONFIG.port),
    command: typeof input.command === 'string' ? input.command.trim() : '',
    cwd: typeof input.cwd === 'string' ? input.cwd.trim() : '',
    // 老配置里没写 autoStart（或不是明确的 false）就走新的默认值 true：
    // 「装上就能玩」比「让用户先找到设置页点一下」重要。明确写 false 的照旧尊重。
    autoStart: input.autoStart === false ? false : true,
    openOnStart: input.openOnStart === true,
    wakeSecret: typeof input.wakeSecret === 'string' ? input.wakeSecret.trim() : '',
  };
}

function readConfig(file: string): LauncherConfig {
  try {
    if (!existsSync(file)) return { ...DEFAULT_CONFIG };
    return normalizeConfig(JSON.parse(readFileSync(file, 'utf8')));
  } catch {
    // 配置坏了不该让插件起不来：按默认值跑，界面里保存一次就修好
    return { ...DEFAULT_CONFIG };
  }
}

function writeConfig(file: string, config: LauncherConfig): void {
  mkdirSync(join(file, '..'), { recursive: true });
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`, 'utf8');
}

/**
 * 插件自带的游戏厅本体（`vendor/app/`，由 `node scripts/vendor-app.mjs` 从平台仓库同步）。
 *
 * 为什么要自带：新用户装完插件点「开启游戏厅」时，不该还要求他 clone 平台、装依赖、配命令。
 * 这份产物是 esbuild 打好的零依赖单文件，`node dist/index.js serve` 直接能跑，
 * 所以**零网络、无需 npm install、秒开**。
 */
const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const VENDORED_APP_DIR = join(PACKAGE_ROOT, 'vendor', 'app');
const VENDORED_APP_ENTRY = join(VENDORED_APP_DIR, 'dist', 'index.js');

/** 插件里是否带了本体；带了的话顺手读出它的平台版本，界面上要显示。 */
export function bundledAppInfo(): { available: boolean; version: string | null } {
  if (!existsSync(VENDORED_APP_ENTRY)) return { available: false, version: null };
  try {
    const meta = readFileSync(join(VENDORED_APP_DIR, 'VENDORED.txt'), 'utf8');
    const match = /platform version:\s*(\S+)/.exec(meta);
    return { available: true, version: match?.[1] ?? null };
  } catch {
    return { available: true, version: null };
  }
}

export interface LaunchSpec {
  command: string;
  /** 额外注入的环境变量（本体自带时要把 PLAYGROUND_WEB_DIST 指到包内） */
  env: Record<string, string>;
  /** 这次是从哪条路来的，界面上用来回答「本体从哪来的」 */
  source: 'config' | 'env' | 'repo' | 'bundled' | 'npx';
  /**
   * 可以直接 spawn 的可执行文件与参数（第 17 轮：为了不弹黑窗）。
   *
   * 为什么需要它：`shell: true` 会先起一个 `cmd.exe /c`，Windows 会给那个 cmd
   * 分配控制台窗口——即使写了 `windowsHide` 也照弹（用户实测截图里那扇黑窗）。
   * 只有「不经过 shell、直接 spawn 一个 .exe」才会真的无窗口。
   * 用户自定义命令 / 需要 shell 解析的路径仍走 command + shell。
   */
  argv?: { file: string; args: string[] };
}

/**
 * 找出本机的 node.exe（第 17 轮）。
 *
 * 坑：插件跑在 Electron 宿主里，`process.execPath` 是 `DeepSeek Harness.exe`，
 * 直接拿它当 node 用会再拉起一个 DSH 本体。所以按 PATH 找 node.exe，
 * 找不到就返回 null（调用方退回 shell 模式，最多是继续弹窗，不会起错东西）。
 */
export function resolveNodeExe(env: NodeJS.ProcessEnv = process.env): string | null {
  const explicit = env.WHALE_NODE_EXE?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const pathValue = env.PATH ?? env.Path ?? '';
  for (const dir of pathValue.split(';')) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = join(trimmed, 'node.exe');
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/**
 * 启动命令的解析顺序（配置为空时）：
 *   1. 插件自带的本体（默认路径，零网络、无需安装）
 *   2. 环境变量 PLAYGROUND_CMD（高级用户的逃生口）
 *   3. 环境变量 AI_PLAYGROUND_REPO（指向平台源码，开发期用）
 *   4. npx 兜底（万一包被裁剪掉了 vendor/）
 */
function resolveCommand(config: LauncherConfig): LaunchSpec {
  if (config.command) return { command: config.command, env: {}, source: 'config' };
  const fromEnv = process.env.PLAYGROUND_CMD?.trim();
  if (fromEnv) return { command: fromEnv, env: {}, source: 'env' };
  const localRepo = process.env.AI_PLAYGROUND_REPO?.trim();
  if (localRepo) {
    return {
      command: `node "${join(localRepo, 'packages/cli/src/index.ts')}" serve`,
      env: {},
      source: 'repo',
    };
  }
  if (existsSync(VENDORED_APP_ENTRY)) {
    const nodeExe = resolveNodeExe();
    return {
      command: `node "${VENDORED_APP_ENTRY}" serve`,
      // 自带本体的静态资源在包内；显式指过去，免得 CLI 自己算错
      env: { PLAYGROUND_WEB_DIST: join(VENDORED_APP_DIR, 'web') },
      source: 'bundled',
      // 找得到 node.exe 就直接 spawn（无黑窗）；找不到就退回 command + shell。
      ...(nodeExe ? { argv: { file: nodeExe, args: [VENDORED_APP_ENTRY, 'serve'] } } : {}),
    };
  }
  return { command: 'npx --yes ai-playground-cli@latest serve', env: {}, source: 'npx' };
}

/**
 * 唤醒端点的基地址（不含 /whale-arcade/wake）。
 * 优先 DSH_WEB_URL；宿主没给时用 `webServer.getOrigin()`（宿主自报的权威地址，不是猜端口）。
 */
export function resolveWakeBase(webServer: any): { base: string | null; source: 'env' | 'origin' | 'none' } {
  const fromEnv = process.env.DSH_WEB_URL?.trim();
  if (fromEnv) return { base: fromEnv.replace(/\/+$/, ''), source: 'env' };
  try {
    const origin = webServer?.getOrigin?.();
    if (typeof origin === 'string' && origin) return { base: origin.replace(/\/+$/, ''), source: 'origin' };
  } catch {
    // 监听还没绑定：落到 none
  }
  return { base: null, source: 'none' };
}

/**
 * 给游戏厅进程注入唤醒配置（平台侧从环境变量读 WAKE_URL / WAKE_SECRET）。
 *
 * 为什么由插件注入而不是让人肉配：这两值必须和被校验的密钥**天然一致**，
 * 手动配一次错一位就整条唤醒链路静默失效，排查起来极费劲。
 * 拿不到基地址时**不注入**（返回 missingUrl），由调用方在日志里说明，绝不瞎猜端口。
 */
export function buildWakeEnv(input: { base?: string | null; wakeSecret?: string | null }): {
  env: Record<string, string>;
  missingUrl: boolean;
} {
  const base = (input.base ?? '').trim();
  const secret = (input.wakeSecret ?? '').trim();
  const env: Record<string, string> = {};
  if (base) env.WAKE_URL = `${base.replace(/\/+$/, '')}${ROUTE_PREFIX}/wake`;
  if (secret) env.WAKE_SECRET = secret;
  return { env, missingUrl: !base };
}

class Supervisor {
  private child: ChildProcess | null = null;
  private status: LauncherStatus = 'stopped';
  /** 谁在提供服务：本插件拉起的（plugin）/ 端口上已有的（external） */
  private owner: InstanceOwner = null;
  private startedAt: number | null = null;
  private error: string | null = null;
  private notice: string | null = null;
  private health: HealthInfo = { games: null, firstGame: null, latencyMs: null };
  /** 上一次启动用的是哪条路（config / env / repo / bundled / npx），界面照它解释本体来源 */
  private launchSource: LaunchSpec['source'] | null = null;
  private readonly logs: string[] = [];
  private healthTimer: NodeJS.Timeout | null = null;
  private readonly extras: () => { wake: WakeState; mcp: McpState };
  /** 唤醒配置注入：每次 start 现算（端口/密钥随时可能变） */
  private readonly wakeEnv: () => { env: Record<string, string>; missingUrl: boolean };

  constructor(
    private config: LauncherConfig,
    extras: () => { wake: WakeState; mcp: McpState },
    wakeEnv: () => { env: Record<string, string>; missingUrl: boolean },
  ) {
    this.extras = extras;
    this.wakeEnv = wakeEnv;
  }

  getConfig(): LauncherConfig {
    return { ...this.config };
  }

  setConfig(next: LauncherConfig): void {
    this.config = next;
  }

  get url(): string {
    return `http://127.0.0.1:${this.config.port}/`;
  }

  get mcpUrl(): string {
    return `http://127.0.0.1:${this.config.port}/mcp`;
  }

  get pid(): number | null {
    return this.child?.pid ?? null;
  }

  private push(line: string): void {
    const clean = stripAnsi(line).replace(/\r/g, '').trimEnd();
    if (!clean) return;
    this.logs.push(clean);
    if (this.logs.length > LOG_LIMIT) this.logs.splice(0, this.logs.length - LOG_LIMIT);
  }

  snapshot(): LauncherState {
    const { wake, mcp } = this.extras();
    return {
      status: this.status,
      config: { ...this.config },
      url: this.url,
      mcpUrl: this.mcpUrl,
      owner: this.owner,
      pid: this.pid,
      startedAt: this.startedAt,
      error: this.error,
      health: { ...this.health },
      logs: this.logs.slice(-80),
      pluginVersion: PLUGIN_VERSION,
      platform: bundledAppInfo(),
      launchSource: this.launchSource,
      notice: this.notice,
      wake,
      mcp,
    };
  }

  /** 端口探测：被占用就直说，不做「自动漂移」——否则用户的书签和 MCP 地址会莫名失效。 */
  private async portFree(port: number): Promise<boolean> {
    const net = await import('node:net');
    return await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.once('listening', () => server.close(() => resolve(true)));
      server.listen(port, '127.0.0.1');
    });
  }

  /**
   * 空闲态顺手探活（第 17 轮，修「状态自相矛盾」）。
   *
   * 场景：插件起的厅被外部杀掉、之后又有人手动起了一个（或主人自己 `node ... serve`），
   * 此时 supervisor 状态停在 `stopped`，但端口上其实有实例——面板/状态接口就会
   * 一边显示「已停止」一边服务可用，排查时非常误导。
   *
   * 只做**只读探测**：探通就按 external 记账（不接管、不 kill）；探不通保持原状。
   */
  async refreshIdle(): Promise<void> {
    if (this.status !== 'stopped' && this.status !== 'failed') return;
    const health = await this.probeHealth();
    if (health.games === null) return;
    this.status = 'running';
    this.owner = 'external';
    this.health = health;
    this.startedAt = null;
    this.launchSource = null;
    this.notice =
      this.notice ?? `端口 ${this.config.port} 上已有一个游戏厅在跑（不是插件起的）：插件按外部实例对待，不负责停止它。`;
    this.startHealthPolling();
    this.push(`[external] 端口 ${this.config.port} 探活成功（${health.games} 款游戏），按外部实例对待`);
  }

  private async probeHealth(): Promise<HealthInfo> {
    const started = Date.now();
    try {
      const res = await fetch(`${this.url}api/games`, { signal: AbortSignal.timeout(1500) });
      if (!res.ok) return { games: null, firstGame: null, latencyMs: Date.now() - started };
      const body = (await res.json()) as { games?: Array<{ id?: string }> };
      const games = Array.isArray(body.games) ? body.games : [];
      return {
        games: games.length,
        firstGame: games[0]?.id ?? null,
        latencyMs: Date.now() - started,
      };
    } catch {
      return { games: null, firstGame: null, latencyMs: null };
    }
  }

  async start(): Promise<LauncherState> {
    if (this.status === 'running' || this.status === 'starting') return this.snapshot();
    this.error = null;
    this.notice = null;
    this.status = 'starting';
    this.owner = null;

    if (!(await this.portFree(this.config.port))) {
      // 端口被占用是本机常态（开发者手动开的游戏厅、上一次 detached 自启留下的）。
      // 只要 /api/games 真能响应，就当成「外部实例运行中」——绿灯、可玩，
      // 但插件**绝不会去杀别人起的进程**（不可逆副作用，红线）。
      const health = await this.probeHealth();
      if (health.games !== null) {
        this.status = 'running';
        this.owner = 'external';
        this.health = health;
        this.startedAt = null;
        this.launchSource = null;
        this.notice = `端口 ${this.config.port} 上已经有一个游戏厅在跑（不是插件起的）：插件按外部实例对待，不负责停止它。`;
        this.push(`[external] 端口 ${this.config.port} 已有实例，健康检查通过（${health.games} 款游戏），插件不会去停它`);
        this.startHealthPolling();
        return this.snapshot();
      }
      this.status = 'failed';
      this.error = `端口 ${this.config.port} 已被占用，而且 /api/games 不通：可能是别的程序占着这个端口，换一个端口再试。`;
      return this.snapshot();
    }

    const launch = resolveCommand(this.config);
    const command = launch.command;
    this.launchSource = launch.source;
    const cwd = this.config.cwd || process.cwd();
    // 平台（游戏厅）从环境变量读唤醒配置：由插件注入，保证 secret 与校验值天然一致
    const wakeEnv = this.wakeEnv();
    this.push(`$ ${command}`);
    this.push(`  cwd: ${cwd}  来源: ${launch.source}`);
    if (wakeEnv.missingUrl) {
      this.push('[wake] 没拿到 DSH_WEB_URL / 宿主 origin：不注入 WAKE_URL（不猜端口），平台侧需手配');
    } else {
      this.push(`[wake] 已注入 WAKE_URL=${wakeEnv.env.WAKE_URL}`);
    }

    try {
      // 关键：detached + stdio:'ignore'。
      // 用 Start-Process / 普通 spawn 派生的进程会挂在 DSH 的进程树里，DSH 退出时的
      // Ctrl+C 会顺着进程树把它带走（已实测）；detached 之后它自成一个进程组，
      // 宿主退出与它无关。代价是没有 stdout——日志只剩插件自己的状态行，可以接受。
      //
      // 第 17 轮：有 argv 就**不经过 shell**直接 spawn。走 shell 会先起 cmd.exe，
      // Windows 会给 cmd 分配控制台窗口（windowsHide 也压不住），用户就看见一扇黑窗。
      const childEnv = {
        ...process.env,
        ...launch.env,
        ...wakeEnv.env,
        PORT: String(this.config.port),
        HOST: '127.0.0.1',
        FORCE_COLOR: '0',
      };
      const child = launch.argv
        ? spawn(launch.argv.file, launch.argv.args, {
            cwd,
            detached: true,
            windowsHide: true,
            stdio: 'ignore',
            env: childEnv,
          })
        : spawn(command, {
            cwd,
            shell: true,
            detached: true,
            windowsHide: true,
            stdio: 'ignore',
            env: childEnv,
          });
      if (launch.argv) this.push(`  [nowindow] ${launch.argv.file}（不经 shell，避免控制台窗口）`);
      this.child = child;
      // 不 unref 的话子进程句柄会撑住 DSH 的事件循环：宿主想退都退不掉。
      child.unref();
      child.on('exit', (code, signal) => {
        this.push(`[exit] code=${code ?? 'null'} signal=${signal ?? 'null'}`);
        if (this.status !== 'stopping') {
          this.status = this.child === child ? 'stopped' : this.status;
          this.startedAt = null;
          if (code !== 0 && code !== null) this.error = `游戏厅进程退出了（code ${code}），看下面的日志。`;
        }
        this.child = null;
        this.stopHealthPolling();
      });
    } catch (err) {
      this.status = 'failed';
      this.error = `启动命令执行失败：${err instanceof Error ? err.message : String(err)}`;
      return this.snapshot();
    }

    // 健康检查：进程起来不等于服务能用，必须等到 /api/games 真的响应
    const deadline = Date.now() + START_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 400));
      const health = await this.probeHealth();
      if (health.games !== null) {
        this.health = health;
        this.status = 'running';
        this.owner = 'plugin';
        this.startedAt = Date.now();
        this.startHealthPolling();
        this.push(`[ready] ${this.url} · ${health.games} 款游戏 · ${health.latencyMs}ms`);
        return this.snapshot();
      }
      if (this.child === null) break; // 进程已经死了，别等满 25 秒
    }

    this.status = 'failed';
    this.error = this.error ?? `等了 ${START_TIMEOUT_MS / 1000} 秒游戏厅还没就绪：确认端口 ${this.config.port} 可用、启动命令能跑。`;
    await this.stop();
    return this.snapshot();
  }

  async stop(): Promise<LauncherState> {
    this.stopHealthPolling();

    // 外部实例：插件只「放手」，不发任何 kill——杀别人起的进程是不可接受的副作用。
    if (this.owner === 'external') {
      this.status = 'stopped';
      this.owner = null;
      this.health = { games: null, firstGame: null, latencyMs: null };
      this.startedAt = null;
      this.notice = '刚才那个是外部实例：插件不会去停它，这里只是不再跟踪它的状态。';
      this.push('[external] 不再跟踪外部实例（未发送任何 kill）');
      return this.snapshot();
    }

    const child = this.child;
    if (!child || child.exitCode !== null) {
      this.status = 'stopped';
      this.owner = null;
      this.child = null;
      this.startedAt = null;
      this.health = { games: null, firstGame: null, latencyMs: null };
      return this.snapshot();
    }

    this.status = 'stopping';
    const pid = child.pid;
    this.push(`[stop] pid=${pid ?? 'null'}`);
    try {
      if (process.platform === 'win32' && pid) {
        // Windows 上 node 的 kill 不保证收掉子进程树（shell:true 会多一层 cmd）
        spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
      } else if (pid) {
        try {
          // detached 之后子进程自成一个进程组，负 pid 才能收到信号
          process.kill(-pid, 'SIGTERM');
        } catch {
          child.kill('SIGTERM');
        }
      }
    } catch {
      // 进程可能已经没了，继续等下面的收尾
    }

    const exited = await Promise.race([
      new Promise<boolean>((resolve) => child.once('exit', () => resolve(true))),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), STOP_GRACE_MS)),
    ]);
    if (!exited && pid) {
      this.push('[stop] 5 秒内没退出，强杀');
      try {
        if (process.platform === 'win32') spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { windowsHide: true });
        else process.kill(-pid, 'SIGKILL');
      } catch {
        // 已经没了
      }
    }

    this.child = null;
    this.status = 'stopped';
    this.owner = null;
    this.startedAt = null;
    this.health = { games: null, firstGame: null, latencyMs: null };
    return this.snapshot();
  }

  /** 运行期每 5 秒补一次健康数据（进程还活着但服务挂了要能发现）。 */
  private startHealthPolling(): void {
    this.stopHealthPolling();
    this.healthTimer = setInterval(() => {
      void this.probeHealth().then((health) => {
        this.health = health;
        if (health.games !== null || this.status !== 'running') return;
        if (this.owner === 'external') {
          // 外部实例不归我们管：它没了就回到「未启动」，别报成插件启动失败
          this.status = 'stopped';
          this.owner = null;
          this.notice = '外部实例已经不在这个端口上了（可能被它自己的主人停了）。';
          this.stopHealthPolling();
          return;
        }
        this.status = 'failed';
        this.error = '游戏厅进程还在，但 /api/games 不再响应：可能卡住了，试试点「重启」。';
      });
    }, 5000);
    this.healthTimer.unref?.();
  }

  private stopHealthPolling(): void {
    if (this.healthTimer) {
      clearInterval(this.healthTimer);
      this.healthTimer = null;
    }
  }
}

/** cordis 插件元信息：等 webServer 就绪后再 apply，路由才挂得上去。
 *  name 用短名（与包名区分），包名/上架 id 在 package.json 与 cordis.patch.yml 里。 */
export const name = 'whale-arcade';
export const inject = ['webServer'];

/**
 * 单测入口：把唤醒桥 / MCP 自注册的内核从打包产物里暴露出来。
 * cordis 只认 `name` / `inject` / `apply`，多导出的这些名字不会被当成插件契约，
 * 但让 `scripts/test-*.mjs` 能在**真实构建产物**上跑断言，而不是另建一套源码翻译。
 */
export {
  buildWakeText,
  DEDUPE_MS,
  generateWakeSecret,
  ID_PATTERN,
  MAX_TEXT_BYTES,
  validateWakePayload,
  WakeBridge,
} from './wake.ts';
export { buildMcpBlock, ensureMcpEntry, hasMcpEntry, markerState, MCP_ENTRY_ID, profilePatchPath } from './mcp-register.ts';

export function apply(ctx: any): void {
  // 初始化是异步的，必须把拒绝吃掉：DSH 启动是「全有或全无」，一个未处理的
  // Promise 拒绝可能被进程级处理当成致命错误。启动器挂了顶多是这张卡片不可用，
  // 绝不该拖垮整个 DSH。
  void bootstrap(ctx).catch((err) => {
    console.error('[dsh-whale-game] 初始化失败（插件停用，不影响 DSH）：', err);
  });
}

/** 唤醒端点的展示地址：优先宿主自报的 base，其次按端口猜（仅用于界面文案）。 */
function resolveWakeUrl(webServer: any): string {
  const { base } = resolveWakeBase(webServer);
  if (base) return `${base}${ROUTE_PREFIX}/wake`;
  const port = webServer?.port;
  return `http://127.0.0.1:${typeof port === 'number' && port > 0 ? port : '<DSH 端口>'}${ROUTE_PREFIX}/wake`;
}

async function bootstrap(ctx: any): Promise<void> {
  const webServer = ctx.webServer;
  if (!webServer?.register) {
    console.warn('[dsh-whale-game] 宿主没有 webServer 服务，启动器无法提供状态接口');
    return;
  }

  const home = await resolveHome();
  const dir = join(home, 'whale-arcade');
  const configFile = join(dir, CONFIG_FILE);

  let config = readConfig(configFile);

  // 唤醒密钥：首次运行生成并落盘。环境变量可以覆盖**比较时用的值**，
  // 但配置里那份始终保留——用户把环境变量撤掉后不至于突然谁也唤不醒。
  const envSecret = process.env.WHALE_WAKE_SECRET?.trim() ?? '';
  if (!config.wakeSecret) {
    const generated = generateWakeSecret();
    config = { ...config, wakeSecret: generated };
    try {
      writeConfig(configFile, config);
      console.log('[dsh-whale-game] 已生成唤醒密钥并写入 config.json');
    } catch (err) {
      console.warn('[dsh-whale-game] 唤醒密钥写入失败（本次仍可用，重启会重新生成）：', err);
    }
  }
  const effectiveSecret = envSecret || config.wakeSecret;

  /** 宿主服务：拿到后 /wake 才可用；拿不到只影响唤醒，别的功能照常。 */
  const services: { current: WakeServices | null } = { current: null };
  /** supervisor 在下面创建；唤醒桥要先拿到密钥闭包，所以先用确定赋值断言占位。 */
  let supervisorRef!: Supervisor;
  const wakeBridge = new WakeBridge({
    // 每次请求现读：改环境变量 / 存配置都会立刻生效
    secret: () => process.env.WHALE_WAKE_SECRET?.trim() || supervisorRef?.getConfig().wakeSecret || effectiveSecret,
    services: () => services.current,
    log: (line) => console.log(line),
  });

  const wakeUrl = resolveWakeUrl(webServer);
  const wakeState = (): WakeState => {
    const snapshot: WakeRuntimeSnapshot = wakeBridge.snapshot();
    return {
      url: wakeUrl,
      secret: process.env.WHALE_WAKE_SECRET?.trim() || supervisorRef?.getConfig().wakeSecret || effectiveSecret,
      secretSource: envSecret ? 'env' : 'config',
      ...snapshot,
    };
  };

  // MCP 自注册：写失败也不抛（插件绝不能因为写配置失败而起不来），
  // 失败时结果里带可复制的 snippet，设置页会摆出来。
  let mcpState: McpState = {
    action: 'skipped',
    path: null,
    backup: null,
    detail: '尚未尝试（插件启动中）',
    snippet: '',
  };

  const wakeBase = resolveWakeBase(webServer);
  supervisorRef = new Supervisor(
    config,
    () => ({ wake: wakeState(), mcp: mcpState }),
    // 每次 start 现算：端口可能被改、密钥可能被环境变量覆盖
    () =>
      buildWakeEnv({
        base: wakeBase.base,
        wakeSecret: process.env.WHALE_WAKE_SECRET?.trim() || supervisorRef?.getConfig().wakeSecret || effectiveSecret,
      }),
  );

  if (wakeBase.source === 'none') {
    console.warn('[dsh-whale-game] 拿不到 DSH_WEB_URL / 宿主 origin：不会给游戏厅注入 WAKE_URL（不猜端口）');
  } else {
    console.log(`[dsh-whale-game] 唤醒配置注入来源：${wakeBase.source === 'env' ? 'DSH_WEB_URL' : 'webServer.getOrigin()'}`);
  }

  const saveConfig = (next: LauncherConfig): void => {
    supervisorRef.setConfig(next);
    try {
      writeConfig(configFile, next);
    } catch (err) {
      console.warn('[dsh-whale-game] 配置写入失败：', err);
    }
  };

  try {
    mcpState = ensureMcpEntry({ home, mcpUrl: supervisorRef.mcpUrl });
    if (mcpState.action === 'written') console.log(`[dsh-whale-game] ${mcpState.detail}（${mcpState.path}）`);
    else if (mcpState.action === 'failed') console.warn(`[dsh-whale-game] MCP 自注册没成功：${mcpState.detail}`);
  } catch (err) {
    // ensureMcpEntry 自己就不会抛；这里再兜一层，保证插件永远能起来
    mcpState = {
      action: 'failed',
      path: null,
      backup: null,
      detail: `MCP 自注册异常（不影响插件）：${err instanceof Error ? err.message : String(err)}`,
      snippet: '',
    };
  }

  // 唤醒桥需要的两个服务：sessionController（resolveAgent）+ sessions（flush）。
  // 用 ctx.inject 而不是静态 inject 列表：宿主版本没这俩服务时，只是这个子插件不挂载，
  // 启动器照常工作——插件整体起不来的代价太大了。
  try {
    ctx.inject(['sessionController', 'sessions'], (wakeCtx: any) => {
      services.current = { sessionController: wakeCtx.sessionController, sessions: wakeCtx.sessions };
      console.log('[dsh-whale-game] 唤醒桥就绪：sessionController + sessions 已注入');
      return () => {
        services.current = null;
      };
    });
  } catch (err) {
    console.warn('[dsh-whale-game] 唤醒桥不可用（宿主没有 sessionController/sessions）：', err);
  }

  const json = (res: any, status: number, body: unknown): void => {
    const text = JSON.stringify(body);
    res.statusCode = status;
    res.setHeader('content-type', 'application/json; charset=utf-8');
    res.setHeader('cache-control', 'no-store');
    res.end(text);
  };

  const readBody = async (req: any): Promise<string> => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
  };

  webServer.register({
    kind: 'prefix',
    path: ROUTE_PREFIX,
    handler: async (req: any, res: any) => {
      const url = new URL(req.url ?? '/', 'http://127.0.0.1');
      const action = url.pathname.slice(ROUTE_PREFIX.length).replace(/^\/+/, '');
      const method = String(req.method ?? 'GET').toUpperCase();

      try {
        if (method === 'GET' && (action === 'status' || action === '')) {
          // 第 17 轮：空闲态顺手探活。否则会出现「面板说已停止，端口上其实有实例」的自相矛盾
          //（典型场景：插件起的厅被外部杀掉，之后主人又手动起了一个）。
          await supervisorRef.refreshIdle();
          json(res, 200, { ok: true, state: supervisorRef.snapshot() });
          return;
        }
        if (method === 'GET' && action === 'logs') {
          const state = supervisorRef.snapshot();
          json(res, 200, { ok: true, logs: state.logs, status: state.status });
          return;
        }
        if (method === 'POST' && action === 'start') {
          json(res, 200, { ok: true, state: await supervisorRef.start() });
          return;
        }
        if (method === 'POST' && action === 'stop') {
          json(res, 200, { ok: true, state: await supervisorRef.stop() });
          return;
        }
        if (method === 'POST' && action === 'restart') {
          await supervisorRef.stop();
          json(res, 200, { ok: true, state: await supervisorRef.start() });
          return;
        }
        if (method === 'GET' && action === 'config') {
          json(res, 200, { ok: true, config: supervisorRef.getConfig() });
          return;
        }
        if (method === 'PUT' && action === 'config') {
          const body = normalizeConfig(JSON.parse((await readBody(req)) || '{}'));
          // 老的设置页/手搓请求可能不带 wakeSecret：那就保留原值，
          // 别因为一次「保存端口」把唤醒密钥悄悄换掉（平台侧配的那份会立刻失效）。
          if (!body.wakeSecret) body.wakeSecret = supervisorRef.getConfig().wakeSecret;
          saveConfig(body);
          json(res, 200, { ok: true, config: supervisorRef.getConfig(), state: supervisorRef.snapshot() });
          return;
        }
        // 唤醒桥：鉴权/校验/去抖/投递全在 WakeBridge 里（便于单测），这里只做搬砖。
        if (action === 'wake') {
          const result = await wakeBridge.handle({
            method,
            headers: req.headers ?? {},
            rawBody: method === 'POST' ? await readBody(req) : '',
          });
          json(res, result.status, result.body);
          return;
        }
        // 可唤醒性预检（第 18 轮）：平台在 bind 时先问一句「这个会话叫得动吗」，
        // 叫不动就当场婉拒，别等人类落子才发现 409。
        if (action === 'wake/check') {
          const result = await wakeBridge.check({
            method,
            headers: req.headers ?? {},
            rawBody: method === 'POST' ? await readBody(req) : '',
          });
          json(res, result.status, result.body);
          return;
        }
        json(res, 404, { ok: false, error: `未知道路：${method} ${action}` });
      } catch (err) {
        json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  /**
   * 插件被禁用 / DSH 退出：**故意不杀**游戏厅。
   *
   * 这是 detached 自启的目的本身——验收标准要求「游戏厅在 DSH 退出后仍存活」。
   * 在 disposer 里 taskkill 就等于把这个特性抵消掉（优雅退出时 disposer 是会跑的）。
   * 代价是要停得手动：气泡里点「停止」，或 `taskkill /pid <pid> /T /F`。
   * 下次 DSH 启动时端口已被占用 → 自动识别成「外部实例」，不会重复拉起、也不会去杀它。
   */
  ctx.effect(() => {
    return () => {
      const state = supervisorRef.snapshot();
      if (state.owner === 'plugin' && state.pid) {
        console.log(
          `[dsh-whale-game] 插件卸载：游戏厅（pid ${state.pid}）保持运行（detached 自启）；需要停请手动结束该进程`,
        );
      }
    };
  }, 'ai-playground: dispose (keep detached hall running)');

  console.log(`  大肥鱼游戏厅：${supervisorRef.url}${supervisorRef.getConfig().autoStart ? '（随 DSH 自启）' : ''}`);
  console.log(`  唤醒桥：POST ${wakeUrl}`);

  if (supervisorRef.getConfig().autoStart) {
    void supervisorRef.start();
  }
}
