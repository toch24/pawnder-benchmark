import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { OPPONENTS } from './chess/engine.ts';
import { rank, type Leaderboard, type LeaderboardEntry } from './leaderboard.ts';

const pm = (e: LeaderboardEntry) => `${e.scorePct.toFixed(1)} ± ${(1.96 * e.stdErrorPct).toFixed(1)}`;

function table(entries: LeaderboardEntry[]): string {
  const head = ['#', 'Player', 'Kind', 'Score %', ...OPPONENTS.map((o) => `vs ${o}`), 'W / D / L %', 'Fallback %', 'Latency', '$/game', 'Games'];
  const rows = [head, head.map(() => '---')];
  let place = 0;
  for (const e of rank(entries)) {
    const ranked = e.kind !== 'rules';
    if (ranked) place += 1;
    rows.push([
      ranked ? String(place) : '–',
      e.name,
      e.kind,
      pm(e),
      ...OPPONENTS.map((o) => (e.vs[o] ? e.vs[o]!.scorePct.toFixed(1) : '–')),
      `${e.winPct.toFixed(0)} / ${e.drawPct.toFixed(0)} / ${e.lossPct.toFixed(0)}`,
      e.fallbackPct.toFixed(1),
      e.meanLatencyMs === null ? '–' : `${e.meanLatencyMs} ms`,
      e.costPerGame ? `$${e.costPerGame.toFixed(4)}` : '–',
      String(e.games),
    ]);
  }
  return rows.map((r) => `| ${r.join(' | ')} |`).join('\n');
}

export function renderMarkdown(board: Leaderboard): string {
  const s = board.settings;
  const out = [
    '# Chess benchmark: gauntlet',
    '',
    'Every player against the scripted opponents. Score % is the chess score against each opponent, (wins + ½ draws) / games, ' +
      'averaged over the opponents; ± is the 95% margin of error. Fallback % is the share of the model\'s moves the bench made for it ' +
      '(late, failed or invalid answers).',
    '',
    `${s.gamesPerOpponent} games per opponent, ${s.maxPlies}-move cap, ${s.moveTimeoutMs / 1000} s per move, bench version ${board.benchVersion}, ${board.generatedAt}.`,
    '',
    table(board.entries),
    '',
  ];
  return `${out.join('\n')}\n`;
}

export function writeReport(dir = 'results'): string {
  const path = join(dir, 'LEADERBOARD.md');
  mkdirSync(dir, { recursive: true });
  writeFileSync(path, renderMarkdown(JSON.parse(readFileSync(join(dir, 'leaderboard.json'), 'utf8')) as Leaderboard));
  return path;
}
