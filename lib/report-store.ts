import "server-only";

import * as blobs from "@/lib/azure-storage";
import type { ReportPhoto, StoredReport } from "@/lib/azure-storage";
import { db, dbConfigured } from "@/lib/db";
import { Prisma, type Report } from "@/lib/generated/prisma/client";
import { parsePhotoAnalysis, type ModerationStatus, type PhotoAnalysis } from "@/lib/moderation";

// Report records. Photos always live in Blob Storage; with Postgres configured the
// report details are also kept there and read from there (fast filtered queries
// instead of listing blobs). Blob metadata stays in sync so the photo route and
// a blob-only setup keep working.

export type { StoredReport };

const fromRow = (r: Report): StoredReport => ({
  key: r.photoKey,
  latitude: r.latitude,
  longitude: r.longitude,
  accuracy: r.accuracy,
  note: r.note,
  submittedAt: r.submittedAt.toISOString(),
  locationSource: r.locationSource,
  takenAt: r.takenAt,
  moderation: r.moderation,
  analysis: parsePhotoAnalysis(r.photoAnalysis),
});

const idOf = (key: string) => key.split("/")[1].split(".")[0];

/** Stores the photo, then its record. */
export async function saveReport(photo: ReportPhoto): Promise<{ id: string; key: string }> {
  // Backfill before uploading: otherwise the first upload imports itself and the
  // following insert fails with a duplicate ID.
  if (dbConfigured) await ready();
  const { id, blobName } = await blobs.uploadReportPhoto(photo);
  const key = blobName.slice("pending/".length);
  if (dbConfigured) {
    // Another instance may import this blob during its own first-use backfill.
    await db().report.upsert({
      where: { id },
      update: {},
      create: {
        id,
        photoKey: key,
        latitude: photo.latitude,
        longitude: photo.longitude,
        accuracy: photo.accuracy,
        note: photo.note,
        submittedAt: new Date(),
        locationSource: photo.locationSource,
        takenAt: photo.takenAt,
        moderation: photo.moderation.status,
        moderationReason: photo.moderation.reason.slice(0, 200),
        ...(photo.analysis && { photoAnalysis: photo.analysis }),
      },
    });
  }
  return { id, key };
}

/** Reports from roughly the last `days` days (null = all), newest first, whatever their moderation status. */
export async function listRecentReports(days: number | null): Promise<StoredReport[]> {
  if (!dbConfigured) return blobs.listRecentReports(days);
  await ready();
  const rows = await db().report.findMany({
    where: days === null ? {} : { submittedAt: { gte: new Date(Date.now() - (days + 1) * 86_400_000) } },
    orderBy: { submittedAt: "desc" },
  });
  return rows.map(fromRow);
}

/** Records a (re-)moderation result in both places. */
export async function setReportModeration(
  key: string,
  status: ModerationStatus,
  reason: string,
  note: string,
  analysis: PhotoAnalysis | null,
): Promise<void> {
  await blobs.setReportModeration(key, status, reason, note, analysis);
  if (dbConfigured) {
    await ready();
    await db().report.updateMany({
      where: { photoKey: key },
      data: { moderation: status, moderationReason: reason.slice(0, 200), note, photoAnalysis: analysis ?? Prisma.DbNull },
    });
  }
}

// ---------------------------------------------------------------------------
// Reports stored before Postgres was set up are imported once, the first time the
// table is used while empty.
let imported: Promise<void> | null = null;

function ready(): Promise<void> {
  imported ??= backfillReportsFromBlobs();
  // Don't cache a failure (e.g. the server was briefly unreachable).
  imported.catch(() => (imported = null));
  return imported;
}

async function backfillReportsFromBlobs(): Promise<void> {
  if (!process.env.AZURE_STORAGE_ACCOUNT_URL || (await db().report.count()) > 0) return;
  const existing = await blobs.listRecentReports(null);
  if (!existing.length) return;
  const { count } = await db().report.createMany({
    data: existing.map((r) => ({
      id: idOf(r.key),
      photoKey: r.key,
      latitude: r.latitude,
      longitude: r.longitude,
      accuracy: r.accuracy,
      note: r.note,
      submittedAt: new Date(r.submittedAt),
      locationSource: r.locationSource,
      takenAt: r.takenAt,
      moderation: r.moderation,
      ...(r.analysis && { photoAnalysis: r.analysis }),
    })),
    skipDuplicates: true,
  });
  console.info(`Imported ${count} existing reports into Postgres`);
}
