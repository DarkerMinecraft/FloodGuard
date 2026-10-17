import "server-only";

import { DefaultAzureCredential } from "@azure/identity";
import { BlobServiceClient, type ContainerClient } from "@azure/storage-blob";
import type { ModerationStatus } from "@/lib/moderation";

// Auth is Entra ID only (shared-key access is disabled on the account):
// locally DefaultAzureCredential uses your `az login`; in Azure, give the app a
// managed identity with the "Storage Blob Data Contributor" role on the account.
const ACCOUNT_URL = process.env.AZURE_STORAGE_ACCOUNT_URL;
const CONTAINER = process.env.AZURE_STORAGE_CONTAINER ?? "flood-reports";

let container: ContainerClient | null = null;

function getContainer(): ContainerClient {
  if (!ACCOUNT_URL) throw new Error("AZURE_STORAGE_ACCOUNT_URL is not set");
  // One client per server process; the SDK reuses connections and caches tokens.
  container ??= new BlobServiceClient(ACCOUNT_URL, new DefaultAzureCredential(), {
    retryOptions: { maxTries: 3, retryDelayInMs: 500, maxRetryDelayInMs: 4000 },
  }).getContainerClient(CONTAINER);
  return container;
}

export type ReportPhoto = {
  data: Uint8Array;
  contentType: string;
  extension: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  /** "photo": placed by the image's EXIF GPS; "device": the submitter's current location. */
  locationSource: "photo" | "device";
  /** Camera wall-clock capture time from EXIF, if any. */
  takenAt: string | null;
  note: string;
  moderation: { status: ModerationStatus; reason: string };
};

// Blob metadata must be ASCII, so free text is URI-encoded.
const encodeMeta = (text: string) => encodeURIComponent(text);
function decodeMeta(value: string | undefined): string {
  try {
    return value ? decodeURIComponent(value) : "";
  } catch {
    return ""; // malformed encoding
  }
}

function moderationOf(meta: Record<string, string>): ModerationStatus {
  // Reports from before moderation existed have no status: treat them as unchecked.
  return meta.moderation === "approved" || meta.moderation === "rejected" ? meta.moderation : "pending";
}

/**
 * Stores a flood report photo under `pending/<date>/<id>.<ext>` so it can be
 * reviewed before anything is shown publicly. The container is private.
 */
export async function uploadReportPhoto(photo: ReportPhoto): Promise<{ id: string; blobName: string }> {
  const id = crypto.randomUUID();
  const now = new Date();
  const blobName = `pending/${now.toISOString().slice(0, 10)}/${id}.${photo.extension}`;

  await getContainer()
    .getBlockBlobClient(blobName)
    .uploadData(photo.data, {
      blobHTTPHeaders: { blobContentType: photo.contentType },
      metadata: {
        latitude: photo.latitude.toFixed(6),
        longitude: photo.longitude.toFixed(6),
        ...(photo.accuracy !== null && { accuracy: Math.round(photo.accuracy).toString() }),
        ...(photo.note && { note: encodeMeta(photo.note) }),
        submittedat: now.toISOString(),
        locationsource: photo.locationSource,
        ...(photo.takenAt && { takenat: photo.takenAt }),
        moderation: photo.moderation.status,
        moderationreason: encodeMeta(photo.moderation.reason),
      },
      // Never overwrite an existing blob.
      conditions: { ifNoneMatch: "*" },
    });

  return { id, blobName };
}

export type StoredReport = {
  /** `<YYYY-MM-DD>/<uuid>.<ext>`, used in photo URLs. */
  key: string;
  latitude: number;
  longitude: number;
  accuracy: number | null;
  note: string;
  submittedAt: string;
  locationSource: "photo" | "device";
  takenAt: string | null;
  moderation: ModerationStatus;
};

const KEY_PATTERN = /^\d{4}-\d{2}-\d{2}\/[0-9a-f-]{36}\.(jpg|png|webp)$/;

export function isReportKey(key: string): boolean {
  return KEY_PATTERN.test(key);
}

/**
 * Reports submitted in roughly the last `days` days (UTC date folders; null = all), newest first,
 * whatever their moderation status. Everything lives under `pending/` (the original
 * layout); visibility is decided by the `moderation` metadata, not the folder.
 */
export async function listRecentReports(days: number | null = 2): Promise<StoredReport[]> {
  const reports: StoredReport[] = [];
  const prefixes =
    days === null
      ? ["pending/"]
      : Array.from({ length: days + 1 }, (_, i) => `pending/${new Date(Date.now() - i * 86_400_000).toISOString().slice(0, 10)}/`);
  for (const prefix of prefixes) {
    for await (const blob of getContainer().listBlobsFlat({ prefix, includeMetadata: true })) {
      if (!isReportKey(blob.name.slice("pending/".length))) continue;
      const meta = blob.metadata ?? {};
      const latitude = Number(meta.latitude);
      const longitude = Number(meta.longitude);
      if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) continue;
      reports.push({
        key: blob.name.slice("pending/".length),
        latitude,
        longitude,
        accuracy: meta.accuracy ? Number(meta.accuracy) : null,
        note: decodeMeta(meta.note),
        submittedAt: meta.submittedat ?? blob.properties.createdOn?.toISOString() ?? "",
        locationSource: meta.locationsource === "photo" ? "photo" : "device",
        takenAt: meta.takenat ?? null,
        moderation: moderationOf(meta),
      });
    }
  }
  return reports.sort((a, b) => b.submittedAt.localeCompare(a.submittedAt));
}

/** Downloads a report photo and its moderation status; null if it doesn't exist. */
export async function downloadReportPhoto(
  key: string,
): Promise<{ data: Buffer; contentType: string; moderation: ModerationStatus; note: string } | null> {
  if (!isReportKey(key)) return null;
  const blob = getContainer().getBlockBlobClient(`pending/${key}`);
  try {
    const props = await blob.getProperties();
    return {
      data: await blob.downloadToBuffer(),
      contentType: props.contentType ?? "image/jpeg",
      moderation: moderationOf(props.metadata ?? {}),
      note: decodeMeta(props.metadata?.note),
    };
  } catch (err) {
    if ((err as { statusCode?: number }).statusCode === 404) return null;
    throw err;
  }
}

/** Records a (re-)moderation result, keeping the rest of the report's metadata. */
export async function setReportModeration(key: string, status: ModerationStatus, reason: string, note: string): Promise<void> {
  if (!isReportKey(key)) throw new Error(`Invalid report key: ${key}`);
  const blob = getContainer().getBlockBlobClient(`pending/${key}`);
  const props = await blob.getProperties();
  const metadata: Record<string, string> = { ...props.metadata, moderation: status, moderationreason: encodeMeta(reason.slice(0, 200)) };
  if (note) metadata.note = encodeMeta(note);
  else delete metadata.note;
  // ifMatch: don't clobber a concurrent update.
  await blob.setMetadata(metadata, { conditions: { ifMatch: props.etag } });
}
