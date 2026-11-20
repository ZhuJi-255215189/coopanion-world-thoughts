/**
 * 「思维链」的纯逻辑：把模型输出流里的 reasoning 增量攒成一段一段，处理截断、收尾与丢弃空段。
 *
 * 不碰 DOM、不读配置、不依赖 Cortico 的时间戳，因此可以直接 `node --test` 跑。
 * World 只负责把事件喂进来、把结果推给面板。
 */

/** 每段思维链前面那个符号。 */
export const THOUGHT_SYMBOL = '✻';

/** 一段思维链的状态：正在写、正常收尾、被打断。 */
export type ThoughtState = 'live' | 'done' | 'aborted';

export interface ThoughtBlock {
  /** 段内唯一，形如 `t3`。 */
  id: string;
  /** 第几段，从 1 起，清空后重新数。 */
  seq: number;
  startedAt: string;
  endedAt: string | null;
  state: ThoughtState;
  /** 正文。超过 maxChars 的尾巴不保留。 */
  text: string;
  /** 截断前的总字符数。 */
  chars: number;
  truncated: boolean;
  /** 这一段之后模型已经开始说正文。 */
  answered: boolean;
}

export interface ThoughtLimits {
  /** 最多留多少段；更早的丢掉。 */
  maxBlocks: number;
  /** 单段最多留多少字符；超出从尾部截断。 */
  maxChars: number;
}

export const THOUGHT_LIMITS: ThoughtLimits = { maxBlocks: 40, maxChars: 20_000 };

/**
 * 这段思考是不是「以中文为主」：至少 4 个汉字，且汉字占中英文合计的 15% 以上。
 *
 * 阈值为什么这么低：中文推理里 `pet_say`、`browser_search`、`read_file` 这类工具名/标识符
 * 会反复出现，字符数很占便宜；实测英文思考里零星中文词只占 3%–8%，中文推理（夹工具名）
 * 也在 34% 以上，0.15 正好把两边分开。
 */
export function isMostlyChinese(text: string): boolean {
  const zh = (text.match(/[\u4e00-\u9fff]/g) || []).length;
  if (zh < 4) return false;
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  return zh / (zh + latin) >= 0.15;
}

/** 从输出流事件里认出的几类信号。 */
export type StreamKind = 'round' | 'delta' | 'finished' | 'answer' | 'tool' | 'none';

export interface StreamSignal {
  kind: StreamKind;
  /** delta 的增量，或 finished 带回的整段文本。 */
  text?: string;
}

/**
 * 把一条 `StreamEvent` 收成我们关心的信号。
 *
 * 参数故意收 `unknown`：扩展与框架的协议类型各自演化，World 只认字段名，
 * 不因为多了一个字段或换了事件名就崩掉。
 */
export function readStreamEvent(event: unknown): StreamSignal {
  const e = (event ?? {}) as {
    type?: unknown;
    delta?: unknown;
    text?: unknown;
    item?: { type?: unknown } | null;
  };
  const type = typeof e.type === 'string' ? e.type : '';
  switch (type) {
    case 'response.created':
      return { kind: 'round' };
    case 'response.reasoning.delta':
    case 'response.reasoning_summary_text.delta':
      return typeof e.delta === 'string' && e.delta ? { kind: 'delta', text: e.delta } : { kind: 'none' };
    case 'response.reasoning.done':
    case 'response.reasoning_summary_text.done':
      // 有的端点只发 done，不带 delta；把整段文本带回去，由 ThoughtLog 决定用不用。
      return { kind: 'finished', ...(typeof e.text === 'string' && e.text ? { text: e.text } : {}) };
    case 'response.output_text.delta':
    case 'response.refusal.delta':
      return { kind: 'answer' };
    case 'response.output_item.added':
    case 'response.output_item.done':
      if (e.item?.type === 'reasoning') return { kind: 'finished' };
      if (e.item?.type === 'function_call') return { kind: 'tool' };
      return { kind: 'none' };
    default:
      return { kind: 'none' };
  }
}

