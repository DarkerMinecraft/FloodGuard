"use client";

import { MapIcon, MapPinIcon, TriangleAlertIcon, XIcon } from "lucide-react";
import { AlertsPanel } from "@/components/alerts-panel";
import { InstallPrompt } from "@/components/install-prompt";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Sheet, SheetClose, SheetContent, SheetDescription, SheetTitle } from "@/components/ui/sheet";
import { Skeleton } from "@/components/ui/skeleton";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { cn } from "@/lib/utils";
import { THREAT_STYLES, type useFloodInfo } from "@/lib/use-flood-info";
import type { useAlerts } from "@/lib/use-alerts";
import type { useLocation } from "@/lib/use-location";
import { MAPTILER_KEY, MAP_STYLES, type MapStyle, type Settings } from "@/lib/use-settings";

type Location = ReturnType<typeof useLocation>;
type FloodInfo = ReturnType<typeof useFloodInfo>;

export function Sidebar({
  open,
  onClose,
  location,
  settings,
  onSettingsChange,
  floodInfo,
  alerts,
  onShowArea,
}: {
  open: boolean;
  onClose: () => void;
  location: Location;
  settings: Settings;
  onSettingsChange: (patch: Partial<Settings>) => void;
  floodInfo: FloodInfo | null;
  alerts: ReturnType<typeof useAlerts>;
  /** Fly the map to a point (a report) or fit the threat area. */
  onShowArea: (target: { lat: number; lng: number } | "threat") => void;
}) {
  // Location setup is only needed until the user has allowed it.
  const needsLocationSetup = location.status !== "granted" && location.status !== "locating";

  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="left"
        showCloseButton={false}
        className="w-[85vw] max-w-sm gap-0 overflow-y-auto pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <header className="flex items-center gap-3 px-4 pb-4">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="" width={36} height={36} className="rounded-lg" />
          <div className="flex-1">
            <SheetTitle className="text-lg font-bold leading-tight tracking-tight">FloodGuard</SheetTitle>
            <SheetDescription className="text-xs">Flood warnings where you are</SheetDescription>
          </div>
          <SheetClose asChild>
            <Button variant="ghost" size="icon-lg" className="rounded-full" aria-label="Close menu">
              <XIcon className="size-5" />
            </Button>
          </SheetClose>
        </header>

        <Separator />

        <div className="flex flex-col gap-6 p-4">
          {needsLocationSetup && (
            <Section title="Location">
              <LocationSetup location={location} />
            </Section>
          )}

          {floodInfo && (
            <>
              <Section title="Flood threat">
                <ThreatCard threat={floodInfo.threat} onShowArea={() => onShowArea("threat")} />
              </Section>
              <Section title="Recent reports nearby">
                <ReportList
                  reports={floodInfo.reports}
                  maxAgeHours={floodInfo.maxAgeHours}
                  onSelect={(r) => onShowArea({ lat: r.latitude, lng: r.longitude })}
                />
              </Section>
            </>
          )}

          <Section title="Flood alerts">
            <AlertsPanel alerts={alerts} location={location} />
          </Section>

          <Section title="Map style">
            <ToggleGroup
              type="single"
              variant="outline"
              disabled={!MAPTILER_KEY}
              value={settings.mapStyle}
              onValueChange={(style) => style && onSettingsChange({ mapStyle: style as MapStyle })}
              className="w-full"
            >
              {(Object.keys(MAP_STYLES) as MapStyle[]).map((style) => (
                <ToggleGroupItem
                  key={style}
                  value={style}
                  className="h-10 flex-1 data-[state=on]:bg-primary data-[state=on]:text-primary-foreground"
                >
                  {MAP_STYLES[style].label}
                </ToggleGroupItem>
              ))}
            </ToggleGroup>
            {!MAPTILER_KEY && (
              <p className="mt-2 text-xs text-muted-foreground">Add a MapTiler key to switch styles.</p>
            )}
          </Section>

          <InstallPrompt />

          <Section title="About">
            <p className="text-sm leading-6 text-muted-foreground">
              FloodGuard shows flood warnings and hazards for your location. Always follow
              instructions from your local emergency services.
            </p>
          </Section>
        </div>
      </SheetContent>
    </Sheet>
  );
}

