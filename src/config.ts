/**
 * 「思维链」World 的配置段与配置页声明。
 *
 * 配置写在 config.json 的 `worlds.thoughts` 下。这里没有密钥、没有外部服务：
 * 这个 World 只观察主 session 的输出流，不联网、不给模型工具、不推事件。
 */
import type { ConfigGroup } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';

export const THOUGHTS_ID = 'thoughts';

/** config.json 的 `worlds.thoughts` 段。 */
export interface ThoughtsConfigSection {
  enabled: boolean;
  /** 暂停记录：暂停后不再攒新的思维链，已经攒下的仍能看。 */
  paused: boolean;
  /** 最多留多少段；更早的丢掉。 */
  maxBlocks: number;
  /** 单段最多留多少字符；超出的尾巴不保留。 */
  maxChars: number;
  /** 每段收尾后自动翻成中文（会额外调用一次模型，默认关）。 */
  autoTranslate: boolean;
}

export const THOUGHTS_DEFAULTS: ThoughtsConfigSection = {
  enabled: false,
  paused: false,
  maxBlocks: 40,
  maxChars: 20_000,
  autoTranslate: false,
};

const integer = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

const boolean = (value: unknown, fallback: boolean): boolean => (typeof value === 'boolean' ? value : fallback);

/** 读配置：越界值夹到合法区间，坏值退回默认，绝不因为一段脏配置让 World 起不来。 */
export function readThoughtsConfig(raw: Partial<ThoughtsConfigSection> | undefined | null): ThoughtsConfigSection {
  const cfg = raw ?? {};
  return {
    enabled: boolean(cfg.enabled, THOUGHTS_DEFAULTS.enabled),
    paused: boolean(cfg.paused, THOUGHTS_DEFAULTS.paused),
    maxBlocks: integer(cfg.maxBlocks, THOUGHTS_DEFAULTS.maxBlocks, 1, 200),
    maxChars: integer(cfg.maxChars, THOUGHTS_DEFAULTS.maxChars, 500, 100_000),
    autoTranslate: boolean(cfg.autoTranslate, THOUGHTS_DEFAULTS.autoTranslate),
  };
}

const TEXT = {
  zh: {
    title: '思维链',
    blocks: { title: '最多留几段', description: '面板里保留最近多少段思考；更早的丢掉。只影响这一页，不写进对话。' },
    chars: { title: '单段最多多少字', description: '一段思考太长时只保留开头这些字，面板会标出「已截断」。' },
    paused: { title: '暂停记录', description: '暂停后不再收新的思维链；已经记下的还能看。' },
    translate: { title: '自动翻成中文', description: '每段思考收尾后自动调一次模型翻成中文。会额外花 token（大约每段一次输出）；关着时也能在面板里手动点「译」。' },
    segments: '段',
    charsUnit: '字',
  },
  en: {
    title: 'Thoughts',
    blocks: { title: 'Blocks kept', description: 'How many recent thought blocks the panel keeps; older ones are dropped. This page only; nothing enters the conversation.' },
    chars: { title: 'Characters per block', description: 'A longer block keeps only its beginning and is marked truncated.' },
    paused: { title: 'Pause recording', description: 'No new thoughts are recorded while paused; what is already there stays.' },
    translate: { title: 'Auto-translate to Chinese', description: 'Calls the model once per block to translate it. Costs extra tokens (about one output per block); when off you can still press "Translate" in the panel.' },
    segments: 'blocks',
    charsUnit: 'chars',
  },
};

export function configGroups(language: Language = 'zh'): ConfigGroup[] {
  const t = TEXT[language === 'zh' || language === 'zh-Hant' ? 'zh' : 'en'];
  const K = `worlds.${THOUGHTS_ID}`;
  return [{
    id: `world:${THOUGHTS_ID}`,
    owner: `world:${THOUGHTS_ID}`,
    schema: {
      type: 'object',
      title: t.title,
      properties: {
        [`${K}.maxBlocks`]: { type: 'integer', ...t.blocks, minimum: 1, maximum: 200, 'x-suffix': t.segments, 'x-hot': true },
        [`${K}.maxChars`]: { type: 'integer', ...t.chars, minimum: 500, maximum: 100000, 'x-suffix': t.charsUnit, 'x-hot': true },
        [`${K}.paused`]: { type: 'boolean', ...t.paused, 'x-hot': true },
        [`${K}.autoTranslate`]: { type: 'boolean', ...t.translate, 'x-hot': true },
      },
    },
  }];
}
