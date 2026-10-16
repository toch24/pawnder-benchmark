import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { defaultParallel, loadPool, pickPlayers, readiness, resolvePlayer } from '../src/cli.ts';
import { Game, setupFor } from '../src/game.ts';
import { BASELINES, ID_PATTERN, loadPlayersFile } from '../src/players.ts';
import { chatPlayer, parseModelSpec, playerFromSpec, readChoice, specId } from '../src/providers.ts';
import { buildRequest, MOVE_QUESTION } from '../src/question.ts';
import { playOne } from '../src/run.ts';

/** A one-route HTTP server on a free port; `reply` answers each request from its JSON body. */
const servers: { close(): void }[] = [];
async function stub(reply: (body: Record<string, unknown>, headers: IncomingHttpHeaders) => { status?: number; json: unknown }) {
  const seen: { url: string; body: Record<string, unknown>; headers: IncomingHttpHeaders }[] = [];
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c: Buffer) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw) as Record<string, unknown>;
      seen.push({ url: req.url!, body, headers: req.headers });
      const r = reply(body, req.headers);
      res.writeHead(r.status ?? 200, { 'content-type': 'application/json' }).end(JSON.stringify(r.json));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  servers.push(server);
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}
afterEach(() => servers.splice(0).forEach((s) => s.close()));

const chatReply = (content: string, usage: Record<string, number> = {}) => ({ json: { choices: [{ message: { role: 'assistant', content } }], usage } });
const userPrompt = (body: Record<string, unknown>) => (body.messages as { role: string; content: string }[])[1].content;

const CRITERIA = {
  e2e4: 'e4: pawn e2→e4',
  g1f3: 'Nf3: knight g1→f3',
  e1g1: 'O-O: castles kingside',
  e4d5: 'exd5: pawn e4→d5; captures a pawn',
  d1h5: 'Qh5+: queen d1→h5; gives check',
  e7e8q: 'e8=Q: pawn e7→e8; promotes to a queen',
};

describe('model specs', () => {
  it('splits at the first colon and names the player after the spec', () => {
    expect(parseModelSpec('ollama:llama3.1:8b')).toEqual({ provider: 'ollama', model: 'llama3.1:8b' });
    expect(parseModelSpec('openrouter:openai/gpt-5-mini')).toEqual({ provider: 'openrouter', model: 'openai/gpt-5-mini' });
    expect(specId('ollama:llama3.1:8b')).toBe('ollama-llama3-1-8b');
    expect(specId('openrouter:openai/gpt-5-mini')).toMatch(ID_PATTERN);
  });

  it('refuses unknown providers and empty models', () => {
    expect(() => parseModelSpec('llama3.1')).toThrow(/provider one of systemone, openrouter/);
    expect(() => parseModelSpec('nope:x')).toThrow(/provider one of/);
    expect(() => parseModelSpec('ollama:')).toThrow(/no model/);
    expect(() => playerFromSpec('chat:some-model', {})).toThrow(/needs a baseUrl/);
  });

  it('carries a missing key as the problem, and checks it before asking', async () => {
    const p = playerFromSpec('systemone:jev-latest', {});
    expect(p.kind).toBe('decision');
    expect(p.problem).toBe('systemone:jev-latest needs OPENROUTER_API_KEY: add it to .env (see .env.example)');
    expect(await readiness(p, 100)).toBe(p.problem);
    expect(playerFromSpec('systemone:jev-latest', { OPENROUTER_API_KEY: 'k' }).problem).toBeUndefined();
    expect(playerFromSpec('ollama:llama3.1:8b', {}).problem).toBeUndefined();
  });

  it('marks local servers local, and takes their address from the environment', () => {
    const p = playerFromSpec('ollama:llama3.1:8b', { OLLAMA_BASE_URL: 'http://gpu:11434/v1/' });
    expect(p.local).toBe(true);
    expect(p.where).toBe('ollama:llama3.1:8b at http://gpu:11434/v1');
    expect(playerFromSpec('openrouter:x/y', { OPENROUTER_API_KEY: 'k' }).local).toBe(false);
  });
});

describe('reading a chat reply', () => {
  it.each([
    ['g1f3', 'g1f3'],
    ['  `g1f3`. ', 'g1f3'],
    ['"E2E4"', 'e2e4'],
    ['**e1g1**', 'e1g1'],
    ['<think>maybe e2e4, but g1f3 develops</think>\ne4d5', 'e4d5'],
    ['```\nd1h5\n```', 'd1h5'],
    ['I will play e2e4 here. Final answer: g1f3', 'g1f3'],
    ['Nf3', 'g1f3'],
    ['O-O', 'e1g1'],
    ['0-0', 'e1g1'],
    ['exd5', 'e4d5'],
    ['Qh5+!', 'd1h5'],
    ['e8=Q', 'e7e8q'],
    ['The best move is Nf3.', 'g1f3'],
  ])('%j → %s', (reply, key) => expect(readChoice(reply, CRITERIA)).toBe(key));

  it('returns a reply naming no option as it is, so it counts as invalid', () => {
    expect(readChoice('I resign.', CRITERIA)).toBe('I resign.');
    expect(readChoice('<think>e2e4 looks good, and', CRITERIA)).toBe('<think>e2e4 looks good, and');
  });
});

