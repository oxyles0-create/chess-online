// Классификация ходов в стиле «как на chess.com» по потере шансов на победу.
import { MATE } from './engine.js';

export const CLASSES = {
  brilliant:  { sym: '!!', label: 'Блестящий ход',   color: '#26c2a3' },
  best:       { sym: '★',  label: 'Лучший ход',      color: '#81b64c' },
  excellent:  { sym: '!',  label: 'Отличный ход',    color: '#96bc4b' },
  good:       { sym: '✓',  label: 'Хороший ход',     color: '#95af8a' },
  forced:     { sym: '□',  label: 'Единственный ход', color: '#97a1a8' },
  inaccuracy: { sym: '?!', label: 'Неточность',      color: '#f7c631' },
  mistake:    { sym: '?',  label: 'Ошибка',          color: '#ffa459' },
  blunder:    { sym: '??', label: 'Зевок',           color: '#fa412d' },
};
export const BAD = new Set(['inaccuracy', 'mistake', 'blunder']);

// Вероятность победы (0..100) для стороны, у которой оценка cp (формула Lichess).
export function winPct(cp) {
  const c = Math.max(-1000, Math.min(1000, cp));
  return 50 + 50 * (2 / (1 + Math.exp(-0.00368208 * c)) - 1);
}

export function formatScore(score) {
  const a = Math.abs(score);
  if (a >= MATE) return score > 0 ? '1-0' : '0-1';
  if (a >= MATE - 10000) {
    const n = Math.round((MATE - a) / 100);
    return (score > 0 ? 'M' : '-M') + n;
  }
  const v = score / 100;
  return (v > 0 ? '+' : '') + v.toFixed(1);
}

const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9, k: 100 };

// Какие фигуры цвета color бьют поле (r, c). b — массив chess.js board() (b[0] = 8-я горизонталь).
function attackers(b, r, c, color) {
  const res = [];
  const at = (rr, cc) => (rr >= 0 && rr < 8 && cc >= 0 && cc < 8 ? b[rr][cc] : undefined);
  const pr = color === 'w' ? r + 1 : r - 1;
  for (const dc of [-1, 1]) {
    const p = at(pr, c + dc);
    if (p && p.color === color && p.type === 'p') res.push('p');
  }
  for (const [dr, dc] of [[1, 2], [2, 1], [-1, 2], [-2, 1], [1, -2], [2, -1], [-1, -2], [-2, -1]]) {
    const p = at(r + dr, c + dc);
    if (p && p.color === color && p.type === 'n') res.push('n');
  }
  for (let dr = -1; dr <= 1; dr++)
    for (let dc = -1; dc <= 1; dc++) {
      if (!dr && !dc) continue;
      const p = at(r + dr, c + dc);
      if (p && p.color === color && p.type === 'k') res.push('k');
    }
  const slide = (dirs, types) => {
    for (const [dr, dc] of dirs) {
      let rr = r + dr, cc = c + dc;
      while (true) {
        const p = at(rr, cc);
        if (p === undefined) break;
        if (p) {
          if (p.color === color && types.includes(p.type)) res.push(p.type);
          break;
        }
        rr += dr; cc += dc;
      }
    }
  };
  slide([[1, 0], [-1, 0], [0, 1], [0, -1]], ['r', 'q']);
  slide([[1, 1], [1, -1], [-1, 1], [-1, -1]], ['b', 'q']);
  return res;
}

// Ход отдаёт фигуру под бой (жертва)?
export function isSacrifice(boardAfter, move) {
  const r = 8 - +move.to[1], c = 'abcdefgh'.indexOf(move.to[0]);
  const piece = boardAfter[r][c];
  if (!piece) return false;
  const v = VAL[piece.type];
  if (v < 3 || v >= 100) return false;
  const captured = move.captured ? VAL[move.captured] : 0;
  if (captured >= v) return false;
  const opp = piece.color === 'w' ? 'b' : 'w';
  const atk = attackers(boardAfter, r, c, opp);
  if (!atk.length) return false;
  const def = attackers(boardAfter, r, c, piece.color);
  const minAtk = Math.min(...atk.map((t) => VAL[t]));
  if (!def.length) return true; // фигура висит
  return minAtk < v;
}

// before/after — оценки (белые) до и после хода.
export function classifyMove({ before, after, color, uci, forced, sacrifice }) {
  const s = color === 'w' ? 1 : -1;
  const wb = winPct(s * before.score);
  const wa = winPct(s * after.score);
  const loss = Math.max(0, wb - wa);
  const accuracy = Math.max(0, Math.min(100, 103.1668 * Math.exp(-0.04354 * loss) - 3.1669));
  let key;
  if (forced) key = 'forced';
  else if (uci === before.best || loss < 0.2) key = 'best';
  else if (loss < 2) key = 'excellent';
  else if (loss < 5) key = 'good';
  else if (loss < 10) key = 'inaccuracy';
  else if (loss < 20) key = 'mistake';
  else key = 'blunder';
  if (sacrifice && (key === 'best' || key === 'excellent') && wa >= 45 && wb < 97) key = 'brilliant';
  return { key, loss, accuracy };
}
