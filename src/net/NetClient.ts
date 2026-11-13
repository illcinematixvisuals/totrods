/**
 * NetClient.ts — the browser side of the WebSocket connection.
 *
 * It does four jobs:
 *  1. Send/receive typed messages (JSON text on the wire, TypeScript types in code).
 *  2. Clock sync: the server's clock is the official one (race start time,
 *     snapshot times). We ping the server and estimate how far our clock is
 *     off. serverNow() then gives "what time is it on the server right now".
 *  3. Reconnect: if the connection drops, keep retrying for a while and
 *     "resume" our seat with a secret token the server gave us.
 *  4. Queue important messages (laps) while disconnected and send them later.
 */
import { PROTOCOL_VERSION, RECONNECT_GRACE_MS, type ClientMessage, type ServerMessage } from "../../shared/protocol";

export type NetStatus = "connecting" | "open" | "reconnecting" | "closed";

/** Where we sit: saved so a page reload can rejoin the same room. */
export interface Session {
  code: string;
  token: string;
}

const SESSION_KEY = "totrods-session";
const PING_INTERVAL_MS = 2000;

export class NetClient {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<(msg: ServerMessage) => void>();
  private readonly outbox: ClientMessage[] = []; // reliable messages waiting for a connection
  private pingTimer = 0;
  private reconnectTimer = 0;
  private reconnectUntil = 0;
  private wantOpen = false; // false after close(): don't reconnect
  private clockSamples: Array<{ rtt: number; offset: number }> = [];

  /** Our clock + offset = server clock. */
  private clockOffset = 0;
  /** Round-trip time of the last ping, in ms. */
  rtt = 0;
  session: Session | null = null;
  status: NetStatus = "closed";
  onStatus: (status: NetStatus) => void = () => {};

  constructor(readonly url: string) {}

  /** Open the connection. Resolves once connected, rejects if the server can't be reached. */
  connect(): Promise<void> {
    this.wantOpen = true;
    return new Promise((resolve, reject) => {
      this.open(resolve, reject);
    });
  }

  private open(onOpen?: () => void, onFail?: (err: Error) => void): void {
    this.setStatus(this.session ? "reconnecting" : "connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      this.setStatus("open");
      // If we were already in a room, ask for our seat back.
      if (this.session) this.sendNow({ type: "resume", code: this.session.code, token: this.session.token, version: PROTOCOL_VERSION });
      this.startPinging();
      onOpen?.();
    };

    // Every message from the server arrives here as text; parse it and hand it on.
    ws.onmessage = (ev: MessageEvent<string>) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "pong") return this.onPong(msg.t, msg.server);
      if (msg.type === "welcome") {
        this.session = { code: msg.room.code, token: msg.token };
        sessionStorage.setItem(SESSION_KEY, JSON.stringify(this.session));
        this.flushOutbox();
      }
      this.listeners.forEach((fn) => fn(msg));
    };

    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      if (this.ws !== ws) return; // an old socket we already replaced
      this.ws = null;
      if (!opened && !this.session) {
        this.setStatus("closed");
        onFail?.(new Error(`Can't reach the game server at ${this.url}`));
        return;
      }
      if (this.wantOpen && this.session) this.scheduleReconnect();
      else this.setStatus("closed");
    };
  }

  /** Try again every second until the server's grace period would be over. */
  private scheduleReconnect(): void {
    if (this.reconnectUntil === 0) this.reconnectUntil = Date.now() + RECONNECT_GRACE_MS;
    if (Date.now() > this.reconnectUntil) {
      this.reconnectUntil = 0;
      this.setStatus("closed");
      return;
    }
    this.setStatus("reconnecting");
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.open(() => (this.reconnectUntil = 0)), 1000);
  }

  private setStatus(s: NetStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  /** Subscribe to server messages. Returns an unsubscribe function. */
  on(fn: (msg: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  /**
   * Send a message. Position updates are simply dropped while offline (a newer
   * one comes 50 ms later anyway), but lap messages are queued: they matter.
   */
  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.status === "open") this.sendNow(msg);
    else if (msg.type === "checkpoint" || msg.type === "lapDone") this.outbox.push(msg);
  }

  get connected(): boolean {
    return this.status === "open";
  }

  private sendNow(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private flushOutbox(): void {
    while (this.outbox.length > 0) this.sendNow(this.outbox.shift()!);
  }

  // ---------------------------------------------------------------------------
  // Clock sync
  // ---------------------------------------------------------------------------

  /** Estimated current time on the server's clock (ms since 1970). */
  serverNow(): number {
    return Date.now() + this.clockOffset;
  }

  private startPinging(): void {
    window.clearInterval(this.pingTimer);
    // A few quick pings first for a good initial estimate, then one every 2 s.
    for (let i = 0; i < 4; i++) window.setTimeout(() => this.ping(), i * 150);
    this.pingTimer = window.setInterval(() => this.ping(), PING_INTERVAL_MS);
  }

  private ping(): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.sendNow({ type: "ping", t: Date.now() });
  }

  /**
   * The server replied with its clock. The reply took `rtt` ms round trip, so
   * the server's clock was read about rtt/2 ago. Pings with the smallest rtt
   * give the most trustworthy estimate, so we keep the best of the last 10.
   */
  private onPong(sentAt: number, server: number): void {
    const now = Date.now();
    this.rtt = now - sentAt;
    this.clockSamples.push({ rtt: this.rtt, offset: server + this.rtt / 2 - now });
    if (this.clockSamples.length > 10) this.clockSamples.shift();
    const best = this.clockSamples.reduce((a, b) => (b.rtt < a.rtt ? b : a));
    this.clockOffset = best.offset;
  }

  // ---------------------------------------------------------------------------

  /** Leave on purpose: tell the server, close, and forget the saved seat. */
  close(): void {
    this.wantOpen = false;
    window.clearTimeout(this.reconnectTimer);
    window.clearInterval(this.pingTimer);
    if (this.ws?.readyState === WebSocket.OPEN) this.sendNow({ type: "leave" });
    this.ws?.close();
    this.ws = null;
    this.session = null;
    NetClient.clearSavedSession();
    this.setStatus("closed");
  }

  /** Testing aid: drop the connection as if the Wi-Fi blinked (we will reconnect). */
  simulateDrop(): void {
    this.ws?.close();
  }

  static savedSession(): Session | null {
    try {
      const raw = sessionStorage.getItem(SESSION_KEY);
      return raw ? (JSON.parse(raw) as Session) : null;
    } catch {
      return null;
    }
  }

  static clearSavedSession(): void {
    sessionStorage.removeItem(SESSION_KEY);
  }
}
