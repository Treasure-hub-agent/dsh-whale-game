#!/usr/bin/env node
/**
 * 把游戏厅本体（AI 游乐场的 CLI 产物）搬进本插件的 `vendor/app/`。
 *
 * 为什么要这一份：插件自己是 21 KB 的启动器，但用户装完插件点「开启游戏厅」时
 * 不该还要求他去 clone 平台、装依赖、配命令。把已构建好的产物随插件一起发，
 * 就是「装完即用、零网络、秒开」。
 *
 * 产物是 esbuild 打好的**零依赖单文件**（`dist/index.js` 内联了 server/core/mcp/sdk），
 * 所以不需要 npm install，直接 `node dist/index.js serve` 就能跑。
 *
 * 用法：
 *   node scripts/vendor-app.mjs [平台仓库路径]
 *   默认读 AI_PLAYGROUND_REPO，再退回 ../ai-playground
 */
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const PLUGIN_ROOT = resolve(HERE, '..');
const VENDOR = join(PLUGIN_ROOT, 'vendor', 'app');

const repo =
  process.argv[2] ?? process.env.AI_PLAYGROUND_REPO ?? resolve(PLUGIN_ROOT, '..', 'ai-playground');

const dist = join(repo, 'packages', 'cli', 'dist');
const web = join(repo, 'packages', 'cli', 'web');
const platformPkg = join(repo, 'package.json');

if (!existsSync(join(dist, 'index.js')) || !existsSync(web)) {
  console.error(`找不到平台 CLI 产物：${dist} / ${web}`);
  console.error('先在平台仓库跑一次：node scripts/pack-cli.mjs');
  process.exit(2);
}

const version = JSON.parse(readFileSync(platformPkg, 'utf8')).version;

rmSync(VENDOR, { recursive: true, force: true });
mkdirSync(VENDOR, { recursive: true });
cpSync(dist, join(VENDOR, 'dist'), { recursive: true });
cpSync(web, join(VENDOR, 'web'), { recursive: true });

// 记一下来源，方便日后核对「插件里带的是哪一版平台」。
// 只写版本与相对位置：这是要进公开仓库和 npm 包的文件，不能带本机绝对路径。
writeFileSync(
  join(VENDOR, 'VENDORED.txt'),
  [
    `platform version: ${version}`,
    `vendored at: ${new Date().toISOString()}`,
    'source project: ai-playground (https://github.com/Treasure-hub-agent/ai-playground)',
    '',
    '更新方式：在平台仓库跑 node scripts/pack-cli.mjs，回到本仓库跑 node scripts/vendor-app.mjs',
    '',
  ].join('\n'),
);

function dirSize(dir) {
  let total = 0;
  const walk = (p) => {
    for (const name of readdirSync(p)) {
      const full = join(p, name);
      const st = statSync(full);
      if (st.isDirectory()) walk(full);
      else total += st.size;
    }
  };
  walk(dir);
  return total;
}

console.log(`✓ vendor/app ← 平台 v${version}`);
console.log(`  dist: ${(statSync(join(VENDOR, 'dist', 'index.js')).size / 1024 / 1024).toFixed(2)} MB`);
console.log(`  总计: ${(dirSize(VENDOR) / 1024 / 1024).toFixed(2)} MB`);
