import { Chess } from 'https://cdn.jsdelivr.net/npm/chess.js@1.0.0/+esm';
import { Board, pieceUrl } from './board.js';
import { Engine, MATE } from './engine.js';
import { CLASSES, BAD, winPct, formatScore, classifyMove, isSacrifice } from './analysis.js';
import { Net } from './net.js';

const $ = (s) => document.querySelector(s);
const START_FEN = new Chess().fen();
const opp = (c) => (c === 'w' ? 'b' : 'w');
const COLOR_RU = { w: 'белые', b: 'чёрные' };

// ---------- хранилище ----------
const lsGet = (k, d = null) => { try { return localStorage.getItem(k) ?? d; } catch { return d; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch {} };
const lsDel = (k) => { try { localStorage.removeItem(k); } catch {} };

const DEFAULTS = { evalBar: true, classify: true, bestMove: false, coords: true, sound: true, depth: 14 };
const settings = (() => {
  try { return { ...DEFAULTS, ...JSON.parse(lsGet('chess.settings', '{}')) }; } catch { return { ...DEFAULTS }; }
})();
const saveSettings = () => lsSet('chess.settings', JSON.stringify(settings));

let clientId = lsGet('chess.clientId');
if (!clientId) { clientId = Math.random().toString(36).slice(2, 12); lsSet('chess.clientId', clientId); }
const myName = () => ($('#nameInput').value.trim() || 'Игрок').slice(0, 20);

// ---------- состояние ----------
const S = {
  mode: 'menu', // menu | waiting | local | online
  game: new Chess(),
  positions: [START_FEN],
  moves: [],
  myColor: null,
  orientation: 'w',
  viewPly: null,
  result: null,
  gameNo: 0,
  names: { w: 'Белые', b: 'Чёрные' },
  isHost: false,
  hostPref: 'w',
  hostId: null,
  guestId: null,
  connected: false,
  drawOffer: null, // 'me' | 'them'
  rematchOffer: null,
};

// ---------- движок ----------
let engineState = 'loading';
const engine = new Engine((st) => { engineState = st; requestAnalysis(); render(); });
const evalCache = new Map(); // fen -> {score, best, pv, depth}
const pending = new Set();
const classCache = new Map();
const engineWanted = () => settings.evalBar || settings.classify || settings.bestMove;

function terminalEval(fen) {
  const g = new Chess(fen);
  if (g.isCheckmate()) return { score: g.turn() === 'w' ? -MATE : MATE, best: null, pv: [], depth: 99 };
  if (g.isDraw() || g.isStalemate()) return { score: 0, best: null, pv: [], depth: 99 };
  return null;
}

function requestAnalysis() {
  if (!engineWanted()) return;
  // Сначала две последние позиции (нужны для оценки хода), потом остальные с конца.
  const lastPly = S.positions.length - 1;
  for (let i = 0; i <= lastPly; i++) {
    const fen = S.positions[i];
    if (evalCache.has(fen) || pending.has(fen)) continue;
    const t = terminalEval(fen);
    if (t) { evalCache.set(fen, t); continue; }
    if (engineState !== 'ready') continue;
    pending.add(fen);
    engine.analyze(fen, { depth: settings.depth, movetime: 2000, urgent: i >= lastPly - 1 }).then((res) => {
      pending.delete(fen);
      if (res) evalCache.set(fen, res);
      render();
    });
  }
}

const evalAt = (ply) => evalCache.get(S.positions[ply]);

function classAt(ply) {
  if (ply < 1) return null;
  const before = evalAt(ply - 1), after = evalAt(ply);
  if (!before || !after) return null;
  const m = S.moves[ply - 1];
  const uci = m.from + m.to + (m.promotion || '');
  const key = S.positions[ply - 1] + '|' + uci;
  if (classCache.has(key)) return classCache.get(key);
  const g = new Chess(S.positions[ply - 1]);
  const forced = g.moves().length === 1;
  const sacrifice = isSacrifice(new Chess(S.positions[ply]).board(), m);
  const res = classifyMove({ before, after, color: m.color, uci, forced, sacrifice });
  classCache.set(key, res);
  return res;
}

function uciToSan(fen, uci) {
  if (!uci) return '';
  try {
    return new Chess(fen).move({ from: uci.slice(0, 2), to: uci.slice(2, 4), promotion: uci[4] }).san;
  } catch { return uci; }
}

// ---------- доска ----------
const board = new Board($('#board'), {
  canMove,
  targets: (sq) => S.game.moves({ square: sq, verbose: true }).map((m) => m.to),
  onMove: userMove,
});

function isLive() { return S.viewPly === null; }

function canMove(sq) {
  if (S.mode !== 'local' && S.mode !== 'online') return false;
  if (S.result || !isLive()) return false;
  const p = S.game.get(sq);
  if (!p || p.color !== S.game.turn()) return false;
  if (S.mode === 'online' && (p.color !== S.myColor || !S.connected)) return false;
  return true;
}

async function userMove(from, to) {
  const cands = S.game.moves({ square: from, verbose: true }).filter((m) => m.to === to);
  if (!cands.length) return;
  let promotion;
  if (cands.some((m) => m.promotion)) {
    promotion = await board.askPromotion(S.game.turn());
    if (!promotion) { render(); return; }
  }
  const mv = applyMove({ from, to, promotion });
  if (mv && S.mode === 'online') {
    net?.send({ t: 'move', gameNo: S.gameNo, ply: S.moves.length - 1, from, to, promotion });
  }
}

function applyMove({ from, to, promotion }, { silent = false } = {}) {
  let mv;
  try { mv = S.game.move({ from, to, promotion }); } catch { return null; }
  if (!mv) return null;
  S.moves.push(mv);
  S.positions.push(S.game.fen());
  S.viewPly = null;
  S.drawOffer = null;
  checkGameEnd();
  if (!silent) sound(mv);
  requestAnalysis();
  render();
  return mv;
}

function checkGameEnd() {
  const g = S.game;
  if (g.isCheckmate()) S.result = { winner: opp(g.turn()), reason: 'мат' };
  else if (g.isStalemate()) S.result = { winner: null, reason: 'пат' };
  else if (g.isThreefoldRepetition()) S.result = { winner: null, reason: 'троекратное повторение' };
  else if (g.isInsufficientMaterial()) S.result = { winner: null, reason: 'недостаточно материала' };
  else if (g.isDraw()) S.result = { winner: null, reason: 'правило 50 ходов' };
}

function resetGame() {
  S.game = new Chess();
  S.positions = [START_FEN];
  S.moves = [];
  S.result = null;
  S.viewPly = null;
  S.drawOffer = null;
  S.rematchOffer = null;
  board.clearSelection();
  engine.reset();
  pending.clear();
  requestAnalysis();
}

// ---------- звук ----------
let actx;
function sound(mv) {
  if (!settings.sound) return;
  try {
    actx ??= new AudioContext();
    const t = actx.currentTime;
    const o = actx.createOscillator(), g = actx.createGain();
    o.type = 'triangle';
    o.frequency.value = mv.captured ? 300 : S.game.inCheck() ? 700 : 480;
    g.gain.setValueAtTime(0.0001, t);
    g.gain.exponentialRampToValueAtTime(0.25, t + 0.01);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.13);
    o.connect(g).connect(actx.destination);
    o.start(t);
    o.stop(t + 0.15);
  } catch {}
}

