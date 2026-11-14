import type { WorldDefinition } from 'cortico/world.ts';
import { THOUGHTS_ID, THOUGHTS_DEFAULTS, type ThoughtsConfigSection } from './config.ts';
import { ThoughtsWorld } from './world.ts';

/**
 * 「思维链」World 的定义。
 *
 * 她不因此多出任何工具、事件或提示词；挂上之后只是多出一页：模型每轮想了什么，
 * 面板里看得见。卸掉就恢复原样。
 */
export const THOUGHTS: WorldDefinition<ThoughtsConfigSection> = {
  id: THOUGHTS_ID,
  label: '思维链',
  defaults: () => ({ ...THOUGHTS_DEFAULTS }),
  create: (ctx) => new ThoughtsWorld({
    cfg: ctx.cfg,
    persist: (patch) => ctx.persist(patch),
    botDir: ctx.botDir,
  }),
  describe: {
    tools: [],
    events: [],
  },
};

export default THOUGHTS;
