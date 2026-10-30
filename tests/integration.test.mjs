/**
 * 桌面集成的行为测试：
 *   1. `autoStart` 默认变成 true（老配置没写这个字段时也按 true 走）；
 *   2. 端口已被占用 + /api/games 能通 → 识别成「外部实例」：绿灯、可玩、**绝不 kill**；
 *   3. 端口被占用但不是游戏厅 → failed 并给出「换端口」的人话；
 *   4. /status 里唤醒桥与 MCP 字段始终齐全（界面直接渲染它们，缺字段会白屏）。
 *
 * 这些用例都在临时 DSH_HOME 里跑，且不会碰真实的 8787。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';

import { apply } from '../lib/index.js';
import { callRoute, makeFakeCtx, makeTempHome, waitFor } from './helpers.mjs';

/** 借一个当前空闲的端口（先 listen(0) 拿系统分配，再关掉）。 */
function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
}

/** 假游戏厅：只实现健康检查要的那一个接口。 */
function fakeHall() {
  const server = http.createServer((req, res) => {
    if (req.url === '/api/games') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ games: [{ id: 'grab' }, { id: 'connect4' }] }));
      return;
    }
    res.statusCode = 404;
    res.end('nope');
  });
  return {
    server,
    listen: (port) => new Promise((resolve) => server.listen(port, '127.0.0.1', resolve)),
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

async function boot({ home, port, autoStart }) {
  const previousHome = process.env.DSH_HOME;
  const previousProfile = process.env.DSH_PROFILE;
  process.env.DSH_HOME = home;
  process.env.DSH_PROFILE = 'integration-profile';
  const fake = makeFakeCtx();
  apply(fake.ctx);
  await waitFor(() => fake.route() !== undefined, { label: '路由注册' });
  const route = fake.route();
  return {
    route,
    call: (method, path, body) => callRoute(route, method, path, { body }),
    async cleanup() {
      await fake.dispose();
      if (previousHome === undefined) delete process.env.DSH_HOME;
      else process.env.DSH_HOME = previousHome;
      if (previousProfile === undefined) delete process.env.DSH_PROFILE;
      else process.env.DSH_PROFILE = previousProfile;
    },
    // autoStart/port 只是提醒调用方它们写进了 config.json，用例本身不依赖
    config: { autoStart, port },
  };
}

test('autoStart 默认 true：老配置缺字段时也按 true 归一（PUT /config 空对象可见）', async () => {
  const tmp = makeTempHome('whale-int-default');
  // 先关掉自启：用例只验归一化，不去碰真实 8787
  tmp.writeConfig({ port: 8787, autoStart: false, openOnStart: false, wakeSecret: 'seed-secret' });
  const ctx = await boot({ home: tmp.home, port: 8787, autoStart: false });
  try {
    // 走的是和读 config.json 同一个 normalizeConfig：body 里没有 autoStart 就必须是 true
    const res = await ctx.call('PUT', '/whale-arcade/config', { port: 8787 });
    assert.equal(res.status, 200);
    assert.equal(res.body.config.autoStart, true, '缺省必须是 true');
    // 明确写 false 要尊重（用户真的关了）
    const off = await ctx.call('PUT', '/whale-arcade/config', { port: 8787, autoStart: false });
    assert.equal(off.body.config.autoStart, false);
    assert.equal(off.body.state.wake.available, false);
  } finally {
    await ctx.cleanup();
    tmp.cleanup();
  }
});

test('端口已有游戏厅 → 外部实例绿灯，stop 不发 kill', async () => {
  const port = await freePort();
  const hall = fakeHall();
  await hall.listen(port);
  const tmp = makeTempHome('whale-int-external');
  tmp.writeConfig({ port, autoStart: true, wakeSecret: 'external-secret' });
  const ctx = await boot({ home: tmp.home, port, autoStart: true });
  try {
    await waitFor(
      async () => {
        const status = await ctx.call('GET', '/whale-arcade/status');
        return status.body?.state?.status === 'running';
      },
      { label: '自启识别到外部实例' },
    );

    const status = await ctx.call('GET', '/whale-arcade/status');
    const state = status.body.state;
    assert.equal(state.owner, 'external');
    assert.equal(state.pid, null, '外部实例没有我们的 pid');
    assert.equal(state.health.games, 2);
    assert.match(state.notice, /不负责停止/);
    assert.equal(state.error, null, '外部实例不是错误');

    // 停止：只放手，不发 kill —— 假游戏厅必须还活着
    const stopped = await ctx.call('POST', '/whale-arcade/stop');
    assert.equal(stopped.body.state.status, 'stopped');
    assert.equal(stopped.body.state.owner, null);
    const stillAlive = await new Promise((resolve) => {
      const req = http.get({ host: '127.0.0.1', port, path: '/api/games' }, (res) => {
        res.resume();
        resolve(res.statusCode === 200);
      });
      req.on('error', () => resolve(false));
    });
    assert.equal(stillAlive, true, '外部实例不能被插件杀掉');
  } finally {
    await ctx.cleanup();
    await hall.close();
    tmp.cleanup();
  }
});

test('端口被占但不是游戏厅 → failed，提示换端口（不误判成外部实例）', async () => {
  const port = await freePort();
  // 一个只说 TCP、不说 HTTP 的占用者：健康检查必然失败
  const squatter = net.createServer((socket) => socket.destroy());
  await new Promise((resolve) => squatter.listen(port, '127.0.0.1', resolve));
  const tmp = makeTempHome('whale-int-squat');
  tmp.writeConfig({ port, autoStart: false, wakeSecret: 'squat-secret' });
  const ctx = await boot({ home: tmp.home, port, autoStart: false });
  try {
    const res = await ctx.call('POST', '/whale-arcade/start');
    assert.equal(res.body.state.status, 'failed');
    assert.equal(res.body.state.owner, null);
    assert.match(res.body.state.error, /换一个端口/);
  } finally {
    await ctx.cleanup();
    await new Promise((resolve) => squatter.close(resolve));
    tmp.cleanup();
  }
});

test('PUT /config 不带 wakeSecret 时不会把密钥清空（保存端口不该让平台配置失效）', async () => {
  const tmp = makeTempHome('whale-int-secret');
  tmp.writeConfig({ port: 8792, autoStart: false, wakeSecret: 'keep-me-please' });
  const ctx = await boot({ home: tmp.home, port: 8792, autoStart: false });
  try {
    const res = await ctx.call('PUT', '/whale-arcade/config', { port: 8793 });
    assert.equal(res.body.config.wakeSecret, 'keep-me-please');
    assert.equal(res.body.state.wake.secret, 'keep-me-please');
    // 显式给新值当然要能改
    const changed = await ctx.call('PUT', '/whale-arcade/config', { port: 8793, wakeSecret: 'brand-new-secret' });
    assert.equal(changed.body.state.wake.secret, 'brand-new-secret');
  } finally {
    await ctx.cleanup();
    tmp.cleanup();
  }
});

test('/status 字段齐全：wake/mcp/owner 都在，密钥与文件路径可读', async () => {
  const tmp = makeTempHome('whale-int-shape');
  tmp.writeConfig({ port: 8791, autoStart: false, wakeSecret: 'shape-secret' });
  const ctx = await boot({ home: tmp.home, port: 8791, autoStart: false });
  try {
    const res = await ctx.call('GET', '/whale-arcade/status');
    assert.equal(res.status, 200);
    const state = res.body.state;
    assert.equal(state.owner, null);
    assert.equal(state.wake.available, false, '假 ctx 没注入服务 → 唤醒不可用但不影响状态接口');
    assert.equal(state.wake.secret, 'shape-secret');
    assert.equal(state.wake.secretSource, 'config');
    assert.match(state.wake.url, /\/whale-arcade\/wake$/);
    // 不要断言具体端口：真实 DSH_WEB_URL 会从外部环境漏进来（开发机端口每次都不一样），
    // 那条「优先 DSH_WEB_URL、其次宿主 origin」的优先级由 wake.test.mjs 的 resolveWakeBase 用例保证。
    assert.match(state.wake.url, /^http:\/\/127\.0\.0\.1:\d+\/whale-arcade\/wake$/);
    assert.equal(state.wake.sourceKind, 'wake');
    assert.ok(['present', 'written', 'failed', 'skipped'].includes(state.mcp.action));
    // profile 目录在本用例里不存在 → 降级成 failed，但 snippet 必须可复制
    assert.equal(state.mcp.action, 'failed');
    assert.match(state.mcp.snippet, /- insert:/);
  } finally {
    await ctx.cleanup();
    tmp.cleanup();
  }
});
