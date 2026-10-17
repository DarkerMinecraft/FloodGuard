"use client";

import { useState } from "react";
import { BellIcon, BellOffIcon, Loader2Icon, MapPinIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { Switch } from "@/components/ui/switch";
import type { AlertLevel, useAlerts } from "@/lib/use-alerts";
import type { useLocation } from "@/lib/use-location";

type Alerts = ReturnType<typeof useAlerts>;
type Location = ReturnType<typeof useLocation>;

const LEVEL_OPTIONS: { value: AlertLevel; label: string }[] = [
  { value: "low", label: "Low risk and above" },
  { value: "moderate", label: "Moderate risk and above" },
  { value: "high", label: "High risk and above" },
  { value: "severe", label: "Severe risk only" },
];

/** Reports a hook result: a message means it failed. */
function report(error: string | null, success?: { title: string; description?: string }) {
  if (error) toast.error(error);
  else if (success) toast.success(success.title, { description: success.description });
}

export function AlertsPanel({ alerts, location }: { alerts: Alerts; location: Location }) {
  const { status } = alerts;

  if (status === "checking") return <Skeleton className="h-32 w-full rounded-xl" />;
  if (status === "unsupported") {
    return <Note>This browser can&apos;t show notifications, so flood alerts aren&apos;t available here.</Note>;
  }
  if (status === "needs-install") {
    return (
      <Note>
        On iPhone and iPad, alerts work from the home-screen app: add FloodGuard to your Home Screen (see below), open it
        from there, then turn alerts on.
      </Note>
    );
  }
  if (status === "unavailable") return <Note>Flood alerts aren&apos;t set up on this server yet.</Note>;
  if (status === "denied") {
    return (
      <Note>
        Notifications are blocked for FloodGuard. Allow them in your browser&apos;s site settings to get flood alerts.
      </Note>
    );
  }
  return status === "on" ? <AlertsOn alerts={alerts} location={location} /> : <AlertsOff alerts={alerts} location={location} />;
}

function AlertsOff({ alerts, location }: { alerts: Alerts; location: Location }) {
  async function turnOn(shareLocation: boolean) {
    // Sharing "always" needs location too; ask in the same tap, as browsers expect.
    if (shareLocation && location.status !== "granted" && location.status !== "locating") location.request();
    report(await alerts.enable({ shareLocation }), {
      title: "Flood alerts are on",
      description: shareLocation
        ? "You'll be warned about flooding near you, even when the app is closed."
        : "Save places below to be warned about flooding there.",
    });
  }

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 font-semibold">
          <BellIcon className="size-4" /> Get warned, even when the app is closed
        </CardTitle>
        <CardDescription className="leading-6">
          Share your location with FloodGuard permanently and you&apos;ll get a notification when flood risk rises or
          flooding is reported within 5 km.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-2">
        <Button size="lg" className="h-11 w-full rounded-xl font-semibold" disabled={alerts.busy} onClick={() => turnOn(true)}>
          {alerts.busy ? <Loader2Icon className="animate-spin" /> : <MapPinIcon />}
          Always share location &amp; alert me
        </Button>
        <Button variant="ghost" className="w-full" disabled={alerts.busy} onClick={() => turnOn(false)}>
          Only alert me for places I save
        </Button>
      </CardContent>
    </Card>
  );
}

function AlertsOn({ alerts, location }: { alerts: Alerts; location: Location }) {
  const [label, setLabel] = useState("");
  const [saving, setSaving] = useState(false);
  const coords = location.status === "granted" ? location.coords : null;
  const last = alerts.places.find((p) => p.kind === "last");
  const full = alerts.savedPlaces.length >= alerts.maxSaved;

  async function savePlace() {
    if (!coords || !label.trim()) return;
    setSaving(true);
    const error = await alerts.addPlace(label.trim(), coords);
    setSaving(false);
    report(error, { title: `Saved “${label.trim()}”`, description: "You'll be warned about flooding there too." });
    if (!error) setLabel("");
  }

  return (
    <Card size="sm">
      <CardContent className="flex flex-col gap-4">
        <div className="flex items-start gap-3">
          <div className="flex-1">
            <Label htmlFor="alerts-share" className="text-sm font-semibold">
              Always share my location
            </Label>
            <p className="mt-0.5 text-xs leading-5 text-muted-foreground">
              {alerts.shareLocation
                ? last
                  ? `Alerts follow you. Last updated ${new Date(last.updatedAt).toLocaleString()}; it refreshes each time you open FloodGuard.`
                  : "Open FloodGuard with location on to start alerts where you are."
                : "Off: only your saved places get alerts."}
            </p>
          </div>
          <Switch
            id="alerts-share"
            disabled={alerts.busy}
            checked={alerts.shareLocation}
            onCheckedChange={async (share) => {
              if (share && location.status !== "granted" && location.status !== "locating") location.request();
              report(await alerts.setShareLocation(share), {
                title: share ? "Sharing your location for alerts" : "Stopped sharing your location",
              });
            }}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <Label className="text-sm font-semibold">Alert me about</Label>
          <Select
            value={alerts.minLevel}
            onValueChange={async (level) => report(await alerts.setMinLevel(level as AlertLevel), { title: "Alert level updated" })}
          >
            <SelectTrigger className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {LEVEL_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>
                  {o.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">New flood reports within 5 km always alert you.</p>
        </div>

        <Separator />

        <div className="flex flex-col gap-2">
          <Label className="text-sm font-semibold">Saved places</Label>
          {alerts.savedPlaces.length === 0 && (
            <p className="text-xs text-muted-foreground">Save places like home or work to be warned about them anywhere.</p>
          )}
          {alerts.savedPlaces.map((place) => (
            <div key={place.id} className="flex items-center gap-2 rounded-lg bg-muted px-3 py-1.5">
              <MapPinIcon className="size-4 shrink-0 text-muted-foreground" />
              <span className="flex-1 truncate text-sm">{place.label}</span>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${place.label}`}
                onClick={async () => report(await alerts.removePlace(place.id), { title: `Removed “${place.label}”` })}
              >
                <Trash2Icon />
              </Button>
            </div>
          ))}
          {!full && (
            <form
              className="flex gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                void savePlace();
              }}
            >
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                maxLength={40}
                placeholder="Name this spot, e.g. Home"
                aria-label="Place name"
                className="h-9"
              />
              <Button type="submit" variant="secondary" className="h-9" disabled={!coords || !label.trim() || saving}>
                {saving ? <Loader2Icon className="animate-spin" /> : <PlusIcon />} Save
              </Button>
            </form>
          )}
          {!full && !coords && (
            <p className="text-xs text-muted-foreground">Turn on location to save where you are now.</p>
          )}
        </div>

        <Button
          variant="ghost"
          className="w-full text-muted-foreground"
          disabled={alerts.busy}
          onClick={async () => report(await alerts.disable(), { title: "Flood alerts are off" })}
        >
          <BellOffIcon /> Turn off alerts
        </Button>
      </CardContent>
    </Card>
  );
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="text-sm leading-6 text-muted-foreground">{children}</p>;
}
