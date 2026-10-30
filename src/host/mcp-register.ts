/**
 * MCP 自注册 · 宿主半侧
 *
 * 为什么需要它：插件能拉起游戏厅，但 Agent 还拿不到 `playground_*` 工具——那需要
 * profile 的 `cordis.patch.yml` 里有一条 `mcp-ai-playground` 的 insert。让用户手动贴
 * YAML 一定会出错（本机就踩过：裸写 `- id:` 只会覆盖已有条目，新 id 被静默忽略）。
 *
 * 所以插件激活时自己确保这条存在：
 *   - 已有（按 `id: mcp-ai-playground` 判）→ 一个字节都不动；
 *   - 没有 → 先备份 `.bak-<时间戳>`，再追加带 `# BEGIN/END dsh-whale-game` 标记的块；
 *   - 任何异常都**不抛**：写配置失败最多是「MCP 没自动接上」，绝不能连累插件启动
 *     （DSH 是全有或全无启动，插件加载失败会拖垮整个会话）。失败时降级成 UI 里
 *     一条可复制的「手动添加」提示 —— snippet 总是随结果返回。
 *
 * 幂等性靠两道独立的判断：目标 id 存在就跳过；标记块不完整（只写了一半）也跳过，
 * 宁可让用户手动看一眼，也不要往半截 YAML 里再追加一次。
 */
import { appendFileSync, copyFileSync, existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_CONFIG, type McpState } from '../shared.ts';

/** 目标条目 id：平台 MCP 服务器在 DSH 配置树里的唯一标识。 */
export const MCP_ENTRY_ID = 'mcp-ai-playground';
/** 标记块边界：用户删掉整段 = 卸载时的手动回滚，插件下次激活会再补回来。 */
const BEGIN_MARKER = '# BEGIN dsh-whale-game';
const END_MARKER = '# END dsh-whale-game';
/** profile 名只允许这些字符，避免拼接出越权路径。 */
const PROFILE_PATTERN = /^[A-Za-z0-9._-]{1,64}$/;

/** 判断文件里是否已经有目标条目（容忍缩进和行尾注释）。 */
export function hasMcpEntry(content: string): boolean {
  return new RegExp(`^\\s*-\\s*id:\\s*${MCP_ENTRY_ID}\\s*(?:#.*)?$`, 'm').test(content);
}

/** 判断标记块状态：both = 完整；half = 只有一半（半截写入，绝不能追加）。 */
export function markerState(content: string): 'none' | 'both' | 'half' {
  const begin = content.includes(BEGIN_MARKER);
  const end = content.includes(END_MARKER);
  if (begin && end) return 'both';
  if (begin || end) return 'half';
  return 'none';
}

/**
 * 兜底 URL：写进配置文件的 URL 必须是真的 URL。
 * 少一个参数就写出 `url: undefined` 的话，MCP 客户端会连一个叫 "undefined" 的地址，
 * 排查起来像见鬼——这里宁可回落到默认端口。
 */
function safeMcpUrl(value: unknown): string {
  const url = typeof value === 'string' ? value.trim() : '';
  return /^https?:\/\/\S+$/.test(url) ? url : `http://127.0.0.1:${DEFAULT_CONFIG.port}/mcp`;
}

/** 生成要追加的块。`- insert:` 是硬要求：profile patch 顶层是 loader patch 条目。 */
export function buildMcpBlock(mcpUrl: string): string {
  const url = safeMcpUrl(mcpUrl);
  return [
    `${BEGIN_MARKER}（插件自动写入；整段删掉 = 关闭自动接线，下次激活会补回来）`,
    '# 为什么要 insert 包装：profile patch 顶层是 loader patch 条目，裸写 `- id:` 只覆盖已存在',
    '# 条目、不存在的 id 会被静默忽略（本机踩过这个坑）。',
    '- insert:',
    `    - id: ${MCP_ENTRY_ID}`,
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '      config:',
    '        serverName: ai-playground',
    '        transport: streamable-http',
    `        url: ${url}`,
    '        # playground_wait_for_turn 默认等 60s（上限 300），默认超时会掐掉正常等待',
    '        toolCallTimeoutMs: 120000',
    '        # 开机先后顺序不再要命：游戏厅什么时候起来，30 秒内都会连上',
    '        reconnect:',
    '          maxAttempts: 1000',
    '          maxDelayMs: 30000',
    END_MARKER,
  ].join('\n');
}

export interface EnsureMcpOptions {
  /** DSH 数据根（$DSH_HOME）。 */
  home: string;
  /** profile 名；缺省读 DSH_PROFILE，再缺省 'desktop'。 */
  profile?: string;
  /** 写进配置的 MCP 端点，例如 http://127.0.0.1:8787/mcp。 */
  mcpUrl: string;
  /** 时钟注入（备份文件名里的时间戳），单测用。 */
  now?: () => number;
}

