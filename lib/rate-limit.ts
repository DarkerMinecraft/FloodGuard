import "server-only";

/**
 * Sliding-window rate limiter keyed by client IP. It lives in memory, so it is per
 * server instance; put a shared store (e.g. Redis) or a gateway limit in front when
 * scaling out.
 */
export function rateLimiter(limit: number, windowMs: number) {
  const hits = new Map<string, number[]>();
  let nextSweep = 0;
  const maxClients = 10_000;
  return function limited(request: Request): boolean {
    const ip = request.headers.get("x-forwarded-for")?.split(",")[0].trim() || "unknown";
    const now = Date.now();
    if (now >= nextSweep) {
      for (const [key, times] of hits) {
        if (now - times[times.length - 1] >= windowMs) hits.delete(key);
      }
      nextSweep = now + Math.min(windowMs, 60_000);
    }
    // Bound memory even if an attacker supplies a new forwarded address each time.
    if (!hits.has(ip) && hits.size >= maxClients) return true;
    const recent = (hits.get(ip) ?? []).filter((t) => now - t < windowMs);
    const over = recent.length >= limit;
    if (!over) recent.push(now);
    hits.set(ip, recent);
    return over;
  };
}
