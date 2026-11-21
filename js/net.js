// P2P-соединение между двумя браузерами через WebRTC (PeerJS).
// Сервер не нужен: PeerJS использует бесплатный публичный сигнальный сервер,
// а сами ходы идут напрямую между игроками. Публичный сервер иногда сбоит,
// поэтому при ошибках связи с ним мы бесконечно переподключаемся.
const randId = () =>
  Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => 'abcdefghjkmnpqrstuvwxyz23456789'[b % 31]).join('');

const SERVER_ERRORS = new Set(['network', 'server-error', 'socket-error', 'socket-closed', 'disconnected']);

export class Net {
  // h: { acceptGuest(hello), onOpen(), onClose(), onData(d), onError(err), onStatus(text), onServer(ok) }
  constructor(handlers) {
    this.h = handlers;
    this.peer = null;
    this.conn = null;
    this.isHost = false;
    this.destroyed = false;
    this.retries = 0;
  }

  static available() {
    return typeof window.Peer === 'function';
  }

  host(fixedId) {
    this.isHost = true;
    this.myId = fixedId || 'chess-' + randId();
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._startHost();
    });
  }

  join(hostId) {
    this.isHost = false;
    this.hostId = hostId;
    return new Promise((resolve) => {
      this._resolve = resolve;
      this._startGuest();
    });
  }

  _newPeer(id) {
    try { this.peer?.destroy(); } catch {}
    const peer = id ? new window.Peer(id, { debug: 1 }) : new window.Peer({ debug: 1 });
    this.peer = peer;
    peer.on('open', () => {
      if (peer !== this.peer) return;
      this.retries = 0;
      this.h.onServer?.(true);
      this._resolve?.(this.myId);
      this._resolve = null;
      if (!this.isHost) this._connect();
    });
    peer.on('disconnected', () => {
      if (peer !== this.peer || this.destroyed) return;
      setTimeout(() => {
        if (peer === this.peer && !peer.destroyed && peer.disconnected) {
          try { peer.reconnect(); } catch {}
        }
      }, 1500);
    });
    peer.on('error', (err) => {
      if (peer !== this.peer || this.destroyed) return;
      this._onPeerError(err);
    });
    return peer;
  }

  _startHost() {
    if (this.destroyed) return;
    const peer = this._newPeer(this.myId);
    peer.on('connection', (conn) => { if (peer === this.peer) this._attach(conn); });
  }

  _startGuest() {
    if (this.destroyed) return;
    this._newPeer(null);
  }

  _onPeerError(err) {
    if (err.type === 'peer-unavailable') {
      this.h.onStatus?.('Друг пока не в сети или игра закрыта, жду…');
      this._scheduleReconnect();
      return;
    }
    if (err.type === 'unavailable-id' && this.isHost) {
      // Код ещё числится за прошлым подключением — сервер освободит его через несколько секунд.
      this._retry('Код игры ещё занят прошлым подключением');
      return;
    }
    if (SERVER_ERRORS.has(err.type)) {
      this.h.onServer?.(false);
      // Если с другом уже есть прямое соединение, игра идёт и без сервера.
      if (this.connected) {
        setTimeout(() => { if (this.peer?.disconnected) try { this.peer.reconnect(); } catch {} }, 5000);
        return;
      }
      this._retry('Сервер соединения не отвечает');
      return;
    }
    this.h.onError?.(err);
  }

  _retry(reason) {
    this.retries++;
    const delay = Math.min(2000 * this.retries, 10000);
    this.h.onStatus?.(`${reason}. Пробую снова через ${Math.round(delay / 1000)} с (попытка ${this.retries})…`);
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => (this.isHost ? this._startHost() : this._startGuest()), delay);
  }

  _connect() {
    if (this.destroyed || !this.peer || this.peer.destroyed || this.peer.disconnected) return;
    const conn = this.peer.connect(this.hostId, { reliable: true });
    if (conn) this._attach(conn);
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
    clearTimeout(this.retryTimer);
    try { this.conn?.close(); } catch {}
    try { this.peer?.destroy(); } catch {}
    this.conn = null;
    this.peer = null;
  }
}
