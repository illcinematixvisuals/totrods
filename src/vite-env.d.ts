/// <reference types="vite/client" />

// Environment variables Vite bakes into the client at build time.
// Only variables starting with VITE_ are exposed to browser code.
interface ImportMetaEnv {
  /** Full WebSocket URL of the game server, e.g. wss://totrods.onrender.com */
  readonly VITE_SERVER_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** Screen Wake Lock (keep the phone controller from going to sleep). */
interface WakeLockSentinel {
  readonly released: boolean;
  release(): Promise<void>;
}
interface Navigator {
  wakeLock?: { request(type: "screen"): Promise<WakeLockSentinel> };
  vibrate?(pattern: number | number[]): boolean;
}
interface Window {
  orientation?: number;
}
interface DeviceOrientationEvent {
  requestPermission?: () => Promise<string>;
}
