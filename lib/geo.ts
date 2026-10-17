/** Great-circle distance in kilometres. */
export function distanceKm(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLng = (lng2 - lng1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(Math.min(1, Math.max(0, a))));
}

/** Parses `latitude`/`longitude` search params; null if missing or out of range. */
export function parseLatLng(params: URLSearchParams): { latitude: number; longitude: number } | null {
  const lat = params.get("lat");
  const lng = params.get("lng");
  if (lat === null || lng === null || lat.trim() === "" || lng.trim() === "") return null;
  const latitude = Number(lat);
  const longitude = Number(lng);
  if (!Number.isFinite(latitude) || Math.abs(latitude) > 90) return null;
  if (!Number.isFinite(longitude) || Math.abs(longitude) > 180) return null;
  return { latitude, longitude };
}

/** [south, west, north, east] */
export type BBox = [number, number, number, number];
