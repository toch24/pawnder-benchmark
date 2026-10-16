import { createInterface } from 'node:readline/promises';
import { BASELINES, loadPlayersFile, type Player } from './players.ts';
import { playerFromSpec, PROVIDERS } from './providers.ts';

type Env = Record<string, string | undefined>;

export const modelsFromEnv = (env: Env = process.env): string[] => (env.MODELS ?? '').split(/[\s,]+/).filter(Boolean);

export function loadPool(playersFile: string, env: Env = process.env): Player[] {
  const pool = [...BASELINES, ...loadPlayersFile(playersFile, env)];
  for (const name of modelsFromEnv(env)) {
    const p = resolvePlayer(name, pool, env);
    if (!pool.includes(p)) pool.push(p);
  }
  const ids = new Set<string>();
  for (const p of pool) {
    if (ids.has(p.id)) throw new Error(`two players are called ${p.id}`);
    ids.add(p.id);
  }
  return pool;
}

export function resolvePlayer(name: string, pool: Player[], env: Env = process.env): Player {
  const known = pool.find((p) => p.id === name || p.name === name);
  if (known) return known;
  if (name.includes(':')) return playerFromSpec(name, env);
  throw new Error(`unknown player ${name}: one of ${pool.map((p) => p.id).join(', ')}, or a model as provider:model (providers: ${Object.keys(PROVIDERS).join(', ')})`);
}

export const defaultParallel = (players: Player[]): number => (players.some((p) => p.local) ? 1 : 4);

/** Null when the player can play, else the reason it can't. */
export async function readiness(player: Player, timeoutMs: number): Promise<string | null> {
  if (player.problem) return player.problem;
  return player.warmUp ? player.warmUp(timeoutMs) : null;
}

const describe = (p: Player) => (p.kind === 'rules' ? `${p.name} (baseline)` : `${p.where ?? p.name} (${p.kind})`);

export async function pickPlayers(
  count: number,
  pool: Player[],
  env: Env = process.env,
  io?: { ask: (question: string) => Promise<string>; print: (line: string) => void },
): Promise<Player[]> {
  const rl = io ? null : createInterface({ input: process.stdin, output: process.stdout });
  const ask = io?.ask ?? ((q: string) => rl!.question(q));
  const print = io?.print ?? ((line: string) => console.log(line));
  try {
    print('Players:');
    pool.forEach((p, i) => print(`  ${String(i + 1).padStart(2)}. ${p.id.padEnd(22)} ${describe(p)}${p.problem ? `  [${p.problem}]` : ''}`));
    const example = count === 1 ? '1' : Array.from({ length: count }, (_, i) => i + 1).join(' ');
    for (;;) {
      const answer = (await ask(`Pick ${count === 1 ? 'one' : count} by number (e.g. ${example}), or type models like ollama:llama3.1:8b: `)).trim();
      try {
        const picked = answer.split(/[\s,]+/).filter(Boolean).map((w) => {
          if (/^\d+$/.test(w)) {
            const p = pool[Number(w) - 1];
            if (!p) throw new Error(`there is no player ${w}`);
            return p;
          }
          return resolvePlayer(w, pool, env);
        });
        if (new Set(picked.map((p) => p.id)).size !== picked.length) throw new Error('pick different players');
        if (picked.length !== count) throw new Error(`pick ${count}`);
        return picked;
      } catch (err) {
        print(`  ${(err as Error).message}`);
      }
    }
  } finally {
    rl?.close();
  }
}

export const canAsk = (): boolean => Boolean(process.stdin.isTTY && process.stdout.isTTY);