function ThreatCard({ threat, onShowArea }: { threat: FloodInfo["threat"]; onShowArea: () => void }) {
  const { data, loading, error } = threat;
  if (!data) {
    if (error) return <ErrorNote>{error}</ErrorNote>;
    if (loading) return <Skeleton className="h-36 w-full rounded-xl" />;
    return <p className="text-sm text-muted-foreground">No data yet.</p>;
  }
  const style = THREAT_STYLES[data.level];
  return (
    <Card size="sm">
      <CardContent>
        <div className="flex items-center gap-2">
          <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: style.color }} />
          <span className="text-sm font-bold">{style.label}</span>
          <Badge variant="outline" className="ml-auto text-muted-foreground">
            {loading ? "Updating…" : `${data.confidence} confidence`}
          </Badge>
        </div>
        <p className="mt-2 text-sm font-semibold leading-5">{data.headline}</p>
        <p className="mt-1 text-sm leading-6 text-muted-foreground">{data.summary}</p>
        {data.factors.length > 0 && (
          <ul className="mt-2 list-disc space-y-0.5 pl-5 text-xs leading-5 text-muted-foreground">
            {data.factors.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
        {data.bbox && (
          <Button variant="secondary" className="mt-3 h-10 w-full" onClick={onShowArea}>
            <MapIcon /> Show area on map
          </Button>
        )}
      </CardContent>
      <CardFooter className="text-[11px] leading-4 text-muted-foreground">
        <p>
          {data.source === "gemma" ? "AI alert level (Gemma 4)" : "Automatic estimate"} from{" "}
          {data.basis === "photos"
            ? "flood photos reported by app users and checked by Gemini"
            : "Open-Meteo river, rain and sea-level forecasts and user reports"}
          , {timeAgo(data.generatedAt)}. Not an official warning.
        </p>
      </CardFooter>
    </Card>
  );
}

function ReportList({
  reports,
  maxAgeHours,
  onSelect,
}: {
  reports: FloodInfo["reports"];
  maxAgeHours: number | null;
  onSelect: (report: NonNullable<FloodInfo["reports"]["data"]>[number]) => void;
}) {
  const { data, loading, error } = reports;
  if (!data) {
    if (error) return <ErrorNote>{error}</ErrorNote>;
    if (loading) {
      return (
        <div className="flex flex-col gap-2">
          <Skeleton className="h-[4.5rem] w-full rounded-xl" />
          <Skeleton className="h-[4.5rem] w-full rounded-xl" />
        </div>
      );
    }
    return <p className="text-sm text-muted-foreground">No data yet.</p>;
  }
  if (!data.length) {
    return (
      <p className="text-sm text-muted-foreground">
        No flood reports within 25 km{maxAgeHours !== null && ` in the last ${maxAgeHours} hours`}.
      </p>
    );
  }
  return (
    <ul className="flex flex-col gap-2">
      {data.map((r) => (
        <li key={r.id}>
          <button
            type="button"
            onClick={() => onSelect(r)}
            className="flex w-full items-center gap-3 rounded-xl bg-card p-2 text-left ring-1 ring-foreground/10 outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-accent"
          >
            {/* eslint-disable-next-line @next/next/no-img-element */}
            <img src={r.photoUrl} alt="" loading="lazy" className="size-14 shrink-0 rounded-lg bg-muted object-cover" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm">{r.note || "Flooding reported"}</span>
              <span className="block text-xs text-muted-foreground">
                {r.distanceKm < 1 ? "<1" : r.distanceKm} km away · {timeAgo(r.submittedAt)}
              </span>
              {(r.locationSource === "photo" || r.takenAt) && (
                <span className="flex items-center gap-1 text-xs text-muted-foreground/80">
                  {r.locationSource === "photo" && (
                    <>
                      <MapPinIcon className="size-3" /> Location from photo
                    </>
                  )}
                  {r.locationSource === "photo" && r.takenAt && " · "}
                  {r.takenAt && `Taken ${new Date(r.takenAt).toLocaleDateString()}`}
                </span>
              )}
            </span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function timeAgo(iso: string): string {
  const mins = Math.round((Date.now() - Date.parse(iso)) / 60_000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins} min ago`;
  const hours = Math.round(mins / 60);
  return hours < 24 ? `${hours} h ago` : `${Math.round(hours / 24)} d ago`;
}

function LocationSetup({ location }: { location: Location }) {
  const { status, error, request } = location;

  if (status === "checking") {
    return <p className="text-sm text-muted-foreground">Checking location access…</p>;
  }

  if (status === "unsupported") {
    return (
      <p className="text-sm leading-6 text-muted-foreground">
        This browser can&apos;t share your location. Location only works over a secure
        (https://) connection.
      </p>
    );
  }

  if (status === "denied") {
    return (
      <>
        <p className="text-sm leading-6 text-muted-foreground">
          Location is turned off. FloodGuard needs it to warn you about floods nearby:
        </p>
        <ul className="mt-2 list-disc space-y-1 pl-5 text-sm leading-6 text-muted-foreground">
          <li>
            <strong className="text-foreground">iPhone:</strong> Settings → Privacy &amp; Security → Location
            Services → Safari Websites (or FloodGuard) → While Using.
          </li>
          <li>
            <strong className="text-foreground">Android:</strong> tap the icon left of the address bar →
            Permissions → Location → Allow.
          </li>
        </ul>
      </>
    );
  }

  // "prompt" or "error"
  return (
    <>
      <p className="text-sm leading-6 text-muted-foreground">
        FloodGuard sends your approximate location to its server to load nearby reports
        and forecasts. If you turn on alerts and location sharing, your last position
        is also saved so alerts can reach you while the app is closed.
      </p>
      {error && <ErrorNote className="mt-2">{error}</ErrorNote>}
      <Button size="lg" className="mt-4 h-12 w-full rounded-xl text-base font-semibold" onClick={request}>
        <MapPinIcon className="size-5" />
        {status === "error" ? "Try again" : "Share my location"}
      </Button>
    </>
  );
}

function ErrorNote({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <Alert className={cn("border-warning/40 text-warning", className)}>
      <TriangleAlertIcon />
      <AlertDescription className="text-warning/90">{children}</AlertDescription>
    </Alert>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section>
      <h2 className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {children}
    </section>
  );
}
