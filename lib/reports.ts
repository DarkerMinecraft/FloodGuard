import "server-only";

import { downloadReportPhoto } from "@/lib/azure-storage";
import { PHOTOS_ONLY } from "@/lib/config";
import { distanceKm } from "@/lib/geo";
import { moderateReport } from "@/lib/moderation";
import { listRecentReports, setReportModeration, type StoredReport } from "@/lib/report-store";

export const NEARBY_RADIUS_KM = 25;
/** Reports older than this are hidden; null in photos-only mode, where they never age out. */
export const REPORT_MAX_AGE_HOURS = PHOTOS_ONLY ? null : 48;

export type NearbyReport = Omit<StoredReport, "key" | "moderation"> & {
  id: string;
  photoUrl: string;
  distanceKm: number;
};

// Listing reports on every map view would be slow; a short-lived snapshot is plenty.
let snapshot: { at: number; reports: Promise<StoredReport[]> } | null = null;
const SNAPSHOT_MS = 30_000;

export function invalidateReports() {
  snapshot = null;
}

/** Approved reports within NEARBY_RADIUS_KM (and REPORT_MAX_AGE_HOURS), newest first. */
export async function nearbyReports(latitude: number, longitude: number, limit = 20): Promise<NearbyReport[]> {
  if (!snapshot || Date.now() - snapshot.at > SNAPSHOT_MS) {
    const reports = listRecentReports(REPORT_MAX_AGE_HOURS === null ? null : Math.ceil(REPORT_MAX_AGE_HOURS / 24));
    snapshot = { at: Date.now(), reports };
    // Don't cache a failure.
    reports.catch(() => snapshot?.reports === reports && (snapshot = null));
    reports.then(rescreenPending, () => {});
  }
  const cutoff = REPORT_MAX_AGE_HOURS === null ? -Infinity : Date.now() - REPORT_MAX_AGE_HOURS * 3_600_000;

  return (await snapshot.reports)
    .filter((r) => r.moderation === "approved" && Date.parse(r.submittedAt) >= cutoff)
    .map((r) => ({
      latitude: r.latitude,
      longitude: r.longitude,
      accuracy: r.accuracy,
      note: r.note,
      submittedAt: r.submittedAt,
      locationSource: r.locationSource,
      takenAt: r.takenAt,
      analysis: r.analysis,
      id: r.key.split("/")[1].split(".")[0],
      photoUrl: `/api/reports/photo/${r.key}`,
      distanceKm: Math.round(distanceKm(latitude, longitude, r.latitude, r.longitude) * 10) / 10,
    }))
    .filter((r) => r.distanceKm <= NEARBY_RADIUS_KM)
    .slice(0, limit);
}

// ---------------------------------------------------------------------------
// Re-screening: reports stored while the AI check was down (or before moderation
// existed) are "pending" and hidden, and approved reports from before Gemini photo
// analysis have no findings. Each listing refresh checks a few of them in the
// background, so they appear (or stay hidden) without anyone reviewing by hand.
const RESCREEN_BATCH = 3;
const inFlight = new Set<string>();

async function rescreenPending(reports: StoredReport[]) {
  const needsCheck = (r: StoredReport) => r.moderation === "pending" || (r.moderation === "approved" && !r.analysis);
  // Hidden reports first: they're invisible until checked.
  const batch = reports
    .filter((r) => needsCheck(r) && !inFlight.has(r.key))
    .sort((a, b) => Number(b.moderation === "pending") - Number(a.moderation === "pending"))
    .slice(0, RESCREEN_BATCH);
  if (!batch.length) return;

  let changed = false;
  for (const report of batch) {
    inFlight.add(report.key);
    try {
      const photo = await downloadReportPhoto(report.key);
      if (!photo || photo.moderation === "rejected") continue;
      const result = await moderateReport({ data: photo.data, contentType: photo.contentType, note: photo.note });
      if (result.status === "pending") break; // AI still unavailable; try again on a later refresh
      await setReportModeration(report.key, result.status, result.reason, result.note, result.analysis);
      console.info(`Re-screened report ${report.key}: ${result.status} (${result.reason})`);
      changed = true;
    } catch (err) {
      console.error(`Re-screening ${report.key} failed`, err);
    } finally {
      inFlight.delete(report.key);
    }
  }
  if (changed) invalidateReports();
}
