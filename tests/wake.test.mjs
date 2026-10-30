/**
 * 唤醒桥的契约测试（对应设计文档 §6 验收标准 1 的「插件侧 3 个测试」的超集）：
 *   鉴权失败 / 形状校验 / 快乐路径 / 3 秒去抖 / 会话不可用降级 / 文案 2KB 截断 /
 *   source.kind 降级（followup 不被接受 → 换 schedule 再投一次）。
 *
 * 全部跑在**构建产物** lib/index.js 上：测的就是真正会被 DSH 加载的那份代码。
 */
import test from 'node:test';
import assert from 'node:assert/strict';

import { apply, buildWakeEnv, buildWakeText, MAX_TEXT_BYTES, resolveWakeBase, validateWakePayload } from '../lib/index.js';
import { callRoute, makeFakeCtx, makeTempHome, makeWakeServices, waitFor } from './helpers.mjs';

const SECRET = 'test-secret-0123456789';

/** 起一个装好配置的插件实例（临时 DSH_HOME，不碰真实环境）。 */
async function boot({ services = null, config = {} } = {}) {
  const tmp = makeTempHome('whale-wake');
  tmp.writeConfig({ port: 8799, autoStart: false, wakeSecret: SECRET, ...config });
  const previousHome = process.env.DSH_HOME;
  const previousSecret = process.env.WHALE_WAKE_SECRET;
  const previousProfile = process.env.DSH_PROFILE;
  process.env.DSH_HOME = tmp.home;
  delete process.env.WHALE_WAKE_SECRET;
  process.env.DSH_PROFILE = 'unittest-profile'; // 让 MCP 自注册走「profile 不存在 → failed」的降级分支
  const fake = makeFakeCtx({ services });
  apply(fake.ctx);
  await waitFor(() => fake.route() !== undefined, { label: '路由注册' });
  const route = fake.route();
  const wake = (body, headers = { 'x-wake-secret': SECRET }, method = 'POST') =>
    callRoute(route, method, '/whale-arcade/wake', { body, headers });
  const cleanup = async () => {
    await fake.dispose();
    tmp.cleanup();
    process.env.DSH_HOME = previousHome;
    if (previousSecret === undefined) delete process.env.WHALE_WAKE_SECRET;
    else process.env.WHALE_WAKE_SECRET = previousSecret;
    if (previousProfile === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = previousProfile;
  };
  return { route, wake, tmp, cleanup };
}

const payload = (over = {}) => ({ roomId: 'room-1', sessionId: 'session-abc', gameId: 'grab', gameName: '抢宝大作战', round: 3, rounds: 9, textView: 'A1 金币 2 · B2 空', ...over });

test('鉴权：缺头 / 错值 / 大小写正确都得到 bad-secret（401）', async () => {
  const { wake, cleanup } = await boot({ services: makeWakeServices().services });
  try {
    const missing = await wake(payload(), {});
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error, 'bad-secret');
    assert.match(missing.body.message, /x-wake-secret/);

    const wrong = await wake(payload(), { 'x-wake-secret': 'nope' });
    assert.equal(wrong.status, 401);
    assert.equal(wrong.body.error, 'bad-secret');

    // 头名大小写不敏感（Node 会小写化，但别的地方可能不是）
    const ok = await wake(payload(), { 'X-Wake-Secret': SECRET });
    assert.equal(ok.status, 200, JSON.stringify(ok.body));
    assert.equal(ok.body.ok, true);
  } finally {
    await cleanup();
  }
});

test('bad-request：形状不合法一律 400，且不投递', async () => {
  const { services, delivered } = makeWakeServices();
  const { wake, cleanup } = await boot({ services });
  try {
    const cases = [
      { roomId: '../etc/passwd', sessionId: 'session-abc' },
      { roomId: 'room-1', sessionId: 'has space' },
      { roomId: '', sessionId: 'session-abc' },
      { roomId: 'room-1', sessionId: 'x'.repeat(129) },
      { roomId: 'room-1', sessionId: 'session-abc', round: 9, rounds: 3 },
    ];
    for (const body of cases) {
      const res = await wake(body);
      assert.equal(res.status, 400, `${JSON.stringify(body)} → ${res.status}`);
      assert.equal(res.body.error, 'bad-request');
    }

    const malformed = await wake('{not json');
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error, 'bad-request');

    const notPost = await wake(undefined, { 'x-wake-secret': SECRET }, 'GET');
    assert.equal(notPost.status, 405);

    assert.equal(delivered.length, 0, '非法请求不该投递任何消息');
  } finally {
    await cleanup();
  }
});

