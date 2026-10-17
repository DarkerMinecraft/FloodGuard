import {
  addPlace,
  alertsConfigured,
  credentialsFrom,
  findSubscription,
  listPlaces,
  MAX_SAVED_PLACES,
  parseCoord,
  removePlace,
} from "@/lib/alerts";
import { rateLimiter } from "@/lib/rate-limit";
import { BodyTooLargeError, limitedJson } from "@/lib/request-body";

const MAX_LABEL_LENGTH = 40;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const rateLimited = rateLimiter(120, 60 * 60 * 1000);

function error(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

/** Resolves the caller's subscription from the X-Push-Endpoint / X-Push-Auth headers. */
async function subscriber(request: Request) {
  if (!alertsConfigured) return { response: error(503, "Alerts aren't available right now.") };
  if (rateLimited(request)) return { response: error(429, "Too many requests.") };
  const creds = credentialsFrom(request);
  if (!creds) return { response: error(400, "Missing push credentials.") };
  const sub = await findSubscription(creds);
  if (!sub) return { response: error(404, "Alerts aren't turned on for this device.") };
  return { sub };
}

/** The subscriber's alert places, including their last shared position. */
export async function GET(request: Request) {
  try {
    const { sub, response } = await subscriber(request);
    if (!sub) return response;
    return Response.json({ places: await listPlaces(sub.id), minLevel: sub.minLevel, maxSaved: MAX_SAVED_PLACES });
  } catch (err) {
    console.error("Listing alert places failed", err);
    return error(502, "Couldn't load your alert places.");
  }
}

/** Pins a place: `{ label, latitude, longitude }`. */
export async function POST(request: Request) {
  try {
    const { sub, response } = await subscriber(request);
    if (!sub) return response;
    const body = (await limitedJson(request)) as { label?: unknown; latitude?: unknown; longitude?: unknown } | null;
    const at = parseCoord(body?.latitude, body?.longitude);
    const label = typeof body?.label === "string" ? body.label.trim() : "";
    if (!at) return error(400, "A valid location is required.");
    if (!label || label.length > MAX_LABEL_LENGTH) return error(400, `Name the place (up to ${MAX_LABEL_LENGTH} characters).`);
    const refused = await addPlace(sub.id, label, at.latitude, at.longitude);
    if (refused) return error(409, refused);
    return Response.json({ places: await listPlaces(sub.id) }, { status: 201 });
  } catch (err) {
    if (err instanceof BodyTooLargeError) return error(413, "The place request is too large.");
    if (err instanceof SyntaxError) return error(400, "Expected a JSON place.");
    console.error("Saving alert place failed", err);
    return error(502, "Couldn't save this place.");
  }
}

/** Removes a pinned place: `?id=`. */
export async function DELETE(request: Request) {
  try {
    const { sub, response } = await subscriber(request);
    if (!sub) return response;
    const id = new URL(request.url).searchParams.get("id") ?? "";
    if (!UUID.test(id)) return error(400, "Unknown place.");
    await removePlace(sub.id, id);
    return Response.json({ places: await listPlaces(sub.id) });
  } catch (err) {
    console.error("Removing alert place failed", err);
    return error(502, "Couldn't remove this place.");
  }
}
