import { parseLatLng } from "@/lib/geo";
import { rateLimiter } from "@/lib/rate-limit";
import { nearbyReports, NEARBY_RADIUS_KM, REPORT_MAX_AGE_HOURS } from "@/lib/reports";
import { assessThreat } from "@/lib/threat";

/**
 * Public flood information API: `GET /api/v1/flood?lat=<latitude>&lng=<longitude>`.
 * Returns the flood threat estimate and recent approved photo reports near that point as
 * JSON, with CORS open so other sites and apps can use it. The response shape is versioned
 * by the path: add fields freely, but breaking changes go to /api/v2.
 */

// Each uncached threat estimate costs a Gemma request, so cap it per client.
const rateLimited = rateLimiter(60, 60 * 60 * 1000);

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Access-Control-Max-Age": "86400",
};

function json(body: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(body, { status, headers: { ...CORS, ...headers } });
}

/**
 * The public origin the client used. The standalone server's `request.url` carries its bind
 * address (0.0.0.0), so use the Host / X-Forwarded-* headers set by Cloudflare and the ingress.
 */
function publicOrigin(request: Request): string {
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? new URL(request.url).host;
  const proto = request.headers.get("x-forwarded-proto")?.split(",")[0].trim() ?? new URL(request.url).protocol.replace(":", "");
  return `${proto}://${host}`;
}

export function OPTIONS() {
  return new Response(null, { status: 204, headers: CORS });
}

export async function GET(request: Request) {
  if (rateLimited(request)) return json({ error: "Too many requests. Try again later." }, 429, { "Retry-After": "3600" });
  const at = parseLatLng(new URL(request.url).searchParams);
  if (!at) return json({ error: "Pass lat and lng query parameters, e.g. ?lat=36.85&lng=-76.29." }, 400);

  const [threat, reports] = await Promise.allSettled([
    assessThreat(at.latitude, at.longitude),
    nearbyReports(at.latitude, at.longitude),
  ]);
  if (threat.status === "rejected") console.error("API: threat assessment failed", threat.reason);
  if (reports.status === "rejected") console.error("API: listing reports failed", reports.reason);
  if (threat.status === "rejected" && reports.status === "rejected") {
    return json({ error: "Flood information is unavailable right now." }, 502);
  }

  const origin = publicOrigin(request);
  return json(
    {
      location: at,
      threat:
        threat.status === "fulfilled"
          ? {
              level: threat.value.level,
              headline: threat.value.headline,
              summary: threat.value.summary,
              factors: threat.value.factors,
              confidence: threat.value.confidence,
              // [south, west, north, east] of the area the estimate covers.
              area: threat.value.bbox,
              source: threat.value.source,
              basis: threat.value.basis,
              generatedAt: threat.value.generatedAt,
            }
          : null,
      reports:
        reports.status === "fulfilled"
          ? {
              radiusKm: NEARBY_RADIUS_KM,
              maxAgeHours: REPORT_MAX_AGE_HOURS,
              items: reports.value.map((r) => ({
                id: r.id,
                latitude: r.latitude,
                longitude: r.longitude,
                distanceKm: r.distanceKm,
                note: r.note,
                submittedAt: r.submittedAt,
                takenAt: r.takenAt,
                photoUrl: new URL(r.photoUrl, origin).href,
              })),
            }
          : null,
      disclaimer: "Community reports and an automated estimate. Always follow official warnings and emergency services.",
    },
    200,
    { "Cache-Control": "public, max-age=60" },
  );
}