test('快乐路径：投递一条 user 消息（source.kind=wake），响应带 deliveredAt/sessionId', async () => {
  const { services, delivered } = makeWakeServices();
  const { wake, cleanup } = await boot({ services });
  try {
    const res = await wake(payload());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.ok, true);
    assert.equal(res.body.sessionId, 'session-abc');
    assert.equal(res.body.sourceKind, 'wake');
    assert.match(res.body.deliveredAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(delivered.length, 1);

    const message = delivered[0];
    assert.equal(message.role, 'user');
    assert.equal(message.source.kind, 'wake');
    const text = message.content[0].text;
    assert.match(text, /该你出招了/);
    assert.match(text, /room-1/);
    assert.match(text, /抢宝大作战/);
    assert.match(text, /第 3\/9 回合/);
    assert.match(text, /submit_action/);
    assert.match(text, /不要猜对手本回合的选择/);
    assert.match(text, /A1 金币 2/);
  } finally {
    await cleanup();
  }
});

test('去抖：同 roomId+round 3 秒内只投一次，换回合或过窗口后放行', async () => {
  const { services, delivered } = makeWakeServices();
  const { wake, cleanup } = await boot({ services });
  try {
    const first = await wake(payload());
    assert.equal(first.status, 200);
    assert.equal(first.body.deduped, undefined);

    const second = await wake(payload());
    assert.equal(second.status, 200, '重复请求也算成功（平台不该因为去抖而失败）');
    assert.equal(second.body.deduped, true);
    assert.equal(second.body.deliveredAt, first.body.deliveredAt, '去抖时回的是首次投递时间');
    assert.equal(delivered.length, 1);

    // 同一房间换了回合：必须再叫一次
    const nextRound = await wake(payload({ round: 4 }));
    assert.equal(nextRound.body.deduped, undefined);
    assert.equal(delivered.length, 2);

    // 换房间：独立去抖
    const otherRoom = await wake(payload({ roomId: 'room-2', round: 4 }));
    assert.equal(otherRoom.body.deduped, undefined);
    assert.equal(delivered.length, 3);

    // 等过 3 秒窗口：同房间同回合可以再次投递（平台二次唤醒）
    await new Promise((r) => setTimeout(r, 3200));
    const later = await wake(payload());
    assert.equal(later.body.deduped, undefined);
    assert.equal(delivered.length, 4);
  } finally {
    await cleanup();
  }
});

test('session-unavailable：resolveAgent 报错 → 409，且界面能读到 lastError', async () => {
  const { services } = makeWakeServices({ resolveError: new Error('session not found') });
  const { wake, cleanup, route } = await boot({ services });
  try {
    const res = await wake(payload());
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'session-unavailable');
    assert.match(res.body.message, /session not found/);

    const status = await callRoute(route, 'GET', '/whale-arcade/status');
    assert.equal(status.body.state.wake.available, true);
    assert.match(status.body.state.wake.lastError, /session not found/);
    assert.equal(status.body.state.wake.delivered, 0);
  } finally {
    await cleanup();
  }
});

test('session-unavailable：宿主没提供 sessionController/sessions → 409 而不是让插件挂掉', async () => {
  const { wake, cleanup, route } = await boot({ services: null });
  try {
    const res = await wake(payload());
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'session-unavailable');

    const status = await callRoute(route, 'GET', '/whale-arcade/status');
    assert.equal(status.status, 200, '状态接口必须照常可用');
    assert.equal(status.body.state.wake.available, false);
  } finally {
    await cleanup();
  }
});

test('持久化没确认（flush=false）→ 409，且不重试（避免同一回合叫醒两次）', async () => {
  const { services } = makeWakeServices({ flushResult: false });
  const { wake, cleanup } = await boot({ services });
  try {
    const res = await wake(payload());
    assert.equal(res.status, 409);
    assert.equal(res.body.error, 'session-unavailable');
    assert.equal(res.body.phase, 'flush');
    assert.match(res.body.message, /持久化/);
  } finally {
    await cleanup();
  }
});

