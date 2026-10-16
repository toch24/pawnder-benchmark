// Players from `provider:model` specs. System One models speak the bench protocol; chat models (any
// OpenAI-compatible server) get the question as a prompt, and the option key is parsed out of their reply.
import type { ModelKind } from './leaderboard.ts';
import { endpointPlayer, postJson, WARM_UP, warmUpWith, type Player } from './players.ts';
import type { ChoiceQuestion, DecideRequest, DecideResponse } from './question.ts';

interface Provider {
  protocol: 'systemone' | 'chat';
  /** Overridden by `baseUrlEnv`. The generic `chat` provider has none; players.json supplies it. */
  baseUrl?: string;
  baseUrlEnv?: string;
  keyEnv?: string;
  kind: ModelKind;
  local?: boolean;
  offlineHint?: string;
  /** Unset for OpenAI: its reasoning models reject any non-default temperature. */
  temperature?: number;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  reportsCost?: boolean;
}

export const PROVIDERS: Record<string, Provider> = {
  systemone: { protocol: 'systemone', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', kind: 'decision' },
  openrouter: { protocol: 'chat', baseUrl: 'https://openrouter.ai/api/v1', keyEnv: 'OPENROUTER_API_KEY', kind: 'chat', temperature: 0, reportsCost: true },
  openai: { protocol: 'chat', baseUrl: 'https://api.openai.com/v1', keyEnv: 'OPENAI_API_KEY', kind: 'chat', maxTokensField: 'max_completion_tokens' },
  ollama: { protocol: 'chat', baseUrl: 'http://localhost:11434/v1', baseUrlEnv: 'OLLAMA_BASE_URL', kind: 'chat', local: true, temperature: 0, offlineHint: 'is Ollama running? (ollama serve)' },
  lmstudio: { protocol: 'chat', baseUrl: 'http://localhost:1234/v1', baseUrlEnv: 'LMSTUDIO_BASE_URL', kind: 'chat', local: true, temperature: 0, offlineHint: "is LM Studio's server on? (lms server start)" },
  chat: { protocol: 'chat', kind: 'chat', temperature: 0, offlineHint: 'is the server running?' },
};

/** Splits at the first colon: `ollama:llama3.1:8b` is provider `ollama`, model `llama3.1:8b`. */
export function parseModelSpec(spec: string): { provider: string; model: string } {
  const at = spec.indexOf(':');
  const provider = at > 0 ? spec.slice(0, at) : '';
  const model = at > 0 ? spec.slice(at + 1) : '';
  if (!PROVIDERS[provider]) throw new Error(`${spec}: a model is provider:model, with provider one of ${Object.keys(PROVIDERS).join(', ')}`);
  if (!model) throw new Error(`${spec}: no model after "${provider}:"`);
  return { provider, model };
}

/** `ollama:llama3.1:8b` → `ollama-llama3-1-8b`. */
export const specId = (spec: string): string =>
  spec
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');

export interface SpecOptions {
  id?: string;
  name?: string;
  baseUrl?: string;
  keyEnv?: string;
  maxTokens?: number;
  temperature?: number;
  local?: boolean;
}

/** A missing API key is set as the player's `problem` instead of thrown, so the rest of the pool still loads. */
export function playerFromSpec(spec: string, env: Record<string, string | undefined> = process.env, opts: SpecOptions = {}): Player {
  const { provider, model } = parseModelSpec(spec);
  const p = PROVIDERS[provider];
  const baseUrl = (opts.baseUrl ?? (p.baseUrlEnv && env[p.baseUrlEnv]) ?? p.baseUrl)?.replace(/\/+$/, '');
  if (!baseUrl) throw new Error(`${spec}: a ${provider}: model needs a baseUrl (in players.json), e.g. http://localhost:8000/v1`);
  const keyEnv = opts.keyEnv ?? p.keyEnv;
  const key = keyEnv ? env[keyEnv] : undefined;
  const id = opts.id ?? specId(spec);
  const name = opts.name ?? spec;
  const local = opts.local ?? p.local ?? false;
  const problem = keyEnv && !key ? `${spec} needs ${keyEnv}: add it to .env (see .env.example)` : undefined;
  const player =
    p.protocol === 'systemone'
      ? endpointPlayer({ id, name, kind: p.kind, url: `${baseUrl}/systemone`, model, token: key, local })
      : chatPlayer({
          id,
          name,
          kind: p.kind,
          baseUrl,
          model,
          apiKey: key,
          local,
          offlineHint: p.offlineHint,
          temperature: opts.temperature ?? p.temperature,
          maxTokens: opts.maxTokens,
          maxTokensField: p.maxTokensField,
          reportsCost: p.reportsCost,
        });
  return { ...player, where: `${spec} at ${baseUrl}`, ...(problem ? { problem } : {}) };
}

export interface ChatConfig {
  id: string;
  name: string;
  kind?: ModelKind;
  baseUrl: string;
  model: string;
  apiKey?: string;
  local?: boolean;
  offlineHint?: string;
  temperature?: number;
  maxTokens?: number;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens';
  reportsCost?: boolean;
}

export const SYSTEM_PROMPT = 'You are choosing one option from a list. Reply with only the option key, nothing else.';

function renderState(state: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const [k, v] of Object.entries(state)) {
    if (Array.isArray(v) && v.every((x) => typeof x === 'string')) lines.push(`${k}:`, ...v.map((row) => `  ${row}`));
    else lines.push(`${k}: ${v !== null && typeof v === 'object' ? JSON.stringify(v) : String(v)}`);
  }
  return lines.join('\n');
}

