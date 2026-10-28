/**
 * dsh-whale-game —— 宿主半侧（host half）
 *
 * 职责只有三件事：**起进程 / 探健康 / 关进程**，再把状态用一棵很小的 HTTP
 * 路由暴露给设置页。这里没有一行游戏逻辑——游戏厅是独立项目，插件不 import
 * 它的任何代码，只 spawn 一条可配置的命令。所以游戏厅怎么迭代都不用动插件。
 *
 * 路由（前缀 ROUTE_PREFIX）：
 *   GET  /status     → LauncherState（状态机 + 配置 + 日志尾 + 健康探测结果）
 *   POST /start      → 起进程并等健康检查通过
 *   POST /stop       → 优雅停；5s 不退强杀进程树
 *   POST /restart    → stop + start
 *   GET  /config     → 当前配置
 *   PUT  /config     → 保存配置（端口 / 命令 / 工作目录 / 自动启动 / 启动后打开）
 *   GET  /logs       → 只取日志（设置页展开日志面板时用）
 *
 * 生命周期：DSH 退出或插件被禁用时，ctx.effect 的 disposer 会把子进程连同
 * 它的进程树一起收掉，不留孤儿端口。
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
  type LauncherConfig,
  type LauncherState,
  type LauncherStatus,
} from '../shared.ts';

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
    autoStart: input.autoStart === true,
    openOnStart: input.openOnStart === true,
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
    return {
      command: `node "${VENDORED_APP_ENTRY}" serve`,
      // 自带本体的静态资源在包内；显式指过去，免得 CLI 自己算错
      env: { PLAYGROUND_WEB_DIST: join(VENDORED_APP_DIR, 'web') },
      source: 'bundled',
    };
  }
  return { command: 'npx --yes ai-playground-cli@latest serve', env: {}, source: 'npx' };
}

class Supervisor {
  private child: ChildProcess | null = null;
  private status: LauncherStatus = 'stopped';
  private startedAt: number | null = null;
  private error: string | null = null;
  private health: HealthInfo = { games: null, firstGame: null, latencyMs: null };
  /** 上一次启动用的是哪条路（config / env / repo / bundled / npx），界面照它解释本体来源 */
  private launchSource: LaunchSpec['source'] | null = null;
  private readonly logs: string[] = [];
  private healthTimer: NodeJS.Timeout | null = null;

  constructor(private config: LauncherConfig) {}

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
    return {
      status: this.status,
      config: { ...this.config },
      url: this.url,
      mcpUrl: this.mcpUrl,
      pid: this.pid,
      startedAt: this.startedAt,
      error: this.error,
      health: { ...this.health },
      logs: this.logs.slice(-80),
      pluginVersion: PLUGIN_VERSION,
      platform: bundledAppInfo(),
      launchSource: this.launchSource,
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
    this.status = 'starting';

    if (!(await this.portFree(this.config.port))) {
      this.status = 'failed';
      this.error = `端口 ${this.config.port} 已被占用：可能已经有一个游戏厅在跑，换一个端口再试。`;
      return this.snapshot();
    }

    const launch = resolveCommand(this.config);
    const command = launch.command;
    this.launchSource = launch.source;
    const cwd = this.config.cwd || process.cwd();
    this.push(`$ ${command}`);
    this.push(`  cwd: ${cwd}  来源: ${launch.source}`);

    try {
      const child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: {
          ...process.env,
          ...launch.env,
          PORT: String(this.config.port),
          HOST: '127.0.0.1',
          FORCE_COLOR: '0',
        },
      });
      this.child = child;
      child.stdout?.on('data', (chunk: Buffer) => this.push(chunk.toString()));
      child.stderr?.on('data', (chunk: Buffer) => this.push(chunk.toString()));
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
    const child = this.child;
    this.stopHealthPolling();
    if (!child || child.exitCode !== null) {
      this.status = 'stopped';
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
        if (health.games === null && this.status === 'running') {
          this.status = 'failed';
          this.error = '游戏厅进程还在，但 /api/games 不再响应：可能卡住了，试试点「重启」。';
        }
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

export function apply(ctx: any): void {
  // 初始化是异步的，必须把拒绝吃掉：DSH 启动是「全有或全无」，一个未处理的
  // Promise 拒绝可能被进程级处理当成致命错误。启动器挂了顶多是这张卡片不可用，
  // 绝不该拖垮整个 DSH。
  void bootstrap(ctx).catch((err) => {
    console.error('[dsh-whale-game] 初始化失败（插件停用，不影响 DSH）：', err);
  });
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
  const supervisor = new Supervisor(readConfig(configFile));

  const saveConfig = (next: LauncherConfig): void => {
    supervisor.setConfig(next);
    try {
      writeConfig(configFile, next);
    } catch (err) {
      console.warn('[dsh-whale-game] 配置写入失败：', err);
    }
  };

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
          json(res, 200, { ok: true, state: supervisor.snapshot() });
          return;
        }
        if (method === 'GET' && action === 'logs') {
          const state = supervisor.snapshot();
          json(res, 200, { ok: true, logs: state.logs, status: state.status });
          return;
        }
        if (method === 'POST' && action === 'start') {
          json(res, 200, { ok: true, state: await supervisor.start() });
          return;
        }
        if (method === 'POST' && action === 'stop') {
          json(res, 200, { ok: true, state: await supervisor.stop() });
          return;
        }
        if (method === 'POST' && action === 'restart') {
          await supervisor.stop();
          json(res, 200, { ok: true, state: await supervisor.start() });
          return;
        }
        if (method === 'GET' && action === 'config') {
          json(res, 200, { ok: true, config: supervisor.getConfig() });
          return;
        }
        if (method === 'PUT' && action === 'config') {
          const body = normalizeConfig(JSON.parse((await readBody(req)) || '{}'));
          saveConfig(body);
          json(res, 200, { ok: true, config: supervisor.getConfig(), state: supervisor.snapshot() });
          return;
        }
        json(res, 404, { ok: false, error: `未知道路：${method} ${action}` });
      } catch (err) {
        json(res, 500, { ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    },
  });

  // 插件被禁用 / DSH 退出：把子进程连同进程树收掉，绝不留下占着端口的孤儿进程
  ctx.effect(() => {
    return () => {
      void supervisor.stop();
    };
  }, 'ai-playground: dispose supervisor');

  console.log(`  大肥鱼游戏厅：${supervisor.url}${supervisor.getConfig().autoStart ? '（随 DSH 自启）' : ''}`);

  if (supervisor.getConfig().autoStart) {
    void supervisor.start();
  }
}
