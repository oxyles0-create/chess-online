// Stockfish в Web Worker. Загружается с CDN, поэтому работает на GitHub Pages без сборки.
const SF_URL = 'https://cdn.jsdelivr.net/npm/stockfish.js@10.0.2/stockfish.js';

export const MATE = 100000;

export class Engine {
  constructor(onStatus = () => {}) {
    this.onStatus = onStatus;
    this.queue = [];
    this.cur = null;
    this.ready = false;
    this.failed = false;
    try {
      const src = `importScripts(${JSON.stringify(SF_URL)});`;
      this.w = new Worker(URL.createObjectURL(new Blob([src], { type: 'application/javascript' })));
      this.w.onmessage = (e) => this._line(String(e.data));
      this.w.onerror = () => this._fail();
      this.w.postMessage('uci');
      this.timeout = setTimeout(() => { if (!this.ready) this._fail(); }, 30000);
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
      this.w.postMessage('setoption name Hash value 32');
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
      if (j.onInfo) j.onInfo(this._result(j, null));
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

  analyze(fen, { depth = 14, movetime = 2500, urgent = false } = {}) {
    if (this.failed) return Promise.resolve(null);
    return new Promise((resolve) => {
      const job = { fen, depth, movetime, resolve, turn: fen.split(' ')[1] };
      if (urgent) this.queue.unshift(job); else this.queue.push(job);
      this._pump();
    });
  }

  _pump() {
    if (!this.ready || this.cur || !this.queue.length) return;
    const j = (this.cur = this.queue.shift());
    this.w.postMessage('position fen ' + j.fen);
    this.w.postMessage(`go depth ${j.depth} movetime ${j.movetime}`);
  }

  // Отменить всё, что стоит в очереди (новая партия).
  reset() {
    this.queue.forEach((j) => j.resolve(null));
    this.queue = [];
    if (this.cur) {
      this.cur.cancelled = true;
      this.w.postMessage('stop');
    }
  }
}
