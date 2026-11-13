/**
 * serverUrl.ts — decide which game server to connect to.
 *
 * In order of priority:
 *  1. ?server=ws://some-host:2567 in the page URL (handy for testing)
 *  2. VITE_SERVER_URL, baked in at build time (e.g. `VITE_SERVER_URL=wss://my.host npm run build`)
 *  3. The page was served BY the game server (it adds a <meta name="totrods-server"> tag),
 *     so connect back to the same host and port. This is the one-deploy setup.
 *  4. Otherwise (Vite dev server, or any static host): same hostname, port 2567.
 */
import { DEFAULT_SERVER_PORT } from "../../shared/protocol";

export function resolveServerUrl(): string {
  const fromQuery = new URLSearchParams(location.search).get("server");
  if (fromQuery) return fromQuery;
  const fromEnv = import.meta.env.VITE_SERVER_URL;
  if (fromEnv) return fromEnv;
  // https pages must use secure WebSockets (wss://), http pages use ws://.
  const scheme = location.protocol === "https:" ? "wss" : "ws";
  if (document.querySelector('meta[name="totrods-server"][content="same-origin"]')) return `${scheme}://${location.host}`;
  return `${scheme}://${location.hostname || "localhost"}:${DEFAULT_SERVER_PORT}`;
}
