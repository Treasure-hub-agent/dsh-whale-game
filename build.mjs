#!/usr/bin/env node
/**
 * 构建：宿主半侧打 ESM（node），浏览器半侧打 IIFE 副作用脚本。
 *
 * 两者格式不同是 DSH 插件契约决定的：
 * - 宿主半侧被 cordis 当模块 import，必须是 ESM，`@deepseek-ai/*` 与 node 内置保持 external；
 * - 浏览器半侧由 DSH 的模块系统当普通脚本加载，不能有顶层 import/export，
 *   react 只能通过 `window.__ModuleLoader__` 的 factory(require) 取。
 */
import { build } from 'esbuild';
import { rmSync, mkdirSync, readFileSync } from 'node:fs';

rmSync('lib', { recursive: true, force: true });
mkdirSync('lib', { recursive: true });

const pkg = JSON.parse(readFileSync('package.json', 'utf8'));

await build({
  entryPoints: ['src/host/index.ts'],
  outfile: 'lib/index.js',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node20',
  // 宿主服务包由 DSH 提供，不打进来；node: 内置模块永远是 external
  external: ['@deepseek-ai/*', 'node:*'],
  banner: { js: `/* ${pkg.name} v${pkg.version} · host half */` },
  logLevel: 'info',
});

await build({
  entryPoints: ['src/client/index.ts'],
  outfile: 'lib/client.js',
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  // 客户端不许有顶层 import：react 由 factory(require) 取，所以这里必须能全内联
  external: [],
  banner: { js: `/* ${pkg.name} v${pkg.version} · client half */` },
  logLevel: 'info',
});

console.log('\n✓ lib/index.js  lib/client.js');
