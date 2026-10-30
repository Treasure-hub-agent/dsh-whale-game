/**
 * 单测脚手架：假宿主上下文。
 *
 * 为什么不用真 DSH：起一次真宿主就得重启 DSH（会掐掉正在跑的会话）；而这里要验的
 * 都是插件自己的分支逻辑（鉴权 / 去抖 / 降级 / 写配置），只要把宿主**最小契约**模拟
 * 出来就够了——`webServer.register`、`ctx.inject(deps, cb)`、`ctx.effect`。
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 造一个临时 DSH_HOME（每个用例一个，互不污染，也绝不碰真实 profile）。 */
export function makeTempHome(label = 'whale-test') {
  const home = mkdtempSync(join(tmpdir(), `${label}-`));
  return {
    home,
    configFile: join(home, 'whale-arcade', 'config.json'),
    writeConfig(config) {
      mkdirSync(join(home, 'whale-arcade'), { recursive: true });
      writeFileSync(join(home, 'whale-arcade', 'config.json'), JSON.stringify(config, null, 2), 'utf8');
    },
    cleanup() {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

/**
 * 假 ctx。`services` 是唤醒桥要的两个服务（sessionController / sessions），
 * 传 null 表示「宿主没提供」——用来验证插件降级而不是整体挂掉。
 */
export function makeFakeCtx({ services = null, origin = 'http://127.0.0.1:52183' } = {}) {
  const routes = [];
  const disposers = [];
  const injections = [];
  const ctx = {
    webServer: {
      register(spec) {
        routes.push(spec);
      },
      getOrigin: () => origin,
    },
    inject(deps, callback) {
      injections.push(deps);
      if (services) callback({ ...ctx, ...services });
    },
    effect(factory) {
      const dispose = factory();
      disposers.push(dispose);
      return () => undefined;
    },
  };
  return {
    ctx,
    routes,
    disposers,
    injections,
    route: () => routes.find((r) => r.path === '/whale-arcade'),
    async dispose() {
      for (const d of disposers) if (typeof d === 'function') await d();
    },
  };
}

/** 直接调路由 handler（模拟 Node 的 req/res，够插件用）。 */
export async function callRoute(route, method, path, { body, headers = {} } = {}) {
  let status = 200;
  let payload = '';
  const req = {
    method,
    url: path,
    headers,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    },
  };
  const res = {
    setHeader() {},
    end(text) {
      payload = text;
    },
    set statusCode(v) {
      status = v;
    },
    get statusCode() {
      return status;
    },
  };
  await route.handler(req, res);
  let parsed = null;
  try {
    parsed = payload ? JSON.parse(payload) : null;
  } catch {
    parsed = payload;
  }
  return { status, body: parsed };
}

/** 等一个断言成立（异步状态机用），超时抛错。 */
export async function waitFor(predicate, { timeoutMs = 5000, intervalMs = 50, label = '条件' } = {}) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`等待超时：${label}`);
}

/** 造一个工作正常的假 sessionController + sessions，记录每次投递。 */
export function makeWakeServices({ resolveError = null, followupThrows = null, flushResult = true } = {}) {
  const delivered = [];
  const state = {
    sessionController: {
      async resolveAgent(sessionId) {
        if (resolveError) return { error: resolveError };
        return {
          agent: {
            session: { id: sessionId },
            followup(message) {
              if (followupThrows) throw followupThrows;
              delivered.push(message);
            },
          },
        };
      },
    },
    sessions: {
      async flush() {
        return flushResult;
      },
    },
  };
  return { services: state, delivered };
}
