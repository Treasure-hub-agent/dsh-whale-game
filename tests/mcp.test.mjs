/**
 * MCP 自注册测试（对应验收「自注册幂等与备份」）。
 *
 * 铁律：**只在临时 DSH_HOME 里试**。真实 profile 里的 cordis.patch.yml 是主人的活配置，
 * 拿它当试验田一次就可能把整份 DSH 配置弄坏。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildMcpBlock, ensureMcpEntry, hasMcpEntry, markerState, MCP_ENTRY_ID, profilePatchPath } from '../lib/index.js';

const MCP_URL = 'http://127.0.0.1:8787/mcp';

/** 造一个 home，profile 目录可选是否创建。 */
function makeHome({ profile = 'desktop', createProfile = true, patch = null } = {}) {
  const home = mkdtempSync(join(tmpdir(), 'whale-mcp-'));
  const dir = join(home, 'profiles', profile);
  if (createProfile) mkdirSync(dir, { recursive: true });
  const file = join(dir, 'cordis.patch.yml');
  if (patch !== null) writeFileSync(file, patch, 'utf8');
  return {
    home,
    dir,
    file,
    backups: () => (existsSync(dir) ? readdirSync(dir).filter((n) => n.includes('.bak-')) : []),
    cleanup: () => rmSync(home, { recursive: true, force: true }),
  };
}

const REAL_LIKE_PATCH = `# profile patch（用户自己的层）
- id: ui-theme
  name: "@deepseek-ai/dsh-client-ui-theme"
  config:
    preference: light
`;

