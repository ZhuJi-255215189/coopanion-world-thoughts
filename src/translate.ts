/**
 * 把一段思维链翻成简体中文：跟随部署当前激活的 provider，调一次纯文本请求。
 *
 * 端点解析与请求形态和 `coopanion-world-threads` 的 model.ts 一致：
 * 读部署 `config.json` 的 `activeProvider` → `../providers/<名字>/config.json` 与 `.env`；
 * 先走 Responses，404/405 退回 Chat Completions。区别只有两点：
 *   · 只做纯文本，不带工具；
 *   · 翻译请求显式关掉思考（`reasoning: { effort: 'none' }`），不额外烧 reasoning token。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export interface TranslateUsage {
  promptTokens: number;
  completionTokens: number;
  cacheHitTokens: number;
  cacheMissTokens: number;
  reasoningTokens?: number;
}

export interface Translated {
  text: string;
  model: string;
  usage?: TranslateUsage;
}

export class TranslateError extends Error {
  readonly status?: number;
  constructor(message: string, status?: number) {
    super(message);
    this.name = 'TranslateError';
    this.status = status;
  }
}

interface ResolvedEndpoint {
  baseUrl: string;
  model: string;
  apiKey: string;
}

type Protocol = 'responses' | 'chat';

const protocolCache = new Map<string, Protocol>();

const INSTRUCTIONS = [
  '把下面这段模型的内部思考翻成简体中文，给它的主人看。',
  '',
  '要求：',
  '- 只翻自然语言；代码、命令、路径、URL、API 名、变量名和数字原样保留。',
  '- 保留原来的分段、列表、顺序和语气；不要总结，不要补充解释，不要删减内容。',
  '- 原文里已经是中文的部分保持原样。',
  '- 直接输出译文本身，不要加「译文：」之类的开头，也不要包在代码块里。',
].join('\n');

function readJson(file: string): Record<string, unknown> | null {
  try {
    if (!existsSync(file)) return null;
    const parsed: unknown = JSON.parse(readFileSync(file, 'utf8'));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : null;
  } catch {
    return null;
  }
}

/** 与框架的 secretReader 同序：非空进程变量优先，其次部署 `.env` 里的那一行。 */
function readSecret(files: readonly string[], name: string): string {
  const fromEnv = process.env[name];
  if (fromEnv) return fromEnv;
  const pattern = new RegExp(`^[ \\t]*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[ \\t]*=[ \\t]*(\\S+)`, 'm');
  for (const file of files) {
    if (!existsSync(file)) continue;
    try {
      const matched = pattern.exec(readFileSync(file, 'utf8'));
      if (matched) return matched[1];
    } catch {
      /* 读不了就当没有 */
    }
  }
  return '';
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** 找这次翻译用的端点：当前激活 provider；没有就报一句能看懂的话。 */
export function resolveTranslateEndpoint(botDir: string): { endpoint?: ResolvedEndpoint; error?: string } {
  const deploy = readJson(join(botDir, 'config.json')) ?? {};
  const active = str(deploy.activeProvider);
  const providersRoot = join(botDir, '..', 'providers');
  const providerConf = active ? (readJson(join(providersRoot, active, 'config.json')) ?? {}) : {};
  const spec = providerConf.spec && typeof providerConf.spec === 'object' ? providerConf.spec as Record<string, unknown> : {};

  const baseUrl = str(providerConf.baseUrl).replace(/\/+$/, '');
  const model = str(spec.model);
  const secretName = str(providerConf.secret);
  const files = active ? [join(providersRoot, active, '.env'), join(botDir, '.env')] : [join(botDir, '.env')];
  const apiKey = secretName ? readSecret(files, secretName) : '';

  if (!active) return { error: '没有激活的 provider，先在设置里选一个模型端点。' };
  if (!baseUrl) return { error: `provider「${active}」没有端点地址。` };
  if (!model) return { error: `provider「${active}」没有选模型。` };
  if (secretName && !apiKey) return { error: `读不到模型密钥（${secretName}）。` };
  return { endpoint: { baseUrl, model, apiKey } };
}

function usageOf(raw: unknown, protocol: Protocol): TranslateUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const u = raw as Record<string, unknown>;
  const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0);
  const details = (v: unknown): Record<string, unknown> => (v && typeof v === 'object' ? v as Record<string, unknown> : {});
  const input = protocol === 'responses' ? num(u.input_tokens) : num(u.prompt_tokens);
  const output = protocol === 'responses' ? num(u.output_tokens) : num(u.completion_tokens);
  const cache = protocol === 'responses'
    ? num(details(u.input_tokens_details).cached_tokens)
    : num(details(u.prompt_tokens_details).cached_tokens);
  const reasoning = protocol === 'responses'
    ? num(details(u.output_tokens_details).reasoning_tokens)
    : num(details(u.completion_tokens_details).reasoning_tokens);
  if (input === 0 && output === 0) return undefined;
  return {
    promptTokens: input,
    completionTokens: output,
    cacheHitTokens: Math.min(cache, input),
    cacheMissTokens: Math.max(0, input - Math.min(cache, input)),
    reasoningTokens: reasoning,
  };
}

/** 去掉模型偶尔自带的代码块包裹与「译文：」前缀。 */
export function cleanTranslation(raw: string): string {
  let text = raw.trim();
  const fenced = /^```[a-zA-Z]*\n([\s\S]*?)\n```$/.exec(text);
  if (fenced) text = fenced[1].trim();
  text = text.replace(/^(译文|翻译|中文)\s*[:：]\s*/, '');
  return text.trim();
}

