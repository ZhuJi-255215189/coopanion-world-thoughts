/**
 * 离线冒烟：不启动 Coopanion，只借它自带的 tsx 与 `cortico/*` 解析规则，
 * 把 World 定义 import 进来、造一个实例、喂几条假事件，看看面板快照与推流帧对不对。
 *
 * 用法（在 Coopanion 的 resources/app 目录下跑，好让 `tsx` 解析得到）：
 *   node --import tsx scripts/probe.mjs
 *
 * 只读、不联网、不写文件。
 */
import { registerHooks } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
/** Coopanion 的框架源码目录；可用 CORTICO_SRC 覆盖。 */
const SRC = process.env.CORTICO_SRC
  ?? 'D:/Coopanion-Setup-0.2.8/resources/app/build/cortico/src/';
const framework = new URL(SRC.endsWith('/') ? SRC : `${SRC}/`);

// 与 extensions/runtime.ts 同样的映射：cortico/<路径> → 框架 src/<路径>。
registerHooks({
  resolve(specifier, context, next) {
    if (specifier.startsWith('cortico/')) return next(new URL(specifier.slice('cortico/'.length), framework).href, context);
    return next(specifier, context);
  },
});

const mod = await import(new URL(`file:///${join(here, '..', 'src', 'index.ts').replace(/\\/g, '/')}`).href);
const definition = mod.default;
if (!definition || definition.id !== 'thoughts') throw new Error('default 导出不是思维链 World');

const cfg = { ...definition.defaults(), enabled: true };
const world = definition.create({
  id: definition.id,
  cfg,
  timezone: 'Asia/Shanghai',
  botName: 'Coo',
  botDir: process.env.COO_BOT_DIR ?? 'D:/Coopanion-Setup-0.2.8/data/home/companion',
  packageDir: here,
  dataDir: here,
  repoRoot: here,
  secret: () => '',
  storeSecret() {},
  persist: (patch) => { Object.assign(cfg, patch); },
  restart: async () => {},
});

await world.start({ log: { info() {}, warn() {}, error() {}, debug() {}, trace() {}, emit() {} } });

const ui = world.webUi('zh');
/** 假的面板连接：收到的每一帧都记下来。 */
const frames = [];
const socket = {
  open: true,
  send(text) { frames.push(JSON.parse(text)); },
  close(reason) { this.open = false; this.reason = reason; },
  onMessage() {},
  onClose(cb) { this.onClosed = cb; },
};
ui.stream('live', socket);

const tap = world.outputTap();
tap.onEvent({ type: 'response.created' });
tap.onEvent({ type: 'response.reasoning.delta', delta: '对方问的是插件' });
tap.onEvent({ type: 'response.reasoning.delta', delta: '，先看她装没装。' });
// 等增量合批的定时器把 delta 发出去
await new Promise((resolve) => setTimeout(resolve, 120));
const beforeAnswer = await ui.invoke('live', 'snapshot');

tap.onEvent({ type: 'response.output_text.delta', delta: '我来看看。' });
const afterAnswer = await ui.invoke('live', 'snapshot');

// 暂停后不应再收新段
await ui.invoke('live', 'pause');
tap.onEvent({ type: 'response.created' });
tap.onEvent({ type: 'response.reasoning.delta', delta: '暂停时不该出现' });
const whilePaused = await ui.invoke('live', 'snapshot');
await ui.invoke('live', 'resume');

// 真打一次翻译：验证端点解析、协议回退与译文清理（花掉几分钱）。
let translation;
try {
  const block = await ui.invoke('live', 'translate', ['t1']);
  translation = { ok: true, translated: block?.translated ?? null };
} catch (error) {
  translation = { ok: false, error: error instanceof Error ? error.message : String(error) };
}

await world.stop();

/** 照客户端 client.js 的算法重放一遍帧，确认拼出来的正文和服务端一致、不重复。 */
const painted = [];
for (const frame of frames) {
  if (frame.t === 'begin') painted.unshift({ ...frame.block });
  else if (frame.t === 'delta') {
    const block = painted.find((item) => item.id === frame.id);
    if (block) { block.text += frame.delta; block.chars += frame.delta.length; }
  } else if (frame.t === 'end') {
    const block = painted.find((item) => item.id === frame.id);
    if (block) { block.state = frame.state; block.text = frame.text; block.chars = frame.chars; }
  } else if (frame.t === 'clear') painted.length = 0;
}
const expected = afterAnswer.blocks[0]?.text;
if (painted[0]?.text !== expected) {
  throw new Error(`客户端拼出来的正文和服务端不一致：${JSON.stringify(painted[0]?.text)} ≠ ${JSON.stringify(expected)}`);
}

console.log(JSON.stringify({
  frames,
  beforeAnswer,
  afterAnswer,
  paused: { cfgPaused: cfg.paused, blocks: whilePaused.blocks.length },
  translation,
  painted,
}, null, 2));
