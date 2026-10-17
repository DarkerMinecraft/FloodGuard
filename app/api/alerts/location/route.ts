import {
  alertsConfigured,
  clearLastLocation,
  credentialsFrom,
  findSubscription,
  parseCoord,
  setLastLocation,
} from "@/lib/alerts";
import { rateLimiter } from "@/lib/rate-limit";
import { BodyTooLargeError, limitedJson } from "@/lib/request-body";

// The app sends this at most every few minutes while open.
const rateLimited = rateLimiter(120, 60 * 60 * 1000);

function error(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

/** Records the subscriber's current position: `{ latitude, longitude }`. */
export async function PUT(request: Request) {
  if (!alertsConfigured) return error(503, "Alerts aren't available right now.");
  if (rateLimited(request)) return error(429, "Too many requests.");
  const creds = credentialsFrom(request);
  if (!creds) return error(400, "Missing push credentials.");
  let raw: unknown;
  try {
    raw = await limitedJson(request);
  } catch (err) {
    return error(err instanceof BodyTooLargeError ? 413 : 400, "A small JSON location is required.");
  }
  const body = raw as { latitude?: unknown; longitude?: unknown } | null;
  const at = parseCoord(body?.latitude, body?.longitude);
  if (!at) return error(400, "A valid location is required.");

  try {
    const sub = await findSubscription(creds);
    if (!sub) return error(404, "Alerts aren't turned on for this device.");
    await setLastLocation(sub.id, at.latitude, at.longitude);
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error("Saving alert location failed", err);
    return error(502, "Couldn't update your alert location.");
  }
}

/** Stops sharing the current position; saved places keep alerting. */
export async function DELETE(request: Request) {
  if (!alertsConfigured) return error(503, "Alerts aren't available right now.");
  const creds = credentialsFrom(request);
  if (!creds) return error(400, "Missing push credentials.");
  try {
    const sub = await findSubscription(creds);
    if (sub) await clearLastLocation(sub.id);
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error("Clearing alert location failed", err);
    return error(502, "Couldn't stop sharing your location.");
  }
}