// ---------- отрисовка ----------
function curPly() { return S.viewPly ?? S.positions.length - 1; }

function render() {
  if (S.mode !== 'local' && S.mode !== 'online') return;
  const ply = curPly();
  const g = new Chess(S.positions[ply]);
  const pieces = {};
  let check = null;
  for (const row of g.board())
    for (const p of row) {
      if (!p) continue;
      pieces[p.square] = p;
      if (p.type === 'k' && p.color === g.turn() && g.inCheck()) check = p.square;
    }
  const last = ply > 0 ? S.moves[ply - 1] : null;
  const cls = settings.classify ? classAt(ply) : null;
  const an = evalAt(ply);
  const arrows = [];
  if (settings.bestMove && an?.best && !(isLive() && S.result)) {
    arrows.push({ from: an.best.slice(0, 2), to: an.best.slice(2, 4), color: '#3d9be9' });
  }
  board.orientation = S.orientation;
  board.render({
    pieces, check, arrows, coords: settings.coords,
    lastMove: last ? { from: last.from, to: last.to } : null,
    badge: cls && last ? { sq: last.to, ...CLASSES[cls.key] } : null,
  });
  renderEval(an);
  renderStrips(g);
  renderMoves();
  renderFeedback(ply, cls, an);
  renderStatus();
  renderActions();
  if (S.isHost && S.mode === 'online') saveHostSession();
}

