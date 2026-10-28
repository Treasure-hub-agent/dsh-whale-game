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
import { join } from 'node:path';
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
 * 启动命令的解析顺序（空配置时）：
 *   1. 环境变量 PLAYGROUND_CMD（给高级用户留的逃生口）
 *   2. 本机仓库里的 CLI（开发期最常用）
 *   3. npx —— 游戏厅发到 npm 之后这条路会自动可用
 */
function resolveCommand(config: LauncherConfig): string {
  if (config.command) return config.command;
  const fromEnv = process.env.PLAYGROUND_CMD?.trim();
  if (fromEnv) return fromEnv;
  const localRepo = process.env.AI_PLAYGROUND_REPO?.trim();
  if (localRepo) return `node "${join(localRepo, 'packages/cli/src/index.ts')}" serve`;
  return 'npx --yes ai-playground@latest serve';
}

class Supervisor {
  private child: ChildProcess | null = null;
  private status: LauncherStatus = 'stopped';
  private startedAt: number | null = null;
  private error: string | null = null;
  private health: HealthInfo = { games: null, firstGame: null, latencyMs: null };
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

    const command = resolveCommand(this.config);
    const cwd = this.config.cwd || process.cwd();
    this.push(`$ ${command}`);
    this.push(`  cwd: ${cwd}`);

    try {
      const child = spawn(command, {
        cwd,
        shell: true,
        windowsHide: true,
        detached: process.platform !== 'win32',
        env: { ...process.env, PORT: String(this.config.port), HOST: '127.0.0.1', FORCE_COLOR: '0' },
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
