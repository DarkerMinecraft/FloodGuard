import { after } from "next/server";
import { checkNewReportAlerts } from "@/lib/alerts";
import { readExifLocation } from "@/lib/exif";
import { parseLatLng } from "@/lib/geo";
import { moderateReport } from "@/lib/moderation";
import { rateLimiter } from "@/lib/rate-limit";
import { BodyTooLargeError, limitedFormData } from "@/lib/request-body";
import { saveReport } from "@/lib/report-store";
import { invalidateReports, nearbyReports, REPORT_MAX_AGE_HOURS } from "@/lib/reports";
import { invalidateThreats } from "@/lib/threat";

// The client downsizes photos to ~2048px JPEGs, so real uploads are well under this.
const MAX_BYTES = 8 * 1024 * 1024;
const MAX_NOTE_LENGTH = 500;

const rateLimited = rateLimiter(10, 60 * 60 * 1000);

/** Identify the format from the file's first bytes; the declared type can't be trusted. */
function sniffImage(bytes: Uint8Array): { contentType: string; extension: string } | null {
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { contentType: "image/jpeg", extension: "jpg" };
  }
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) {
    return { contentType: "image/png", extension: "png" };
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to));
  if (ascii(0, 4) === "RIFF" && ascii(8, 12) === "WEBP") {
    return { contentType: "image/webp", extension: "webp" };
  }
  return null;
}

function error(status: number, message: string) {
  return Response.json({ error: message }, { status });
}

/** Accepts a flood report: multipart form with `photo`, `latitude`, `longitude`, optional `accuracy` and `note`. */
export async function POST(request: Request) {
  if (rateLimited(request)) return error(429, "Too many reports. Please try again later.");

  let form: FormData;
  try {
    form = await limitedFormData(request, MAX_BYTES + 64 * 1024);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return error(413, "Photo is too large.");
    return error(400, "Expected a multipart form.");
  }

  const photo = form.get("photo");
  if (!(photo instanceof File) || photo.size === 0) return error(400, "Add a photo.");
  if (photo.size > MAX_BYTES) return error(413, "Photo is too large.");

  const note = String(form.get("note") ?? "").trim();
  if (note.length > MAX_NOTE_LENGTH) return error(400, `Keep the note under ${MAX_NOTE_LENGTH} characters.`);

  const data = new Uint8Array(await photo.arrayBuffer());
  const format = sniffImage(data);
  if (!format) return error(415, "Only JPEG, PNG or WebP photos are accepted.");

  // The photo's own GPS (kept in the uploaded file's EXIF) places the report when the
  // client asks for it; read from the bytes so the stored image and location always agree.
  const exif = await readExifLocation(data);
  const locationSource = form.get("locationSource") === "photo" ? "photo" : "device";
  let latitude: number, longitude: number, accuracy: number | null;
  if (locationSource === "photo") {
    if (!exif) return error(400, "This photo has no location data. Turn on location to use your current position.");
    ({ latitude, longitude } = exif);
    accuracy = null;
  } else {
    const lat = form.get("latitude");
    const lng = form.get("longitude");
    latitude = Number(lat);
    longitude = Number(lng);
    if (
      typeof lat !== "string" || lat.trim() === "" || !Number.isFinite(latitude) || Math.abs(latitude) > 90 ||
      typeof lng !== "string" || lng.trim() === "" || !Number.isFinite(longitude) || Math.abs(longitude) > 180
    ) {
      return error(400, "A valid location is required.");
    }
    const accuracyRaw = Number(form.get("accuracy"));
    accuracy = form.get("accuracy") !== null && Number.isFinite(accuracyRaw) && accuracyRaw >= 0 ? accuracyRaw : null;
  }

  // AI check before anything is stored: rejected photos never reach storage.
  const moderation = await moderateReport({ data, contentType: format.contentType, note });
  if (moderation.status === "rejected") {
    console.info("Report rejected by moderation:", moderation.reason);
    return error(422, moderation.userMessage ?? "This photo can't be posted.");
  }

  try {
    const { id } = await saveReport({
      data,
      ...format,
      latitude,
      longitude,
      accuracy,
      locationSource,
      takenAt: exif?.takenAt ?? null,
      note: moderation.note,
      moderation: { status: moderation.status, reason: moderation.reason },
      analysis: moderation.analysis,
    });
    if (moderation.status === "approved") {
      invalidateReports();
      invalidateThreats();
      // Warn subscribers near this report right away instead of waiting for the next scheduled check.
      after(() => checkNewReportAlerts().catch((err) => console.error("Report alerts failed", err)));
    }
    // "pending" means the AI check couldn't run; the report stays hidden until re-screened.
    return Response.json({ id, status: moderation.status, latitude, longitude, locationSource }, { status: 201 });
  } catch (err) {
    console.error("Flood report upload failed", err);
    return error(502, "Couldn't save your report. Please try again.");
  }
}

/** Recent reports near `?lat=&lng=`. */
export async function GET(request: Request) {
  const at = parseLatLng(new URL(request.url).searchParams);
  if (!at) return error(400, "lat and lng are required.");
  try {
    return Response.json({ reports: await nearbyReports(at.latitude, at.longitude), maxAgeHours: REPORT_MAX_AGE_HOURS });
  } catch (err) {
    console.error("Listing reports failed", err);
    return error(502, "Couldn't load reports.");
  }
}