function renderEval(an) {
  const bar = $('#evalBar');
  bar.classList.toggle('hidden', !settings.evalBar);
  bar.classList.toggle('flipped', S.orientation === 'b');
  if (!an) { bar.classList.add('pending'); return; }
  bar.classList.remove('pending');
  const pct = Math.abs(an.score) >= MATE - 10000 ? (an.score > 0 ? 100 : 0) : winPct(an.score);
  bar.querySelector('.eval-fill').style.height = pct + '%';
  const txt = bar.querySelector('.eval-text');
  txt.textContent = formatScore(an.score).replace('+', '');
  txt.classList.toggle('on-white', an.score >= 0);
}

const PIECE_ORDER = ['q', 'r', 'b', 'n', 'p'];
const START_COUNT = { p: 8, n: 2, b: 2, r: 2, q: 1 };
const VAL = { p: 1, n: 3, b: 3, r: 5, q: 9 };

function renderStrips(g) {
  const count = { w: {}, b: {} };
  let mat = 0;
  for (const row of g.board())
    for (const p of row) {
      if (!p || p.type === 'k') continue;
      count[p.color][p.type] = (count[p.color][p.type] || 0) + 1;
      mat += (p.color === 'w' ? 1 : -1) * VAL[p.type];
    }
  const strip = (el, color) => {
    el.querySelector('.pname').textContent = S.names[color] + (S.mode === 'online' && color === S.myColor ? ' (вы)' : '');
    el.querySelector('.pdot').className = 'pdot ' + color;
    el.classList.toggle('to-move', !S.result && isLive() && S.game.turn() === color);
    const caps = el.querySelector('.pcaps');
    caps.textContent = '';
    const enemy = opp(color);
    for (const t of PIECE_ORDER) {
      const n = Math.max(0, START_COUNT[t] - (count[enemy][t] || 0));
      for (let i = 0; i < n; i++) {
        const img = document.createElement('img');
        img.src = pieceUrl(enemy, t);
        caps.append(img);
      }
    }
    const adv = color === 'w' ? mat : -mat;
    if (adv > 0) { const s = document.createElement('span'); s.textContent = '+' + adv; caps.append(s); }
  };
  strip($('#stripTop'), opp(S.orientation));
  strip($('#stripBottom'), S.orientation);
}

function badgeHtml(cls) {
  if (!cls) return '';
  const c = CLASSES[cls.key];
  return `<i class="mb" style="background:${c.color}" title="${c.label}">${c.sym}</i>`;
}

function renderMoves() {
  const list = $('#moveList');
  const ply = curPly();
  let html = '';
  for (let i = 0; i < S.moves.length; i += 2) {
    html += `<div class="mrow"><span class="mnum">${i / 2 + 1}.</span>`;
    for (const j of [i, i + 1]) {
      const m = S.moves[j];
      if (!m) { html += '<span></span>'; continue; }
      const cls = settings.classify ? classAt(j + 1) : null;
      html += `<span class="mv${ply === j + 1 ? ' active' : ''}" data-ply="${j + 1}">${badgeHtml(cls)}${m.san}</span>`;
    }
    html += '</div>';
  }
  if (!S.moves.length) html = '<div class="muted small">Ходов пока нет</div>';
  list.innerHTML = html;
  list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });

  // Точность
  const acc = { w: [], b: [] };
  if (settings.classify)
    for (let p = 1; p < S.positions.length; p++) {
      const c = classAt(p);
      if (c) acc[S.moves[p - 1].color].push(c.accuracy);
    }
  const avg = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : '—');
  $('#accuracy').innerHTML = settings.classify && S.moves.length
    ? `Точность: <b>${S.names.w}</b> ${avg(acc.w)}% · <b>${S.names.b}</b> ${avg(acc.b)}%`
    : '';
}

