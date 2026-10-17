"use client";

import dynamic from "next/dynamic";
import { useCallback, useEffect, useState } from "react";
import { CameraIcon, ChevronRightIcon, Loader2Icon, LocateFixedIcon, MenuIcon } from "lucide-react";
import { toast } from "sonner";
import { ReportFlood } from "@/components/report-flood";
import { Sidebar } from "@/components/sidebar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MapFocus } from "@/components/location-map";
import { useAlerts } from "@/lib/use-alerts";
import { parseLatLng } from "@/lib/geo";
import { THREAT_STYLES, useFloodInfo } from "@/lib/use-flood-info";
import { useLocation } from "@/lib/use-location";
import { useSettings } from "@/lib/use-settings";

const LocationMap = dynamic(() => import("./location-map"), {
  ssr: false,
  loading: () => <div className="h-full w-full bg-background" />,
});

/** White pill used for the buttons floating over the map. */
const FLOATING = "rounded-full shadow-lg hover:bg-primary/90 active:bg-blue-100";

/** Full-screen map; location setup and settings live in the sidebar. */
export function HomeScreen() {
  const location = useLocation();
  const { settings, update } = useSettings();
  const [menuOpen, setMenuOpen] = useState(false);
  const [recenterSignal, setRecenterSignal] = useState(0);
  const [panned, setPanned] = useState(false);
  const onUserPan = useCallback(() => setPanned(true), []);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const [reporting, setReporting] = useState(false);
  const closeReport = useCallback(() => setReporting(false), []);

  const { status, error: locationError, request: requestLocation } = location;

  useEffect(() => {
    if (!locationError) return;
    toast.error("Couldn't find your location", {
      id: "location-error",
      description: locationError,
      action: { label: "Try again", onClick: requestLocation },
    });
  }, [locationError, requestLocation]);
  const needsLocation = status !== "granted" && status !== "locating" && status !== "checking";
  // Don't show a stale saved position as if it were live once location is off.
  const coords = needsLocation ? null : location.coords;
  const floodInfo = useFloodInfo(coords);
  const threat = floodInfo.threat.data;
  const [focus, setFocus] = useState<MapFocus>({ signal: 0, target: "threat" });
  const showArea = useCallback((target: MapFocus["target"]) => {
    setMenuOpen(false);
    setFocus((f) => ({ signal: f.signal + 1, target }));
  }, []);
  const alerts = useAlerts(coords);

  // Notifications open the app at the place they're about (/?lat=&lng=).
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const at = parseLatLng(params);
    if (!at) return;
    window.history.replaceState(null, "", window.location.pathname);
    // Synchronize the external notification URL after browser hydration.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    showArea({ lat: at.latitude, lng: at.longitude });
  }, [showArea]);

  const { refresh } = floodInfo;
  const onReportSent = useCallback(
    (at: { lat: number; lng: number }) => {
      refresh();
      showArea(at);
    },
    [refresh, showArea],
  );

  return (
    <div className="fixed inset-0">
      <LocationMap
        coords={coords}
        mapStyle={settings.mapStyle}
        recenterSignal={recenterSignal}
        onUserPan={onUserPan}
        threat={coords ? threat : null}
        reports={coords ? (floodInfo.reports.data ?? []) : []}
        focus={focus}
      />

      {coords && threat && (
        <Button
          onClick={() => setMenuOpen(true)}
          className={`${FLOATING} absolute left-1/2 top-[max(1rem,env(safe-area-inset-top))] z-[1000] h-12 max-w-[calc(100vw-9rem)] -translate-x-1/2 gap-2 px-4 font-semibold`}
        >
          <span className="size-3 shrink-0 rounded-full" style={{ backgroundColor: THREAT_STYLES[threat.level].color }} />
          <span className="truncate">
            {threat.level === "none" ? threat.headline : `${THREAT_STYLES[threat.level].label} flood risk`}
          </span>
        </Button>
      )}

      <Button
        size="icon"
        onClick={() => setMenuOpen(true)}
        aria-label="Open menu"
        aria-expanded={menuOpen}
        className={`${FLOATING} absolute left-4 top-[max(1rem,env(safe-area-inset-top))] z-[1000] size-12`}
      >
        <MenuIcon className="size-[22px]" strokeWidth={2.25} />
        {needsLocation && (
          <span className="absolute right-0.5 top-0.5 size-3 rounded-full bg-warning ring-2 ring-primary" />
        )}
      </Button>

      <div className="pointer-events-none absolute inset-x-0 bottom-0 z-[1000] mx-auto flex max-w-md flex-col items-end gap-3 px-4 pb-[max(1rem,env(safe-area-inset-bottom))]">
        {coords && panned && (
          <Button
            onClick={() => {
              setRecenterSignal((n) => n + 1);
              setPanned(false);
            }}
            className={`${FLOATING} pointer-events-auto h-10 self-center px-4 font-semibold`}
          >
            <LocateFixedIcon /> My location
          </Button>
        )}

        {/* Available without device location: a photo with GPS data places itself. */}
        {status !== "checking" && (
          <Button
            onClick={() => setReporting(true)}
            className="pointer-events-auto h-12 gap-2 rounded-full bg-warning md:self-center px-5 font-bold text-warning-foreground shadow-lg hover:bg-warning/90"
          >
            <CameraIcon className="size-5" /> Report flooding
          </Button>
        )}

        {status === "locating" && (
          <Badge variant="secondary" className="h-9 self-center bg-background/95 px-4 text-sm font-normal text-muted-foreground shadow-lg">
            <Loader2Icon className="animate-spin" /> Finding you…
          </Badge>
        )}

        {needsLocation && (
          <button
            type="button"
            onClick={() => setMenuOpen(true)}
            className="pointer-events-auto flex w-full items-center gap-3 rounded-2xl bg-background/95 p-4 text-left shadow-2xl ring-1 ring-border backdrop-blur outline-none focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-background"
          >
            <span className="size-2.5 shrink-0 rounded-full bg-warning" />
            <span className="flex-1 text-sm leading-5">
              <strong className="block">Location is off</strong>
              <span className="text-muted-foreground">Set it up to see flood warnings near you</span>
            </span>
            <ChevronRightIcon className="size-4 text-muted-foreground" />
          </button>
        )}
      </div>

      <ReportFlood open={reporting} coords={coords} onClose={closeReport} onSent={onReportSent} />

      <Sidebar
        open={menuOpen}
        onClose={closeMenu}
        location={location}
        settings={settings}
        onSettingsChange={update}
        floodInfo={coords ? floodInfo : null}
        alerts={alerts}
        onShowArea={showArea}
      />
    </div>
  );
}
