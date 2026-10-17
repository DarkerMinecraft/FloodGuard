import "server-only";

/**
 * Photos-only (demo) mode: the flood threat is estimated purely from approved report
 * photos. Open-Meteo river/rain/sea-level data is not fetched, and reports never age
 * out (no 48 h window), so older demo photos still count. Set FLOODGUARD_PHOTOS_ONLY=1.
 */
export const PHOTOS_ONLY = process.env.FLOODGUARD_PHOTOS_ONLY === "1";
