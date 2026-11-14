/**
 * 「思维链 · 实时」面板。
 *
 * 只做一件事：把 World 采到的推理段摆出来——最新一段在显眼处实时长字，更早的收进折叠块。
 * 没有框架依赖，纯 ESM；宿主通过 `cortico.webUiClient` 加载，样式走 `webui/style.css`。
 */

const STR = {
  zh: {
    title: '思维链 · 实时',
    desc: '她在这轮回答之前想了什么。模型每吐一段推理，这里就长一行；她开口说正文，这一段就收起来。',
    live: '正在想',
    idle: '空闲',
    paused: '已暂停',
    pause: '暂停记录',
    resume: '继续记录',
    clear: '清空',
    clearTitle: '清空思维链',
    clearBody: '面板上记下的思维链会全部清掉；已经说出口的回答不受影响。',
    copy: '复制最近一段',
    copied: '已复制',
    empty: '还没有思维链。等她说下一句话，这里就会出现她刚才想了什么。',
    emptyHint: '如果一直空着：这个端点可能不返回思维链，或者「暂停记录」还开着。',
    latest: '最近一段',
    answered: '已开口',
    interrupted: '中断',
    truncated: '已截断',
    chars: (n) => `${n} 字`,
    block: (n) => `第 ${n} 段`,
    history: '再往前',
    noHistory: '没有更早的了。',
    failed: '面板刷新失败',
    connecting: '连接中…',
    connected: '实时',
    offline: '断线',
    pausedHint: '暂停后不再收新的思维链；已经记下的仍能看。',
    resumedHint: '已继续记录',
    pausedToast: '已暂停记录',
    clearedToast: '已清空',
    copyEmpty: '这一轮还没有思维链',
    translate: '译',
    translateTitle: '译成中文',
    translating: '译中…',
    translatedTag: '中文',
    translatedOk: '译好了',
    translateFailed: '翻译失败',
    autoTranslate: '自动译',
    autoTranslateHint: '每段收尾后自动翻成中文。翻译会再调用一次模型，按输出 token 计费；关着时也能手动点「译」。',
    autoOn: '已开启自动翻译',
    autoOff: '已关闭自动翻译',
    zhLabel: '中文',
  },
  en: {
    title: 'Thoughts · live',
    desc: 'What she thinks before answering. Every reasoning delta grows a line here; the block closes when she starts speaking.',
    live: 'Thinking',
    idle: 'Idle',
    paused: 'Paused',
    pause: 'Pause recording',
    resume: 'Resume recording',
    clear: 'Clear',
    clearTitle: 'Clear thoughts',
    clearBody: 'Every block on this panel is removed. Answers already spoken are unaffected.',
    copy: 'Copy latest',
    copied: 'Copied',
    empty: 'No thoughts yet. Once she starts a reply, what she thought shows up here.',
    emptyHint: 'If this stays empty: the endpoint may return no reasoning, or recording is paused.',
    latest: 'Latest',
    answered: 'answered',
    interrupted: 'interrupted',
    truncated: 'truncated',
    chars: (n) => `${n} chars`,
    block: (n) => `#${n}`,
    history: 'Earlier',
    noHistory: 'Nothing earlier.',
    failed: 'Could not refresh the panel',
    connecting: 'Connecting…',
    connected: 'live',
    offline: 'offline',
    pausedHint: 'No new thoughts are recorded while paused; what is here stays.',
    resumedHint: 'Recording resumed',
    pausedToast: 'Recording paused',
    clearedToast: 'Cleared',
    copyEmpty: 'No thoughts in this round yet',
    translate: '译',
    translateTitle: 'Translate to Chinese',
    translating: 'Translating…',
    translatedTag: 'Chinese',
    translatedOk: 'Translated',
    translateFailed: 'Translation failed',
    autoTranslate: 'Auto',
    autoTranslateHint: 'Translate every finished block to Chinese. Each translation is one more model call billed as output; you can also press 译 by hand.',
    autoOn: 'Auto-translate on',
    autoOff: 'Auto-translate off',
    zhLabel: 'Chinese',
  },
};

const text = (language) => (language === 'zh' || language === 'zh-Hant' ? STR.zh : STR.en);

const errText = (error) => (error instanceof Error ? error.message : String(error)).replace(/^[A-Za-z_$][\w$]*Error:\s*/, '');

