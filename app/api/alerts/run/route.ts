import { timingSafeEqual } from "node:crypto";
import { alertsConfigured, runAlertCheck } from "@/lib/alerts";

/**
 * Runs the alert check now. The server also runs it on a timer (instrumentation.ts);
 * this is for an external scheduler when there are several instances, so the timer
 * can be turned off with ALERT_CHECK_INTERVAL_MINUTES=0. Needs `Authorization: Bearer <ALERT_CRON_SECRET>`.
 */
export async function POST(request: Request) {
  const secret = process.env.ALERT_CRON_SECRET;
  const given = Buffer.from(request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "");
  const expected = Buffer.from(secret ?? "");
  if (!secret || given.length !== expected.length || !timingSafeEqual(given, expected)) {
    return new Response("Unauthorized", { status: 401 });
  }
  if (!alertsConfigured) return Response.json({ error: "Alerts aren't configured." }, { status: 503 });
  try {
    await runAlertCheck();
    return new Response(null, { status: 204 });
  } catch (err) {
    console.error("Alert check failed", err);
    return Response.json({ error: "Alert check failed." }, { status: 502 });
  }
}
