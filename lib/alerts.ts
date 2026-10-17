import "server-only";

import webpush from "web-push";
import { db, dbConfigured, isUniqueViolation } from "@/lib/db";
import type { AlertLevel } from "@/lib/generated/prisma/client";
import { distanceKm } from "@/lib/geo";
import { isPushEndpoint, isPushSubscription } from "@/lib/push-validation";
import { assessThreat, THREAT_LEVELS, type ThreatLevel } from "@/lib/threat";

// Push alerts for people who chose to share their location permanently: their last
// known position (updated whenever the app is open) and any places they pinned are
// checked on a schedule, and a Web Push notification goes out when flood risk at a
// place reaches their threshold or a new flood report appears close by, even while
// the app is closed.

export type { AlertLevel };
export const ALERT_LEVELS: AlertLevel[] = ["low", "moderate", "high", "severe"];

/** New reports closer than this to a place trigger an alert. */
export const REPORT_ALERT_RADIUS_KM = 5;
/** Only reports this recent are announced (older ones were already on the map). */
const REPORT_ALERT_WINDOW_MS = 6 * 3_600_000;
/** A still-elevated threat is announced again after this long. */
const THREAT_REMIND_MS = 12 * 3_600_000;
/** A last position not refreshed in this long is no longer checked. */
const LAST_PLACE_MAX_AGE_MS = 14 * 86_400_000;
export const MAX_SAVED_PLACES = 5;

const VAPID_PUBLIC = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const VAPID_PRIVATE = process.env.VAPID_PRIVATE_KEY;

export const alertsConfigured = dbConfigured && Boolean(VAPID_PUBLIC && VAPID_PRIVATE);

if (alertsConfigured) {
  webpush.setVapidDetails(process.env.VAPID_SUBJECT || "mailto:alerts@floodguard.app", VAPID_PUBLIC!, VAPID_PRIVATE!);
}

const rank = (level: string | null) => (level ? THREAT_LEVELS.indexOf(level as ThreatLevel) : -1);
/** ~1 km cells, matching the threat cache: moving within one keeps what was announced. */
const sameCell = (a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) =>
  a.latitude.toFixed(2) === b.latitude.toFixed(2) && a.longitude.toFixed(2) === b.longitude.toFixed(2);

// ---------------------------------------------------------------------------
// Subscriptions and places

export type PushCredentials = { endpoint: string; auth: string };

export type AlertPlace = {
  id: string;
  kind: "last" | "saved";
  label: string;
  latitude: number;
  longitude: number;
  updatedAt: string;
};

export async function upsertSubscription(
  sub: { endpoint: string; keys: { p256dh: string; auth: string } },
  minLevel: AlertLevel,
): Promise<boolean> {
  if (!isPushSubscription(sub)) throw new Error("Invalid push subscription");
  const data = { p256dh: sub.keys.p256dh, minLevel, lastSeenAt: new Date() };
  try {
    await db().pushSubscription.create({ data: { endpoint: sub.endpoint, auth: sub.keys.auth, ...data } });
    return true;
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
  }
  // The auth secret proves ownership. An endpoint alone must never let a caller
  // replace credentials and read the subscriber's saved locations. updateMany
  // checks ownership atomically, including races between first registrations.
  const { count } = await db().pushSubscription.updateMany({
    where: { endpoint: sub.endpoint, auth: sub.keys.auth },
    data,
  });
  return count > 0;
}

/** The subscription when the endpoint and its auth secret match; null otherwise. */
export async function findSubscription(creds: PushCredentials): Promise<{ id: string; minLevel: AlertLevel } | null> {
  const sub = await db().pushSubscription.findUnique({ where: { endpoint: creds.endpoint } });
  if (!sub || sub.auth !== creds.auth) return null;
  await db().pushSubscription.update({ where: { id: sub.id }, data: { lastSeenAt: new Date() } });
  return { id: sub.id, minLevel: sub.minLevel };
}

export async function deleteSubscription(creds: PushCredentials): Promise<void> {
  await db().pushSubscription.deleteMany({ where: { endpoint: creds.endpoint, auth: creds.auth } });
}

const lastKey = (subscriptionId: string) => ({
  subscriptionId_kind_label: { subscriptionId, kind: "last" as const, label: "" },
});

