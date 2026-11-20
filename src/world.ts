/**
 * 「思维链」World：把主 session 的模型输出流里那部分推理（reasoning）接出来，摆到她自己的
 * 一页上——她在这轮回答里想了什么、想到哪了、什么时候开口。
 *
 * 为什么放在 World 层：Core 的 `OutputTap` 会把每一轮模型的流式事件原样转给每个挂载的
 * World（见 `World.outputTap`），所以不需要改 Persona、不改聊天页、不碰宿主代码；
 * 卸载这个 World 就完全恢复原样。
 *
 * 它只观察，不参与：没有工具、没有事件、没有环境提示词，`envPromptVars()` 返回 null。
 * 思维链只在面板里出现，不会进入对话上下文。
 */
import type { OutputTap, ToolDef, World, WorldHost, WorldStreamSocket, WorldWebUiDecl } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { configGroups, readThoughtsConfig, THOUGHTS_ID, type ThoughtsConfigSection } from './config.ts';
import { readStreamEvent, THOUGHT_SYMBOL, ThoughtLog, type ThoughtBlock, type ThoughtLimits } from './thought.ts';
import { translateThinking, type Translated } from './translate.ts';

/** 增量往面板推的合批间隔：够快看出在长字，又不至于一 token 一帧。 */
const FLUSH_MS = 60;

/**
 * 与桌宠宿主补丁共享的绑定标记（`scripts/patch-pet-bubble.ps1`）。
 *
 * 插件在跑：标记在，桌宠的「思考」活动气泡显示最后一句思考；
 * 插件停用/被卸载：标记删掉，气泡退回只有思考图标。
 * 两边用同一个 `Symbol.for` 键，不引入文件或进程间通信。
 */
const BUBBLE_KEY = Symbol.for('dsh.thoughts.bubble');

export interface ThoughtsWorldOptions {
  cfg: ThoughtsConfigSection;
  persist: (patch: Partial<ThoughtsConfigSection>) => void;
  /** 部署目录：翻译时从这里读当前 provider 与密钥。 */
  botDir: string;
}

export class ThoughtsWorld implements World {
  readonly id = THOUGHTS_ID;
  private host: WorldHost | null = null;
  private readonly cfg: ThoughtsConfigSection;
  private readonly persist: (patch: Partial<ThoughtsConfigSection>) => void;
  private readonly botDir: string;
  private readonly blocks: ThoughtLog;
  private readonly sockets = new Set<WorldStreamSocket>();
  /** 段 id → 中文译文；只活在内存里，重启即清。 */
  private readonly translations = new Map<string, string>();
  /** 正在翻译的段，按 id 记下是哪一段（清空后同 id 的新段不会被误认）。 */
  private readonly translating = new Map<string, ThoughtBlock>();
  /** 给宿主桌宠补丁看的绑定状态；插件停用后整个标记会被删掉。 */
  private readonly bubble: { paused: boolean; zh: string; fallback: string } = {
    paused: false,
    /** 最近一段已译好的中文；气泡只显示它，不显示英文原文。 */
    zh: '',
    /** 第一段还没译好、或还没开自动译时的中文占位，避免气泡空着。 */
    fallback: '正在想…',
  };
  /** 还没发出去的增量，按段合并；面板不在时直接丢。 */
  private pending = new Map<string, string>();
  private flushTimer: NodeJS.Timeout | null = null;

  constructor(opts: ThoughtsWorldOptions) {
    this.cfg = opts.cfg;
    this.persist = opts.persist;
    this.botDir = opts.botDir;
    this.blocks = new ThoughtLog(this.limits());
  }

  private limits(): ThoughtLimits {
    const cfg = readThoughtsConfig(this.cfg);
    return { maxBlocks: cfg.maxBlocks, maxChars: cfg.maxChars };
  }

  // ── World 契约 ──────────────────────────────────────────────────────────

  /** 不给环境提示词：这个 World 不进模型上下文。 */
  envPromptVars(): null {
    return null;
  }

  /** 没有工具：它不替用户做事，只把思考过程摆出来。 */
  tools(): ToolDef[] {
    return [];
  }

  /**
   * 主 session 的输出旁路。思考不算外部输出（`externalizes` 恒为 false），
   * 所以它不会改变「模型已经开口」的判定，也不会挡住打断。
   */
  outputTap(): OutputTap | undefined {
    return {
      onEvent: (event) => this.capture(event),
      externalizes: () => false,
      onRoundEnd: () => this.endLive('done'),
      onAbort: () => this.endLive('aborted'),
    };
  }

  async start(host: WorldHost): Promise<void> {
    this.host = host;
    // 绑定桌宠气泡：插件在跑才显示思考；暂停记录时气泡也退回只有图标。
    this.bubble.paused = readThoughtsConfig(this.cfg).paused;
    this.bubble.zh = '';
    (globalThis as unknown as Record<symbol, unknown>)[BUBBLE_KEY] = this.bubble;
    try {
      host.log.info('思维链：World 启动（只观察主 session 的推理流）');
    } catch {
      /* 日志失败不影响启动 */
    }
  }

