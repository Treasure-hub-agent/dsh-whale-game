/**
 * 唤醒桥（wake bridge）· 宿主半侧
 *
 * 问题：DSH 的会话是消息驱动的——回合结束就休眠，浏览器里点击落子**不会**唤醒 Agent。
 * 所以平台（AI 游乐场）在「轮到 Agent」时 POST 到这里，由插件往目标会话里塞一条 user
 * 消息，把它叫醒。官方 `@deepseek-ai/dsh-schedule` 就是这么投递定时提醒的，这里照抄
 * 它的姿势（resolveAgent → createUserMessage → agent.followup → sessions.flush）。
 *
 * 职责边界（重要）：插件**不判断棋局语义**（不决定「该不该叫」），信源只有一个：平台。
 * 插件只做三件事——鉴权、把文案拼成人类看得懂的一条消息、投进会话。
 *
 * 这个模块刻意做成「纯逻辑 + 注入依赖」：时钟、宿主服务、createUserMessage 都能替换，
 * 于是鉴权/去抖/降级这些分支可以在假 ctx 上跑单测，不需要真 DSH。
 */
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import type { WakeSourceKind, WakeState } from '../shared.ts';

/** 房间号/会话 id 的形状：只允许这些字符，长度 1..128（防注入、防拿它干别的事）。 */
export const ID_PATTERN = /^[A-Za-z0-9._:-]{1,128}$/;

/** 文案总字节上限（设计文档 §4：注入内容 ≤2KB，超长截断）。 */
export const MAX_TEXT_BYTES = 2048;

/** 同一 roomId+round 的最小投递间隔：平台侧超时重试很激进，这里是最后一道闸。 */
export const DEDUPE_MS = 3000;

/** 请求体上限：平台只会发一条 textView 摘要，96KB 已经非常宽松。 */
const MAX_BODY_BYTES = 96 * 1024;

/** 平台 POST 过来的 JSON（字段全部按「不可信外部输入」处理）。 */
export interface WakePayload {
  roomId: string;
  sessionId: string;
  gameId?: string;
  gameName?: string;
  round?: number;
  rounds?: number;
  textView?: string;
  /**
   * 第 15 轮新增：`turn`（该你出招）或 `ended`（对局结束）。
   * 缺省按 `turn` 处理 —— 老平台不带这个字段时行为不变。
   */
  reason?: 'turn' | 'ended';
  /** 仅 `reason === 'ended'` 时由平台给出：内核的结算文案。 */
  resultText?: string;
}

/** createUserMessage 的最小签名（从 @deepseek-ai/dsh-llm 取，结构等价）。 */
export type CreateUserMessage = (input: {
  content: Array<{ type: 'text'; text: string }>;
  source: { kind: string } & Record<string, unknown>;
}) => unknown;

/** 宿主两个必需服务的**最小**接口——只写我们真的用到的部分，别的版本差异与我们无关。 */
export interface WakeServices {
  sessionController: {
    resolveAgent(sessionId: string): Promise<{ agent?: WakeAgent; error?: unknown }>;
  };
  sessions: {
    flush(session: unknown): Promise<boolean>;
  };
}

export interface WakeAgent {
  readonly session: unknown;
  followup(message: unknown): void;
}

export interface WakeHttpResult {
  status: number;
  body: Record<string, unknown>;
}

export interface WakeBridgeOptions {
  /** 每次请求都读一次：设置页改了密钥立刻生效，不用重启 DSH。 */
  secret(): string;
  /** 宿主服务快照；null = 宿主没提供这些服务（降级为 409，插件其它功能照常）。 */
  services(): WakeServices | null;
  /** 注入 createUserMessage（单测替换用）；缺省走动态 import。 */
  loadCreateUserMessage?(): Promise<CreateUserMessage>;
  /** 时钟注入，单测用假时间验证去抖。 */
  now?(): number;
  log?(line: string): void;
  /** 首次投递用的 source.kind；默认 'wake'。 */
  sourceKind?: WakeSourceKind;
}

/** 快照里除 url/secret 之外的部分：那两个由 index.ts 拼（它知道端口和环境变量）。 */
export type WakeRuntimeSnapshot = Omit<WakeState, 'url' | 'secret' | 'secretSource'>;

type Phase = 'resolve' | 'create' | 'followup' | 'flush';

