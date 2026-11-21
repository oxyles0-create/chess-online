// Звуки шахмат, синтезированные через Web Audio: стук деревянной фигуры о доску,
// взятие, шах, рокировка, превращение, премув, начало и конец партии.
let ctx = null;
let master = null;
let noiseBuf = null;

function ac() {
  if (!ctx) {
    ctx = new (window.AudioContext || window.webkitAudioContext)();
    master = ctx.createGain();
    master.gain.value = 0.9;
    const comp = ctx.createDynamicsCompressor();
    master.connect(comp).connect(ctx.destination);
    noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 0.25, ctx.sampleRate);
    const d = noiseBuf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  }
  if (ctx.state === 'suspended') ctx.resume();
  return ctx;
}

// Один «стук»: короткий щелчок шума через полосовой фильтр + низкий резонанс дерева.
function knock(t, { freq = 1800, q = 1.2, body = 190, vol = 1, len = 0.09 } = {}) {
  const c = ctx;
  const n = c.createBufferSource();
  n.buffer = noiseBuf;
  const bp = c.createBiquadFilter();
  bp.type = 'bandpass';
  bp.frequency.value = freq;
  bp.Q.value = q;
  const ng = c.createGain();
  ng.gain.setValueAtTime(0.0001, t);
  ng.gain.exponentialRampToValueAtTime(0.9 * vol, t + 0.002);
  ng.gain.exponentialRampToValueAtTime(0.0001, t + len * 0.55);
  n.connect(bp).connect(ng).connect(master);
  n.start(t);
  n.stop(t + len);

  const o = c.createOscillator();
  o.type = 'sine';
  o.frequency.setValueAtTime(body * 1.6, t);
  o.frequency.exponentialRampToValueAtTime(body, t + 0.03);
  const og = c.createGain();
  og.gain.setValueAtTime(0.0001, t);
  og.gain.exponentialRampToValueAtTime(0.55 * vol, t + 0.003);
  og.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(og).connect(master);
  o.start(t);
  o.stop(t + len + 0.02);
}

function tone(t, freq, len, vol = 0.25, type = 'sine') {
  const o = ctx.createOscillator();
  o.type = type;
  o.frequency.value = freq;
  const g = ctx.createGain();
  g.gain.setValueAtTime(0.0001, t);
  g.gain.exponentialRampToValueAtTime(vol, t + 0.01);
  g.gain.exponentialRampToValueAtTime(0.0001, t + len);
  o.connect(g).connect(master);
  o.start(t);
  o.stop(t + len + 0.02);
}

export const Sounds = {
  enabled: true,
  play(kind) {
    if (!this.enabled) return;
    try {
      ac();
    } catch {
      return;
    }
    const t = ctx.currentTime + 0.005;
    switch (kind) {
      case 'move':
        knock(t, { freq: 1500, body: 170 });
        break;
      case 'capture':
        knock(t, { freq: 2600, q: 0.9, body: 230, vol: 1 });
        knock(t + 0.045, { freq: 1300, body: 150, vol: 0.8 });
        break;
      case 'castle':
        knock(t, { freq: 1500, body: 170 });
        knock(t + 0.11, { freq: 1700, body: 185, vol: 0.85 });
        break;
      case 'check':
        knock(t, { freq: 2000, body: 200 });
        tone(t + 0.01, 880, 0.22, 0.13, 'triangle');
        tone(t + 0.01, 1320, 0.18, 0.06, 'sine');
        break;
      case 'promote':
        knock(t, { freq: 1600, body: 180 });
        tone(t + 0.04, 784, 0.12, 0.12, 'triangle');
        tone(t + 0.12, 1175, 0.2, 0.12, 'triangle');
        break;
      case 'premove':
        knock(t, { freq: 3200, q: 2, body: 320, vol: 0.35, len: 0.05 });
        break;
      case 'illegal':
        tone(t, 140, 0.15, 0.2, 'square');
        break;
      case 'start':
        tone(t, 523, 0.18, 0.15, 'triangle');
        tone(t + 0.12, 784, 0.3, 0.15, 'triangle');
        break;
      case 'end':
        tone(t, 784, 0.2, 0.15, 'triangle');
        tone(t + 0.15, 659, 0.2, 0.15, 'triangle');
        tone(t + 0.3, 523, 0.45, 0.15, 'triangle');
        break;
    }
  },
  // Выбрать звук по ходу chess.js
  forMove(mv, inCheck, gameOver) {
    if (gameOver) {
      this.play(mv.captured ? 'capture' : 'move');
      setTimeout(() => this.play('end'), 180);
      return;
    }
    if (inCheck) this.play('check');
    else if (mv.promotion) this.play('promote');
    else if (mv.flags.includes('k') || mv.flags.includes('q')) this.play('castle');
    else if (mv.captured) this.play('capture');
    else this.play('move');
  },
};
