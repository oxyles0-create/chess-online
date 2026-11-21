// Шахматная доска: отрисовка, клики/перетаскивание, стрелки, значки оценки хода.
const NS = 'http://www.w3.org/2000/svg';
const FILES = 'abcdefgh';

// Фигуры Cburnett с Wikimedia Commons (CC BY-SA 3.0)
const WIKI = {
  wk: '4/42/Chess_klt45', wq: '1/15/Chess_qlt45', wr: '7/72/Chess_rlt45',
  wb: 'b/b1/Chess_blt45', wn: '7/70/Chess_nlt45', wp: '4/45/Chess_plt45',
  bk: 'f/f0/Chess_kdt45', bq: '4/47/Chess_qdt45', br: 'f/ff/Chess_rdt45',
  bb: '9/98/Chess_bdt45', bn: 'e/ef/Chess_ndt45', bp: 'c/c7/Chess_pdt45',
};
export const pieceUrl = (color, type) =>
  `https://upload.wikimedia.org/wikipedia/commons/${WIKI[color + type]}.svg`;

function el(tag, cls) {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}

// Цвета пометок правой кнопкой: без модификатора / Shift / Ctrl / Alt
const ANNOT = { def: '#f2a33a', shift: '#5fae3e', ctrl: '#e0443b', alt: '#3d9be9' };
const annotColor = (e) => (e.shiftKey ? ANNOT.shift : e.ctrlKey || e.metaKey ? ANNOT.ctrl : e.altKey ? ANNOT.alt : ANNOT.def);