export interface WakeDeliveryResult {
  ok: boolean;
  phase?: Phase;
  error?: unknown;
  messageId?: string;
}

interface DedupeEntry {
  at: number;
  deliveredAt: string;
  sessionId: string;
  sourceKind: WakeSourceKind;
}

/**
 * 生成唤醒密钥。
 * 24 字节随机 → 48 位十六进制：足够长，塞进平台的环境变量也不会有 shell 转义问题。
 */
export function generateWakeSecret(): string {
  return randomBytes(24).toString('hex');
}

/** 定长比较，避免通过响应时间猜密钥（本机回环也照做，便宜且无副作用）。 */
function secretEquals(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

/** 按 UTF-8 字节截断，不切坏代理对（emoji 半个字符会变成乱码方块）。 */
export function truncateUtf8(text: string, maxBytes: number): string {
  if (maxBytes <= 0) return '';
  if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text;
  let used = 0;
  let out = '';
  for (const char of text) {
    const size = Buffer.byteLength(char, 'utf8');
    if (used + size > maxBytes) break;
    used += size;
    out += char;
  }
  return out;
}

/** 把任意输入压成「单行短文本」：房间名/游戏名会进消息标题，不能带换行或超长尾巴。 */
function cleanLine(value: unknown, maxChars: number): string | null {
  if (typeof value !== 'string') return null;
  const flat = value.replace(/[\r\n\t]+/g, ' ').trim();
  if (!flat) return null;
  return flat.length <= maxChars ? flat : `${flat.slice(0, maxChars - 1)}…`;
}

/** 只接受有限非负整数（也容忍平台发字符串数字，省得它多一处 JSON 细节就整条链路哑掉）。 */
function cleanCount(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return undefined;
  return Math.min(Math.floor(n), 1_000_000);
}

/**
 * 拼人类可见的唤醒文案（设计文档 §3.2 第 2 条）。
 *
 * 头尾是「指令」，中间是平台给的只读盘面摘要；超长时**只截盘面**，头尾必须完整保留：
 * 头让人知道是哪一局，尾告诉 Agent 只出一手。
 *
 * 第 15 轮两处补充（主人实测反馈）：
 * 1. `reason === 'ended'` 时换成「对局结束」的文案 —— 人类赢了 Agent 却收不到消息，
 *    只能等下一个人说话，体验很差；
 * 2. 每手都提醒 Agent 用 `playground_say` 说一句 —— 只闷头下棋，人类会觉得在跟机器玩。
 */
export function buildWakeText(payload: WakePayload): string {
  const roundText =
    payload.round === undefined ? '' : ` · 第 ${payload.round}${payload.rounds ? `/${payload.rounds}` : ''} 回合`;
  const gameName = payload.gameName ?? payload.gameId ?? '小游戏';
  const view = typeof payload.textView === 'string' ? payload.textView.replace(/\r\n?/g, '\n').trim() : '';
  const marker = '…（盘面已截断）';

  const ended = payload.reason === 'ended';
  const head = ended
    ? `🏁 对局结束了 · 房间 ${payload.roomId} · ${gameName}${roundText}`
    : `🎮 该你出招了 · 房间 ${payload.roomId} · ${gameName}${roundText}`;
  const resultLine =
    ended && payload.resultText ? `\n结算：${payload.resultText.replace(/\s+/g, ' ').trim().slice(0, 200)}` : '';
  const tail = ended
    ? '\n下一步：playground_get_result 核对比分，然后用 playground_say 跟人类收个尾（赢了夸他一句、输了认账，别装死）。'
    : '\n读完盘面直接 submit_action；出招后顺手 playground_say 说一句（≤200 字，嘴炮/战况都行）。不要猜对手本回合的选择，不要托管整局。';

  // 盘面摘要夹在「头 + 结算」与「尾」之间：超长时只截它，指令与结算必须完整。
  const top = `${head}${resultLine}`;
  const full = view ? `${top}\n${view}${tail}` : `${top}${tail}`;
  if (Buffer.byteLength(full, 'utf8') <= MAX_TEXT_BYTES) return full;

  const budget =
    MAX_TEXT_BYTES - Buffer.byteLength(top, 'utf8') - Buffer.byteLength(tail, 'utf8') - Buffer.byteLength(`\n${marker}`, 'utf8');
  const clipped = truncateUtf8(view, Math.max(0, budget));
  return truncateUtf8(`${top}\n${clipped}${marker}${tail}`, MAX_TEXT_BYTES);
}

/**
 * 从请求头里取 `x-wake-secret`。Node 的 IncomingHttpHeaders 已经是小写键，
 * 但单测/别处可能传未小写的对象，所以统一转一遍。
 */
export function readWakeSecret(header: unknown): string | null {
  if (!header || typeof header !== 'object') return null;
  for (const [key, value] of Object.entries(header as Record<string, unknown>)) {
    if (key.toLowerCase() !== 'x-wake-secret') continue;
    const raw = Array.isArray(value) ? value[0] : value;
    return typeof raw === 'string' ? raw.trim() : null;
  }
  return null;
}

/** 校验并规范化 payload；返回错误字段名，调用方据此回 400。 */
export function validateWakePayload(input: unknown): { ok: true; payload: WakePayload } | { ok: false; field: string; reason: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, field: 'body', reason: 'body 必须是 JSON 对象' };
  }
  const raw = input as Record<string, unknown>;
  const roomId = typeof raw.roomId === 'string' ? raw.roomId.trim() : '';
  if (!ID_PATTERN.test(roomId)) return { ok: false, field: 'roomId', reason: 'roomId 必须是 [A-Za-z0-9._:-]{1,128}' };
  const sessionId = typeof raw.sessionId === 'string' ? raw.sessionId.trim() : '';
  if (!ID_PATTERN.test(sessionId)) return { ok: false, field: 'sessionId', reason: 'sessionId 必须是 [A-Za-z0-9._:-]{1,128}' };

  const round = cleanCount(raw.round);
  const rounds = cleanCount(raw.rounds);
  if (round !== undefined && rounds !== undefined && round > rounds) {
    return { ok: false, field: 'round', reason: 'round 不能大于 rounds' };
  }

  const payload: WakePayload = {
    roomId,
    sessionId,
    gameId: cleanLine(raw.gameId, 64) ?? undefined,
    gameName: cleanLine(raw.gameName, 64) ?? undefined,
    round,
    rounds,
    textView: typeof raw.textView === 'string' ? raw.textView.slice(0, MAX_BODY_BYTES) : undefined,
    // 只认这两个值；其它（含缺失）一律当 'turn'，别让脏值影响文案分支。
    reason: raw.reason === 'ended' ? 'ended' : 'turn',
    resultText: typeof raw.resultText === 'string' ? raw.resultText.slice(0, 500) : undefined,
  };
  return { ok: true, payload };
}

