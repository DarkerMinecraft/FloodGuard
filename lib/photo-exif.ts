"use client";

// Location metadata for report photos. Resizing through a canvas drops all EXIF, so we
// read GPS + capture time from the original first and write just those back into the
// resized JPEG. Other EXIF (camera serials, software, thumbnails) is intentionally
// left out.

export type PhotoMeta = {
  latitude: number;
  longitude: number;
  altitude: number | null;
  takenAt: Date | null;
} | null;

const GPS_TAGS = ["GPSLatitude", "GPSLatitudeRef", "GPSLongitude", "GPSLongitudeRef"];

/** GPS position and capture time from a photo's EXIF (JPEG, HEIC, PNG, WebP); null without GPS. */
export async function readPhotoMeta(file: Blob): Promise<PhotoMeta> {
  try {
    // Loaded on demand: only needed once someone picks a photo.
    const exifr = (await import("exifr")).default;
    const data = await exifr.parse(file, {
      gps: true,
      // Pick the raw GPS tags: exifr computes latitude/longitude from them (picking
      // "latitude" itself skips the raw tags and yields nothing).
      pick: [...GPS_TAGS, "GPSAltitude", "GPSAltitudeRef", "DateTimeOriginal", "CreateDate"],
    });
    const { latitude, longitude } = data ?? {};
    if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
    if (Math.abs(latitude) > 90 || Math.abs(longitude) > 180 || (latitude === 0 && longitude === 0)) return null;
    const taken = data.DateTimeOriginal ?? data.CreateDate;
    return {
      latitude,
      longitude,
      // GPSAltitudeRef is a one-byte array: 1 means below sea level.
      altitude: Number.isFinite(data.GPSAltitude) ? (Number(data.GPSAltitudeRef?.[0] ?? data.GPSAltitudeRef) === 1 ? -data.GPSAltitude : data.GPSAltitude) : null,
      takenAt: taken instanceof Date && !Number.isNaN(taken.getTime()) ? taken : null,
    };
  } catch {
    return null; // unreadable or no EXIF
  }
}

const pad = (n: number) => String(n).padStart(2, "0");
/** EXIF wants local wall-clock time as "YYYY:MM:DD HH:MM:SS"; exifr parsed it as local, so format it back the same way. */
const exifDate = (d: Date) =>
  `${d.getFullYear()}:${pad(d.getMonth() + 1)}:${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;

function blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/** Writes GPS position (and capture time) into a JPEG's EXIF. */
export async function embedPhotoMeta(jpeg: Blob, meta: NonNullable<PhotoMeta>): Promise<Blob> {
  const piexif = (await import("piexifjs")).default;
  const { GPSIFD, ExifIFD, GPSHelper } = piexif;

  const gps: Record<number, unknown> = {
    [GPSIFD.GPSVersionID]: [2, 3, 0, 0],
    [GPSIFD.GPSLatitudeRef]: meta.latitude < 0 ? "S" : "N",
    [GPSIFD.GPSLatitude]: GPSHelper.degToDmsRational(Math.abs(meta.latitude)),
    [GPSIFD.GPSLongitudeRef]: meta.longitude < 0 ? "W" : "E",
    [GPSIFD.GPSLongitude]: GPSHelper.degToDmsRational(Math.abs(meta.longitude)),
  };
  if (meta.altitude !== null) {
    gps[GPSIFD.GPSAltitudeRef] = meta.altitude < 0 ? 1 : 0;
    gps[GPSIFD.GPSAltitude] = [Math.round(Math.abs(meta.altitude) * 100), 100];
  }
  const exif: Record<number, unknown> = {};
  if (meta.takenAt) exif[ExifIFD.DateTimeOriginal] = exifDate(meta.takenAt);

  // The canvas already applied any rotation, so no Orientation tag (= upright).
  const withExif = piexif.insert(piexif.dump({ "0th": {}, Exif: exif, GPS: gps }), await blobToDataUrl(jpeg));
  return (await fetch(withExif)).blob();
}