test("source.kind 降级：followup 拒绝 'wake' → 自动换 'schedule' 重投一次并记住", async () => {
  let attempts = 0;
  const delivered = [];
  const services = {
    sessionController: {
      async resolveAgent(sessionId) {
        return {
          agent: {
            session: { id: sessionId },
            followup(message) {
              attempts += 1;
              if (message.source.kind === 'wake') throw new Error('invalid message source kind "wake"');
              delivered.push(message);
            },
          },
        };
      },
    },
    sessions: { async flush() { return true; } },
  };
  const { wake, cleanup, route } = await boot({ services });
  try {
    const res = await wake(payload());
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.sourceKind, 'schedule');
    assert.equal(attempts, 2, '先试 wake，再退 schedule');
    assert.equal(delivered.length, 1);
    assert.equal(delivered[0].source.kind, 'schedule');

    // 降级是粘性的：下一次直接用 schedule，不再浪费一次失败尝试
    const second = await wake(payload({ round: 5 }));
    assert.equal(second.body.sourceKind, 'schedule');
    assert.equal(attempts, 3);

    const status = await callRoute(route, 'GET', '/whale-arcade/status');
    assert.equal(status.body.state.wake.sourceKind, 'schedule');
  } finally {
    await cleanup();
  }
});

test('文案：超长盘面按 2KB 截断，头尾指令必须完整保留', () => {
  const huge = '金币'.repeat(5000);
  const text = buildWakeText(payload({ textView: huge }));
  assert.ok(Buffer.byteLength(text, 'utf8') <= MAX_TEXT_BYTES, `实际 ${Buffer.byteLength(text, 'utf8')} 字节`);
  assert.match(text, /^🎮 该你出招了/);
  assert.match(text, /盘面已截断/);
  assert.match(text, /不要托管整局。/);
});

test('payload 校验：round 容忍字符串数字，游戏名压成单行', () => {
  const ok = validateWakePayload({ roomId: 'r1', sessionId: 's1', round: '4', rounds: '9', gameName: '抢宝\n大作战', textView: 'x' });
  assert.equal(ok.ok, true);
  assert.equal(ok.payload.round, 4);
  assert.equal(ok.payload.rounds, 9);
  assert.equal(ok.payload.gameName, '抢宝 大作战');
});

test('平台最终契约：带 createdAt/nonce 的 body 也照常投递（这两个字段插件不用，但不能拒）', async () => {
  const { services, delivered } = makeWakeServices();
  const { wake, cleanup } = await boot({ services });
  try {
    const res = await wake(
      payload({
        createdAt: Date.now(),
        nonce: 'n-0123456789abcdef',
        // 平台侧 round 取的是游戏观测的 round（connect4 是手数），0 也得能过
        round: 0,
        rounds: undefined,
      }),
    );
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.equal(res.body.round, 0);
    assert.equal(delivered.length, 1);
    // 去重键用 round：0 回合也是有效回合，不能被当成「没给 round」
    const again = await wake(payload({ createdAt: Date.now(), round: 0, rounds: undefined }));
    assert.equal(again.body.deduped, true);
  } finally {
    await cleanup();
  }
});

test('buildWakeEnv：给游戏厅进程注入 WAKE_URL/WAKE_SECRET，缺 base 时不瞎猜', () => {
  const withBase = buildWakeEnv({ base: 'http://127.0.0.1:52183/', wakeSecret: 'abc123' });
  assert.equal(withBase.missingUrl, false);
  assert.equal(withBase.env.WAKE_URL, 'http://127.0.0.1:52183/whale-arcade/wake');
  assert.equal(withBase.env.WAKE_SECRET, 'abc123');

  const without = buildWakeEnv({ base: null, wakeSecret: 'abc123' });
  assert.equal(without.missingUrl, true);
  assert.equal(without.env.WAKE_URL, undefined, '没有 base 就不写 WAKE_URL');
  assert.equal(without.env.WAKE_SECRET, 'abc123');
});