/**
 * createUserMessage 的本地结构等价实现（兜底）。
 *
 * 依据：`@deepseek-ai/dsh-llm` 的 `lib/types/message.js` 里它就是
 * `createMessage({ ...input, role: 'user' })`，而 `createMessage` 只是
 * `deepFreeze(structuredClone({ ...input, id: randomUUID() }))` —— 没有任何字段校验。
 * 所以万一宿主没把这个包暴露给插件（版本差异），照这个结构自己造一条，
 * 效果一样；有包时永远优先用官方的，避免两边实现漂移。
 */
function localCreateUserMessage(input: Parameters<CreateUserMessage>[0]): unknown {
  const message = { ...input, role: 'user', id: randomUUID() };
  const freeze = (value: unknown): unknown => {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
      for (const child of Object.values(value as Record<string, unknown>)) freeze(child);
      Object.freeze(value);
    }
    return value;
  };
  return freeze(JSON.parse(JSON.stringify(message)));
}

/** 默认的 createUserMessage 来源：动态 import 宿主安装目录里的 dsh-llm。 */
async function importCreateUserMessage(log?: (line: string) => void): Promise<CreateUserMessage> {
  try {
    // 用变量拼模块名：这个包只在 DSH 运行时才能解析，写成静态 import 会让 tsc 直接报找不到模块。
    const spec = '@deepseek-ai/dsh-llm';
    const mod = (await import(spec)) as { createUserMessage?: CreateUserMessage };
    if (typeof mod.createUserMessage === 'function') return mod.createUserMessage;
    log?.('dsh-llm 里没有 createUserMessage，改用本地结构等价实现');
  } catch (err) {
    log?.(`拿不到 @deepseek-ai/dsh-llm（${err instanceof Error ? err.message : String(err)}），改用本地结构等价实现`);
  }
  return localCreateUserMessage as CreateUserMessage;
}