/** 时间戳：20261029-221500。只用于备份名，不需要精确到毫秒，但加毫秒后缀避免同秒覆盖。 */
function stamp(at: number): string {
  const d = new Date(at);
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}${pad(d.getMilliseconds(), 3)}`;
}

/** profile 目录：$DSH_HOME/profiles/<profile>（与 dsh-app-boot 的布局一致）。 */
export function profilePatchPath(home: string, profile?: string): string | null {
  const name = (profile ?? process.env.DSH_PROFILE ?? '').trim() || 'desktop';
  if (!PROFILE_PATTERN.test(name)) return null;
  return join(home, 'profiles', name, 'cordis.patch.yml');
}

/**
 * 确保 profile patch 里有 MCP 条目。
 * **永不抛异常**：所有失败都折成 `action: 'failed'` + 人话 detail，调用方照常启动插件。
 */
export function ensureMcpEntry(options: EnsureMcpOptions): McpState {
  const snippet = buildMcpBlock(options.mcpUrl);
  const at = (options.now ?? (() => Date.now()))();
  const patchPath = profilePatchPath(options.home, options.profile);
  if (!patchPath) {
    return {
      action: 'failed',
      path: null,
      backup: null,
      detail: 'DSH_PROFILE 含非法字符，没法定位 profile 配置；请手动把下面的块加到 $DSH_HOME/profiles/<profile>/cordis.patch.yml',
      snippet,
    };
  }

  try {
    const profileDir = join(options.home, 'profiles', (options.profile ?? process.env.DSH_PROFILE ?? '').trim() || 'desktop');
    if (!existsSync(profileDir)) {
      return {
        action: 'failed',
        path: patchPath,
        backup: null,
        detail: `profile 目录不存在（${profileDir}）：可能 profile 名不对，手动把下面的块加到该文件里`,
        snippet,
      };
    }

    const exists = existsSync(patchPath);
    // 先确认是普通文件再读：目标是个目录时 readFileSync 会抛 EISDIR，
    // 那会掉进最外层 catch、把 detail 说成「写配置失败」，排查时反而误导。
    if (exists && !statSync(patchPath).isFile()) {
      return { action: 'failed', path: patchPath, backup: null, detail: '目标路径不是普通文件，没法写进去', snippet };
    }
    const current = exists ? readFileSync(patchPath, 'utf8') : '';

    // ① 已有条目：直接跳过，连备份都不做（本机现在就是这种情况，别重复写）
    if (hasMcpEntry(current)) {
      return { action: 'present', path: patchPath, backup: null, detail: `MCP 条目已存在（${MCP_ENTRY_ID}），未改动`, snippet };
    }

    // ② 上一轮写了半截：不敢追加，交给人看一眼
    const markers = markerState(current);
    if (markers === 'both') {
      return {
        action: 'failed',
        path: patchPath,
        backup: null,
        detail: '标记块在、但 mcp-ai-playground 条目不在：可能被手工编辑过，请检查该段后删掉整段让插件重写',
        snippet,
      };
    }
    if (markers === 'half') {
      return {
        action: 'failed',
        path: patchPath,
        backup: null,
        detail: '标记块不完整（只有 BEGIN 或只有 END）：为避免把 YAML 弄坏，这里不追加，请手动修好该段',
        snippet,
      };
    }

    // ③ 先备份、再追加；文件不存在就直接新建（没有内容可备份）
    let backup: string | null = null;
    if (exists) {
      backup = `${patchPath}.bak-${stamp(at)}`;
      copyFileSync(patchPath, backup);
    }

    const separator = current.length === 0 ? '' : current.endsWith('\n') ? '\n' : '\n\n';
    const payload = `${separator}${snippet}\n`;
    if (exists) appendFileSync(patchPath, payload, 'utf8');
    else writeFileSync(patchPath, payload.replace(/^\n+/, ''), 'utf8');

    // ④ 回读确认：写完必须能读到自己写的那条，否则算失败（别让 UI 报假成功）
    const after = readFileSync(patchPath, 'utf8');
    if (!hasMcpEntry(after)) {
      return {
        action: 'failed',
        path: patchPath,
        backup,
        detail: '写完了但回读不到条目：文件可能被别的进程覆盖，请检查',
        snippet,
      };
    }

    return {
      action: 'written',
      path: patchPath,
      backup,
      detail: '已写入 MCP 条目，DSH 的 HMR 会在数秒内生效（工具会以 mcp__ai-playground__* 出现）',
      snippet,
    };
  } catch (error) {
    return {
      action: 'failed',
      path: patchPath,
      backup: null,
      detail: `写配置失败（${error instanceof Error ? error.message : String(error)}），插件继续启动；请手动添加下面的块`,
      snippet,
    };
  }
}
