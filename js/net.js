// P2P-соединение между двумя браузерами через WebRTC (PeerJS).
// Сервер не нужен: PeerJS использует бесплатный публичный сигнальный сервер,
// а сами ходы идут напрямую между игроками.
const randId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

export class Net {
  // h: { acceptGuest(hello), onOpen(), onClose(), onData(d), onError(err), onStatus(text) }
  constructor(handlers) {
    this.h = handlers;
    this.peer = null;
    this.conn = null;
    this.isHost = false;
    this.destroyed = false;
  }

  static available() {
    return typeof window.Peer === 'function';
  }

  host(fixedId) {
    this.isHost = true;
    return new Promise((resolve, reject) => {
      let tries = 0;
      const attempt = () => {
        if (this.destroyed) return;
        const id = fixedId || 'chess-' + randId();
        const peer = new window.Peer(id, { debug: 1 });
        this.peer = peer;
        peer.on('open', (pid) => resolve(pid));
        peer.on('connection', (conn) => this._attach(conn));
        peer.on('disconnected', () => this._revive());
        peer.on('error', (err) => {
          if (err.type === 'unavailable-id' && tries++ < 12) {
            peer.destroy();
            this.h.onStatus?.('Код ещё занят прошлой сессией, повтор…');
            setTimeout(attempt, fixedId ? 3000 : 0);
            return;
          }
          this.h.onError?.(err);
          reject(err);
        });
      };
      attempt();
    });
  }

  join(hostId) {
    this.isHost = false;
    this.hostId = hostId;
    return new Promise((resolve, reject) => {
      const peer = new window.Peer({ debug: 1 });
      this.peer = peer;
      peer.on('open', () => {
        this._connect();
        resolve();
      });
      peer.on('disconnected', () => this._revive());
      peer.on('error', (err) => {
        if (err.type === 'peer-unavailable') {
          this.h.onStatus?.('Хозяин игры пока недоступен, жду…');
          this._scheduleReconnect();
          return;
        }
        this.h.onError?.(err);
        reject(err);
      });
    });
  }

  _revive() {
    setTimeout(() => {
      if (this.peer && !this.peer.destroyed && this.peer.disconnected) {
        try { this.peer.reconnect(); } catch {}
      }
    }, 1500);
  }

  _connect() {
    if (this.destroyed || !this.peer || this.peer.destroyed) return;
    const conn = this.peer.connect(this.hostId, { reliable: true });
    this._attach(conn);
    this._scheduleReconnect();
  }

  _scheduleReconnect() {
    if (this.isHost || this.destroyed) return;
    clearTimeout(this.rt);
    this.rt = setTimeout(() => {
      if (this.conn || this.destroyed) return;
      if (this.peer?.disconnected) {
        try { this.peer.reconnect(); } catch {}
      }
      this._connect();
    }, 4000);
  }

  _attach(conn) {
    conn.on('open', () => {
      if (!this.isHost) {
        if (this.conn && this.conn !== conn) try { this.conn.close(); } catch {}
        this.conn = conn;
        clearTimeout(this.rt);
        this.h.onOpen?.();
      }
    });
    conn.on('data', (d) => {
      if (conn !== this.conn) {
        // Хост принимает подключение только после приветствия «своего» гостя.
        if (this.isHost && d && d.t === 'hello' && this.h.acceptGuest?.(d)) {
          const old = this.conn;
          this.conn = conn;
          if (old) try { old.close(); } catch {}
          this.h.onOpen?.();
          this.h.onData?.(d);
        } else if (this.isHost) {
          try { conn.send({ t: 'full' }); } catch {}
          setTimeout(() => conn.close(), 800);
        }
        return;
      }
      this.h.onData?.(d);
    });
    conn.on('close', () => {
      if (conn !== this.conn) return;
      this.conn = null;
      this.h.onClose?.();
      this._scheduleReconnect();
    });
    conn.on('error', () => {});
  }

  get connected() {
    return !!(this.conn && this.conn.open);
  }

  send(msg) {
    if (!this.connected) return false;
    this.conn.send(msg);
    return true;
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.rt);
    try { this.conn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    this.conn = null;
    this.peer = null;
  }
}
