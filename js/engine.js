// Stockfish 18 (NNUE lite, однопоточный WebAssembly) в Web Worker.
// Файлы движка лежат в папке engine/ рядом с сайтом.
//
// Чтобы у обоих игроков оценки совпадали, каждая позиция считается
// детерминированно: одинаковая фиксированная глубина, один поток и
// очищенная хеш-таблица (ucinewgame) перед каждым расчётом.
const SF_URL = new URL('../engine/stockfish-18-lite-single.js', import.meta.url).href;

export const MATE = 100000;
export const DEPTH = 22;

export class Engine {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.queue = [];
    this.cur = null;
    this.ready = false;
    this.failed = false;
    try {
      this.w = new Worker(SF_URL);
      this.w.onmessage = (e) => this._line(String(e.data));
      this.w.onerror = () => this._fail();
      this.w.postMessage('uci');
      this.timeout = setTimeout(() => { if (!this.ready) this._fail(); }, 60000);
    } catch {
      this._fail();
    }
  }

  _fail() {
    if (this.failed) return;
    this.failed = true;
    this.onStatus('error');
    this.queue.forEach((j) => j.resolve(null));
    this.queue = [];
  }

  _line(line) {
    if (line === 'uciok') {
      this.w.postMessage('setoption name Threads value 1');
      this.w.postMessage('setoption name Hash value 64');
      this.w.postMessage('isready');
      return;
    }
    if (line === 'readyok') {
      if (!this.ready) {
        this.ready = true;
        clearTimeout(this.timeout);
        this.onStatus('ready');
      }
      this._pump();
      return;
    }
    const j = this.cur;
    if (!j) return;
    if (line.startsWith('info ') && line.includes(' score ') && line.includes(' pv ')) {
      const t = line.split(' ');
      const mpv = t.indexOf('multipv');
      if (mpv >= 0 && t[mpv + 1] !== '1') return;
      const i = t.indexOf('score');
      if (t[i + 3] === 'lowerbound' || t[i + 3] === 'upperbound') return;
      j.info = {
        depth: parseInt(t[t.indexOf('depth') + 1], 10),
        kind: t[i + 1],
        val: parseInt(t[i + 2], 10),
        pv: t.slice(t.indexOf('pv') + 1),
      };
      j.onProgress?.(j.info.depth);
      return;
    }
    if (line.startsWith('bestmove')) {
      const best = line.split(' ')[1];
      this.cur = null;
      j.resolve(j.cancelled ? null : this._result(j, best));
      this._pump();
    }
  }

  // Оценка в сантипешках с точки зрения белых. Мат в n = ±(MATE - n*100).
  _result(j, best) {
    const info = j.info;
    let score = 0;
    if (info) {
      if (info.kind === 'mate') {
        score = info.val === 0 ? -MATE : Math.sign(info.val) * (MATE - Math.abs(info.val) * 100);
      } else score = info.val;
    }
    if (j.turn === 'b') score = -score;
    const bm = best && best !== '(none)' ? best : info?.pv?.[0] || null;
    return { score, best: bm, pv: info?.pv || [], depth: info?.depth || 0 };
  }

  get busyFen() {
    return this.cur?.fen || null;
  }

  analyze(fen, { urgent = false, onProgress } = {}) {
    if (this.failed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const job = { fen, resolve, onProgress, turn: fen.split(' ')[1] };
      if (urgent) this.queue.unshift(job); else this.queue.push(job);
      this._pump();
    });
  }

  _pump() {
    if (!this.ready || this.cur || !this.queue.length) return;
    const j = (this.cur = this.queue.shift());
    this.w.postMessage('ucinewgame');
    this.w.postMessage('position fen ' + j.fen);
    this.w.postMessage(`go depth ${DEPTH}`);
  }

  // Убрать из очереди всё лишнее (новая партия). Текущий расчёт доводим до конца,
  // чтобы его результат остался в кэше и совпадал у обоих игроков.
  reset() {
    this.queue.forEach((j) => j.resolve(null));
    this.queue = [];
  }
}
