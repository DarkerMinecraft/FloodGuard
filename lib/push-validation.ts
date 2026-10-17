import { ECDH } from "node:crypto";

/** Only browser push services may be contacted; subscriptions are untrusted input. */
export function isPushEndpoint(endpoint: unknown): endpoint is string {
  if (typeof endpoint !== "string" || endpoint.length > 1000) return false;
  try {
    const url = new URL(endpoint);
    if (url.protocol !== "https:" || url.username || url.password || url.hash || (url.port && url.port !== "443")) return false;
    const host = url.hostname;
    return host === "fcm.googleapis.com" || host === "android.googleapis.com" ||
      host === "updates.push.services.mozilla.com" || host.endsWith(".push.services.mozilla.com") ||
      host === "web.push.apple.com" || host.endsWith(".push.apple.com") ||
      host.endsWith(".notify.windows.com") || host.endsWith(".notify.live.net");
  } catch {
    return false;
  }
}

function decodeKey(value: unknown, length: number): Buffer | null {
  if (typeof value !== "string" || value.length > 100 || !/^[A-Za-z0-9_-]+={0,2}$/.test(value)) return null;
  const bytes = Buffer.from(value, "base64url");
  return bytes.length === length && bytes.toString("base64url") === value.replace(/=+$/, "") ? bytes : null;
}

export function isPushSubscription(value: unknown): value is { endpoint: string; keys: { p256dh: string; auth: string } } {
  const sub = value as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | null;
  if (!isPushEndpoint(sub?.endpoint) || !decodeKey(sub?.keys?.auth, 16)) return false;
  const key = decodeKey(sub?.keys?.p256dh, 65);
  if (!key || key[0] !== 4) return false;
  try {
    // Length alone is insufficient: reject points that are not on the P-256 curve.
    ECDH.convertKey(key, "prime256v1");
    return true;
  } catch {
    return false;
  }
}