export function chatPrompt(state: Record<string, unknown>, q: ChoiceQuestion): string {
  const options = Object.entries(q.criteria).map(([key, text]) => `${key}: ${text}`);
  return `${q.instructions}\n\n${renderState(state)}\n\nOptions:\n${options.join('\n')}\n\nAnswer with one option key.`;
}

/**
 * The option a chat reply names, ignoring <think> blocks: the whole reply if it is a key (quotes and trailing
 * punctuation aside), else the last key or SAN move it mentions (each option's text starts with its SAN). A reply
 * naming none is returned unchanged, so it is recorded as an invalid answer.
 */
export function readChoice(reply: string, criteria: Record<string, string>): string {
  const keys = Object.keys(criteria);
  const text = reply
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<think>[\s\S]*$/i, '')
    .replace(/```[a-z]*/gi, '')
    .trim();
  const bare = text.replace(/^[\s"'`*]+|[\s"'`*.!]+$/g, '').toLowerCase();
  const exact = keys.find((k) => k.toLowerCase() === bare);
  if (exact) return exact;
  const bySan = new Map<string, string>();
  for (const [key, desc] of Object.entries(criteria)) {
    const colon = desc.indexOf(':');
    if (colon > 0) bySan.set(desc.slice(0, colon).replace(/[+#]+$/, ''), key);
  }
  const tokens = text.match(/[A-Za-z0-9][A-Za-z0-9=-]*/g) ?? [];
  for (const raw of tokens.reverse()) {
    const token = raw.replace(/-+$/, '');
    const key = keys.find((k) => k.toLowerCase() === token.toLowerCase());
    if (key) return key;
    const san = bySan.get(token) ?? bySan.get(token.replace(/0/g, 'O'));
    if (san) return san;
  }
  return reply.trim();
}

export function chatPlayer(cfg: ChatConfig): Player {
  const url = `${cfg.baseUrl.replace(/\/+$/, '')}/chat/completions`;
  const ask = async (state: Record<string, unknown>, q: ChoiceQuestion, signal: AbortSignal) => {
    const body = {
      model: cfg.model,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: chatPrompt(state, q) },
      ],
      ...(cfg.temperature !== undefined ? { temperature: cfg.temperature } : {}),
      ...(cfg.maxTokens !== undefined ? { [cfg.maxTokensField ?? 'max_tokens']: cfg.maxTokens } : {}),
      ...(cfg.reportsCost ? { usage: { include: true } } : {}),
    };
    const out = await postJson(url, body, { token: cfg.apiKey, signal, offlineHint: cfg.offlineHint });
    const choices = out.choices as { message?: { content?: unknown } }[] | undefined;
    if (!Array.isArray(choices) || !choices[0]?.message) throw new Error('the chat answer has no message');
    // No text (a reasoning model that spent its tokens thinking) counts as an answer that names no option.
    const content = choices[0].message.content;
    const usage = (out.usage ?? {}) as { prompt_tokens?: unknown; completion_tokens?: unknown; cost?: unknown };
    return {
      choice: typeof content === 'string' ? readChoice(content, q.criteria) : '(no reply text)',
      input: typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : 0,
      output: typeof usage.completion_tokens === 'number' ? usage.completion_tokens : 0,
      cost: typeof usage.cost === 'number' ? usage.cost : null,
    };
  };
  const decide = async (request: DecideRequest, signal: AbortSignal): Promise<DecideResponse> => {
    const answers: DecideResponse['answers'] = {};
    let input = 0;
    let output = 0;
    let cost: number | null = null;
    for (const [name, q] of Object.entries(request.questions)) {
      const a = await ask(request.state, q, signal);
      answers[name] = { type: 'choice', choice: a.choice };
      input += a.input;
      output += a.output;
      if (a.cost !== null) cost = (cost ?? 0) + a.cost;
    }
    return { answers, usage: { input_tokens: input, output_tokens: output }, costUsd: cost };
  };
  return {
    id: cfg.id,
    name: cfg.name,
    kind: cfg.kind ?? 'chat',
    local: cfg.local,
    decide: (request, _game, signal) => decide(request, signal),
    warmUp: (timeoutMs) => warmUpWith((signal) => decide(WARM_UP, signal), timeoutMs),
  };
}