  async stop(): Promise<void> {
    this.endLive('done');
    // 插件停了，桌宠气泡就不再显示思考文本。
    delete (globalThis as unknown as Record<symbol, unknown>)[BUBBLE_KEY];
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = null;
    this.pending.clear();
    this.translations.clear();
    this.translating.clear();
    for (const socket of this.sockets) {
      try {
        socket.close('stopped');
      } catch {
        /* 已经断开的连接 */
      }
    }
    this.sockets.clear();
    try {
      this.host?.log.info('思维链：World 停止');
    } catch {
      /* ignore */
    }
    this.host = null;
  }

  // ── 采集 ────────────────────────────────────────────────────────────────

  private capture(event: unknown): void {
    if (this.cfg.paused) return;
    const signal = readStreamEvent(event);
    switch (signal.kind) {
      case 'round':
        // 新的一轮开始：上一轮没收尾的（比如流被截断）先收掉，空段会被自动丢掉。
        this.endLive('done');
        return;
      case 'delta': {
        const before = this.blocks.live?.id ?? null;
        const block = this.blocks.append(signal.text!);
        // 开段帧不带正文、字数从零起：这一段已经收下的增量会随 delta 帧补到面板，带上就会重复。
        if (block.id !== before) this.broadcast({ t: 'begin', block: { ...this.view(block), text: '', chars: 0 } });
        this.queueDelta(block.id, signal.text!);
        return;
      }
      case 'finished': {
        // 只有 done、没有 delta 的端点：整段补进来（收过增量的段会忽略）。
        const block = signal.text ? this.blocks.fill(signal.text) : null;
        if (block) this.broadcast({ t: 'begin', block: { ...this.view(block), text: '', chars: 0 } });
        this.endLive('done');
        return;
      }
      case 'answer':
        this.endLive('done', true);
        return;
      case 'tool':
        this.endLive('done');
        return;
      default:
        return;
    }
  }

  /** 收掉正在写的那段并通知面板；没有在写的就什么也不做。 */
  private endLive(state: 'done' | 'aborted', answered = false): void {
    const live = this.blocks.live;
    if (!live) return;
    if (answered) live.answered = true;
    const id = live.id;
    const hadText = live.text.trim().length > 0;
    this.blocks.finish(state);
    this.flushDeltas();
    this.broadcast({
      t: 'end',
      id,
      state,
      endedAt: live.endedAt,
      answered: live.answered,
      truncated: live.truncated,
      chars: live.chars,
      // 客户端按 delta 拼出来的文本可能与服务端的截断不同，这一段以这里为准。
      text: live.text,
    });
    // 自动翻译：只在段真的结束、并且开着 autoTranslate 时；出错不打扰对话。
    if (hadText && readThoughtsConfig(this.cfg).autoTranslate) {
      void this.translate(id, true).catch(() => { /* 自动翻译失败只记日志 */ });
    }
  }

  // ── 翻译 ────────────────────────────────────────────────────────────────

  /**
   * 把一段思考翻成中文。已有译文直接返回；正在翻就返回「译中」状态；
   * 失败抛错（面板 toast 出来）；`silent` 用于自动翻译，失败只记日志、不推失败帧。
   */
  private async translate(id: string, silent = false): Promise<Record<string, unknown>> {
    const block = this.blocks.find(id);
    if (!block) throw new Error('这一段已经不在了');
    if (!block.text.trim()) throw new Error('这一段还没有内容，没什么可翻的。');
    if (this.translations.has(id)) return this.view(block);
    if (this.translating.get(id) === block) return this.view(block);
    this.translating.set(id, block);
    this.broadcast({ t: 'translating', id, on: true });
    try {
      const result = await translateThinking(this.botDir, block.text, { timeoutMs: 90_000 });
      // 清空或换了新段时，旧结果直接丢掉。
      if (this.blocks.find(id) !== block) return this.view(block);
      this.translations.set(id, result.text);
      this.reportUsage(result);
      // 桌宠气泡：只有"最新一段"的译文才更新，手动翻旧段不会把气泡倒退。
      const newest = this.blocks.list()[0];
      if (newest && newest.id === id) this.bubble.zh = result.text;
      this.broadcast({ t: 'translated', id, text: result.text });
      return this.view(block);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      try { this.host?.log.warn('思维链：翻译失败', { err: message }); } catch { /* ignore */ }
      if (!silent) this.broadcast({ t: 'translate-error', id, error: message });
      throw new Error(message);
    } finally {
      if (this.translating.get(id) === block) this.translating.delete(id);
      this.broadcast({ t: 'translating', id, on: false });
    }
  }

  /** 翻译用的 token 也记进用量账本，别让它悄悄从账上消失。 */
  private reportUsage(result: Translated): void {
    if (!result.usage || !this.host?.reportUsage) return;
    try {
      this.host.reportUsage(result.usage, { model: result.model, label: '思维链翻译' });
    } catch {
      /* 记账失败不影响翻译 */
    }
  }

