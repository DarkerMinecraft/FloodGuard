"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { Coordinates } from "@/lib/use-location";
import { serialQueue } from "@/lib/serial-queue";

const VAPID_PUBLIC_KEY = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
const SHARE_KEY = "floodguard:alerts-share-location";
/** Send the position again after moving this far or this long, whichever comes first. */
const RESEND_METRES = 250;
const RESEND_MS = 10 * 60_000;

export type AlertLevel = "low" | "moderate" | "high" | "severe";

export type AlertPlace = {
  id: string;
  kind: "last" | "saved";
  label: string;
  latitude: number;
  longitude: number;
  updatedAt: string;
};

export type AlertsStatus =
  | "checking"
  | "unsupported" // no service worker / push in this browser
  | "needs-install" // iPhone/iPad: push only works from the home-screen app
  | "unavailable" // the server has no push keys configured
  | "denied" // notifications blocked for this site
  | "off"
  | "on";

function keyBytes(base64url: string): Uint8Array<ArrayBuffer> {
  const base64 = (base64url + "=".repeat((4 - (base64url.length % 4)) % 4)).replace(/-/g, "+").replace(/_/g, "/");
  const raw = atob(base64);
  const bytes = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) bytes[i] = raw.charCodeAt(i);
  return bytes;
}

function headersFor(sub: PushSubscription): HeadersInit {
  return {
    "Content-Type": "application/json",
    "X-Push-Endpoint": sub.endpoint,
    "X-Push-Auth": sub.toJSON().keys?.auth ?? "",
  };
}

async function api<T>(url: string, init: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = res.status === 204 ? null : await res.json().catch(() => null);
  if (!res.ok) {
    const err = new Error(body?.error ?? "Something went wrong.") as Error & { status: number };
    err.status = res.status;
    throw err;
  }
  return body as T;
}

function readShare(): boolean {
  try {
    return localStorage.getItem(SHARE_KEY) !== "false";
  } catch {
    return true;
  }
}

function metresBetween(a: { latitude: number; longitude: number }, b: { latitude: number; longitude: number }) {
  const rad = Math.PI / 180;
  const x = (b.longitude - a.longitude) * rad * Math.cos(((a.latitude + b.latitude) / 2) * rad);
  const y = (b.latitude - a.latitude) * rad;
  return Math.hypot(x, y) * 6_371_000;
}

/**
 * Flood alerts by push notification. When on, the user's position is sent to the
 * server whenever the app is open (if they chose to share it), so the server can
 * warn them about that spot and any saved places while the app is closed.
 */
