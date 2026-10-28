#!/usr/bin/env node
/**
 * 安装前的静态自检：不碰真实 DSH，用假的宿主上下文把两个半侧各跑一遍。
 *
 * 覆盖的契约（任何一个挂了都会被 DSH 判成「插件加载失败」，而 DSH 是全有或全无启动）：
 *   宿主半侧：ESM 导出 { name, inject, apply }；apply 注册了路由；status/config 路由可用
 *   浏览器半侧：是普通副作用脚本；调用 __ModuleLoader__.load；factory 返回 { name, inject, apply }；
 *               apply 注册了 sidebar.footer.action 与 shell.overlay 两个插槽
 */
import { readFileSync, rmSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import vm from 'node:vm';

let failed = 0;
const ok = (label) => console.log(`  ✓ ${label}`);
const bad = (label, detail) => {
  failed += 1;
  console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
};
const assert = (cond, label, detail) => (cond ? ok(label) : bad(label, detail));

// ─────────────────────────────── 宿主半侧 ───────────────────────────────
console.log('\n[host] lib/index.js');

const hostMod = await import('../lib/index.js');
assert(hostMod.name === 'whale-arcade', 'name 正确', hostMod.name);
assert(Array.isArray(hostMod.inject) && hostMod.inject.includes('webServer'), 'inject 声明了 webServer', JSON.stringify(hostMod.inject));
assert(typeof hostMod.apply === 'function', 'apply 是函数');

// 假的 webServer：把注册进来的 handler 抓出来
let route = null;
const fakeCtx = {
  webServer: {
    register(spec) {
      route = spec;
    },
  },
  effect(factory) {
    // 模拟 cordis：立刻执行并持有 disposer
    const dispose = factory();
    return () => (typeof dispose === 'function' ? dispose() : undefined);
  },
};

// 数据目录指到临时目录，别写进真实 $DSH_HOME
const dataHome = mkdtempSync(join(tmpdir(), 'whale-arcade-smoke-'));
process.env.DSH_HOME = dataHome;

hostMod.apply(fakeCtx);
await new Promise((r) => setTimeout(r, 50));

assert(route !== null && route.kind === 'prefix', '注册了 prefix 路由', JSON.stringify(route?.path));
assert(route?.path === '/whale-arcade', '路由前缀正确', route?.path);

if (route) {
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
    return { status, body: payload ? JSON.parse(payload) : null };
  };

  const status = await call('GET', '/whale-arcade/status');
  assert(status.status === 200 && status.body?.ok === true, 'GET /status 200');
  assert(status.body?.state?.status === 'stopped', '初始状态是 stopped', status.body?.state?.status);
  assert(status.body?.state?.url === 'http://127.0.0.1:8787/', '默认地址是 8787', status.body?.state?.url);

  const save = await call('PUT', '/whale-arcade/config', { port: 8899, command: 'echo hi', autoStart: false });
  assert(save.status === 200 && save.body?.config?.port === 8899, 'PUT /config 保存端口', JSON.stringify(save.body?.config));

  const status2 = await call('GET', '/whale-arcade/status');
  assert(status2.body?.state?.url === 'http://127.0.0.1:8899/', '保存后地址跟着变', status2.body?.state?.url);

  const reject = await call('PUT', '/whale-arcade/config', { port: 80 });
  assert(reject.body?.config?.port === 8787, '非法端口回落到默认', reject.body?.config?.port);

  const nope = await call('GET', '/whale-arcade/nope');
  assert(nope.status === 404, '未知路由 404');
}

// ────────────────────────────── 浏览器半侧 ──────────────────────────────
console.log('\n[client] lib/client.js');

const clientSource = readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8');
assert(!/^\s*(import|export)\s/m.test(clientSource), '没有顶层 ESM 语法（副作用脚本）');

let loaded = null;
const styleTags = [];
const fakeWindow = {
  __ModuleLoader__: {
    load(info) {
      loaded = info;
    },
  },
  addEventListener() {},
  removeEventListener() {},
  innerWidth: 1440,
  innerHeight: 900,
};
const fakeDocument = {
  querySelector: () => null,
  createElement: () => ({ dataset: {}, textContent: '' }),
  head: { appendChild: (el) => styleTags.push(el) },
};

vm.runInNewContext(clientSource, { window: fakeWindow, document: fakeDocument, console, setTimeout, clearTimeout });

assert(loaded !== null, '调用了 __ModuleLoader__.load');
assert(loaded?.id === 'dsh-whale-arcade', 'id 正确', loaded?.id);

const hookStub = (initial) => [typeof initial === 'function' ? initial() : initial, () => {}];
const reactStub = {
  createElement: (type, props, ...children) => ({ type, props, children }),
  Fragment: Symbol('Fragment'),
  useState: hookStub,
  useEffect: () => undefined,
  useRef: (initial) => ({ current: initial }),
  useCallback: (fn) => fn,
};

const module = loaded?.factory?.(() => reactStub);
assert(module?.name === 'whale-arcade', 'factory 返回的 name 正确', module?.name);
assert(typeof module?.apply === 'function', 'factory 返回 apply');

const registered = [];
const components = {};
const fakeClientCtx = {
  locale: { register() {}, bind: () => (key) => key },
  slots: {
    inject(name, factory) {
      registered.push(name);
      const result = factory();
      return result;
    },
    register(spec, component) {
      components[spec.name] = component;
      return { dispose() {}, name: spec.name, id: spec.id };
    },
  },
};

module.apply(fakeClientCtx);
assert(registered.includes('sidebar.footer.action'), '注册了左侧栏细条', registered.join(', '));
assert(registered.includes('shell.overlay'), '注册了悬浮气泡', registered.join(', '));

// 渲染两条插槽的组件：没数据时也不能抛（这是用户唯一会看到的那一屏）
const renderSafely = (label, fn) => {
  try {
    fn();
    ok(`${label} 渲染通过`);
  } catch (err) {
    bad(`${label} 渲染抛错`, err instanceof Error ? err.message : String(err));
  }
};

renderSafely('侧栏细条', () => components['sidebar.footer.action']({}));
// 点一下细条把气泡打开（store 是模块内部的，靠组件自己的 onClick 驱动）
const stripVNode = components['sidebar.footer.action']({});
if (typeof stripVNode?.props?.onClick === 'function') {
  try {
    stripVNode.props.onClick();
    ok('细条点击能打开气泡');
  } catch (err) {
    bad('细条点击抛错', err instanceof Error ? err.message : String(err));
  }
} else {
  bad('细条没有 onClick', '组件结构变了？');
}
renderSafely('悬浮气泡（无数据）', () => components['shell.overlay']({}));

// ─────────────────────────────── 收尾 ───────────────────────────────
rmSync(dataHome, { recursive: true, force: true });
rmSync(join(dataHome), { recursive: true, force: true });

console.log(failed === 0 ? '\n✅ 自检全部通过' : `\n❌ ${failed} 项失败`);
process.exit(failed === 0 ? 0 : 1);