export class Board {
  constructor(root, { canMove, targets, onMove, onDeselect }) {
    this.root = root;
    this.canMove = canMove;
    this.targets = targets;
    this.onMove = onMove;
    this.onDeselect = onDeselect || (() => {});
    this.userArrows = []; // {from,to,color}
    this.marks = new Map(); // sq -> color
    this.rdrag = null;
    this.orientation = 'w';
    this.selected = null;
    this.drag = null;
    this.view = null;
    this.promoOpen = false;

    root.classList.add('board');
    this.grid = el('div', 'grid');
    this.cells = [];
    for (let i = 0; i < 64; i++) {
      const c = el('div', 'sq');
      this.grid.append(c);
      this.cells.push(c);
    }
    this.svg = document.createElementNS(NS, 'svg');
    this.svg.setAttribute('viewBox', '0 0 800 800');
    this.svg.classList.add('arrows');
    this.promo = el('div', 'promo hidden');
    root.append(this.grid, this.svg, this.promo);

    root.addEventListener('pointerdown', (e) => this._down(e));
    window.addEventListener('pointermove', (e) => this._move(e));
    window.addEventListener('pointerup', (e) => this._up(e));
    window.addEventListener('pointercancel', () => this._cancelDrag());
    root.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  _sqAt(i) {
    const r = Math.floor(i / 8), c = i % 8;
    const f = this.orientation === 'w' ? c : 7 - c;
    const rank = this.orientation === 'w' ? 8 - r : r + 1;
    return FILES[f] + rank;
  }
  _rc(sq) {
    const f = FILES.indexOf(sq[0]), rank = +sq[1];
    return {
      c: this.orientation === 'w' ? f : 7 - f,
      r: this.orientation === 'w' ? 8 - rank : rank - 1,
    };
  }
  _pointSq(x, y) {
    const rc = this.grid.getBoundingClientRect();
    if (x < rc.left || y < rc.top || x >= rc.right || y >= rc.bottom) return null;
    const c = Math.floor(((x - rc.left) / rc.width) * 8);
    const r = Math.floor(((y - rc.top) / rc.height) * 8);
    return this._sqAt(r * 8 + c);
  }

  setOrientation(o) {
    this.orientation = o;
    this._draw();
  }
  clearSelection() {
    this.selected = null;
  }
  clearAnnotations() {
    this.userArrows = [];
    this.marks.clear();
  }

  // view: { pieces: {sq: {color,type}}, lastMove, check, badge, arrows, coords }
  render(view) {
    this.view = view;
    if (this.selected && !this.canMove(this.selected)) this.selected = null;
    this._draw();
  }

  _draw() {
    const v = this.view;
    if (!v) return;
    const targets = this.selected ? this.targets(this.selected) : [];
    for (let i = 0; i < 64; i++) {
      const sq = this._sqAt(i);
      const cell = this.cells[i];
      const r = Math.floor(i / 8), c = i % 8;
      const light = (FILES.indexOf(sq[0]) + +sq[1]) % 2 === 1;
      let cls = 'sq ' + (light ? 'l' : 'd');
      if (v.lastMove && (v.lastMove.from === sq || v.lastMove.to === sq)) cls += ' last';
      if (this.selected === sq) cls += ' sel';
      if (v.check === sq) cls += ' check';
      if (v.premove && (v.premove.from === sq || v.premove.to === sq)) cls += ' pre';
      cell.className = cls;
      cell.textContent = '';
      if (this.marks.has(sq)) {
        const m = el('div', 'mark');
        m.style.background = this.marks.get(sq);
        cell.append(m);
      }

      if (v.coords) {
        if (c === 0) { const s = el('span', 'coord rank'); s.textContent = sq[1]; cell.append(s); }
        if (r === 7) { const s = el('span', 'coord file'); s.textContent = sq[0]; cell.append(s); }
      }
      const p = v.pieces[sq];
      if (p) {
        const img = el('img', 'piece');
        img.src = pieceUrl(p.color, p.type);
        img.alt = p.color + p.type;
        img.draggable = false;
        if (this.drag && this.drag.moved && this.drag.from === sq) img.classList.add('ghosted');
        cell.append(img);
      }
      if (targets.includes(sq)) cell.append(el('div', (p ? 'hint cap' : 'hint') + (v.premoveMode ? ' prehint' : '')));
      if (v.badge && v.badge.sq === sq) {
        const b = el('div', 'badge');
        b.style.background = v.badge.color;
        b.textContent = v.badge.sym;
        b.title = v.badge.label;
        cell.append(b);
      }
    }
    this._drawArrows();
  }

  _drawArrows() {
    this.svg.textContent = '';
    for (const a of [...(this.view?.arrows || []), ...this.userArrows]) {
      const s = this._rc(a.from), e = this._rc(a.to);
      const sx = s.c * 100 + 50, sy = s.r * 100 + 50;
      const ex = e.c * 100 + 50, ey = e.r * 100 + 50;
      const len = Math.hypot(ex - sx, ey - sy);
      if (!len) continue;
      const ux = (ex - sx) / len, uy = (ey - sy) / len;
      const nx = -uy, ny = ux;
      const w = 9, hw = 24, hl = 38, start = 22;
      const ax = sx + ux * start, ay = sy + uy * start;
      const hx = ex - ux * hl, hy = ey - uy * hl;
      const pts = [
        [ax + nx * w, ay + ny * w], [hx + nx * w, hy + ny * w], [hx + nx * hw, hy + ny * hw],
        [ex, ey], [hx - nx * hw, hy - ny * hw], [hx - nx * w, hy - ny * w], [ax - nx * w, ay - ny * w],
      ];
      const poly = document.createElementNS(NS, 'polygon');
      poly.setAttribute('points', pts.map((p) => p.join(',')).join(' '));
      poly.setAttribute('fill', a.color);
      poly.setAttribute('opacity', '0.85');
      this.svg.append(poly);
    }
  }

  _down(e) {
    if (this.promoOpen) return;
    const sq = this._pointSq(e.clientX, e.clientY);
    if (!sq) return;
    if (e.button === 2) {
      // Правая кнопка: рисуем стрелку или отмечаем поле (как на chess.com)
      this.rdrag = { from: sq, color: annotColor(e) };
      if (this.selected) { this.selected = null; this._draw(); }
      this.onDeselect(true);
      return;
    }
    if (e.button !== 0) return;
    if (this.userArrows.length || this.marks.size) this.clearAnnotations();
    if (this.selected && sq !== this.selected && this.targets(this.selected).includes(sq)) {
      const from = this.selected;
      this.selected = null;
      this._draw();
      this.onMove(from, sq);
      return;
    }
    if (this.view?.pieces[sq] && this.canMove(sq)) {
      const wasSelected = this.selected === sq;
      this.selected = sq;
      this.drag = { from: sq, x: e.clientX, y: e.clientY, moved: false, ghost: null, wasSelected };
      this._draw();
      e.preventDefault();
      return;
    }
    this.selected = null;
    this.onDeselect(false);
    this._draw();
  }

  _rightUp(e) {
    const r = this.rdrag;
    this.rdrag = null;
    const to = this._pointSq(e.clientX, e.clientY);
    if (!to) return;
    if (to === r.from) {
      if (this.marks.get(to) === r.color) this.marks.delete(to);
      else this.marks.set(to, r.color);
    } else {
      const i = this.userArrows.findIndex((a) => a.from === r.from && a.to === to);
      if (i >= 0 && this.userArrows[i].color === r.color) this.userArrows.splice(i, 1);
      else {
        if (i >= 0) this.userArrows.splice(i, 1);
        this.userArrows.push({ from: r.from, to, color: r.color });
      }
    }
    this._draw();
  }

  _move(e) {
    const d = this.drag;
    if (!d) return;
    if (!d.moved) {
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) < 5) return;
      const p = this.view.pieces[d.from];
      if (!p) return;
      d.moved = true;
      d.size = this.grid.getBoundingClientRect().width / 8;
      d.ghost = el('img', 'drag-ghost');
      d.ghost.src = pieceUrl(p.color, p.type);
      d.ghost.style.width = d.ghost.style.height = d.size + 'px';
      document.body.append(d.ghost);
      this._draw();
    }
    d.ghost.style.left = e.clientX - d.size / 2 + 'px';
    d.ghost.style.top = e.clientY - d.size / 2 + 'px';
  }

  _up(e) {
    if (e.button === 2 && this.rdrag) return this._rightUp(e);
    if (e.button !== 0) return;
    const d = this.drag;
    if (!d) return;
    this.drag = null;
    if (d.moved) {
      d.ghost.remove();
      const sq = this._pointSq(e.clientX, e.clientY);
      if (sq && sq !== d.from && this.targets(d.from).includes(sq)) {
        this.selected = null;
        this._draw();
        this.onMove(d.from, sq);
        return;
      }
      this._draw();
      return;
    }
    if (d.wasSelected) {
      this.selected = null;
      this._draw();
    }
  }

  _cancelDrag() {
    if (this.drag?.ghost) this.drag.ghost.remove();
    this.drag = null;
    this._draw();
  }

  askPromotion(color) {
    return new Promise((resolve) => {
      this.promoOpen = true;
      this.promo.textContent = '';
      const box = el('div', 'promo-box');
      const done = (v) => {
        this.promoOpen = false;
        this.promo.classList.add('hidden');
        resolve(v);
      };
      for (const t of ['q', 'r', 'b', 'n']) {
        const b = el('button', 'promo-btn');
        const img = el('img');
        img.src = pieceUrl(color, t);
        img.draggable = false;
        b.append(img);
        b.addEventListener('pointerdown', (ev) => { ev.stopPropagation(); done(t); });
        box.append(b);
      }
      this.promo.append(box);
      this.promo.onpointerdown = (ev) => { if (ev.target === this.promo) { ev.stopPropagation(); done(null); } };
      this.promo.classList.remove('hidden');
    });
  }
}