function renderFeedback(ply, cls, an) {
  const box = $('#feedback');
  const parts = [];
  if (engineState === 'error') {
    parts.push('<div class="muted">Не удалось загрузить Stockfish (нужен интернет).</div>');
  } else if (!engineWanted()) {
    parts.push('<div class="muted">Подсказки движка выключены в настройках.</div>');
  } else if (engineState === 'loading') {
    parts.push('<div class="muted">Загружается Stockfish…</div>');
  }
  if (engineState === 'ready' && engineWanted()) {
    if (ply > 0 && settings.classify) {
      const m = S.moves[ply - 1];
      if (cls) {
        const c = CLASSES[cls.key];
        let line = `<div class="fb-main"><i class="mb big" style="background:${c.color}">${c.sym}</i>
          <div><b>${m.san}</b> — <span style="color:${c.color}">${c.label.toLowerCase()}</span>`;
        if (an) line += ` <span class="muted">(${formatScore(an.score)})</span>`;
        line += '</div></div>';
        parts.push(line);
        const prev = evalAt(ply - 1);
        if (BAD.has(cls.key) && prev?.best) {
          parts.push(`<div class="fb-sub">Лучше было: <b>${uciToSan(S.positions[ply - 1], prev.best)}</b>
            <span class="muted">(${formatScore(prev.score)})</span></div>`);
        }
      } else {
        parts.push(`<div class="muted">Stockfish оценивает ход <b>${m.san}</b>…</div>`);
      }
    } else if (ply === 0) {
      parts.push('<div class="muted">Начальная позиция</div>');
    }
    if (settings.bestMove && !(isLive() && S.result)) {
      parts.push(an?.best
        ? `<div class="fb-sub">Лучший ход сейчас: <b>${uciToSan(S.positions[ply], an.best)}</b>
           <span class="muted">(${formatScore(an.score)}, глубина ${an.depth})</span></div>`
        : '<div class="fb-sub muted">Ищу лучший ход…</div>');
    }
  }
  box.innerHTML = parts.join('');
}

function resultText() {
  const r = S.result;
  if (!r) return '';
  if (!r.winner) return `Ничья — ${r.reason}`;
  const who = S.mode === 'online' ? (r.winner === S.myColor ? 'Вы победили!' : 'Вы проиграли') : `Победили ${COLOR_RU[r.winner]}`;
  return `${who} (${r.reason})`;
}