test('没有 patch 文件：直接新建，写入带 - insert: 包装的条目', () => {
  const h = makeHome();
  try {
    const result = ensureMcpEntry({ home: h.home, profile: 'desktop', mcpUrl: MCP_URL });
    assert.equal(result.action, 'written', result.detail);
    assert.equal(h.backups().length, 0, '没有原文件就不需要备份');
    const content = readFileSync(h.file, 'utf8');
    assert.ok(hasMcpEntry(content), '写入后能按 id 找到条目');
    assert.match(content, /^- insert:/m, '必须用 insert 包装（裸 id 会被静默忽略）');
    assert.match(content, /# BEGIN dsh-whale-game/);
    assert.match(content, /# END dsh-whale-game/);
    assert.ok(content.includes(MCP_URL));
  } finally {
    h.cleanup();
  }
});

test('已有 mcp-ai-playground：一个字节都不动，也不产生备份', () => {
  const patch = `${REAL_LIKE_PATCH}- insert:\n    - id: ${MCP_ENTRY_ID}\n      name: "@deepseek-ai/dsh-mcp-client"\n`;
  const h = makeHome({ patch });
  try {
    const result = ensureMcpEntry({ home: h.home, profile: 'desktop', mcpUrl: MCP_URL });
    assert.equal(result.action, 'present');
    assert.equal(readFileSync(h.file, 'utf8'), patch, '内容必须完全不变');
    assert.equal(h.backups().length, 0);
  } finally {
    h.cleanup();
  }
});

test('有 patch 但没有条目：先备份再追加，原内容完整保留', () => {
  const h = makeHome({ patch: REAL_LIKE_PATCH });
  try {
    const result = ensureMcpEntry({ home: h.home, profile: 'desktop', mcpUrl: MCP_URL });
    assert.equal(result.action, 'written', result.detail);
    assert.ok(result.backup, '必须给备份路径');
    assert.ok(existsSync(result.backup), '备份文件真的存在');
    assert.equal(readFileSync(result.backup, 'utf8'), REAL_LIKE_PATCH, '备份内容 = 写入前的原文');

    const after = readFileSync(h.file, 'utf8');
    assert.ok(after.startsWith(REAL_LIKE_PATCH), '原有条目必须原样在前');
    assert.ok(hasMcpEntry(after));
    assert.equal(h.backups().length, 1);
  } finally {
    h.cleanup();
  }
});

test('幂等：连跑三次只写一次、只备份一次', () => {
  const h = makeHome({ patch: REAL_LIKE_PATCH });
  try {
    const first = ensureMcpEntry({ home: h.home, profile: 'desktop', mcpUrl: MCP_URL });
    const contentAfterFirst = readFileSync(h.file, 'utf8');
    const second = ensureMcpEntry({ home: h.home, profile: 'desktop', mcpUrl: MCP_URL });
    const third = ensureMcpEntry({ home: h.home, profile: 'desktop', mcpUrl: MCP_URL });

    assert.equal(first.action, 'written');
    assert.equal(second.action, 'present');
    assert.equal(third.action, 'present');
    assert.equal(readFileSync(h.file, 'utf8'), contentAfterFirst, '后两次不能改动文件');
    assert.equal(h.backups().length, 1, '只有第一次启动时备份');
    // 只出现一份 insert 块：重复追加会把 YAML 写坏
    assert.equal(readFileSync(h.file, 'utf8').split(`- id: ${MCP_ENTRY_ID}`).length - 1, 1);
  } finally {
    h.cleanup();
  }
});

test('标记块半截（只有 BEGIN）：拒绝追加，报 failed 让人工看一眼', () => {
  const h = makeHome({ patch: `${REAL_LIKE_PATCH}# BEGIN dsh-whale-game（上次写到一半）\n` });
  try {
    const result = ensureMcpEntry({ home: h.home, profile: 'desktop', mcpUrl: MCP_URL });
    assert.equal(result.action, 'failed');
    assert.match(result.detail, /标记块不完整/);
    assert.equal(readFileSync(h.file, 'utf8'), `${REAL_LIKE_PATCH}# BEGIN dsh-whale-game（上次写到一半）\n`);
    assert.equal(h.backups().length, 0);
  } finally {
    h.cleanup();
  }
});

test('标记块在但条目被删：不重复写，报 failed', () => {
  const stripped = `${REAL_LIKE_PATCH}\n${buildMcpBlock(MCP_URL)
    .split('\n')
    .filter((line) => !line.includes(`id: ${MCP_ENTRY_ID}`))
    .join('\n')}\n`;
  const h = makeHome({ patch: stripped });
  try {
    const result = ensureMcpEntry({ home: h.home, profile: 'desktop', mcpUrl: MCP_URL });
    assert.equal(result.action, 'failed');
    assert.match(result.detail, /标记块在/);
  } finally {
    h.cleanup();
  }
});

test('profile 目录不存在 / 名字非法 / 目标是目录：一律 failed 且不抛异常', () => {
  const missing = makeHome({ createProfile: false });
  const bad = makeHome();
  const asDir = makeHome();
  try {
    const r1 = ensureMcpEntry({ home: missing.home, profile: 'nope', mcpUrl: MCP_URL });
    assert.equal(r1.action, 'failed');
    assert.match(r1.detail, /profile 目录不存在/);
    assert.ok(!existsSync(missing.file), '不该凭空创建 profile 目录');

    const r2 = ensureMcpEntry({ home: bad.home, profile: '../escape', mcpUrl: MCP_URL });
    assert.equal(r2.action, 'failed');
    assert.equal(r2.path, null);
    assert.match(r2.detail, /非法字符/);

    mkdirSync(join(asDir.dir, 'cordis.patch.yml'), { recursive: true });
    const r3 = ensureMcpEntry({ home: asDir.home, profile: 'desktop', mcpUrl: MCP_URL });
    assert.equal(r3.action, 'failed');
    assert.match(r3.detail, /不是普通文件/);

    // 无论哪种失败，snippet 都要在（界面降级成「手动添加」就靠它）
    for (const r of [r1, r2, r3]) assert.match(r.snippet, /- insert:/);
  } finally {
    missing.cleanup();
    bad.cleanup();
    asDir.cleanup();
  }
});

test('profile 名缺省读 DSH_PROFILE，再缺省 desktop', () => {
  const previous = process.env.DSH_PROFILE;
  try {
    delete process.env.DSH_PROFILE;
    assert.match(profilePatchPath('C:/dsh', undefined), /profiles[\\/]desktop[\\/]cordis\.patch\.yml$/);
    process.env.DSH_PROFILE = 'web';
    assert.match(profilePatchPath('C:/dsh', undefined), /profiles[\\/]web[\\/]cordis\.patch\.yml$/);
    assert.match(profilePatchPath('C:/dsh', 'desktop'), /profiles[\\/]desktop[\\/]cordis\.patch\.yml$/);
  } finally {
    if (previous === undefined) delete process.env.DSH_PROFILE;
    else process.env.DSH_PROFILE = previous;
  }
});

test('URL 兜底：没给/给了垃圾也绝不能写出 "undefined"', () => {
  assert.match(buildMcpBlock(undefined), /url: http:\/\/127\.0\.0\.1:8787\/mcp/);
  assert.match(buildMcpBlock('not a url'), /url: http:\/\/127\.0\.0\.1:8787\/mcp/);
  assert.match(buildMcpBlock('http://127.0.0.1:9999/mcp'), /url: http:\/\/127\.0\.0\.1:9999\/mcp/);
  assert.doesNotMatch(buildMcpBlock(undefined), /undefined/);
});

test('标记块工具函数：状态判定与 id 识别（容忍缩进/行尾注释）', () => {
  assert.equal(markerState('- insert:\n'), 'none');
  assert.equal(markerState('# BEGIN dsh-whale-game\n'), 'half');
  assert.equal(markerState('# BEGIN dsh-whale-game\n# END dsh-whale-game\n'), 'both');
  assert.equal(hasMcpEntry('    - id: mcp-ai-playground\n'), true);
  assert.equal(hasMcpEntry('    - id: mcp-ai-playground    # 注释\n'), true);
  assert.equal(hasMcpEntry('    - id: mcp-ai-playground-extra\n'), false);
});
