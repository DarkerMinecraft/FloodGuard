import "server-only";

import type { FloodData } from "@/lib/flood-data";
import { distanceKm, type LatLng, type Ring } from "@/lib/geo";
import type { PhotoAnalysis } from "@/lib/moderation";
import type { NearbyReport } from "@/lib/reports";

// The flood area is drawn from the evidence itself rather than asked of a model: each
// piece of evidence (a photo report, a river cell forecast to run high) becomes a circle
// sized by how far the flooding reaches, nearby circles are grouped, and each group is
// outlined by the convex hull of its circles. That gives a many-sided polygon that hugs
// the evidence instead of a rectangle, and one polygon per separate flooded area.

/** Reports further than this from the user don't shape the area. */
const REPORT_REACH_KM = 10;
/** Circles whose edges are within this distance belong to the same area. */
const JOIN_GAP_KM = 1;
const MAX_AREAS = 4;
const CIRCLE_POINTS = 24;

/** How far around a photo the flooding plausibly reaches, from what Gemini saw. */
const EXTENT_RADIUS_KM: Record<PhotoAnalysis["extent"], number> = {
  patch: 0.3,
  street: 0.6,
  neighbourhood: 1.5,
  widespread: 3,
  unknown: 0.6,
};

type Circle = { lat: number; lng: number; radiusKm: number };

/** Polygons (lat/lng rings, not closed) outlining the likely flooded areas; empty when there's no threat. */
export function floodAreas(input: {
  level: string;
  latitude: number;
  longitude: number;
  reports: NearbyReport[];
  data: FloodData;
}): Ring[] {
  if (input.level === "none") return [];
  const circles: Circle[] = [];

  for (const r of input.reports) {
    if (distanceKm(input.latitude, input.longitude, r.latitude, r.longitude) > REPORT_REACH_KM) continue;
    const base = EXTENT_RADIUS_KM[r.analysis?.extent ?? "unknown"];
    // Deep water usually spreads further than the frame shows.
    const deep = r.analysis && ["waist", "deeper"].includes(r.analysis.depth) ? 1.3 : 1;
    circles.push({ lat: r.latitude, lng: r.longitude, radiusKm: base * deep });
  }
  for (const river of input.data.rivers) {
    // Ignore trickles: a small stream doubling isn't a flood signal.
    if (river.forecastPeak < 5 || river.peakRatio < 2) continue;
    circles.push({ lat: river.latitude, lng: river.longitude, radiusKm: Math.min(4, 1 + (river.peakRatio - 2) * 0.75) });
  }
  // Rain or sea level alone has no location of its own: mark the area around the user.
  if (!circles.length) circles.push({ lat: input.latitude, lng: input.longitude, radiusKm: 2 });

  return groupCircles(circles)
    .sort((a, b) => weight(b) - weight(a))
    .slice(0, MAX_AREAS)
    .map(outline);
}

const weight = (group: Circle[]) => group.reduce((sum, c) => sum + c.radiusKm, 0);

/** Single-linkage grouping: circles that overlap or nearly touch end up together. */
function groupCircles(circles: Circle[]): Circle[][] {
  const parent = circles.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < circles.length; i++) {
    for (let j = i + 1; j < circles.length; j++) {
      const a = circles[i];
      const b = circles[j];
      if (distanceKm(a.lat, a.lng, b.lat, b.lng) <= a.radiusKm + b.radiusKm + JOIN_GAP_KM) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, Circle[]>();
  circles.forEach((c, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), c]));
  return [...groups.values()];
}

/** Convex hull of the group's circles, computed in a local flat projection (fine at these scales). */
function outline(group: Circle[]): Ring {
  const lat0 = group.reduce((s, c) => s + c.lat, 0) / group.length;
  const kmPerDegLat = 111.32;
  const kmPerDegLng = 111.32 * Math.cos((lat0 * Math.PI) / 180);

  const points: [number, number][] = [];
  for (const c of group) {
    for (let k = 0; k < CIRCLE_POINTS; k++) {
      const angle = (2 * Math.PI * k) / CIRCLE_POINTS;
      points.push([c.lng * kmPerDegLng + c.radiusKm * Math.cos(angle), c.lat * kmPerDegLat + c.radiusKm * Math.sin(angle)]);
    }
  }
  const r5 = (v: number) => Math.round(v * 1e5) / 1e5;
  return convexHull(points).map(([x, y]): LatLng => [r5(y / kmPerDegLat), r5(x / kmPerDegLng)]);
}

/** Andrew's monotone chain; returns the hull counter-clockwise without repeating the first point. */
function convexHull(points: [number, number][]): [number, number][] {
  const sorted = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o: number[], a: number[], b: number[]) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower: [number, number][] = [];
  for (const p of sorted) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], p) <= 0) lower.pop();
    lower.push(p);
  }
  const upper: [number, number][] = [];
  for (const p of sorted.reverse()) {
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], p) <= 0) upper.pop();
    upper.push(p);
  }
  return [...lower.slice(0, -1), ...upper.slice(0, -1)];
}