/** Records where the subscriber is now. Moving to another cell resets what was announced. */
export async function setLastLocation(subscriptionId: string, latitude: number, longitude: number): Promise<void> {
  const prev = await db().alertPlace.findUnique({ where: lastKey(subscriptionId) });
  const moved = prev && !sameCell(prev, { latitude, longitude });
  await db().alertPlace.upsert({
    where: lastKey(subscriptionId),
    create: { subscriptionId, kind: "last", label: "", latitude, longitude },
    update: { latitude, longitude, locatedAt: new Date(), ...(moved && { notifiedLevel: null, notifiedAt: null }) },
  });
}

export async function clearLastLocation(subscriptionId: string): Promise<void> {
  await db().alertPlace.deleteMany({ where: { subscriptionId, kind: "last" } });
}

export async function listPlaces(subscriptionId: string): Promise<AlertPlace[]> {
  const rows = await db().alertPlace.findMany({
    where: { subscriptionId },
    orderBy: [{ kind: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    label: r.label,
    latitude: r.latitude,
    longitude: r.longitude,
    updatedAt: r.locatedAt.toISOString(),
  }));
}

/** Pins a place; returns an error message when it can't. */
export async function addPlace(subscriptionId: string, label: string, latitude: number, longitude: number): Promise<string | null> {
  try {
    return await db().$transaction(async (tx) => {
      // Serialize count + insert per subscription across all server instances.
      await tx.$queryRaw`SELECT id FROM push_subscriptions WHERE id = ${subscriptionId}::uuid FOR UPDATE`;
      const saved = await tx.alertPlace.count({ where: { subscriptionId, kind: "saved" } });
      if (saved >= MAX_SAVED_PLACES) return `You can save up to ${MAX_SAVED_PLACES} places.`;
      await tx.alertPlace.create({ data: { subscriptionId, kind: "saved", label, latitude, longitude } });
      return null;
    });
  } catch (err) {
    if (isUniqueViolation(err)) return `You already have a place called “${label}”.`;
    throw err;
  }
}

export async function removePlace(subscriptionId: string, placeId: string): Promise<void> {
  await db().alertPlace.deleteMany({ where: { id: placeId, subscriptionId, kind: "saved" } });
}

// ---------------------------------------------------------------------------
// Checks

type Place = Awaited<ReturnType<typeof loadPlaces>>[number];

function loadPlaces() {
  return db().alertPlace.findMany({
    where: { OR: [{ kind: "saved" }, { locatedAt: { gt: new Date(Date.now() - LAST_PLACE_MAX_AGE_MS) } }] },
    include: { subscription: true },
  });
}

const where = (p: Place) => (p.kind === "last" ? "near you" : `near ${p.label}`);
/** A place/subscription can be deleted after the check's snapshot was loaded. */
const disappeared = (err: unknown) => ["P2003", "P2025"].includes((err as { code?: string } | null)?.code ?? "");

let running: Promise<void> | null = null;

/** Full check: threat levels and new reports at every place. Overlapping calls share one run. */
export function runAlertCheck(): Promise<void> {
  if (!alertsConfigured) return Promise.resolve();
  running ??= (async () => {
    const started = Date.now();
    const places = await loadPlaces();
    const expired = new Set<string>();
    await checkThreats(places, expired);
    await checkReports(places, expired);
    console.info(`Alert check: ${places.length} places, ${expired.size} expired subscriptions, ${Date.now() - started} ms`);
  })().finally(() => (running = null));
  return running;
}

/** Only the new-report check; run right after a report is approved. */
export async function checkNewReportAlerts(): Promise<void> {
  if (!alertsConfigured) return;
  await checkReports(await loadPlaces());
}

async function checkThreats(places: Place[], expired: Set<string>) {
  // assessThreat caches per ~1 km cell, so places in the same cell share one assessment.
  for (const place of places) {
    if (expired.has(place.subscription.id)) continue;
    try {
      let level: ThreatLevel, headline: string;
      try {
        ({ level, headline } = await assessThreat(place.latitude, place.longitude));
      } catch (err) {
        console.error(`Threat check failed for place ${place.id}`, err);
        continue;
      }

      if (level === "none" || rank(level) < rank(place.subscription.minLevel)) {
        // Back below the threshold: forget it, so a new rise is announced again.
        if (place.notifiedLevel) {
          await db().alertPlace.update({ where: { id: place.id }, data: { notifiedLevel: null, notifiedAt: null } });
        }
        continue;
      }
      const rose = rank(level) > rank(place.notifiedLevel);
      const stale = !place.notifiedAt || Date.now() - place.notifiedAt.getTime() > THREAT_REMIND_MS;
      if (!rose && !stale) continue;

      const label = level[0].toUpperCase() + level.slice(1);
      const sent = await send(place, {
        title: `${label} flood risk ${where(place)}`,
        body: headline,
        tag: `threat-${place.id}`,
        url: `/?lat=${place.latitude.toFixed(4)}&lng=${place.longitude.toFixed(4)}`,
      }, expired);
      if (sent) {
        const now = new Date();
        await db().alertPlace.update({ where: { id: place.id }, data: { notifiedLevel: level, notifiedAt: now } });
        await db().alertSent.create({ data: { placeId: place.id, kind: "threat", ref: `${level}:${now.toISOString()}` } });
      }
    } catch (err) {
      if (!disappeared(err)) throw err;
    }
  }
}

async function checkReports(places: Place[], expired = new Set<string>()) {
  if (!places.length) return;
  const reports = await db().report.findMany({
    where: { moderation: "approved", submittedAt: { gt: new Date(Date.now() - REPORT_ALERT_WINDOW_MS) } },
    select: { id: true, latitude: true, longitude: true, note: true },
  });
  if (!reports.length) return;

  for (const place of places) {
    if (expired.has(place.subscription.id)) continue;
    try {
      const near = reports
        .map((r) => ({ ...r, km: distanceKm(place.latitude, place.longitude, r.latitude, r.longitude) }))
        .filter((r) => r.km <= REPORT_ALERT_RADIUS_KM);
      if (!near.length) continue;

      // Claim each report for this place first; only ones not announced before are new.
      const fresh: typeof near = [];
      for (const r of near) {
        const { count } = await db().alertSent.createMany({
          data: [{ placeId: place.id, kind: "report", ref: r.id }],
          skipDuplicates: true,
        });
        if (count) fresh.push(r);
      }
      if (!fresh.length) continue;

      const nearest = fresh.sort((a, b) => a.km - b.km)[0];
      const km = nearest.km < 1 ? "under 1 km" : `${nearest.km.toFixed(1)} km`;
      const sent = await send(place, {
        title: fresh.length === 1 ? `Flooding reported ${where(place)}` : `${fresh.length} flood reports ${where(place)}`,
        body: `${nearest.note || "A photo of flooding was shared"} (${km} away).`,
        tag: `reports-${place.id}`,
        url: `/?lat=${nearest.latitude.toFixed(4)}&lng=${nearest.longitude.toFixed(4)}`,
      }, expired);
      if (!sent) {
        // A transient provider failure must not permanently consume these reports.
        await db().alertSent.deleteMany({
          where: { placeId: place.id, kind: "report", ref: { in: fresh.map((r) => r.id) } },
        });
      }
    } catch (err) {
      if (!disappeared(err)) throw err;
    }
  }
}

/** Sends one notification; removes subscriptions the push service says are gone. */
async function send(place: Place, payload: { title: string; body: string; tag: string; url: string }, expired: Set<string>): Promise<boolean> {
  const { subscription: sub } = place;
  // Recheck old database rows too; they may predate registration validation.
  if (!isPushSubscription({ endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } })) {
    console.error(`Invalid push subscription ${sub.id}; notification skipped`);
    return false;
  }
  try {
    await webpush.sendNotification(
      { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
      JSON.stringify(payload),
      { TTL: 6 * 3600, urgency: "high", timeout: 10_000 },
    );
    return true;
  } catch (err) {
    const status = (err as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) {
      expired.add(sub.id);
      await db().pushSubscription.deleteMany({ where: { id: sub.id } });
    } else {
      console.error(`Push to subscription ${sub.id} failed`, err);
    }
    return false;
  }
}

// ---------------------------------------------------------------------------
// Request helpers shared by the alert routes

export function credentialsFrom(request: Request): PushCredentials | null {
  const endpoint = request.headers.get("x-push-endpoint");
  const auth = request.headers.get("x-push-auth");
  if (!isPushEndpoint(endpoint) || !auth || auth.length > 200) return null;
  return { endpoint, auth };
}

export function parseCoord(lat: unknown, lng: unknown): { latitude: number; longitude: number } | null {
  if (typeof lat !== "number" || typeof lng !== "number") return null;
  if (!Number.isFinite(lat) || Math.abs(lat) > 90 || !Number.isFinite(lng) || Math.abs(lng) > 180) return null;
  return { latitude: lat, longitude: lng };
}