/**
 * 判断错误像不像是「source.kind 不被接受」。
 * 只在**没有实际投递风险**（followup 抛错）或**只影响下次选型**时用它，
 * 绝不在 flush 失败后重试——那会把同一回合唤醒两次（一次是真的，一次是重试）。
 */
function looksLikeSourceKindError(error: unknown): boolean {
  const text = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return /\b(kind|source|schema|valid|invalid|unknown|unrecognized|unsupported|enum)\b/i.test(text);
}

function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  try {
    return JSON.stringify(error);
  } catch {
    return String(error);
  }
}

export class WakeBridge {
  private readonly options: WakeBridgeOptions;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly dedupe = new Map<string, DedupeEntry>();
  private createUserMessage: CreateUserMessage | null = null;
  private activeKind: WakeSourceKind;
  private lastDeliveredAt: string | null = null;
  private lastError: string | null = null;
  private delivered = 0;
  private failed = 0;
  private debounced = 0;
  private lastRoom: string | null = null;
  private lastRound: number | null = null;

  constructor(options: WakeBridgeOptions) {
    this.options = options;
    this.now = options.now ?? (() => Date.now());
    this.log = options.log ?? (() => undefined);
    this.activeKind = options.sourceKind ?? 'wake';
  }

  /** 给设置页的快照（url/secret 由 index.ts 补齐，它才知道端口和环境变量覆盖）。 */
  snapshot(): WakeRuntimeSnapshot {
    return {
      available: this.options.services() !== null,
      sourceKind: this.activeKind,
      lastDeliveredAt: this.lastDeliveredAt,
      lastError: this.lastError,
      delivered: this.delivered,
      failed: this.failed,
      debounced: this.debounced,
      lastRoom: this.lastRoom,
      lastRound: this.lastRound,
    };
  }

  private fail(status: number, error: 'bad-secret' | 'bad-request' | 'session-unavailable', message: string, extra?: Record<string, unknown>): WakeHttpResult {
    if (error === 'session-unavailable') this.failed += 1;
    if (error !== 'bad-secret' && error !== 'bad-request') this.lastError = message;
    return { status, body: { ok: false, error, message, ...(extra ?? {}) } };
  }

  private async createMessage(): Promise<CreateUserMessage> {
    if (this.createUserMessage) return this.createUserMessage;
    const loader = this.options.loadCreateUserMessage ?? (() => importCreateUserMessage(this.log));
    this.createUserMessage = await loader();
    return this.createUserMessage;
  }

  /**
   * 投递一次（不重试、不去抖）。
   * 四个阶段分开报，调用方才能判断「重试安全吗」：
   *   resolve  → 会话不存在/不可用（409）
   *   create   → 消息没造出来（我们的问题）
   *   followup → 消息**没被接受**（重试安全）
   *   flush    → 消息可能已接受、但没落盘（重试**不安全**，会重复出一手）
   */
  private async deliverOnce(kind: WakeSourceKind, payload: WakePayload): Promise<WakeDeliveryResult> {
    const services = this.options.services();
    if (!services) return { ok: false, phase: 'resolve', error: new Error('宿主没有 sessionController/sessions 服务') };

    let agent: WakeAgent;
    try {
      const resolved = await services.sessionController.resolveAgent(payload.sessionId);
      // 官方写法就是看 'error' 键（见 @deepseek-ai/dsh-schedule 的 drive()）
      if (!resolved || 'error' in resolved) {
        return { ok: false, phase: 'resolve', error: resolved?.error ?? new Error('resolveAgent 返回了空结果') };
      }
      if (!resolved.agent) return { ok: false, phase: 'resolve', error: new Error('resolveAgent 没有返回 agent') };
      agent = resolved.agent;
    } catch (error) {
      return { ok: false, phase: 'resolve', error };
    }

    let message: unknown;
    let messageId: string | undefined;
    try {
      const create = await this.createMessage();
      message = create({
        content: [{ type: 'text', text: buildWakeText(payload) }],
        source: { kind },
      });
      const id = (message as { id?: unknown })?.id;
      messageId = typeof id === 'string' ? id : undefined;
    } catch (error) {
      return { ok: false, phase: 'create', error };
    }

    try {
      agent.followup(message);
    } catch (error) {
      return { ok: false, phase: 'followup', error };
    }

    try {
      // 照抄官方：flush 返回 false = 没有持久化监听器参与，等于没写进日志。
      const durable = await services.sessions.flush(agent.session);
      if (!durable) return { ok: false, phase: 'flush', error: new Error('会话没有确认持久化（flush 返回 false）') };
    } catch (error) {
      return { ok: false, phase: 'flush', error };
    }

    return { ok: true, messageId };
  }

