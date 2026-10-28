#!/usr/bin/env node
/**
 * 真机联调（不碰 DSH）：用假的宿主上下文加载宿主半侧，真的去拉起游戏厅进程，
 * 验证「起 → 健康检查 → 停 → 端口释放」这条主链路。
 *
 * 用法：
 *   node scripts/e2e-local.mjs <游戏厅仓库路径>
 *   AI_PLAYGROUND_REPO=<路径> node scripts/e2e-local.mjs
 *
 * 需要一个可用的 AI 游乐场源码目录（https://github.com/Treasure-hub-agent/ai-playground），
 * 因为它会真的 `node <repo>/packages/cli/src/index.ts serve` 起一次服务再关掉。
 */
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';

const repo = process.argv[2] ?? process.env.AI_PLAYGROUND_REPO ?? '';
if (!repo || !existsSync(join(repo, 'packages', 'cli', 'src', 'index.ts'))) {
  console.error('用法：node scripts/e2e-local.mjs <AI 游乐场仓库路径>');
  console.error('（或设置 AI_PLAYGROUND_REPO 环境变量）');
  process.exit(2);
}
const port = 8907;
const dataHome = mkdtempSync(join(tmpdir(), 'whale-arcade-e2e-'));
process.env.DSH_HOME = dataHome;

let failed = 0;
const ok = (label) => console.log(`  ✓ ${label}`);
const bad = (label, detail) => {
  failed += 1;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
};
const assert = (cond, label, detail) => (cond ? ok(label) : bad(label, detail));

const host = await import('../lib/index.js');
let route = null;
host.apply({
  webServer: { register: (spec) => (route = spec) },
  effect: (factory) => {
    const dispose = factory();
    return () => (typeof dispose === 'function' ? dispose() : undefined);
  },
});
await new Promise((r) => setTimeout(r, 50));

if (!route) {
  console.log('  ✗ 路由没注册');
  process.exit(1);
}

const call = async (method, path, body) => {
  let status = 200;
  let payload = '';
  const req = {
    method,
    url: path,
    async *[Symbol.asyncIterator]() {
      if (body !== undefined) yield Buffer.from(JSON.stringify(body));
    },
  };
  const res = {
    setHeader() {},
    end: (t) => (payload = t),
    set statusCode(v) {
      status = v;
    },
    get statusCode() {
      return status;
    },
  };
  await route.handler(req, res);
  return { status, body: JSON.parse(payload) };
};

const portFree = () =>
  new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(false));
    s.once('listening', () => s.close(() => resolve(true)));
    s.listen(port, '127.0.0.1');
  });

console.log(`\n[e2e] repo=${repo} port=${port}`);

// 1. 先把启动命令指向本机仓库，端口换成测试端口
await call('PUT', '/whale-arcade/config', {
  port,
  command: `node "${repo}/packages/cli/src/index.ts" serve`,
  cwd: repo,
  autoStart: false,
  openOnStart: false,
});

// 2. 起
const started = await call('POST', '/whale-arcade/start');
assert(started.body?.state?.status === 'running', '启动后状态是 running', JSON.stringify(started.body?.state?.status));
assert(started.body?.state?.health?.games === 6, '健康检查探到 6 款游戏', String(started.body?.state?.health?.games));
assert(started.body?.state?.url === `http://127.0.0.1:${port}/`, 'URL 正确', started.body?.state?.url);
assert(typeof started.body?.state?.pid === 'number', '拿到了子进程 pid', String(started.body?.state?.pid));

// 3. 停
const stopped = await call('POST', '/whale-arcade/stop');
assert(stopped.body?.state?.status === 'stopped', '停止后状态是 stopped', JSON.stringify(stopped.body?.state?.status));
await new Promise((r) => setTimeout(r, 800));
assert(await portFree(), '端口已释放', `port ${port}`);

// 4. 日志里应该留下"已启动/ready"的痕迹
const after = await call('GET', '/whale-arcade/status');
const logs = (after.body?.state?.logs ?? []).join('\n');
assert(/\[ready\]/.test(logs), '日志里有 ready 记录');

rmSync(dataHome, { recursive: true, force: true });
console.log(failed === 0 ? '\n✅ 真机联调通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
