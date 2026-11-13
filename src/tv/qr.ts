/**
 * qr.ts — draw a join-URL QR code on a canvas (used by the TV lobby).
 * Generated entirely in the browser, so it works through any public URL
 * (ngrok, Render, localhost) as long as we pass window.location.origin.
 */
import QRCode from "qrcode";

export async function drawJoinQr(canvas: HTMLCanvasElement, url: string): Promise<void> {
  await QRCode.toCanvas(canvas, url, {
    width: canvas.width || 360,
    margin: 1,
    color: { dark: "#13235b", light: "#ffffff" },
    errorCorrectionLevel: "M",
  });
}

/** The phone-controller link for a room. Uses the page's origin so it works through tunnels. */
export function joinUrlFor(code: string, origin = window.location.origin): string {
  return `${origin}?join=${code}`;
}
