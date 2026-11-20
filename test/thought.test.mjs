/**
 * 纯逻辑测试：thinking 段的开合、截断、丢弃空段，以及流事件识别。
 * 不需要 Cortico，也不碰 DOM。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isMostlyChinese, readStreamEvent, THOUGHT_SYMBOL, ThoughtLog } from '../src/thought.ts';

test('符号就是面板上用的那个', () => {
  assert.equal(THOUGHT_SYMBOL, '✻');
});

test('append 自动开段，并一直写在同一段里', () => {
  const log = new ThoughtLog();
  const a = log.append('想', '2026-01-01T00:00:00.000Z');
  const b = log.append('一下', '2026-01-01T00:00:01.000Z');
  assert.equal(a.id, b.id);
  assert.equal(log.count, 1);
  assert.equal(log.live?.text, '想一下');
  assert.equal(log.live?.chars, 3);
  assert.equal(log.live?.startedAt, '2026-01-01T00:00:00.000Z');
});

test('begin 会先把上一段收掉', () => {
  const log = new ThoughtLog();
  log.append('第一段');
  const second = log.begin('2026-01-01T00:00:02.000Z');
  const [latest, older] = log.list();
  assert.equal(latest.id, second.id);
  assert.equal(older.state, 'done');
  assert.equal(older.endedAt, '2026-01-01T00:00:02.000Z');
});

test('answered 收尾并标记已开口', () => {
  const log = new ThoughtLog();
  log.append('她先想');
  log.answered('2026-01-01T00:00:03.000Z');
  assert.equal(log.live, null);
  const [block] = log.list();
  assert.equal(block.state, 'done');
  assert.equal(block.answered, true);
  assert.equal(block.endedAt, '2026-01-01T00:00:03.000Z');
});

test('空段在收尾时被丢掉', () => {
  const log = new ThoughtLog();
  log.begin();
  log.finish('done');
  assert.equal(log.count, 0);
  assert.deepEqual(log.list(), []);
});

test('只有 done、没有 delta 的端点也能补进整段', () => {
  const log = new ThoughtLog();
  const block = log.fill('整段思考');
  assert.ok(block);
  assert.equal(log.live?.text, '整段思考');
  // 已经收过增量的段不再重复填
  log.append('，接着说');
  assert.equal(log.fill('整段思考'), null);
  assert.equal(log.live?.text, '整段思考，接着说');
});

test('超过 maxChars 的尾巴不保留，并标出截断', () => {
  const log = new ThoughtLog({ maxBlocks: 3, maxChars: 5 });
  log.append('一二三四五六七八');
  const [block] = log.list();
  assert.equal(block.text, '一二三四五');
  assert.equal(block.chars, 8);
  assert.equal(block.truncated, true);
});

test('最多留 maxBlocks 段，最早的先走', () => {
  const log = new ThoughtLog({ maxBlocks: 2, maxChars: 1000 });
  for (const word of ['甲', '乙', '丙']) {
    log.append(word);
    log.finish('done');
  }
  const list = log.list();
  assert.equal(list.length, 2);
  assert.equal(list[0].text, '丙');
  assert.equal(list[1].text, '乙');
});

test('maxBlocks 为 1 时当前段不会被自己裁掉', () => {
  const log = new ThoughtLog({ maxBlocks: 1, maxChars: 1000 });
  log.append('还在想');
  assert.equal(log.count, 1);
  assert.equal(log.live?.text, '还在想');
});

test('clear 之后重新从第 1 段数', () => {
  const log = new ThoughtLog();
  log.append('旧');
  log.clear();
  assert.equal(log.count, 0);
  const block = log.append('新');
  assert.equal(block.seq, 1);
});

test('list 最新在前，且不改内部顺序', () => {
  const log = new ThoughtLog();
  log.append('早');
  log.finish('done');
  log.append('晚');
  const list = log.list();
  assert.deepEqual(list.map((b) => b.text), ['晚', '早']);
  assert.equal(log.list().length, 2);
});

test('readStreamEvent 认出各家的 reasoning 增量', () => {
  assert.deepEqual(readStreamEvent({ type: 'response.created' }), { kind: 'round' });
  assert.deepEqual(
    readStreamEvent({ type: 'response.reasoning.delta', delta: '嗯' }),
    { kind: 'delta', text: '嗯' },
  );
  assert.deepEqual(
    readStreamEvent({ type: 'response.reasoning_summary_text.delta', delta: '嗯' }),
    { kind: 'delta', text: '嗯' },
  );
  assert.deepEqual(
    readStreamEvent({ type: 'response.reasoning.done', text: '整段' }),
    { kind: 'finished', text: '整段' },
  );
  assert.deepEqual(readStreamEvent({ type: 'response.reasoning.done' }), { kind: 'finished' });
  assert.deepEqual(readStreamEvent({ type: 'response.output_text.delta', delta: '答' }), { kind: 'answer' });
  assert.deepEqual(readStreamEvent({ type: 'response.refusal.delta', delta: '不' }), { kind: 'answer' });
  assert.deepEqual(
    readStreamEvent({ type: 'response.output_item.done', item: { type: 'reasoning' } }),
    { kind: 'finished' },
  );
  assert.deepEqual(
    readStreamEvent({ type: 'response.output_item.added', item: { type: 'function_call' } }),
    { kind: 'tool' },
  );
});

test('readStreamEvent 对无关或坏事件不抛错', () => {
  assert.deepEqual(readStreamEvent(undefined), { kind: 'none' });
  assert.deepEqual(readStreamEvent({}), { kind: 'none' });
  assert.deepEqual(readStreamEvent({ type: 'response.completed' }), { kind: 'none' });
  assert.deepEqual(readStreamEvent({ type: 'response.reasoning.delta', delta: '' }), { kind: 'none' });
  assert.deepEqual(readStreamEvent({ type: 'response.reasoning.delta', delta: 42 }), { kind: 'none' });
});

test('isMostlyChinese 认中文原文，不被工具名带偏', () => {
  assert.equal(isMostlyChinese('先调用 pet_say 说一句，再 browser_search 搜天气。'), true);
  assert.equal(isMostlyChinese('This is an English thought.'), false);
  assert.equal(isMostlyChinese(''), false);
  assert.equal(isMostlyChinese('pet_say browser_search'), false);
  assert.equal(isMostlyChinese('代码路径 src/index.ts 保持原样，其余用中文说明。'), true);
});
