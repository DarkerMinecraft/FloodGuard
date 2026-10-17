import "server-only";

// Open-Meteo (https://open-meteo.com) is free and keyless for non-commercial use.
// River discharge comes from the Copernicus GloFAS model (~5 km cells), so it covers
// rivers well but says nothing about storm drains or tidal flooding; rain and sea
// level fill in those gaps.
const FLOOD_API = "https://flood-api.open-meteo.com/v1/flood";
const WEATHER_API = "https://api.open-meteo.com/v1/forecast";
const MARINE_API = "https://marine-api.open-meteo.com/v1/marine";

/** Grid of river sample points around the user, in degrees (~11 km apart). */
const GRID_STEP = 0.1;
const BASELINE_DAYS = 92;
const FORECAST_DAYS = 7;
const TIMEOUT_MS = 10_000;

export type RiverPoint = {
  latitude: number;
  longitude: number;
  /** Typical flow: median daily discharge over the past ~90 days, m³/s. */
  baseline: number;
  today: number;
  forecastPeak: number;
  forecastPeakDate: string;
  /** Wettest ensemble member's peak, a worst-case signal, m³/s. */
  ensembleMaxPeak: number;
  /** forecastPeak / baseline; >2 is notably high, >5 is exceptional. */
  peakRatio: number;
};

export type FloodData = {
  rivers: RiverPoint[];
  rain: {
    dailyMm: { date: string; mm: number; probability: number | null }[];
    next24hMm: number;
    maxHourlyNext24hMm: number;
  } | null;
  /** Null inland, where the marine model has no data. */
  seaLevel: { nowM: number; peakNext48hM: number; peakNext48hAt: string; maxPast24hM: number } | null;
  errors: string[];
};

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
  if (!res.ok) throw new Error(`${new URL(url).host} responded ${res.status}`);
  return res.json() as Promise<T>;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)] : 0;
};
const round = (n: number, dp = 2) => Math.round(n * 10 ** dp) / 10 ** dp;
/** Open-Meteo hourly timestamp for the current UTC hour, e.g. "2026-10-17T15:00". */
const currentHour = () => new Date().toISOString().slice(0, 13) + ":00";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

type FloodResponse = {
  latitude: number;
  longitude: number;
  daily?: { time: string[]; river_discharge: (number | null)[]; river_discharge_max: (number | null)[] };
};

async function fetchRivers(lat: number, lng: number): Promise<RiverPoint[]> {
  const lats: number[] = [];
  const lngs: number[] = [];
  for (const dLat of [-GRID_STEP, 0, GRID_STEP]) {
    for (const dLng of [-GRID_STEP, 0, GRID_STEP]) {
      lats.push(round(lat + dLat, 4));
      lngs.push(round(lng + dLng, 4));
    }
  }
  const url = `${FLOOD_API}?latitude=${lats.join(",")}&longitude=${lngs.join(",")}&daily=river_discharge,river_discharge_max&past_days=${BASELINE_DAYS}&forecast_days=${FORECAST_DAYS}`;
  const data = await getJson<FloodResponse[] | FloodResponse>(url);
  const today = new Date().toISOString().slice(0, 10);

  const seen = new Set<string>();
  const points: RiverPoint[] = [];
  for (const cell of Array.isArray(data) ? data : [data]) {
    // Nearby requests often snap to the same model cell.
    const id = `${cell.latitude},${cell.longitude}`;
    if (seen.has(id) || !cell.daily) continue;
    seen.add(id);

    const { time, river_discharge: q, river_discharge_max: qMax } = cell.daily;
    const past = time.flatMap((t, i) => (t < today && isNum(q[i]) ? [q[i] as number] : []));
    const future = time.flatMap((t, i) => (t >= today && isNum(q[i]) ? [{ t, q: q[i] as number, max: qMax[i] }] : []));
    if (!past.length || !future.length) continue; // no river in this cell

    const baseline = median(past);
    const peak = future.reduce((a, b) => (b.q > a.q ? b : a));
    const ensembleMaxPeak = Math.max(...future.map((f) => (isNum(f.max) ? f.max : f.q)));
    points.push({
      latitude: cell.latitude,
      longitude: cell.longitude,
      baseline: round(baseline),
      today: round(future[0].q),
      forecastPeak: round(peak.q),
      forecastPeakDate: peak.t,
      ensembleMaxPeak: round(ensembleMaxPeak),
      peakRatio: round(baseline > 0.01 ? peak.q / baseline : 1),
    });
  }
  return points;
}