  /**
   * 可唤醒性预检（第 18 轮）：**只问不投**。
   *
   * 为什么需要：绑定一个「属于 subagent routing」的会话时，平台会一直以为绑定成功，
   * 直到人类落子才发现 409（本次真实测试波三个测试员全踩）。让平台在 bind 时先问一句，
   * 就能当场婉拒，而不是等人坐到牌桌前。
   */
  async check(request: { method: string; headers: unknown; rawBody: string }): Promise<WakeHttpResult> {
    const method = request.method.toUpperCase();
    if (method !== 'POST') return this.fail(405, 'bad-request', `只接受 POST，收到 ${method}`);

    const expected = this.options.secret();
    const provided = readWakeSecret(request.headers);
    if (!expected) return this.fail(401, 'bad-secret', '插件还没生成唤醒密钥');
    if (!provided) return this.fail(401, 'bad-secret', '缺少 x-wake-secret 请求头');
    if (!secretEquals(provided, expected)) return this.fail(401, 'bad-secret', 'x-wake-secret 不匹配');

    let parsed: unknown;
    try {
      parsed = JSON.parse(request.rawBody || '{}');
    } catch (error) {
      return this.fail(400, 'bad-request', `body 不是合法 JSON：${describeError(error)}`);
    }
    const sessionId = (parsed as { sessionId?: unknown })?.sessionId;
    if (typeof sessionId !== 'string' || !ID_PATTERN.test(sessionId)) {
      return this.fail(400, 'bad-request', 'sessionId 必须是 [A-Za-z0-9._:-]{1,128}', { field: 'sessionId' });
    }

    const services = this.options.services();
    if (!services) {
      // 宿主没装 sessionController：现在叫不了，但可能是插件还没注入好 —— 报 available=false 而不是 throw。
      return { status: 200, body: { ok: true, wakeable: false, reason: '宿主没有 sessionController/sessions 服务', phase: 'services' } };
    }
    try {
      const resolved = await services.sessionController.resolveAgent(sessionId);
      if (resolved?.error) {
        return {
          status: 200,
          body: { ok: true, wakeable: false, reason: describeError(resolved.error), phase: 'resolve' },
        };
      }
      if (!resolved?.agent) {
        return { status: 200, body: { ok: true, wakeable: false, reason: 'resolveAgent 没有返回 agent', phase: 'resolve' } };
      }
      return { status: 200, body: { ok: true, wakeable: true } };
    } catch (error) {
      return { status: 200, body: { ok: true, wakeable: false, reason: describeError(error), phase: 'resolve' } };
    }
  }