function renderStatus() {
  const st = $('#statusText');
  const conn = $('#connText');
  const offer = $('#offerBar');
  let text;
  if (S.result) text = resultText();
  else if (S.mode === 'online') {
    text = !S.connected ? 'Соперник не подключён'
      : S.game.turn() === S.myColor ? 'Ваш ход' : 'Ход соперника';
    if (S.game.inCheck() && S.connected) text += ' — шах!';
  } else {
    text = `Ход: ${COLOR_RU[S.game.turn()]}` + (S.game.inCheck() ? ' — шах!' : '');
  }
  if (!isLive()) text += ' · просмотр истории';
  st.textContent = text;
  st.classList.toggle('over', !!S.result);

  if (S.mode === 'online') {
    conn.textContent = S.connected ? `● На связи с ${S.names[opp(S.myColor)]}` : '○ Нет соединения — ждём переподключения…';
    conn.className = 'conn ' + (S.connected ? 'ok' : 'bad');
  } else {
    conn.textContent = 'Игра на одном устройстве';
    conn.className = 'conn';
  }

  offer.innerHTML = '';
  const mk = (txt, yes, no) => {
    offer.innerHTML = `<span>${txt}</span>`;
    const by = document.createElement('button'); by.className = 'btn primary sm'; by.textContent = 'Да'; by.onclick = yes;
    const bn = document.createElement('button'); bn.className = 'btn sm'; bn.textContent = 'Нет'; bn.onclick = no;
    offer.append(by, bn);
  };
  if (S.drawOffer === 'them' && !S.result) {
    mk('Соперник предлагает ничью', () => {
      S.drawOffer = null; S.result = { winner: null, reason: 'по соглашению' };
      net?.send({ t: 'drawAccept' }); render();
    }, () => { S.drawOffer = null; net?.send({ t: 'drawDecline' }); render(); });
  } else if (S.rematchOffer === 'them') {
    mk('Соперник предлагает реванш', () => {
      S.rematchOffer = null;
      if (S.isHost) doRematch(); else net?.send({ t: 'rematchAccept' });
    }, () => { S.rematchOffer = null; render(); });
  } else if (S.drawOffer === 'me') offer.innerHTML = '<span class="muted">Вы предложили ничью…</span>';
  else if (S.rematchOffer === 'me') offer.innerHTML = '<span class="muted">Ждём ответа на реванш…</span>';
}

function renderActions() {
  const online = S.mode === 'online';
  const show = (id, v) => $(id).classList.toggle('hidden', !v);
  show('#btnDraw', online && !S.result);
  show('#btnResign', online && !S.result);
  show('#btnRematch', online && !!S.result);
  show('#btnUndo', !online && S.moves.length > 0);
  show('#btnNewLocal', !online);
  show('#btnCopyLink', online && S.isHost);
  $('#chatCard').classList.toggle('hidden', !online);
}

// ---------- экраны ----------
function showScreen(id) {
  for (const s of ['lobby', 'waiting', 'game']) $('#' + s).classList.toggle('hidden', s !== id);
}

function showGame() {
  showScreen('game');
  render();
}

function goLobby() {
  net?.destroy();
  net = null;
  S.mode = 'menu';
  S.isHost = false;
  S.connected = false;
  history.replaceState(null, '', location.pathname);
  refreshResume();
  showScreen('lobby');
}

function startLocal() {
  net?.destroy(); net = null;
  S.mode = 'local';
  S.myColor = null;
  S.isHost = false;
  S.names = { w: 'Белые', b: 'Чёрные' };
  S.orientation = 'w';
  resetGame();
  $('#chatLog').textContent = '';
  showGame();
}

// ---------- сеть ----------
let net = null;

function makeNet() {
  return new Net({
    acceptGuest: (d) => {
      if (!S.guestId) { S.guestId = d.clientId; return true; }
      return S.guestId === d.clientId;
    },
    onOpen: () => {
      S.connected = true;
      if (!S.isHost) net.send({ t: 'hello', clientId, name: myName() });
      render();
    },
    onClose: () => { S.connected = false; render(); },
    onData: onNet,
    onStatus: (t) => { if (S.mode === 'waiting') $('#waitStatus').textContent = t; else toast(t); },
    onError: (err) => {
      const msg = err.type === 'browser-incompatible'
        ? 'Браузер не поддерживает WebRTC — откройте сайт в Chrome, Firefox или Edge'
        : 'Ошибка соединения: ' + err.type;
      if (S.mode === 'waiting') $('#waitStatus').textContent = msg; else toast(msg);
    },
  });
}

function sendSync() {
  net?.send({
    t: 'sync', gameNo: S.gameNo, guestColor: opp(S.myColor), hostName: myName(),
    moves: S.moves.map((m) => ({ from: m.from, to: m.to, promotion: m.promotion })),
    result: S.result,
  });
}

function startOnlineAsHost(color) {
  S.mode = 'online';
  S.myColor = color;
  S.orientation = color;
  resetGame();
  showGame();
}

