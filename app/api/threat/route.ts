import { parseLatLng } from "@/lib/geo";
import { rateLimiter } from "@/lib/rate-limit";
import { assessThreat } from "@/lib/threat";

// Each uncached call costs a Gemma request, so cap it per client.
const rateLimited = rateLimiter(60, 60 * 60 * 1000);

/** Flood threat estimate around `?lat=&lng=`: level, affected bounding box and explanation. */
export async function GET(request: Request) {
  if (rateLimited(request)) return Response.json({ error: "Too many requests." }, { status: 429 });
  const at = parseLatLng(new URL(request.url).searchParams);
  if (!at) return Response.json({ error: "lat and lng are required." }, { status: 400 });
  try {
    return Response.json(await assessThreat(at.latitude, at.longitude));
  } catch (err) {
    console.error("Threat assessment failed", err);
    return Response.json({ error: "Couldn't assess the flood threat right now." }, { status: 502 });
  }
}