describe('chat models', () => {
  it('asks with the whole question and reads the move, tokens and cost', async () => {
    const server = await stub(() => chatReply('O-O', { prompt_tokens: 900, completion_tokens: 3, cost: 0.0002 }));
    const p = chatPlayer({ id: 'c', name: 'C', baseUrl: `${server.base}/v1/`, model: 'm-1', apiKey: 'sk-test', temperature: 0, maxTokens: 20, reportsCost: true });
    const game = new Game(setupFor(0));
    const request = buildRequest(game);
    const res = await p.decide(request, game, AbortSignal.timeout(5000));

    const { url, body, headers } = server.seen[0];
    expect(url).toBe('/v1/chat/completions');
    expect(headers.authorization).toBe('Bearer sk-test');
    expect(body).toMatchObject({ model: 'm-1', temperature: 0, max_tokens: 20, usage: { include: true } });
    const prompt = userPrompt(body);
    for (const [key, text] of Object.entries(request.questions[MOVE_QUESTION].criteria)) expect(prompt).toContain(`${key}: ${text}`);
    expect(prompt).toContain(`fen: ${game.pos.fen()}`);
    for (const row of request.state.board as string[]) expect(prompt).toContain(`\n  ${row}\n`);

    expect(res.answers[MOVE_QUESTION]?.choice).toBe('e1g1');
    expect(res.usage).toEqual({ input_tokens: 900, output_tokens: 3 });
    expect(res.costUsd).toBe(0.0002);
  });

  it("leaves out what the provider didn't ask for, and uses OpenAI's token field", async () => {
    const server = await stub(() => chatReply('a'));
    const p = playerFromSpec('openai:gpt-5-mini', { OPENAI_API_KEY: 'k' }, { baseUrl: server.base, maxTokens: 50 });
    await p.decide({ state: {}, questions: { q: { type: 'choice', instructions: 'Pick.', criteria: { a: 'A', b: 'B' } } } }, null as unknown as Game, AbortSignal.timeout(5000));
    const { body } = server.seen[0];
    expect(body).not.toHaveProperty('temperature');
    expect(body).not.toHaveProperty('usage');
    expect(body).toMatchObject({ model: 'gpt-5-mini', max_completion_tokens: 50 });
  });

  it("passes on the provider's error message", async () => {
    const server = await stub(() => ({ status: 401, json: { error: { code: 401, message: 'No auth credentials found' } } }));
    const p = playerFromSpec('openrouter:x/y', { OPENROUTER_API_KEY: 'bad' }, { baseUrl: server.base });
    expect(await readiness(p, 1000)).toBe('HTTP 401: No auth credentials found');
  });

  it("says when a local server isn't running", async () => {
    const server = await stub(() => chatReply('a'));
    servers.splice(0).forEach((s) => s.close());
    const p = playerFromSpec('ollama:llama3.1:8b', {}, { baseUrl: `${server.base}/v1` });
    expect(await readiness(p, 1000)).toBe(`can't reach ${server.base}: is Ollama running? (ollama serve)`);
  });

  it('plays a whole game without fallbacks', async () => {
    // A "model" that answers with the SAN of the first option, as a chat model might.
    const server = await stub((body) => {
      const first = userPrompt(body).split('Options:\n')[1].split('\n')[0];
      return chatReply(first.split(': ')[1]);
    });
    const p = chatPlayer({ id: 'c', name: 'C', baseUrl: server.base, model: 'm' });
    const { result } = await playOne(p, 'random', 0);
    expect(result.modelMoves).toBeGreaterThan(5);
    expect(result.fallbacks).toBe(0);
  });
});

describe('failed calls', () => {
  const ask = (p: ReturnType<typeof playerFromSpec>) => p.decide({ state: {}, questions: { q: { type: 'choice', instructions: 'Pick.', criteria: { a: 'A', b: 'B' } } } }, null as unknown as Game, AbortSignal.timeout(10_000));

  it('tries a rate limit, a server error or a failed upstream model again, and then answers', async () => {
    const replies = [{ status: 429, json: { error: { message: 'slow down' } } }, { status: 502, json: {} }, { json: { error: { code: 503, message: 'upstream down' } } }, chatReply('b')];
    const server = await stub(() => replies.shift()!);
    const p = playerFromSpec('openrouter:x/y', { OPENROUTER_API_KEY: 'k' }, { baseUrl: server.base });
    expect((await ask(p)).answers.q?.choice).toBe('b');
    expect(server.seen).toHaveLength(4);
  });

  it("doesn't try again what can't work: no credits, a bad key", async () => {
    const server = await stub(() => ({ status: 402, json: { error: { message: 'Insufficient credits' } } }));
    const p = playerFromSpec('openrouter:x/y', { OPENROUTER_API_KEY: 'k' }, { baseUrl: server.base });
    await expect(ask(p)).rejects.toThrow('HTTP 402: Insufficient credits');
    expect(server.seen).toHaveLength(1);
  });

  it('counts a reply with no text as an answer naming no option', async () => {
    const server = await stub(() => ({ json: { choices: [{ message: { role: 'assistant', content: null } }] } }));
    const p = playerFromSpec('openrouter:x/y', { OPENROUTER_API_KEY: 'k' }, { baseUrl: server.base });
    expect((await ask(p)).answers.q?.choice).toBe('(no reply text)');
  });
});

