import { ALERT_LEVELS, alertsConfigured, credentialsFrom, deleteSubscription, upsertSubscription, type AlertLevel } from "@/lib/alerts";
import { rateLimiter } from "@/lib/rate-limit";
import { isPushSubscription } from "@/lib/push-validation";
import { BodyTooLargeError, limitedJson } from "@/lib/request-body";

const rateLimited = rateLimiter(30, 60 * 60 * 1000);

function error(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

/** Turns alerts on (or updates the threshold): `{ subscription: PushSubscriptionJSON, minLevel }`. */
export async function PUT(request: Request) {
  if (!alertsConfigured) return error(503, "Alerts aren't available right now.");
  if (rateLimited(request)) return error(429, "Too many requests. Please try again later.");

  let raw: unknown;
  try {
    raw = await limitedJson(request);
  } catch (err) {
    return error(err instanceof BodyTooLargeError ? 413 : 400, "A small JSON push subscription is required.");
  }
  const body = raw as {
    subscription?: { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } };
    minLevel?: unknown;
  } | null;
  const sub = body?.subscription;
  if (!isPushSubscription(sub)) return error(400, "A valid browser push subscription is required.");
  const minLevel = ALERT_LEVELS.includes(body?.minLevel as AlertLevel) ? (body!.minLevel as AlertLevel) : "moderate";

  try {
    const saved = await upsertSubscription(sub, minLevel);
    if (!saved) return error(403, "The push credentials do not match this subscription.");
    return Response.json({ ok: true, minLevel });
  } catch (err) {
    console.error("Saving push subscription failed", err);
    return error(502, "Couldn't turn on alerts. Please try again.");
  }
}

/** Turns alerts off and forgets every place stored for them. */
export async function DELETE(request: Request) {
  if (!alertsConfigured) return error(503, "Alerts aren't available right now.");
  const creds = credentialsFrom(request);
  if (!creds) return error(400, "Missing push credentials.");
  try {
    await deleteSubscription(creds);
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error("Deleting push subscription failed", err);
    return error(502, "Couldn't turn off alerts. Please try again.");
  }
}