  /** 主入口：鉴权 → 校验 → 去抖 → 投递（含一次安全的 kind 降级）。 */
  async handle(request: { method: string; headers: unknown; rawBody: string }): Promise<WakeHttpResult> {
    const method = request.method.toUpperCase();
    if (method !== 'POST') return this.fail(405, 'bad-request', `只接受 POST，收到 ${method}`);

    const expected = this.options.secret();
    const provided = readWakeSecret(request.headers);
    if (!expected) return this.fail(401, 'bad-secret', '插件还没生成唤醒密钥：重启一次插件，或看 $DSH_HOME/whale-arcade/config.json');
    if (!provided) return this.fail(401, 'bad-secret', '缺少 x-wake-secret 请求头');
    if (!secretEquals(provided, expected)) return this.fail(401, 'bad-secret', 'x-wake-secret 不匹配');

    if (request.rawBody.length > MAX_BODY_BYTES) return this.fail(400, 'bad-request', `请求体超过 ${MAX_BODY_BYTES} 字节`);
    let parsed: unknown;
    try {
      parsed = JSON.parse(request.rawBody || '{}');
    } catch (error) {
      return this.fail(400, 'bad-request', `body 不是合法 JSON：${describeError(error)}`);
    }
    const validated = validateWakePayload(parsed);
    if (!validated.ok) return this.fail(400, 'bad-request', validated.reason, { field: validated.field });
    const payload = validated.payload;

    // 去抖：同一 roomId+round 3 秒内只投一次。平台重试 / 人类连点都靠它兜住。
    // 去抖键带上 reason：终局那一手和「该你出招」可能落在同一回合号上，
    // 如果只按房间+回合去抖，「对局结束」会被 3 秒窗口吞掉（主人在最后一局踩过这个）。
    const dedupeKey = `${payload.roomId}\u0000${payload.round ?? 'na'}\u0000${payload.reason ?? 'turn'}`;
    const previous = this.dedupe.get(dedupeKey);
    const at = this.now();
    if (previous && at - previous.at < DEDUPE_MS) {
      this.debounced += 1;
      this.log(`[wake] 去抖：房间 ${payload.roomId} 第 ${payload.round ?? '?'} 回合 ${DEDUPE_MS}ms 内已投递过`);
      return {
        status: 200,
        body: {
          ok: true,
          deduped: true,
          deliveredAt: previous.deliveredAt,
          sessionId: previous.sessionId,
          sourceKind: previous.sourceKind,
          roomId: payload.roomId,
          round: payload.round ?? null,
        },
      };
    }
    this.pruneDedupe(at);

    const primary = this.activeKind;
    const first = await this.deliverOnce(primary, payload);

    if (first.ok) return this.accept(payload, primary, first.messageId, dedupeKey, at);

    // 降级判定（设计文档 §3.2 第 1 条要求「实测不被接受就退回 schedule」）：
    //   - followup 抛错 = 消息没被接受 → 重试安全，立刻换 kind 再来一次；
    //   - flush 抛错   = 消息可能已经进了会话 → **绝不重试**，只把 kind 换成保底值，
    //                    让下一次唤醒直接走 'schedule'（日志会写明原因）。
    const kindError = looksLikeSourceKindError(first.error);
    if (primary === 'wake' && (first.phase === 'followup' || kindError)) {
      this.log(`[wake] source.kind='${primary}' 投递失败（${first.phase}）：${describeError(first.error)}，改用 'schedule' 重试`);
      if (first.phase === 'followup') {
        const second = await this.deliverOnce('schedule', payload);
        if (second.ok) {
          this.activeKind = 'schedule';
          return this.accept(payload, 'schedule', second.messageId, dedupeKey, at);
        }
        this.lastError = `唤醒失败（${second.phase}）：${describeError(second.error)}`;
        return this.fail(409, 'session-unavailable', this.lastError, { phase: second.phase });
      }
      // flush 阶段：只降级、不重试，避免同一回合被叫醒两次
      this.activeKind = 'schedule';
    }

    const phase = first.phase ?? 'followup';
    const message =
      phase === 'resolve'
        ? `会话不可用：${describeError(first.error)}`
        : `投递失败（${phase}）：${describeError(first.error)}`;
    return this.fail(409, 'session-unavailable', message, { phase });
  }

  private accept(payload: WakePayload, kind: WakeSourceKind, messageId: string | undefined, key: string, at: number): WakeHttpResult {
    const deliveredAt = new Date(at).toISOString();
    this.lastDeliveredAt = deliveredAt;
    this.lastError = null;
    this.delivered += 1;
    this.lastRoom = payload.roomId;
    this.lastRound = payload.round ?? null;
    this.dedupe.set(key, { at, deliveredAt, sessionId: payload.sessionId, sourceKind: kind });
    this.log(`[wake] 已投递 → ${payload.sessionId}（房间 ${payload.roomId} 第 ${payload.round ?? '?'} 回合，kind=${kind}）`);
    return {
      status: 200,
      body: {
        ok: true,
        deliveredAt,
        sessionId: payload.sessionId,
        sourceKind: kind,
        roomId: payload.roomId,
        round: payload.round ?? null,
        messageId: messageId ?? null,
      },
    };
  }

  /** 去抖表不能无限涨：太久远的键没人会再撞上，直接清掉（最多也就几十个房间）。 */
  private pruneDedupe(at: number): void {
    if (this.dedupe.size < 64) return;
    for (const [key, entry] of this.dedupe) {
      if (at - entry.at > DEDUPE_MS * 4) this.dedupe.delete(key);
    }
  }
}