describe('System One models', () => {
  it("send the bench's request with the model, and read the cost from usage", async () => {
    const server = await stub((body) => {
      const keys = Object.keys((body.questions as Record<string, { criteria: Record<string, string> }>)[MOVE_QUESTION].criteria);
      return { json: { model: 'typesafe/jev-1.13', answers: { [MOVE_QUESTION]: { type: 'choice', choice: keys[0], confidence: 0.7, probabilities: { [keys[0]]: 0.9 } } }, usage: { input_tokens: 500, output_tokens: 4, cost: 0.00002 } } };
    });
    const p = playerFromSpec('systemone:jev-latest', { OPENROUTER_API_KEY: 'sk-or' }, { baseUrl: server.base });
    const game = new Game(setupFor(0));
    const request = buildRequest(game);
    const res = await p.decide(request, game, AbortSignal.timeout(5000));

    const { url, body, headers } = server.seen[0];
    expect(url).toBe('/systemone');
    expect(headers.authorization).toBe('Bearer sk-or');
    expect(body).toEqual({ model: 'jev-latest', ...request });
    expect(res.answers[MOVE_QUESTION]?.choice).toBe(Object.keys(request.questions[MOVE_QUESTION].criteria)[0]);
    expect(res.costUsd).toBe(0.00002);
  });
});

describe('choosing players', () => {
  const dir = mkdtempSync(join(tmpdir(), 'bench-players-'));
  const file = join(dir, 'players.json');
  writeFileSync(
    file,
    JSON.stringify([
      { id: 'jev', name: 'Jev', model: 'systemone:jev-latest' },
      { id: 'vllm', model: 'chat:qwen', baseUrl: 'http://box:8000/v1', keyEnv: 'VLLM_KEY', local: true, maxTokens: 8 },
      { id: 'mine', kind: 'decision', url: 'http://localhost:8787' },
    ]),
  );

  it('reads models by spec from players.json, next to endpoints', () => {
    const [jev, vllm, mine] = loadPlayersFile(file, { OPENROUTER_API_KEY: 'k' });
    expect(jev).toMatchObject({ id: 'jev', name: 'Jev', kind: 'decision' });
    expect(jev.problem).toBeUndefined();
    expect(vllm).toMatchObject({ id: 'vllm', kind: 'chat', local: true, problem: 'chat:qwen needs VLLM_KEY: add it to .env (see .env.example)' });
    expect(mine).toMatchObject({ id: 'mine', kind: 'decision', where: 'http://localhost:8787' });
  });

  it('adds the MODELS models to the pool, and finds players by id, name or spec', () => {
    const pool = loadPool(file, { MODELS: 'jev, ollama:llama3.1:8b' });
    expect(pool.map((p) => p.id)).toEqual([...BASELINES.map((b) => b.id), 'jev', 'vllm', 'mine', 'ollama-llama3-1-8b']);
    expect(resolvePlayer('ollama:llama3.1:8b', pool)).toBe(pool.at(-1));
    expect(resolvePlayer('greedy', pool)).toBe(pool[2]);
    expect(resolvePlayer('lmstudio:qwen', pool).id).toBe('lmstudio-qwen');
    expect(() => resolvePlayer('gpt', pool)).toThrow(/unknown player gpt: one of random, facts/);
  });

  it('says which entry of players.json is not a player', () => {
    const bad = join(dir, 'bad.json');
    writeFileSync(bad, JSON.stringify([{ id: 'ok', model: 'ollama:x' }, null]));
    expect(() => loadPlayersFile(bad, {})).toThrow(`${bad}[1]: a player is an object`);
  });

  it('plays one game at a time with a local model', () => {
    expect(defaultParallel(BASELINES)).toBe(4);
    expect(defaultParallel([...BASELINES, playerFromSpec('ollama:x', {})])).toBe(1);
  });

  it('picks by number or spec, and asks again until the answer names enough different players', async () => {
    const answers = ['1', '3 3', '9 x', '2 ollama:llama3.1:8b'];
    const printed: string[] = [];
    const picked = await pickPlayers(2, BASELINES, {}, { ask: async () => answers.shift()!, print: (l) => printed.push(l) });
    expect(picked.map((p) => p.id)).toEqual(['facts', 'ollama-llama3-1-8b']);
    expect(printed).toContain('  pick 2');
    expect(printed).toContain('  pick different players');
    expect(printed).toContain('  there is no player 9');
  });
});