type WeatherResponse = {
  daily: { time: string[]; precipitation_sum: (number | null)[]; precipitation_probability_max: (number | null)[] };
  hourly: { time: string[]; precipitation: (number | null)[] };
};

async function fetchRain(lat: number, lng: number): Promise<FloodData["rain"]> {
  const url = `${WEATHER_API}?latitude=${lat}&longitude=${lng}&daily=precipitation_sum,precipitation_probability_max&hourly=precipitation&past_days=2&forecast_days=3&timezone=GMT`;
  const data = await getJson<WeatherResponse>(url);
  const now = currentHour();
  const window = data.hourly.time
    .map((t, i) => ({ t, mm: data.hourly.precipitation[i] }))
    .filter((h) => h.t >= now)
    .slice(0, 24);
  if (window.length !== 24 || window.some((h) => !isNum(h.mm))) {
    throw new Error("Rain forecast is missing hourly readings for the next 24 hours");
  }
  const next24 = window.map((h) => h.mm as number);
  return {
    dailyMm: data.daily.time.map((date, i) => ({
      date,
      mm: round(data.daily.precipitation_sum[i] ?? 0, 1),
      probability: data.daily.precipitation_probability_max[i],
    })),
    next24hMm: round(next24.reduce((a, b) => a + b, 0), 1),
    maxHourlyNext24hMm: round(Math.max(0, ...next24), 1),
  };
}

type MarineResponse = { hourly: { time: string[]; sea_level_height_msl: (number | null)[] } };

async function fetchSeaLevel(lat: number, lng: number): Promise<FloodData["seaLevel"]> {
  const url = `${MARINE_API}?latitude=${lat}&longitude=${lng}&hourly=sea_level_height_msl&past_days=1&forecast_days=2&timezone=GMT`;
  const data = await getJson<MarineResponse>(url);
  const now = currentHour();
  const hours = data.hourly.time
    .map((t, i) => ({ t, m: data.hourly.sea_level_height_msl[i] }))
    .filter((h): h is { t: string; m: number } => isNum(h.m));
  if (!hours.length) return null;
  const past = hours.filter((h) => h.t < now);
  const future = hours.filter((h) => h.t >= now);
  if (!future.length) return null;
  const peak = future.reduce((a, b) => (b.m > a.m ? b : a));
  return {
    nowM: round(future[0].m),
    peakNext48hM: round(peak.m),
    peakNext48hAt: peak.t,
    maxPast24hM: round(Math.max(...past.map((h) => h.m), future[0].m)),
  };
}

/** Everything Open-Meteo knows about flood conditions around a point. Partial data beats none. */
export async function fetchFloodData(latitude: number, longitude: number): Promise<FloodData> {
  const [rivers, rain, seaLevel] = await Promise.allSettled([
    fetchRivers(latitude, longitude),
    fetchRain(latitude, longitude),
    fetchSeaLevel(latitude, longitude),
  ]);
  const errors: string[] = [];
  const value = <T,>(r: PromiseSettledResult<T>, name: string, fallback: T): T => {
    if (r.status === "fulfilled") return r.value;
    errors.push(`${name}: ${(r.reason as Error).message}`);
    return fallback;
  };
  return {
    rivers: value(rivers, "rivers", []),
    rain: value(rain, "rain", null),
    seaLevel: value(seaLevel, "sea level", null),
    errors,
  };
}
