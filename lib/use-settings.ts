"use client";

import { useCallback, useEffect, useState } from "react";

export const MAPTILER_KEY = process.env.NEXT_PUBLIC_MAPTILER_KEY;

export const MAP_STYLES = {
  streets: { label: "Streets", path: "streets-v2/256/{z}/{x}/{y}.png" },
  outdoor: { label: "Terrain", path: "outdoor-v2/256/{z}/{x}/{y}.png" },
  satellite: { label: "Satellite", path: "hybrid/256/{z}/{x}/{y}.jpg" },
} as const;

export type MapStyle = keyof typeof MAP_STYLES;

export type Settings = {
  mapStyle: MapStyle;
};

const DEFAULTS: Settings = { mapStyle: "streets" };
const STORAGE_KEY = "floodguard:settings";

/** App preferences, remembered on this device. */
export function useSettings() {
  const [settings, setSettings] = useState<Settings>(DEFAULTS);

  useEffect(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return;
      const saved = JSON.parse(raw) as Partial<Settings>;
      // Hydrate settings from browser storage after server rendering.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setSettings({
        ...DEFAULTS,
        ...saved,
        // Drop values from older versions that no longer exist.
        mapStyle: saved.mapStyle && saved.mapStyle in MAP_STYLES ? saved.mapStyle : DEFAULTS.mapStyle,
      });
    } catch {
      // Storage unavailable or corrupt; keep defaults.
    }
  }, []);

  const update = useCallback((patch: Partial<Settings>) => {
    setSettings((prev) => {
      const next = { ...prev, ...patch };
      try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      } catch {
        // Not persisted, but still applies for this visit.
      }
      return next;
    });
  }, []);

  return { settings, update };
}