export function useAlerts(coords: Coordinates | null) {
  const [status, setStatus] = useState<AlertsStatus>("checking");
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [shareLocation, setShareLocationState] = useState(true);
  const [minLevel, setMinLevelState] = useState<AlertLevel>("moderate");
  const [places, setPlaces] = useState<AlertPlace[]>([]);
  const [maxSaved, setMaxSaved] = useState(5);
  const [busy, setBusy] = useState(false);
  const lastSent = useRef<{ at: number; latitude: number; longitude: number } | null>(null);
  const sharing = useRef(true);
  const locationWrites = useRef(serialQueue());

  const register = useCallback(async (sub: PushSubscription, level: AlertLevel) => {
    await api("/api/alerts/subscription", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ subscription: sub.toJSON(), minLevel: level }),
    });
  }, []);

  const loadPlaces = useCallback(
    async (sub: PushSubscription) => {
      try {
        const res = await api<{ places: AlertPlace[]; minLevel: AlertLevel; maxSaved: number }>("/api/alerts/places", {
          headers: headersFor(sub),
        });
        setPlaces(res.places);
        setMinLevelState(res.minLevel);
        setMaxSaved(res.maxSaved);
      } catch (err) {
        // The server lost this subscription (e.g. it expired there): sign it up again.
        if ((err as { status?: number }).status === 404) {
          await register(sub, "moderate");
          setPlaces([]);
        } else throw err;
      }
    },
    [register],
  );

  useEffect(() => {
    // Hydrate localStorage and browser notification capability after mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setShareLocationState(readShare());
    sharing.current = readShare();
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
      setStatus(ios ? "needs-install" : "unsupported");
      return;
    }
    if (!VAPID_PUBLIC_KEY) return setStatus("unavailable");
    if (Notification.permission === "denied") return setStatus("denied");

    let cancelled = false;
    navigator.serviceWorker.ready
      .then((reg) => reg.pushManager.getSubscription())
      .then(async (sub) => {
        if (cancelled) return;
        setSubscription(sub);
        setStatus(sub ? "on" : "off");
        if (sub) await loadPlaces(sub);
      })
      .catch((err) => console.error("Checking alert subscription failed", err));
    return () => {
      cancelled = true;
    };
  }, [loadPlaces]);

  /** Asks for notification permission and subscribes. Resolves to an error message, or null on success. */
  const enable = useCallback(
    async (opts: { shareLocation: boolean }): Promise<string | null> => {
      if (!VAPID_PUBLIC_KEY) return "Alerts aren't set up on this server yet.";
      setBusy(true);
      try {
        const permission = await Notification.requestPermission();
        if (permission !== "granted") {
          if (permission === "denied") setStatus("denied");
          return "Notifications are blocked. Allow them for this site to get flood alerts.";
        }
        const reg = await navigator.serviceWorker.ready;
        const sub =
          (await reg.pushManager.getSubscription()) ??
          (await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(VAPID_PUBLIC_KEY) }));
        await register(sub, minLevel);
        sharing.current = opts.shareLocation;
        if (!opts.shareLocation) {
          await locationWrites.current(() => api("/api/alerts/location", { method: "DELETE", headers: headersFor(sub) }));
        }
        try {
          localStorage.setItem(SHARE_KEY, String(opts.shareLocation));
        } catch {}
        setShareLocationState(opts.shareLocation);
        lastSent.current = null;
        setSubscription(sub);
        setStatus("on");
        await loadPlaces(sub);
        return null;
      } catch (err) {
        console.error("Turning on alerts failed", err);
        return (err as Error).message || "Couldn't turn on alerts.";
      } finally {
        setBusy(false);
      }
    },
    [minLevel, register, loadPlaces],
  );

  const disable = useCallback(async (): Promise<string | null> => {
    if (!subscription) return null;
    setBusy(true);
    try {
      await api("/api/alerts/subscription", { method: "DELETE", headers: headersFor(subscription) });
      await subscription.unsubscribe();
      setSubscription(null);
      setPlaces([]);
      setStatus("off");
      return null;
    } catch (err) {
      return (err as Error).message;
    } finally {
      setBusy(false);
    }
  }, [subscription]);

  const setShareLocation = useCallback(
    async (share: boolean): Promise<string | null> => {
      const previous = sharing.current;
      // Stop queued/new PUTs immediately, before React renders the new setting.
      sharing.current = share;
      setShareLocationState(share);
      try {
        localStorage.setItem(SHARE_KEY, String(share));
      } catch {}
      lastSent.current = null;
      if (share || !subscription) return null;
      setBusy(true);
      try {
        // Wait for any in-flight PUT before deleting, so it cannot recreate the
        // stored position after the user has stopped sharing.
        await locationWrites.current(() => api("/api/alerts/location", { method: "DELETE", headers: headersFor(subscription) }));
        setPlaces((p) => p.filter((place) => place.kind !== "last"));
        return null;
      } catch (err) {
        sharing.current = previous;
        setShareLocationState(previous);
        try { localStorage.setItem(SHARE_KEY, String(previous)); } catch {}
        return (err as Error).message;
      } finally {
        setBusy(false);
      }
    },
    [subscription],
  );

  const setMinLevel = useCallback(
    async (level: AlertLevel): Promise<string | null> => {
      setMinLevelState(level);
      if (!subscription) return null;
      try {
        await register(subscription, level);
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    },
    [subscription, register],
  );

  const addPlace = useCallback(
    async (label: string, at: { latitude: number; longitude: number }): Promise<string | null> => {
      if (!subscription) return "Turn on alerts first.";
      try {
        const res = await api<{ places: AlertPlace[] }>("/api/alerts/places", {
          method: "POST",
          headers: headersFor(subscription),
          body: JSON.stringify({ label, ...at }),
        });
        setPlaces(res.places);
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    },
    [subscription],
  );

  const removePlace = useCallback(
    async (id: string): Promise<string | null> => {
      if (!subscription) return null;
      try {
        const res = await api<{ places: AlertPlace[] }>(`/api/alerts/places?id=${encodeURIComponent(id)}`, {
          method: "DELETE",
          headers: headersFor(subscription),
        });
        setPlaces(res.places);
        return null;
      } catch (err) {
        return (err as Error).message;
      }
    },
    [subscription],
  );

  // Keep the server's copy of "where I am" fresh while the app is open.
  useEffect(() => {
    if (status !== "on" || !shareLocation || !sharing.current || !subscription || !coords) return;
    const prev = lastSent.current;
    if (prev && Date.now() - prev.at < RESEND_MS && metresBetween(prev, coords) < RESEND_METRES) return;
    const at = { latitude: coords.latitude, longitude: coords.longitude };
    lastSent.current = { at: Date.now(), ...at };
    locationWrites.current(async () => {
      if (!sharing.current) return;
      await api("/api/alerts/location", { method: "PUT", headers: headersFor(subscription), body: JSON.stringify(at) });
      if (sharing.current) {
        setPlaces((p) => {
          const rest = p.filter((place) => place.kind !== "last");
          const last = p.find((place) => place.kind === "last");
          return [
            { id: last?.id ?? "last", kind: "last", label: "your location", ...at, updatedAt: new Date().toISOString() },
            ...rest,
          ];
        });
      }
    }).catch((err) => {
        lastSent.current = null;
        console.error("Updating alert location failed", err);
      });
  }, [status, shareLocation, subscription, coords]);

  return {
    status,
    busy,
    shareLocation,
    minLevel,
    places,
    savedPlaces: places.filter((p) => p.kind === "saved"),
    maxSaved,
    enable,
    disable,
    setShareLocation,
    setMinLevel,
    addPlace,
    removePlace,
  };
}