/**
 * 思维链账本。只有一段在写（`live`），其余都是收尾过的历史。
 *
 * 没真的思考时不会开段：`append` 才开，收尾时把空段扔掉。
 */
export class ThoughtLog {
  private readonly blocks: ThoughtBlock[] = [];
  private readonly limits: ThoughtLimits;
  private seq = 0;

  constructor(limits: ThoughtLimits = THOUGHT_LIMITS) {
    this.limits = {
      maxBlocks: Math.max(1, Math.floor(limits.maxBlocks)),
      maxChars: Math.max(1, Math.floor(limits.maxChars)),
    };
  }

  /** 正在写的那一段；没有就是 null。 */
  get live(): ThoughtBlock | null {
    const last = this.blocks.at(-1);
    return last && last.state === 'live' ? last : null;
  }

  get liveId(): string | null {
    return this.live?.id ?? null;
  }

  get count(): number {
    return this.blocks.length;
  }

  /** 开一段；已经有在写的就先把那段正常收尾。 */
  begin(at = new Date().toISOString()): ThoughtBlock {
    this.finish('done', at);
    const block: ThoughtBlock = {
      id: `t${++this.seq}`,
      seq: this.seq,
      startedAt: at,
      endedAt: null,
      state: 'live',
      text: '',
      chars: 0,
      truncated: false,
      answered: false,
    };
    this.blocks.push(block);
    this.trim();
    if (block.id !== this.blocks.at(-1)?.id) {
      // maxBlocks 为 1 时新段也会被裁掉；至少留当前这一段。
      this.blocks.splice(0, this.blocks.length, block);
    }
    return block;
  }

  /** 把一个增量接在当前那段；没有在写的就新开一段。返回落点。 */
  append(delta: string, at = new Date().toISOString()): ThoughtBlock {
    const block = this.live ?? this.begin(at);
    if (!delta) return block;
    block.chars += delta.length;
    const room = this.limits.maxChars - block.text.length;
    if (room > 0) {
      block.text += delta.slice(0, room);
      if (delta.length > room) block.truncated = true;
    } else {
      block.truncated = true;
    }
    return block;
  }

  /**
   * 只发整段、不发增量的端点：把这一段补进当前段。
   * 已经收过增量的段不重复填。返回落点；没有文本时 null。
   */
  fill(text: string, at = new Date().toISOString()): ThoughtBlock | null {
    if (!text.trim()) return null;
    const live = this.live;
    if (live && live.chars > 0) return null;
    return this.append(text, at);
  }

  /** 模型开口说正文：这一段到此为止。 */
  answered(at = new Date().toISOString()): void {
    const live = this.live;
    if (!live) return;
    live.answered = true;
    this.finish('done', at);
  }

  /** 收掉正在写的那段；空段直接丢掉。 */
  finish(state: Exclude<ThoughtState, 'live'> = 'done', at = new Date().toISOString()): void {
    const live = this.live;
    if (!live) return;
    live.state = state;
    live.endedAt = at;
    if (!live.text.trim()) {
      const at2 = this.blocks.indexOf(live);
      if (at2 >= 0) this.blocks.splice(at2, 1);
    }
  }

  /** 按 id 找一段（翻译时要取原文）；找不到就是 null。 */
  find(id: string): ThoughtBlock | null {
    return this.blocks.find((block) => block.id === id) ?? null;
  }

  clear(): void {
    this.blocks.length = 0;
    // 清空后重新从第 1 段数：面板上的编号也跟着重来。
    this.seq = 0;
  }

  /** 最新一段在最前；给面板用，不交出内部对象。 */
  list(): ThoughtBlock[] {
    return [...this.blocks].reverse();
  }

  private trim(): void {
    while (this.blocks.length > this.limits.maxBlocks) this.blocks.shift();
  }
}