function doRematch() {
  S.gameNo++;
  startOnlineAsHost(opp(S.myColor));
  S.names[S.myColor] = myName();
  sendSync();
  render();
}

function applySync(d) {
  const same = S.mode === 'online' && d.gameNo === S.gameNo && S.myColor === d.guestColor &&
    d.moves.length >= S.moves.length &&
    S.moves.every((m, i) => m.from === d.moves[i].from && m.to === d.moves[i].to);
  if (!same) {
    S.mode = 'online';
    S.gameNo = d.gameNo;
    S.myColor = d.guestColor;
    S.orientation = d.guestColor;
    resetGame();
    showScreen('game');
  }
  for (let i = S.moves.length; i < d.moves.length; i++) applyMove(d.moves[i], { silent: true });
  if (d.result) S.result = d.result;
  S.names = { [S.myColor]: myName(), [opp(S.myColor)]: d.hostName || 'Соперник' };
  render();
}

function resync() {
  if (S.isHost) sendSync(); else net?.send({ t: 'syncReq' });
}

function onNet(d) {
  if (!d || typeof d !== 'object') return;
  switch (d.t) {
    case 'hello':
      if (!S.isHost) return;
      if (S.mode === 'waiting') {
        const c = S.hostPref === 'r' ? (Math.random() < 0.5 ? 'w' : 'b') : S.hostPref;
        S.gameNo = S.gameNo || 1;
        startOnlineAsHost(c);
      }
      S.names = { [S.myColor]: myName(), [opp(S.myColor)]: String(d.name || 'Соперник').slice(0, 20) };
      sendSync();
      toast(`${S.names[opp(S.myColor)]} подключился`);
      render();
      break;
    case 'sync':
      if (!S.isHost) applySync(d);
      break;
    case 'syncReq':
      if (S.isHost) sendSync();
      break;
    case 'move':
      if (S.mode !== 'online') return;
      if (d.gameNo !== S.gameNo || d.ply !== S.moves.length || S.game.turn() === S.myColor || S.result) return resync();
      if (!applyMove({ from: d.from, to: d.to, promotion: d.promotion })) resync();
      break;
    case 'resign':
      if (!S.result) S.result = { winner: S.myColor, reason: 'соперник сдался' };
      render();
      break;
    case 'draw':
      if (!S.result) S.drawOffer = 'them';
      render();
      break;
    case 'drawAccept':
      if (!S.result) S.result = { winner: null, reason: 'по соглашению' };
      S.drawOffer = null;
      render();
      break;
    case 'drawDecline':
      S.drawOffer = null;
      toast('Соперник отклонил ничью');
      render();
      break;
    case 'rematch':
      S.rematchOffer = 'them';
      render();
      break;
    case 'rematchAccept':
      if (S.isHost) doRematch();
      break;
    case 'chat':
      addChat(S.names[opp(S.myColor)], String(d.text || '').slice(0, 300), false);
      break;
    case 'full':
      toast('В этой игре уже два игрока');
      goLobby();
      break;
  }
}

async function hostGame(resume) {
  net?.destroy();
  S.isHost = true;
  S.mode = 'waiting';
  S.connected = false;
  S.guestId = resume?.guestId || null;
  showScreen('waiting');
  $('#shareBlock').classList.add('hidden');
  $('#waitTitle').textContent = resume ? 'Восстанавливаем игру' : 'Игра создана';
  $('#waitStatus').textContent = 'Подключение к серверу…';
  if (!Net.available()) { $('#waitStatus').textContent = 'Не загрузилась библиотека PeerJS (нужен интернет).'; return; }
  net = makeNet();
  try {
    const id = await net.host(resume?.hostId);
    S.hostId = id;
    $('#shareLink').value = shareLink();
    $('#shareBlock').classList.remove('hidden');
    if (resume) {
      S.gameNo = resume.gameNo;
      S.mode = 'online';
      S.myColor = resume.myColor;
      S.orientation = resume.myColor;
      resetGame();
      for (const m of resume.moves) applyMove(m, { silent: true });
      S.result = resume.result;
      S.names = { [S.myColor]: myName(), [opp(S.myColor)]: resume.oppName || 'Соперник' };
      showGame();
      toast('Игра восстановлена — ждём соперника');
    } else {
      S.gameNo = 1;
      $('#waitStatus').textContent = 'Отправьте ссылку другу. Игра начнётся, как только он откроет её.';
    }
  } catch (e) {
    $('#waitStatus').textContent = 'Не удалось создать игру: ' + (e?.type || e);
  }
}