test('resolveWakeBase：优先 DSH_WEB_URL，其次宿主 origin，都没有就返回 none', () => {
  const previous = process.env.DSH_WEB_URL;
  try {
    process.env.DSH_WEB_URL = 'http://127.0.0.1:52999';
    assert.deepEqual(resolveWakeBase({ getOrigin: () => 'http://127.0.0.1:52183' }), {
      base: 'http://127.0.0.1:52999',
      source: 'env',
    });

    delete process.env.DSH_WEB_URL;
    assert.deepEqual(resolveWakeBase({ getOrigin: () => 'http://127.0.0.1:52183' }), {
      base: 'http://127.0.0.1:52183',
      source: 'origin',
    });
    assert.deepEqual(resolveWakeBase({ getOrigin: () => { throw new Error('not listening'); } }), {
      base: null,
      source: 'none',
    });
  } finally {
    if (previous === undefined) delete process.env.DSH_WEB_URL;
    else process.env.DSH_WEB_URL = previous;
  }
});


test('文案：reason=ended 换成结束语气，带结算文案并提醒 say 收尾（第 15 轮）', () => {
  const text = buildWakeText(
    payload({ reason: 'ended', resultText: '座位 0 获胜！率先连成四子（共 15 手）。', textView: '四子棋 · 对局结束' }),
  );
  assert.match(text, /^🏁 对局结束了/);
  assert.match(text, /座位 0 获胜/);
  assert.match(text, /playground_say/);
  assert.match(text, /playground_get_result/);
  assert.doesNotMatch(text, /该你出招了/);
});

test('文案：每手都提醒用 playground_say 说话（否则人类觉得在跟机器玩）', () => {
  const text = buildWakeText(payload({ textView: '盘面' }));
  assert.match(text, /playground_say/);
});

test('payload 校验：reason 只认 ended，其余脏值一律按 turn', () => {
  assert.equal(validateWakePayload({ roomId: 'r1', sessionId: 's1', reason: 'ended' }).payload.reason, 'ended');
  assert.equal(validateWakePayload({ roomId: 'r1', sessionId: 's1', reason: 'hack' }).payload.reason, 'turn');
  assert.equal(validateWakePayload({ roomId: 'r1', sessionId: 's1' }).payload.reason, 'turn');
});

// ─────────── 可唤醒性预检 /whale-arcade/wake/check（第 18 轮） ───────────

test('check：主会话可唤醒 → wakeable:true，且**不投递**任何消息', async () => {
  const svc = makeWakeServices();
  const { route, cleanup } = await boot({ services: svc.services });
  try {
    const res = await callRoute(route, 'POST', '/whale-arcade/wake/check', {
      body: { sessionId: 'session-ok' },
      headers: { 'x-wake-secret': SECRET },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.wakeable, true);
    assert.equal(svc.delivered.length, 0, 'check 只问不投，不能往会话里塞消息');
  } finally {
    await cleanup();
  }
});

test('check：subagent 会话 → 200 + wakeable:false + reason（平台据此婉拒，而不是等落子才发现）', async () => {
  const svc = makeWakeServices({ resolveError: new Error('session "x" is owned by subagent routing') });
  const { route, cleanup } = await boot({ services: svc.services });
  try {
    const res = await callRoute(route, 'POST', '/whale-arcade/wake/check', {
      body: { sessionId: 'session-sub' },
      headers: { 'x-wake-secret': SECRET },
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.wakeable, false);
    assert.match(String(res.body.reason), /subagent routing/);
    assert.equal(svc.delivered.length, 0);
  } finally {
    await cleanup();
  }
});

test('check：鉴权与形状校验和 /wake 一致（缺密钥 401、坏 sessionId 400）', async () => {
  const svc = makeWakeServices();
  const { route, cleanup } = await boot({ services: svc.services });
  try {
    const noSecret = await callRoute(route, 'POST', '/whale-arcade/wake/check', { body: { sessionId: 's1' }, headers: {} });
    assert.equal(noSecret.status, 401);
    const badId = await callRoute(route, 'POST', '/whale-arcade/wake/check', {
      body: { sessionId: 'has space' },
      headers: { 'x-wake-secret': SECRET },
    });
    assert.equal(badId.status, 400);
  } finally {
    await cleanup();
  }
});