function responseText(data: Record<string, unknown>): string {
  const output = Array.isArray(data.output) ? data.output : [];
  const parts: string[] = [];
  for (const item of output) {
    if (!item || typeof item !== 'object') continue;
    const entry = item as Record<string, unknown>;
    if (entry.type !== 'message') continue;
    const content = Array.isArray(entry.content) ? entry.content : [];
    for (const piece of content) {
      if (!piece || typeof piece !== 'object') continue;
      const part = piece as Record<string, unknown>;
      if (part.type === 'output_text' && typeof part.text === 'string') parts.push(part.text);
    }
  }
  return parts.join('\n').trim();
}

function chatText(data: Record<string, unknown>): string {
  const choices = Array.isArray(data.choices) ? data.choices : [];
  const message = choices[0] && typeof choices[0] === 'object' ? (choices[0] as Record<string, unknown>).message : null;
  if (!message || typeof message !== 'object') return '';
  const content = (message as Record<string, unknown>).content;
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  return content
    .map((part) => (part && typeof part === 'object' && typeof (part as Record<string, unknown>).text === 'string' ? String((part as Record<string, unknown>).text) : ''))
    .join('')
    .trim();
}

async function callOnce(
  endpoint: ResolvedEndpoint,
  protocol: Protocol,
  text: string,
  maxTokens: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ text: string; usage?: TranslateUsage }> {
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new Error('timeout'));
  }, Math.max(1000, timeoutMs));
  const onOuter = () => controller.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) controller.abort(signal.reason);
    else signal.addEventListener('abort', onOuter, { once: true });
  }
  const body = protocol === 'responses'
    ? {
        model: endpoint.model,
        instructions: INSTRUCTIONS,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text }] }],
        store: false,
        stream: false,
        max_output_tokens: maxTokens,
        temperature: 0.1,
        // 翻译不需要思考：省时间也省 reasoning token。
        reasoning: { effort: 'none' },
      }
    : {
        model: endpoint.model,
        messages: [
          { role: 'system', content: INSTRUCTIONS },
          { role: 'user', content: text },
        ],
        stream: false,
        max_tokens: maxTokens,
        temperature: 0.1,
      };
  const path = protocol === 'responses' ? '/responses' : '/chat/completions';
  try {
    const response = await fetch(`${endpoint.baseUrl}${path}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(endpoint.apiKey ? { Authorization: `Bearer ${endpoint.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    const raw = await response.text();
    if (!response.ok) {
      throw new TranslateError(`HTTP ${response.status}: ${raw.replace(/\s+/g, ' ').slice(0, 300)}`, response.status);
    }
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new TranslateError(`返回的不是 JSON：${raw.slice(0, 160)}`);
    }
    const result = protocol === 'responses' ? responseText(data) : chatText(data);
    return { text: cleanTranslation(result), usage: usageOf(data.usage, protocol) };
  } catch (error) {
    if (error instanceof TranslateError) throw error;
    if (timedOut) throw new TranslateError('翻译请求超时');
    if (signal?.aborted) throw new TranslateError('翻译已取消');
    throw new TranslateError(error instanceof Error ? error.message : String(error));
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onOuter);
  }
}

/**
 * 翻一段思考。失败抛 `TranslateError`，错误文本是给人看的；
 * 端点不可用时也走这里，面板把原话显示出来即可。
 */
export async function translateThinking(
  botDir: string,
  text: string,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Translated> {
  const source = text.trim();
  if (!source) throw new TranslateError('这一段还没有内容，没什么可翻的。');
  const { endpoint, error } = resolveTranslateEndpoint(botDir);
  if (!endpoint) throw new TranslateError(error ?? '模型端点不可用');
  const timeoutMs = opts.timeoutMs ?? 90_000;
  // 中文译文通常比英文原文短；给足余量，太少会被截断。
  const maxTokens = Math.min(8192, Math.max(512, Math.ceil(source.length * 1.5)));

  const key = `${endpoint.baseUrl}|${endpoint.model}`;
  let protocol: Protocol = protocolCache.get(key) ?? 'responses';
  let lastError: unknown = null;
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const result = await callOnce(endpoint, protocol, source, maxTokens, timeoutMs, opts.signal);
      protocolCache.set(key, protocol);
      if (!result.text) throw new TranslateError('模型返回了空译文');
      return { text: result.text, model: endpoint.model, usage: result.usage };
    } catch (err) {
      lastError = err;
      const status = (err as { status?: number }).status;
      if ((status === 404 || status === 405) && protocol === 'responses') {
        protocol = 'chat';
        continue;
      }
      // 有的端点不认识 reasoning.effort=none；去掉它再试一次。
      if (status === 400 && protocol === 'responses' && /reasoning/i.test(err instanceof Error ? err.message : '')) {
        try {
          const retried = await callOnceChat(endpoint, source, maxTokens, timeoutMs, opts.signal);
          protocolCache.set(key, 'chat');
          if (!retried.text) throw new TranslateError('模型返回了空译文');
          return { text: retried.text, model: endpoint.model, usage: retried.usage };
        } catch (chatError) {
          lastError = chatError;
        }
      }
      break;
    }
  }
  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new TranslateError(`翻译失败：${message.replace(/^HTTP \d+: /, '')}`);
}

/** 400（不认识 reasoning 参数）时的退路：直接走 Chat Completions。 */
async function callOnceChat(
  endpoint: ResolvedEndpoint,
  text: string,
  maxTokens: number,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<{ text: string; usage?: TranslateUsage }> {
  return callOnce(endpoint, 'chat', text, maxTokens, timeoutMs, signal);
}