const shareLink = () => location.origin + location.pathname + '?join=' + S.hostId;

async function joinGame(id) {
  net?.destroy();
  S.isHost = false;
  S.mode = 'waiting';
  S.connected = false;
  showScreen('waiting');
  $('#shareBlock').classList.add('hidden');
  $('#waitTitle').textContent = 'Подключение к игре';
  $('#waitStatus').textContent = 'Соединяемся с другом…';
  if (!Net.available()) { $('#waitStatus').textContent = 'Не загрузилась библиотека PeerJS (нужен интернет).'; return; }
  history.replaceState(null, '', location.pathname + '?join=' + encodeURIComponent(id));
  net = makeNet();
  try { await net.join(id); } catch (e) { $('#waitStatus').textContent = 'Ошибка: ' + (e?.type || e); }
}

// Хост сохраняет партию, чтобы после перезагрузки страницы продолжить с тем же кодом.
function saveHostSession() {
  lsSet('chess.hostSession', JSON.stringify({
    hostId: S.hostId, guestId: S.guestId, gameNo: S.gameNo, myColor: S.myColor,
    moves: S.moves.map((m) => ({ from: m.from, to: m.to, promotion: m.promotion })),
    result: S.result, oppName: S.names[opp(S.myColor)], time: Date.now(),
  }));
}
function loadHostSession() {
  try {
    const s = JSON.parse(lsGet('chess.hostSession', 'null'));
    if (s && s.hostId && Date.now() - s.time < 24 * 3600 * 1000) return s;
  } catch {}
  return null;
}
function refreshResume() {
  const s = loadHostSession();
  $('#resumeBlock').classList.toggle('hidden', !s);
  if (s) $('#resumeInfo').textContent = `против ${s.oppName || 'соперника'}, ходов: ${s.moves.length}`;
}

// ---------- чат ----------
function addChat(name, text, mine) {
  const log = $('#chatLog');
  const row = document.createElement('div');
  row.className = 'chat-row' + (mine ? ' mine' : '');
  const b = document.createElement('b');
  b.textContent = name + ': ';
  row.append(b, document.createTextNode(text));
  log.append(row);
  log.scrollTop = log.scrollHeight;
}

// ---------- тосты ----------
let toastTimer;
function toast(t) {
  const el = $('#toast');
  el.textContent = t;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 3000);
}

// ---------- навигация ----------
function setView(p) {
  const lastPly = S.positions.length - 1;
  p = Math.max(0, Math.min(lastPly, p));
  S.viewPly = p === lastPly ? null : p;
  board.clearSelection();
  render();
}

// ---------- события UI ----------
$('#nameInput').value = lsGet('chess.name', '');
$('#nameInput').addEventListener('input', () => lsSet('chess.name', $('#nameInput').value));

for (const b of document.querySelectorAll('#colorPick button')) {
  b.addEventListener('click', () => {
    document.querySelectorAll('#colorPick button').forEach((x) => x.classList.toggle('active', x === b));
    S.hostPref = b.dataset.c;
  });
}
$('#btnHost').onclick = () => { lsDel('chess.hostSession'); hostGame(null); };
$('#btnResume').onclick = () => { const s = loadHostSession(); if (s) hostGame(s); };
$('#btnLocal').onclick = startLocal;
$('#btnJoin').onclick = () => {
  const v = $('#joinInput').value.trim();
  const m = v.match(/join=([\w-]+)/);
  const id = m ? m[1] : v;
  if (id) joinGame(id);
};
$('#joinInput').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#btnJoin').click(); });
$('#btnCopy').onclick = () => copyLink();
$('#btnCopyLink').onclick = () => copyLink();
function copyLink() {
  const link = shareLink();
  navigator.clipboard?.writeText(link).then(() => toast('Ссылка скопирована'), () => {
    $('#shareLink').select(); toast('Скопируйте ссылку вручную');
  });
}
$('#btnCancelWait').onclick = goLobby;
$('#btnLeave').onclick = () => {
  if (S.mode === 'online' && !S.result && !confirm('Выйти из партии? Соперник останется ждать.')) return;
  goLobby();
};

