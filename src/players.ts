import { readFileSync, existsSync } from 'node:fs';
import { setTimeout as sleep } from 'node:timers/promises';
import { uci } from './chess/board.ts';
import { ruleMove, type Game } from './game.ts';
import { isModelKind, type ModelKind } from './leaderboard.ts';
import { playerFromSpec } from './providers.ts';
import { MOVE_QUESTION, type ChoiceQuestion, type DecideRequest, type DecideResponse } from './question.ts';

export interface Player {
  id: string;
  name: string;
  kind: ModelKind;
  /** `game` is only for the built-in rules; models answer from `request` and should stop when `signal` aborts. */
  decide(request: DecideRequest, game: Game, signal: AbortSignal): Promise<DecideResponse>;
  /** Null when the player answers in time, else the reason it can't play. */
  warmUp?(timeoutMs: number): Promise<string | null>;
  /** Runs on this machine, whose server handles one request at a time, so its games run one at a time. */
  local?: boolean;
  where?: string;
  /** Known reason it can't play without asking it, e.g. a missing API key. */
  problem?: string;
}

const answer = (choice: string): DecideResponse => ({ answers: { [MOVE_QUESTION]: { type: 'choice', choice } } });

/**
 * Picks from the option texts alone, as a model would: a mate if there is one, else avoids moves marked UNSAFE,
 * hanging or allowing mate, preferring captures, then checks, then threats. Ahead it also avoids draws and
 * repetitions; 3+ pawns behind it takes a draw.
 */
export function chooseFromFacts(q: ChoiceQuestion, state: Record<string, unknown> = {}): string {
  const options = Object.keys(q.criteria);
  const has = (key: string, re: RegExp) => re.test(q.criteria[key]);
  const mate = options.find((k) => has(k, /CHECKMATE/));
  if (mate) return mate;
  const lead = typeof state.materialLead === 'number' ? state.materialLead : 0;
  const draw = options.find((k) => has(k, /STALEMATE|DRAW/));
  if (lead <= -3 && draw) return draw;
  const avoid = lead >= 1 ? /UNSAFE|ALLOWS MATE|leaves hanging|STALEMATE|DRAW|repeats/ : /UNSAFE|ALLOWS MATE|leaves hanging|STALEMATE|DRAW/;
  const safe = options.filter((k) => !has(k, avoid));
  const pool = safe.length ? safe : options;
  return pool.find((k) => has(k, /captures/)) ?? pool.find((k) => has(k, /gives check/)) ?? pool.find((k) => has(k, /then attacks/)) ?? pool[0];
}

/** random, greedy and minimax play exactly as the scripted opponents of the same name. */
export const BASELINES: Player[] = [
  {
    id: 'random',
    name: 'Random mover',
    kind: 'rules',
    decide: async (_req, game) => answer(uci(ruleMove(game, 'random', 'player'))),
  },
  {
    id: 'facts',
    name: 'Fact reader',
    kind: 'rules',
    decide: async (req) => answer(chooseFromFacts(req.questions[MOVE_QUESTION], req.state)),
  },
  {
    id: 'greedy',
    name: 'Greedy (1 ply)',
    kind: 'rules',
    decide: async (_req, game) => answer(uci(ruleMove(game, 'greedy', 'player'))),
  },
  {
    id: 'minimax',
    name: 'Minimax (3 ply)',
    kind: 'rules',
    decide: async (_req, game) => answer(uci(ruleMove(game, 'minimax', 'player'))),
  },
];

export interface EndpointConfig {
  id: string;
  name: string;
  kind: ModelKind;
  url: string;
  token?: string;
  /** Sent in every request, for services hosting many models behind one URL. */
  model?: string;
  local?: boolean;
  offlineHint?: string;
}

export const WARM_UP: DecideRequest = { state: { note: 'warm-up' }, questions: { warmup: { type: 'choice', instructions: 'Pick one.', criteria: { a: 'Option A', b: 'Option B' } } } };

export class CallError extends Error {
  readonly retryable: boolean;
  constructor(message: string, retryable: boolean) {
    super(message);
    this.retryable = retryable;
  }
}

export const RETRY_DELAYS_MS = [250, 1000, 2500];
const retryableStatus = (status: number) => status === 408 || status === 425 || status === 429 || status >= 500;

async function postOnce(url: string, body: string, opts: { token?: string; signal: AbortSignal; offlineHint?: string }): Promise<Record<string, unknown>> {
  let res: Response;
  let text: string;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(opts.token ? { authorization: `Bearer ${opts.token}` } : {}) },
      body,
      signal: opts.signal,
    });
    text = await res.text();
  } catch (err) {
    if (opts.signal.aborted) throw err;
    const code = ((err as Error).cause as { code?: string } | undefined)?.code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'EHOSTUNREACH') {
      throw new CallError(`can't reach ${new URL(url).origin}${opts.offlineHint ? `: ${opts.offlineHint}` : ''}`, false);
    }
    throw new CallError(`${(err as Error).message}${code ? ` (${code})` : ''}`, true);
  }
  let out: unknown;
  try {
    out = JSON.parse(text);
  } catch {
    out = undefined;
  }
  const error = (out as { error?: { message?: unknown; code?: unknown } } | undefined)?.error;
  const message = typeof error?.message === 'string' ? `: ${error.message}` : '';
  if (!res.ok) throw new CallError(`HTTP ${res.status}${message}`, retryableStatus(res.status));
  if (typeof out !== 'object' || out === null) throw new CallError('the answer is not JSON', true);
  // Gateways like OpenRouter answer 200 with an error object when the upstream model failed.
  if (error && typeof error === 'object' && !('choices' in out) && !('answers' in out)) {
    throw new CallError(`provider error${typeof error.code === 'number' ? ` ${error.code}` : ''}${message}`, typeof error.code !== 'number' || retryableStatus(error.code));
  }
  return out as Record<string, unknown>;
}

