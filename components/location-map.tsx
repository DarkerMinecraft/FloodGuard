"use client";

import "leaflet/dist/leaflet.css";
import { useEffect, useRef } from "react";
import {
  AttributionControl,
  Circle,
  CircleMarker,
  MapContainer,
  Rectangle,
  TileLayer,
  Tooltip,
  useMap,
} from "react-leaflet";
import { THREAT_STYLES, type Report, type Threat } from "@/lib/use-flood-info";
import type { Coordinates } from "@/lib/use-location";
import { MAPTILER_KEY, MAP_STYLES, type MapStyle } from "@/lib/use-settings";

const MAPTILER_ATTRIBUTION =
  '<a href="https://www.maptiler.com/copyright/" target="_blank">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright" target="_blank">&copy; OpenStreetMap contributors</a>';

// Without a key we fall back to OpenStreetMap's public tiles, which are fine for local
// development but not for production traffic.
const OSM_TILES = {
  url: "https://tile.openstreetmap.org/{z}/{x}/{y}.png",
  attribution:
    '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors',
};

function tilesFor(style: MapStyle) {
  if (!MAPTILER_KEY) return OSM_TILES;
  return {
    url: `https://api.maptiler.com/maps/${MAP_STYLES[style].path}?key=${MAPTILER_KEY}`,
    attribution: MAPTILER_ATTRIBUTION,
  };
}

if (!MAPTILER_KEY && process.env.NODE_ENV !== "production") {
  console.warn("NEXT_PUBLIC_MAPTILER_KEY is not set; using OpenStreetMap tiles.");
}

const WORLD_VIEW = { center: [20, 0] as [number, number], zoom: 2 };
const USER_ZOOM = 15;

export type MapFocus = { signal: number; target: { lat: number; lng: number } | "threat" };

// Leaflet touches `window` on import, so load this with next/dynamic and `ssr: false`.
export default function LocationMap({
  coords,
  mapStyle,
  recenterSignal,
  onUserPan,
  threat,
  reports,
  focus,
}: {
  coords: Coordinates | null;
  mapStyle: MapStyle;
  /** Bump this number to snap the map back to the user. */
  recenterSignal: number;
  onUserPan: () => void;
  threat: Threat | null;
  reports: Report[];
  /** Bump `signal` to fly to a report or fit the threat area. */
  focus: MapFocus;
}) {
  const center: [number, number] | null = coords
    ? [coords.latitude, coords.longitude]
    : null;
  const tiles = tilesFor(mapStyle);

  return (
    <MapContainer
      center={center ?? WORLD_VIEW.center}
      zoom={center ? USER_ZOOM : WORLD_VIEW.zoom}
      zoomControl={false}
      attributionControl={false}
      worldCopyJump
      className="h-full w-full"
    >
      {/* Top-right so the bottom sheet never hides the required credit. */}
      <AttributionControl position="topright" prefix={false} />
      {/* Keyed so switching style swaps the layer (and its attribution) cleanly. */}
      <TileLayer key={tiles.url} url={tiles.url} attribution={tiles.attribution} maxZoom={19} />
      {threat && threat.level !== "none" && (
        <Rectangle
          bounds={[
            [threat.bbox[0], threat.bbox[1]],
            [threat.bbox[2], threat.bbox[3]],
          ]}
          pathOptions={{ color: THREAT_STYLES[threat.level].color, weight: 2, fillOpacity: 0.12, dashArray: "6 4" }}
        >
          <Tooltip sticky>{THREAT_STYLES[threat.level].label} flood risk: {threat.headline}</Tooltip>
        </Rectangle>
      )}
      {reports.map((r) => (
        <CircleMarker
          key={r.id}
          center={[r.latitude, r.longitude]}
          radius={7}
          pathOptions={{ color: "#0b3a6e", weight: 2, fillColor: "#fbbf24", fillOpacity: 1 }}
        >
          <Tooltip>{r.note || "Flooding reported"}</Tooltip>
        </CircleMarker>
      ))}
      {coords && center && (
        <>
          <Circle
            center={center}
            radius={coords.accuracy}
            pathOptions={{ color: "#1e88e5", fillOpacity: 0.15, weight: 1 }}
          />
          <CircleMarker
            center={center}
            radius={9}
            pathOptions={{ color: "#ffffff", weight: 3, fillColor: "#1e88e5", fillOpacity: 1 }}
          />
        </>
      )}
      <FollowUser
        center={center}
        recenterSignal={recenterSignal}
        onUserPan={onUserPan}
        focus={focus}
        threatBox={threat?.bbox ?? null}
      />
    </MapContainer>
  );
}

/** Keeps the user in view as they move, unless they've panned the map themselves. */
function FollowUser({
  center,
  recenterSignal,
  onUserPan,
  focus,
  threatBox,
}: {
  center: [number, number] | null;
  recenterSignal: number;
  onUserPan: () => void;
  focus: MapFocus;
  threatBox: Threat["bbox"] | null;
}) {
  const map = useMap();
  const following = useRef(true);
  const hadFix = useRef(center !== null);
  const lat = center?.[0];
  const lng = center?.[1];

  useEffect(() => {
    const onDrag = () => {
      following.current = false;
      onUserPan();
    };
    map.on("dragstart", onDrag);
    return () => {
      map.off("dragstart", onDrag);
    };
  }, [map, onUserPan]);

  useEffect(() => {
    if (lat === undefined || lng === undefined) return;
    if (!hadFix.current) {
      // First fix after starting on the world view: zoom in to the user.
      hadFix.current = true;
      map.flyTo([lat, lng], USER_ZOOM, { duration: 1.5 });
    } else if (following.current) {
      map.panTo([lat, lng]);
    }
  }, [map, lat, lng]);

  useEffect(() => {
    if (recenterSignal === 0 || lat === undefined || lng === undefined) return;
    following.current = true;
    map.flyTo([lat, lng], Math.max(map.getZoom(), USER_ZOOM), { duration: 0.8 });
    // Only react to the button press, not to every position update.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, recenterSignal]);

  useEffect(() => {
    if (focus.signal === 0) return;
    // Looking at something else: stop following until "My location" is tapped.
    following.current = false;
    onUserPan();
    if (focus.target === "threat") {
      if (threatBox) map.flyToBounds([[threatBox[0], threatBox[1]], [threatBox[2], threatBox[3]]], { padding: [40, 40], duration: 1 });
    } else {
      map.flyTo([focus.target.lat, focus.target.lng], Math.max(map.getZoom(), 16), { duration: 1 });
    }
    // Only react to a new focus request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [map, focus.signal]);

  return null;
}
