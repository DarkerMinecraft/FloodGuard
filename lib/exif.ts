import "server-only";

import exifr from "exifr";

/** takenAt is the camera's local wall-clock time, "YYYY-MM-DDTHH:MM:SS" with no zone (EXIF rarely records one). */
export type ExifLocation = { latitude: number; longitude: number; takenAt: string | null };

const pad = (n: number) => String(n).padStart(2, "0");
// exifr parses EXIF dates as local time in this process, so local getters give back the camera's own reading.
function wallClock(d: unknown): string | null {
  if (!(d instanceof Date) || Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

/**
 * GPS position (and capture time, as written by the camera) from an image's EXIF; null
 * without usable GPS. The client re-embeds these after resizing, so they survive upload.
 */
export async function readExifLocation(data: Uint8Array): Promise<ExifLocation | null> {
  try {
    const exif = await exifr.parse(Buffer.from(data), {
      gps: true,
      // Raw GPS tags: exifr derives latitude/longitude from them.
      pick: ["GPSLatitude", "GPSLatitudeRef", "GPSLongitude", "GPSLongitudeRef", "DateTimeOriginal"],
    });
    const { latitude, longitude } = exif ?? {};
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) return null;
    return { latitude, longitude, takenAt: wallClock(exif.DateTimeOriginal) };
  } catch {
    return null;
  }
}
