/**
 * TvNet.ts — WebSocket helper for TV Party (the TV display and the phones).
 * Same idea as NetClient, but with its own sessionStorage key and resume
 * message so it never collides with an online-rooms seat on the same device.
 */
import { PROTOCOL_VERSION, TV_HOST_GRACE_MS, type ClientMessage, type ServerMessage } from "../../shared/protocol";

export type TvNetStatus = "connecting" | "open" | "reconnecting" | "closed";

export interface TvSessionSeat {
  code: string;
  token: string;
  role: "tv" | "controller";
}

export class TvNet {
  private ws: WebSocket | null = null;
  private readonly listeners = new Set<(msg: ServerMessage) => void>();
  private reconnectTimer = 0;
  private reconnectUntil = 0;
  private wantOpen = false;
  private pingTimer = 0;
  session: TvSessionSeat | null = null;
  status: TvNetStatus = "closed";
  onStatus: (status: TvNetStatus) => void = () => {};

  constructor(
    readonly url: string,
    readonly storageKey: string,
    private readonly resumeType: "tv_resume" | "controller_resume",
  ) {}

  connect(): Promise<void> {
    this.wantOpen = true;
    return new Promise((resolve, reject) => this.open(resolve, reject));
  }

  private open(onOpen?: () => void, onFail?: (err: Error) => void): void {
    this.setStatus(this.session ? "reconnecting" : "connecting");
    const ws = new WebSocket(this.url);
    this.ws = ws;
    let opened = false;
    ws.onopen = () => {
      opened = true;
      this.setStatus("open");
      if (this.session) {
        this.sendNow({ type: this.resumeType, code: this.session.code, token: this.session.token, version: PROTOCOL_VERSION });
      }
      this.startPing();
      onOpen?.();
    };
    ws.onmessage = (ev: MessageEvent<string>) => {
      let msg: ServerMessage;
      try {
        msg = JSON.parse(ev.data) as ServerMessage;
      } catch {
        return;
      }
      if (msg.type === "tv_welcome") {
        this.session = { code: msg.room.code, token: msg.token, role: msg.role };
        sessionStorage.setItem(this.storageKey, JSON.stringify(this.session));
      }
      this.listeners.forEach((fn) => fn(msg));
    };
    ws.onclose = () => {
      window.clearInterval(this.pingTimer);
      if (this.ws !== ws) return;
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

  private scheduleReconnect(): void {
    const grace = TV_HOST_GRACE_MS; // long enough for both TV and phones
    if (this.reconnectUntil === 0) this.reconnectUntil = Date.now() + grace;
    if (Date.now() > this.reconnectUntil) {
      this.reconnectUntil = 0;
      this.setStatus("closed");
      return;
    }
    this.setStatus("reconnecting");
    window.clearTimeout(this.reconnectTimer);
    this.reconnectTimer = window.setTimeout(() => this.open(() => (this.reconnectUntil = 0)), 1000);
  }

  private setStatus(s: TvNetStatus): void {
    if (this.status === s) return;
    this.status = s;
    this.onStatus(s);
  }

  on(fn: (msg: ServerMessage) => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN && this.status === "open") this.sendNow(msg);
  }

  get connected(): boolean {
    return this.status === "open";
  }

  private sendNow(msg: ClientMessage): void {
    this.ws?.send(JSON.stringify(msg));
  }

  private startPing(): void {
    window.clearInterval(this.pingTimer);
    this.pingTimer = window.setInterval(() => {
      if (this.ws?.readyState === WebSocket.OPEN) this.sendNow({ type: "ping", t: Date.now() });
    }, 2000);
  }

  close(): void {
    this.wantOpen = false;
    window.clearTimeout(this.reconnectTimer);
    window.clearInterval(this.pingTimer);
    if (this.ws?.readyState === WebSocket.OPEN) this.sendNow({ type: "leave" });
    this.ws?.close();
    this.ws = null;
    this.session = null;
    sessionStorage.removeItem(this.storageKey);
    this.setStatus("closed");
  }

  simulateDrop(): void {
    this.ws?.close();
  }

  static saved(storageKey: string): TvSessionSeat | null {
    try {
      const raw = sessionStorage.getItem(storageKey);
      return raw ? (JSON.parse(raw) as TvSessionSeat) : null;
    } catch {
      return null;
    }
  }
}