  // ── 推送 ────────────────────────────────────────────────────────────────

  private queueDelta(id: string, delta: string): void {
    if (!this.sockets.size) return;
    this.pending.set(id, (this.pending.get(id) ?? '') + delta);
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null;
      this.flushDeltas();
    }, FLUSH_MS);
    this.flushTimer.unref?.();
  }

  private flushDeltas(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = null;
    }
    if (!this.pending.size) return;
    const items = [...this.pending];
    this.pending.clear();
    for (const socket of this.sockets) {
      for (const [id, delta] of items) {
        socket.send(JSON.stringify({ t: 'delta', id, delta }));
      }
    }
  }

  private broadcast(payload: Record<string, unknown>): void {
    if (!this.sockets.size) return;
    this.flushDeltas();
    const text = JSON.stringify(payload);
    for (const socket of this.sockets) socket.send(text);
  }

  // ── 面板 ────────────────────────────────────────────────────────────────

  private view(block: ThoughtBlock): Record<string, unknown> {
    return {
      id: block.id,
      seq: block.seq,
      startedAt: block.startedAt,
      endedAt: block.endedAt,
      state: block.state,
      text: block.text,
      chars: block.chars,
      truncated: block.truncated,
      answered: block.answered,
      translated: this.translations.get(block.id) ?? null,
      translating: this.translating.get(block.id) === block,
    };
  }

  private snapshot(): Record<string, unknown> {
    const cfg = readThoughtsConfig(this.cfg);
    return {
      symbol: THOUGHT_SYMBOL,
      paused: cfg.paused,
      autoTranslate: cfg.autoTranslate,
      liveId: this.blocks.liveId,
      blocks: this.blocks.list().map((block) => this.view(block)),
      limits: { maxBlocks: cfg.maxBlocks, maxChars: cfg.maxChars },
    };
  }

  webUi(language: Language = 'zh'): WorldWebUiDecl {
    const zh = language === 'zh' || language === 'zh-Hant';
    const cfg = readThoughtsConfig(this.cfg);
    return {
      label: zh ? '思维链' : 'Thoughts',
      lamps: [{
        label: zh ? '思维链' : 'Thoughts',
        state: cfg.paused ? 'offline' : 'online',
        hint: cfg.paused
          ? (zh ? '已暂停记录；已记下的仍能看。' : 'Recording paused; earlier blocks stay.')
          : (zh ? '正在接住模型每一轮的推理流。' : 'Collecting each round’s reasoning stream.'),
      }],
      badges: [
        {
          label: zh ? '状态' : 'state',
          value: this.blocks.live ? (zh ? '正在想' : 'thinking') : (zh ? '空闲' : 'idle'),
          tone: this.blocks.live ? 'on' : 'plain',
        },
        { label: zh ? '已记' : 'blocks', value: this.blocks.count },
      ],
      config: configGroups(language),
      panels: [{
        id: 'live',
        title: zh ? '思维链 · 实时' : 'Thoughts · live',
        description: zh
          ? '她在这轮回答里想了什么：模型每吐一段推理，这里就长一行；讲完正文，这一段就收起来。只在面板里出现，不会进入对话。'
          : 'What she thinks before speaking: every reasoning delta lands here, and the block closes when she starts answering. This panel only; nothing enters the conversation.',
        getMethods: ['snapshot'],
      }],
      invoke: async (panel, method, args) => {
        if (panel !== 'live') throw new Error(zh ? `未知面板：${panel}` : `Unknown panel: ${panel}`);
        switch (method) {
          case 'snapshot':
            return this.snapshot();
          case 'clear':
            this.blocks.clear();
            this.translations.clear();
            this.bubble.zh = '';
            this.broadcast({ t: 'clear' });
            return this.snapshot();
          case 'pause':
          case 'resume': {
            const paused = method === 'pause';
            this.persist({ paused });
            this.bubble.paused = paused;
            this.broadcast({ t: 'paused', paused });
            return this.snapshot();
          }
          case 'translate': {
            const id = typeof args?.[0] === 'string' ? args[0] : '';
            if (!id) throw new Error(zh ? '缺少要翻译的段。' : 'Missing the block to translate.');
            return this.translate(id);
          }
          case 'autoTranslate': {
            const on = args?.[0] === true;
            this.persist({ autoTranslate: on });
            this.broadcast({ t: 'autoTranslate', on });
            return this.snapshot();
          }
          default:
            throw new Error(zh ? `未知方法：${method}` : `Unknown method: ${method}`);
        }
      },
      stream: (panel, socket) => {
        if (panel !== 'live') {
          socket.close('unknown panel');
          return;
        }
        this.sockets.add(socket);
        socket.onClose(() => { this.sockets.delete(socket); });
        // 连上先给一份全量：客户端不必猜先后。
        socket.send(JSON.stringify({ t: 'snapshot', ...this.snapshot() }));
      },
    };
  }
}
