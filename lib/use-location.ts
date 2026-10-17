"use client";

import { useCallback, useEffect, useRef, useState } from "react";

export type Coordinates = {
  latitude: number;
  longitude: number;
  accuracy: number; // metres
  timestamp: number;
};

export type LocationStatus =
  | "checking" // working out whether we already have permission
  | "prompt" // user hasn't been asked yet
  | "locating" // waiting for the first fix
  | "granted"
  | "denied"
  | "unsupported" // no geolocation API, or not a secure (HTTPS) context
  | "error";

const STORAGE_KEY = "floodguard:last-location";

function readSaved(): Coordinates | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw ? (JSON.parse(raw) as Coordinates) : null;
  } catch {
    return null;
  }
}

function save(coords: Coordinates) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(coords));
  } catch {
    // Storage can be unavailable (private mode); location still works in memory.
  }
}

/**
 * Tracks the user's location. Nothing is requested until `request()` is called
 * (browsers, iOS Safari especially, expect the prompt to follow a user tap),
 * unless permission was already granted on a previous visit.
 */
export function useLocation() {
  const [status, setStatus] = useState<LocationStatus>("checking");
  const [coords, setCoords] = useState<Coordinates | null>(null);
  const [error, setError] = useState<string | null>(null);
  const watchId = useRef<number | null>(null);

  const startWatching = useCallback(() => {
    if (watchId.current !== null) return;
    setStatus((s) => (s === "granted" ? s : "locating"));
    setError(null);

    watchId.current = navigator.geolocation.watchPosition(
      (pos) => {
        const next: Coordinates = {
          latitude: pos.coords.latitude,
          longitude: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          timestamp: pos.timestamp,
        };
        setCoords(next);
        setStatus("granted");
        save(next);
      },
      (err) => {
        if (watchId.current !== null) {
          navigator.geolocation.clearWatch(watchId.current);
          watchId.current = null;
        }
        if (err.code === err.PERMISSION_DENIED) {
          setStatus("denied");
        } else {
          setStatus("error");
          setError(
            err.code === err.TIMEOUT
              ? "Finding your location took too long. Try again outdoors or near a window."
              : "Your location isn't available right now.",
          );
        }
      },
      { enableHighAccuracy: true, maximumAge: 60_000, timeout: 20_000 },
    );
  }, []);

  useEffect(() => {
    if (!window.isSecureContext || !("geolocation" in navigator)) {
      // Browser capability is only available after hydration.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setStatus("unsupported");
      return;
    }

    const saved = readSaved();
    if (saved) setCoords(saved);

    let permission: PermissionStatus | null = null;
    const onChange = () => {
      if (permission?.state === "granted") startWatching();
      else if (permission?.state === "denied") setStatus("denied");
    };

    // The Permissions API lets returning users skip the prompt screen.
    // Older Safari lacks it, so fall back to asking.
    if (!navigator.permissions) {
      setStatus("prompt");
    } else {
      navigator.permissions
        .query({ name: "geolocation" })
        .then((p) => {
          permission = p;
          if (p.state === "granted") startWatching();
          else setStatus(p.state === "denied" ? "denied" : "prompt");
          p.addEventListener("change", onChange);
        })
        .catch(() => setStatus("prompt"));
    }

    return () => {
      permission?.removeEventListener("change", onChange);
      if (watchId.current !== null) {
        navigator.geolocation.clearWatch(watchId.current);
        watchId.current = null;
      }
    };
  }, [startWatching]);

  return { status, coords, error, request: startWatching };
}