/** 宿主给的时间是 ISO；面板里只要时分秒。 */
function clock(iso) {
  if (!iso) return '';
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  return at.toLocaleTimeString(undefined, { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

/** 服务端与客户端之间的块形状，缺字段就补默认值。 */
function normalize(raw) {
  const b = raw || {};
  return {
    id: typeof b.id === 'string' ? b.id : `t${Math.random().toString(36).slice(2)}`,
    seq: Number(b.seq) || 0,
    startedAt: typeof b.startedAt === 'string' ? b.startedAt : '',
    endedAt: typeof b.endedAt === 'string' ? b.endedAt : null,
    state: b.state === 'live' || b.state === 'aborted' ? b.state : 'done',
    text: typeof b.text === 'string' ? b.text : '',
    chars: Number(b.chars) || 0,
    truncated: b.truncated === true,
    answered: b.answered === true,
    translated: typeof b.translated === 'string' && b.translated ? b.translated : null,
    translating: b.translating === true,
  };
}

const PANEL = {
  mount(ctx) {
    const t = text(ctx.language);
    const { ui, root } = ctx;

    /** 最新一段在最前，和 World 的 list() 一致。 */
    const view = { symbol: '✻', paused: false, autoTranslate: false, blocks: [], liveId: null };

    const sheet = ui.sheet({ title: t.title, desc: t.desc });
    const bar = ui.rowbar();
    const lampHost = ui.h('span', 'th-lamp');
    const autoBox = ui.checkbox(t.autoTranslate, {
      checked: false,
      title: t.autoTranslateHint,
      onChange: (checked) => void setAutoTranslate(checked),
    });
    const pauseBtn = ui.button(t.pause, { size: 'sm', onClick: () => void togglePause() });
    const clearBtn = ui.button(t.clear, { size: 'sm', variant: 'plain', onClick: () => void clear() });
    const copyBtn = ui.copyButton(() => latestText(), { label: t.copy, okText: t.copied, size: 'sm' });
    bar.append(lampHost, autoBox.el, ui.h('span', 'grow'), copyBtn, pauseBtn, clearBtn);

    const note = ui.h('div', 'th-note', '');
    const current = ui.h('div', 'th-current');
    const head = ui.h('div', 'th-current-head');
    const symEl = ui.h('span', 'th-sym', view.symbol);
    const nameEl = ui.h('span', 'th-current-name', '');
    const metaEl = ui.h('span', 'th-meta', '');
    const trBtn = ui.button(t.translate, {
      size: 'sm',
      variant: 'plain',
      onClick: () => void translateBlock(latest()),
    });
    trBtn.title = t.translateTitle;
    trBtn.className = 'btn sm plain th-tr-btn';
    head.append(symEl, nameEl, ui.h('span', 'grow'), trBtn, metaEl);
    const flow = ui.h('div', 'th-flow');
    const textEl = ui.h('div', 'th-text', '');
    const currentTr = ui.h('div', 'th-translation', '');
    currentTr.hidden = true;
    flow.append(textEl, currentTr);
    current.append(head, flow);

    const historyTitle = ui.h('div', 'th-subtitle', t.history);
    const historyList = ui.h('div', 'th-history');
    /** 展开过的历史段：整页重排（比如 30 秒一次的兜底同步）之后恢复展开。 */
    const opened = new Set();
    const msg = ui.msgline('');
    msg.hidden = true;

    sheet.body.append(bar, note, msg, current, historyTitle, historyList);
    root.append(sheet.el);

    const show = (bad, line) => {
      msg.hidden = !line;
      msg.textContent = line || '';
      msg.className = bad ? 'msgline bad' : 'msgline';
    };

    const latest = () => view.blocks[0] || null;
    const latestText = () => {
      const block = latest();
      return block && block.text ? block.text : t.copyEmpty;
    };
    const find = (id) => view.blocks.find((block) => block.id === id) || null;

    function paintLamp() {
      const block = latest();
      const mode = view.paused ? 'plain' : block && block.state === 'live' ? 'on' : 'plain';
      const label = view.paused ? t.paused : block && block.state === 'live' ? t.live : t.idle;
      lampHost.replaceChildren(ui.pill(label, mode));
    }

    function metaOf(block) {
      const bits = [clock(block.startedAt) || t.idle, t.chars(block.chars)];
      if (block.answered) bits.push(t.answered);
      else if (block.state === 'aborted') bits.push(t.interrupted);
      if (block.truncated) bits.push(t.truncated);
      return bits.join(' · ');
    }

    function paintCurrent() {
      const block = latest();
      if (!block) {
        current.hidden = true;
        return;
      }
      current.hidden = false;
      symEl.textContent = view.symbol;
      nameEl.textContent = block.state === 'live' ? t.live : t.block(block.seq);
      metaEl.textContent = metaOf(block);
      textEl.textContent = block.text;
      currentTr.hidden = !block.translated;
      currentTr.textContent = block.translated || '';
      trBtn.hidden = !block.text || Boolean(block.translated);
      trBtn.disabled = block.translating === true;
      trBtn.textContent = block.translating ? t.translating : t.translate;
      current.className = block.state === 'live' ? 'th-current live' : block.state === 'aborted' ? 'th-current aborted' : 'th-current';
      // 贴底时跟着长字；人往上翻就不打扰。
      const stick = flow.scrollHeight - flow.scrollTop - flow.clientHeight < 48;
      if (stick) flow.scrollTop = flow.scrollHeight;
    }

    function paintHistory() {
      const older = view.blocks.slice(1);
      historyTitle.hidden = older.length === 0;
      historyList.hidden = older.length === 0;
      const rows = older.map((block) => {
        const box = document.createElement('details');
        box.className = block.state === 'aborted' ? 'th-block aborted' : 'th-block';
        box.open = opened.has(block.id);
        box.addEventListener('toggle', () => {
          if (box.open) opened.add(block.id);
          else opened.delete(block.id);
        });
        const sum = document.createElement('summary');
        sum.className = 'th-block-head';
        const sym = ui.h('span', 'th-sym', view.symbol);
        const name = ui.h('span', 'th-block-name', t.block(block.seq));
        const meta = ui.h('span', 'th-meta', metaOf(block));
        sum.append(sym, name, meta);
        if (block.text && !block.translated) {
          const btn = ui.button(block.translating ? t.translating : t.translate, {
            size: 'sm',
            variant: 'plain',
            onClick: (ev) => {
              ev.preventDefault();
              ev.stopPropagation();
              void translateBlock(block);
            },
          });
          btn.title = t.translateTitle;
          btn.disabled = block.translating === true;
          btn.className = 'btn sm plain th-tr-btn';
          sum.append(btn);
        }
        const body = ui.h('div', 'th-text', block.text);
        box.append(sum, body);
        if (block.translated) box.append(ui.h('div', 'th-translation', block.translated));
        return box;
      });
      historyList.replaceChildren(...rows);
    }

    function paintNote() {
      note.textContent = view.paused ? t.pausedHint : `${view.symbol} ${t.desc}`;
    }

    function render() {
      pauseBtn.textContent = view.paused ? t.resume : t.pause;
      paintLamp();
      paintNote();
      paintCurrent();
      paintHistory();
      if (!view.blocks.length) {
        current.hidden = true;
        historyList.replaceChildren(ui.placeholder(`${t.empty}\n${t.emptyHint}`));
        historyList.hidden = false;
      }
    }

    function applySnapshot(data) {
      if (!data || typeof data !== 'object') return;
      view.symbol = typeof data.symbol === 'string' && data.symbol ? data.symbol : view.symbol;
      view.paused = data.paused === true;
      view.autoTranslate = data.autoTranslate === true;
      view.liveId = typeof data.liveId === 'string' ? data.liveId : null;
      view.blocks = (Array.isArray(data.blocks) ? data.blocks : []).map(normalize);
      autoBox.setChecked(view.autoTranslate);
      render();
    }

    async function sync() {
      try {
        applySnapshot(await ctx.invoke('snapshot'));
        show(false, '');
      } catch (error) {
        show(true, `${t.failed}：${errText(error)}`);
      }
    }

    async function togglePause() {
      const lock = ui.disable(pauseBtn, clearBtn);
      try {
        applySnapshot(await ctx.invoke(view.paused ? 'resume' : 'pause'));
        ui.toast(view.paused ? t.pausedToast : t.resumedHint);
      } catch (error) {
        show(true, errText(error));
      } finally {
        lock.dispose();
      }
    }

    async function clear() {
      if (!(await ui.confirm({ title: t.clearTitle, body: t.clearBody, danger: true }))) return;
      const lock = ui.disable(clearBtn);
      try {
        applySnapshot(await ctx.invoke('clear'));
        ui.toast(t.clearedToast);
      } catch (error) {
        show(true, errText(error));
      } finally {
        lock.dispose();
      }
    }

    /** 译一段：先占住按钮，回来用服务端给的那一块；失败就 toast。 */
    async function translateBlock(block) {
      if (!block || !block.text || block.translating) return;
      block.translating = true;
      render();
      try {
        const result = normalize(await ctx.invoke('translate', [block.id]));
        const target = find(block.id) || block;
        target.translated = result.translated;
        target.translating = false;
        render();
        if (target.translated) ui.toast(t.translatedOk);
      } catch (error) {
        block.translating = false;
        render();
        show(true, `${t.translateFailed}：${errText(error)}`);
        ui.toast(`${t.translateFailed}：${errText(error)}`, 'bad');
      }
    }

    async function setAutoTranslate(on) {
      const lock = ui.disable(autoBox.input);
      try {
        applySnapshot(await ctx.invoke('autoTranslate', [on]));
        ui.toast(on ? t.autoOn : t.autoOff);
      } catch (error) {
        autoBox.setChecked(view.autoTranslate);
        show(true, errText(error));
      } finally {
        lock.dispose();
      }
    }

    function onFrame(raw) {
      let frame;
      try {
        frame = JSON.parse(raw);
      } catch {
        return;
      }
      if (!frame || typeof frame !== 'object') return;
      switch (frame.t) {
        case 'snapshot':
          applySnapshot(frame);
          return;
        case 'begin': {
          const block = normalize(frame.block);
          view.blocks = [block, ...view.blocks.filter((item) => item.id !== block.id)];
          view.liveId = block.id;
          render();
          return;
        }
        case 'delta': {
          const block = find(frame.id);
          if (!block) {
            // 漏了开段（比如刚重连）：拉一次全量，别在这里拼残片。
            void sync();
            return;
          }
          if (typeof frame.delta === 'string') {
            block.text += frame.delta;
            block.chars += frame.delta.length;
          }
          view.liveId = block.id;
          paintLamp();
          if (block === latest()) {
            nameEl.textContent = t.live;
            metaEl.textContent = metaOf(block);
            textEl.textContent = block.text;
            const stick = flow.scrollHeight - flow.scrollTop - flow.clientHeight < 48;
            if (stick) flow.scrollTop = flow.scrollHeight;
          } else {
            render();
          }
          return;
        }
        case 'end': {
          const block = find(frame.id);
          if (block) {
            block.state = frame.state === 'aborted' ? 'aborted' : 'done';
            block.endedAt = typeof frame.endedAt === 'string' ? frame.endedAt : block.endedAt;
            block.answered = frame.answered === true;
            block.truncated = frame.truncated === true;
            if (Number.isFinite(frame.chars)) block.chars = frame.chars;
            // 服务端可能截断过；这一段以它的正文为准。
            if (typeof frame.text === 'string') block.text = frame.text;
          }
          view.liveId = null;
          render();
          return;
        }
        case 'clear':
          view.blocks = [];
          view.liveId = null;
          render();
          return;
        case 'paused':
          view.paused = frame.paused === true;
          render();
          return;
        case 'autoTranslate':
          view.autoTranslate = frame.on === true;
          autoBox.setChecked(view.autoTranslate);
          render();
          return;
        case 'translated': {
          const block = find(frame.id);
          if (block) {
            block.translated = typeof frame.text === 'string' ? frame.text : block.translated;
            block.translating = false;
          }
          render();
          return;
        }
        case 'translating': {
          const block = find(frame.id);
          if (block) {
            block.translating = frame.on === true;
            render();
          }
          return;
        }
        case 'translate-error': {
          const block = find(frame.id);
          if (block) {
            block.translating = false;
            render();
          }
          const detail = typeof frame.error === 'string' ? frame.error : '';
          show(true, `${t.translateFailed}：${detail}`);
          ui.toast(`${t.translateFailed}：${detail}`, 'bad');
          return;
        }
        default:
          return;
      }
    }

    ctx.stream({
      message: onFrame,
      open: () => {
        show(false, '');
        // 断线期间可能漏帧：连上就对一次全量。
        void sync();
      },
      close: () => { /* ctx.stream 自己退避重连；状态由下次 snapshot 校正 */ },
    });

    void sync();

    // 流在断线重连后可能漏帧，定期对一次全量；面板不在前台时也只是几次小请求。
    ctx.interval(() => { void sync(); }, 30_000);
  },
};

export default { panels: { live: PANEL } };