/**
 * Retries rate limits, server errors and dropped connections (RETRY_DELAYS_MS) while `signal` allows, so a provider
 * hiccup doesn't become a fallback move. Other failures (a refused key, no credits) throw at once.
 */
export async function postJson(url: string, body: unknown, opts: { token?: string; signal: AbortSignal; offlineHint?: string }): Promise<Record<string, unknown>> {
  const json = JSON.stringify(body);
  for (let attempt = 0; ; attempt++) {
    try {
      return await postOnce(url, json, opts);
    } catch (err) {
      if (!(err instanceof CallError) || !err.retryable || attempt >= RETRY_DELAYS_MS.length || opts.signal.aborted) throw err;
      await sleep(RETRY_DELAYS_MS[attempt], undefined, { signal: opts.signal });
    }
  }
}

/** Idle hosted models can be slow to wake: retries for up to a minute until one answer comes within `timeoutMs`. */
export async function warmUpWith(ask: (signal: AbortSignal) => Promise<unknown>, timeoutMs: number): Promise<string | null> {
  const started = performance.now();
  let last = 'no answer';
  while (performance.now() - started < 60_000) {
    const t0 = performance.now();
    try {
      await ask(AbortSignal.timeout(Math.max(timeoutMs, 30_000)));
      if (performance.now() - t0 < timeoutMs) return null;
      last = `answered in ${Math.round(performance.now() - t0)} ms, over the ${timeoutMs} ms limit (a slower model needs a longer --timeout)`;
    } catch (err) {
      last = (err as Error).message;
      if (!/timed? ?out|abort/i.test(last)) return last;
    }
  }
  return `did not answer in time within a minute (${last})`;
}

/**
 * POSTs `{model?, state, questions}` and expects `{answers, usage?, costUsd?}` (see README.md). System One reports
 * cost as `usage.cost` instead of `costUsd`.
 */
export function endpointPlayer(cfg: EndpointConfig): Player {
  const post = async (request: DecideRequest, signal: AbortSignal): Promise<DecideResponse> => {
    const out = await postJson(cfg.url, cfg.model ? { model: cfg.model, ...request } : request, { token: cfg.token, signal, offlineHint: cfg.offlineHint });
    if (typeof out.answers !== 'object' || out.answers === null) throw new Error('endpoint answer has no answers object');
    const usage = out.usage as (DecideResponse['usage'] & { cost?: unknown }) | undefined;
    const costUsd = typeof out.costUsd === 'number' ? out.costUsd : typeof usage?.cost === 'number' ? usage.cost : null;
    return { answers: out.answers as DecideResponse['answers'], usage, costUsd };
  };
  return {
    id: cfg.id,
    name: cfg.name,
    kind: cfg.kind,
    local: cfg.local,
    where: cfg.url,
    decide: (request, _game, signal) => post(request, signal),
    warmUp: (timeoutMs) => warmUpWith((signal) => post(WARM_UP, signal), timeoutMs),
  };
}

export const ID_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

/**
 * Entries are either a model spec (`{ "id": "jev", "model": "systemone:jev-latest" }`) or an endpoint
 * (`{ "id": "my-model", "kind": "decision", "url": "http://…", "tokenEnv": "MY_MODEL_TOKEN" }`).
 */
export function loadPlayersFile(path: string, env: Record<string, string | undefined> = process.env): Player[] {
  if (!existsSync(path)) return [];
  const list = JSON.parse(readFileSync(path, 'utf8')) as unknown;
  if (!Array.isArray(list)) throw new Error(`${path} must hold a list of players`);
  return list.map((entry: unknown, i) => {
    const where = `${path}[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) throw new Error(`${where}: a player is an object, like { "id": "jev", "model": "systemone:jev-latest" }`);
    const p = entry as Record<string, unknown>;
    if (typeof p.id !== 'string' || !ID_PATTERN.test(p.id)) throw new Error(`${where}: id must be lowercase letters, digits and dashes`);
    if (BASELINES.some((b) => b.id === p.id)) throw new Error(`${where}: ${p.id} is a built-in baseline`);
    const name = typeof p.name === 'string' ? p.name : undefined;
    if (typeof p.model === 'string') {
      const num = (k: string) => (typeof p[k] === 'number' ? (p[k] as number) : undefined);
      try {
        return playerFromSpec(p.model, env, {
          id: p.id,
          name,
          baseUrl: typeof p.baseUrl === 'string' ? p.baseUrl : undefined,
          keyEnv: typeof p.keyEnv === 'string' ? p.keyEnv : undefined,
          maxTokens: num('maxTokens'),
          temperature: num('temperature'),
          local: typeof p.local === 'boolean' ? p.local : undefined,
        });
      } catch (err) {
        throw new Error(`${where}: ${(err as Error).message}`);
      }
    }
    if (typeof p.url !== 'string' || !/^https?:\/\//.test(p.url)) throw new Error(`${where}: give a model ("provider:model") or a url (http(s))`);
    if (!isModelKind(p.kind)) throw new Error(`${where}: kind must be decision, chat or rules`);
    const token = typeof p.tokenEnv === 'string' ? env[p.tokenEnv] : undefined;
    return endpointPlayer({ id: p.id, name: name ?? p.id, kind: p.kind, url: p.url, token, local: typeof p.local === 'boolean' ? p.local : undefined });
  });
}
