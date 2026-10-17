"use client";

import { useCallback, useEffect, useState } from "react";
import type { BBox } from "@/lib/geo";
import type { Coordinates } from "@/lib/use-location";

// Mirrors the API responses (lib/threat.ts, lib/reports.ts are server-only).
export type ThreatLevel = "none" | "low" | "moderate" | "high" | "severe";

export type Threat = {
  level: ThreatLevel;
  headline: string;
  summary: string;
  factors: string[];
  confidence: "low" | "medium" | "high";
  bbox: BBox;
  source: "gemma" | "rules";
  basis: "photos" | "photos+environment";
  generatedAt: string;
};

export type Report = {
  id: string;
  latitude: number;
  longitude: number;
  note: string;
  submittedAt: string;
  photoUrl: string;
  distanceKm: number;
  locationSource: "photo" | "device";
  /** Camera wall-clock time from the photo's EXIF, "YYYY-MM-DDTHH:MM:SS". */
  takenAt: string | null;
};

export const THREAT_STYLES: Record<ThreatLevel, { label: string; color: string }> = {
  none: { label: "No threat", color: "#22c55e" },
  low: { label: "Low", color: "#eab308" },
  moderate: { label: "Moderate", color: "#f97316" },
  high: { label: "High", color: "#ef4444" },
  severe: { label: "Severe", color: "#a21caf" },
};

type Load<T> = { cell: string | null; data: T | null; loading: boolean; error: string | null };

async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  const body = await res.json().catch(() => null);
  if (!res.ok) throw new Error(body?.error ?? "Something went wrong.");
  return body as T;
}

/**
 * Flood threat and nearby reports for the user's area. Refetches when they move
 * ~1 km (matching the server's cache cells), every 15 minutes, or on `refresh()`.
 */
export function useFloodInfo(coords: Coordinates | null) {
  const [threat, setThreat] = useState<Load<Threat>>({ cell: null, data: null, loading: false, error: null });
  const [reports, setReports] = useState<Load<Report[]>>({ cell: null, data: null, loading: false, error: null });
  /** How far back reports go; null when they never age out (photos-only mode). */
  const [maxAgeHours, setMaxAgeHours] = useState<number | null>(48);
  const [tick, setTick] = useState(0);
  const refresh = useCallback(() => setTick((n) => n + 1), []);

  const lat = coords ? coords.latitude.toFixed(2) : null;
  const lng = coords ? coords.longitude.toFixed(2) : null;
  const cell = lat === null || lng === null ? null : `${lat},${lng}`;

  useEffect(() => {
    if (lat === null || lng === null) return;
    let cancelled = false;
    const q = `lat=${lat}&lng=${lng}`;

    // Loading state is synchronized with the external request started here.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setThreat({ cell, data: null, loading: true, error: null });
    getJson<Threat>(`/api/threat?${q}`)
      .then((data) => !cancelled && setThreat({ cell, data, loading: false, error: null }))
      .catch((e: Error) => !cancelled && setThreat({ cell, data: null, loading: false, error: e.message }));

    setReports({ cell, data: null, loading: true, error: null });
    getJson<{ reports: Report[]; maxAgeHours: number | null }>(`/api/reports?${q}`)
      .then((res) => {
        if (cancelled) return;
        setReports({ cell, data: res.reports, loading: false, error: null });
        setMaxAgeHours(res.maxAgeHours);
      })
      .catch((e: Error) => !cancelled && setReports({ cell, data: null, loading: false, error: e.message }));

    return () => {
      cancelled = true;
    };
  }, [lat, lng, cell, tick]);

  useEffect(() => {
    const id = setInterval(refresh, 15 * 60 * 1000);
    return () => clearInterval(id);
  }, [refresh]);

  // Hide another cell's data during render, before the fetching effect can run.
  const empty = { cell, data: null, loading: cell !== null, error: null };
  return {
    threat: cell !== null && threat.cell === cell ? threat : empty,
    reports: cell !== null && reports.cell === cell ? reports : empty,
    maxAgeHours,
    refresh,
  };
}