$('#btnFlip').onclick = () => { S.orientation = opp(S.orientation); render(); };
$('#btnUndo').onclick = () => {
  if (S.mode !== 'local' || !S.moves.length) return;
  S.game.undo();
  S.moves.pop();
  S.positions.pop();
  S.result = null;
  S.viewPly = null;
  board.clearSelection();
  render();
};
$('#btnNewLocal').onclick = () => { resetGame(); render(); };
$('#btnResign').onclick = () => {
  if (S.result || !confirm('Сдаться?')) return;
  S.result = { winner: opp(S.myColor), reason: 'вы сдались' };
  net?.send({ t: 'resign' });
  render();
};
$('#btnDraw').onclick = () => {
  if (S.result || S.drawOffer) return;
  S.drawOffer = 'me';
  net?.send({ t: 'draw' });
  render();
};
$('#btnRematch').onclick = () => {
  if (S.rematchOffer === 'them') { S.rematchOffer = null; if (S.isHost) doRematch(); else net?.send({ t: 'rematchAccept' }); return; }
  S.rematchOffer = 'me';
  net?.send({ t: 'rematch' });
  render();
};

$('#navFirst').onclick = () => setView(0);
$('#navPrev').onclick = () => setView(curPly() - 1);
$('#navNext').onclick = () => setView(curPly() + 1);
$('#navLast').onclick = () => setView(Infinity);
$('#moveList').addEventListener('click', (e) => {
  const t = e.target.closest('.mv');
  if (t) setView(+t.dataset.ply);
});
document.addEventListener('keydown', (e) => {
  if (S.mode !== 'local' && S.mode !== 'online') return;
  if (e.target.closest('input, textarea')) return;
  if (e.key === 'ArrowLeft') setView(curPly() - 1);
  else if (e.key === 'ArrowRight') setView(curPly() + 1);
  else if (e.key === 'Home') setView(0);
  else if (e.key === 'End') setView(Infinity);
  else return;
  e.preventDefault();
});

$('#chatForm').addEventListener('submit', (e) => {
  e.preventDefault();
  const inp = $('#chatInput');
  const text = inp.value.trim();
  if (!text) return;
  if (!net?.send({ t: 'chat', text })) { toast('Нет соединения'); return; }
  addChat('Вы', text, true);
  inp.value = '';
});

// Настройки
const dlg = $('#settingsDlg');
$('#btnSettings').onclick = () => {
  for (const k of ['evalBar', 'classify', 'bestMove', 'coords', 'sound']) $('#set-' + k).checked = settings[k];
  $('#set-depth').value = settings.depth;
  $('#depthVal').textContent = settings.depth;
  dlg.showModal();
};
$('#btnCloseSettings').onclick = () => dlg.close();
dlg.addEventListener('click', (e) => { if (e.target === dlg) dlg.close(); });
for (const k of ['evalBar', 'classify', 'bestMove', 'coords', 'sound']) {
  $('#set-' + k).addEventListener('change', (e) => {
    settings[k] = e.target.checked;
    saveSettings();
    requestAnalysis();
    render();
  });
}
$('#set-depth').addEventListener('input', (e) => {
  settings.depth = +e.target.value;
  $('#depthVal').textContent = settings.depth;
  saveSettings();
});

// ---------- старт ----------
const joinParam = new URLSearchParams(location.search).get('join');
refreshResume();
if (joinParam) joinGame(joinParam);
else showScreen('lobby');
