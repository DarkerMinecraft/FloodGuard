"use client";

import { useEffect, useRef, useState } from "react";
import { CameraIcon, Loader2Icon, MapPinIcon, TriangleAlertIcon } from "lucide-react";
import { toast } from "sonner";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Sheet, SheetContent, SheetDescription, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { embedPhotoMeta, readPhotoMeta, type PhotoMeta } from "@/lib/photo-exif";
import type { Coordinates } from "@/lib/use-location";

const MAX_DIMENSION = 2048;
const MAX_NOTE_LENGTH = 500;

/**
 * Re-encodes the photo as a JPEG no larger than MAX_DIMENSION. This keeps uploads
 * small on mobile data and turns iPhone HEIC into something every browser can show.
 * The canvas drops all EXIF, so the photo's GPS position and capture time are
 * written back afterwards; nothing else from the original EXIF is kept.
 */
async function prepareImage(file: File, meta: PhotoMeta): Promise<Blob> {
  const bitmap = await createImageBitmap(file);
  const scale = Math.min(1, MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement("canvas");
  canvas.width = Math.round(bitmap.width * scale);
  canvas.height = Math.round(bitmap.height * scale);
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  const jpeg = await new Promise<Blob>((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))), "image/jpeg", 0.85),
  );
  return meta ? embedPhotoMeta(jpeg, meta) : jpeg;
}

/**
 * Bottom sheet for sending a photo of flooding. The report is placed where the photo
 * was taken when it carries GPS data, otherwise at the user's current location.
 * The outcome (on the map, held for review, or failed) is announced with a toast.
 */
export function ReportFlood({
  open,
  coords,
  onClose,
  onSent,
}: {
  open: boolean;
  coords: Coordinates | null;
  onClose: () => void;
  /** Called after a report is stored with where it was placed, so the map and lists can update. */
  onSent: (at: { lat: number; lng: number }) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={(next) => !next && onClose()}>
      <SheetContent
        side="bottom"
        className="mx-auto max-h-[90dvh] max-w-md gap-0 overflow-y-auto rounded-t-3xl border-x pb-[max(1rem,env(safe-area-inset-bottom))]"
      >
        <SheetHeader className="pb-2">
          <SheetTitle className="text-lg font-bold">Report flooding</SheetTitle>
          <SheetDescription>Share a photo so others nearby can stay safe.</SheetDescription>
        </SheetHeader>
        {/* The sheet's content unmounts when closed, so each report starts from a clean form. */}
        <ReportForm coords={coords} onClose={onClose} onSent={onSent} />
      </SheetContent>
    </Sheet>
  );
}

function ReportForm({
  coords,
  onClose,
  onSent,
}: {
  coords: Coordinates | null;
  onClose: () => void;
  onSent: (at: { lat: number; lng: number }) => void;
}) {
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [note, setNote] = useState("");
  const [photoMeta, setPhotoMeta] = useState<PhotoMeta>(null);
  const [readingMeta, setReadingMeta] = useState(false);
  const [useDeviceLocation, setUseDeviceLocation] = useState(false);
  const [sending, setSending] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    // Object URLs belong to the browser and must be created/revoked with this effect.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!file) return setPreview(null);
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // Where the report goes: the photo's own GPS unless the user picked their current location.
  const location =
    photoMeta && !(useDeviceLocation && coords)
      ? { source: "photo" as const, latitude: photoMeta.latitude, longitude: photoMeta.longitude, accuracy: null }
      : coords
        ? { source: "device" as const, latitude: coords.latitude, longitude: coords.longitude, accuracy: coords.accuracy }
        : null;

  async function choose(next: File | null) {
    setFile(next);
    setPhotoMeta(null);
    setUseDeviceLocation(false);
    if (!next) return;
    setReadingMeta(true);
    const meta = await readPhotoMeta(next);
    setReadingMeta(false);
    setPhotoMeta(meta);
  }

  async function submit() {
    if (!file || !location) return;
    setSending(true);
    const id = toast.loading("Checking & sending your report…");

    let photo: Blob;
    try {
      photo = await prepareImage(file, photoMeta);
    } catch {
      setSending(false);
      toast.error("That photo couldn't be read", { id, description: "Try another one." });
      return;
    }

    try {
      const body = new FormData();
      body.append("photo", photo, "report.jpg");
      body.append("latitude", String(location.latitude));
      body.append("longitude", String(location.longitude));
      if (location.accuracy !== null) body.append("accuracy", String(location.accuracy));
      body.append("locationSource", location.source);
      if (note.trim()) body.append("note", note.trim());

      const res = await fetch("/api/reports", { method: "POST", body });
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as { error?: string } | null;
        throw new Error(data?.error ?? "Please try again.");
      }
      const placed = (await res.json()) as { status?: string; latitude: number; longitude: number };
      // "pending": stored, but the AI check couldn't run yet, so it isn't public yet.
      if (placed.status === "pending") {
        toast.info("Report received", {
          id,
          description: "It will appear on the map once our automatic check has run.",
        });
      } else {
        toast.success("Thanks — your report is on the map", {
          id,
          description: "It helps others nearby stay safe.",
        });
      }
      onSent({ lat: placed.latitude, lng: placed.longitude });
      onClose();
    } catch (err) {
      setSending(false);
      // fetch() rejects with a TypeError when there's no connection.
      const offline = err instanceof TypeError;
      toast.error(offline ? "You seem to be offline" : "Couldn't send your report", {
        id,
        description: offline ? "Try again when you have signal." : (err as Error).message,
      });
    }
  }

  return (
    <div className="flex flex-col gap-4 px-4">
      <input
        ref={input}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={(e) => choose(e.target.files?.[0] ?? null)}
      />
      <button
        type="button"
        onClick={() => input.current?.click()}
        disabled={sending}
        className="grid aspect-[4/3] w-full place-items-center overflow-hidden rounded-2xl border border-dashed bg-card outline-none transition-colors hover:bg-muted focus-visible:ring-3 focus-visible:ring-ring/50 active:bg-accent"
      >
        {preview ? (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={preview} alt="Selected photo" className="h-full w-full object-cover" />
        ) : (
          <span className="flex flex-col items-center gap-2 text-sm font-medium text-muted-foreground">
            <CameraIcon className="size-8" />
            Take or choose a photo
          </span>
        )}
      </button>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor="report-note" className="text-xs uppercase tracking-wide text-muted-foreground">
          Note (optional)
        </Label>
        <Textarea
          id="report-note"
          value={note}
          onChange={(e) => setNote(e.target.value)}
          maxLength={MAX_NOTE_LENGTH}
          rows={2}
          placeholder="e.g. Road under water near the bridge"
          className="min-h-0 resize-none"
        />
      </div>

      {file && (
        <LocationNote
          reading={readingMeta}
          photoMeta={photoMeta}
          hasDevice={coords !== null}
          source={location?.source ?? null}
          onToggle={() => setUseDeviceLocation((v) => !v)}
        />
      )}

      <p className="text-xs text-muted-foreground">Don&apos;t put yourself at risk to take a photo.</p>

      <Button
        size="lg"
        className="h-12 w-full rounded-xl text-base font-semibold"
        disabled={!file || !location || readingMeta || sending}
        onClick={submit}
      >
        {sending && <Loader2Icon className="animate-spin" />}
        {sending ? "Checking & sending…" : "Send report"}
      </Button>
    </div>
  );
}

function LocationNote({
  reading,
  photoMeta,
  hasDevice,
  source,
  onToggle,
}: {
  reading: boolean;
  photoMeta: PhotoMeta;
  hasDevice: boolean;
  source: "photo" | "device" | null;
  onToggle: () => void;
}) {
  if (reading) {
    return (
      <p className="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2Icon className="size-4 animate-spin" /> Reading photo location…
      </p>
    );
  }

  const toggle = (label: string) => (
    <Button variant="link" onClick={onToggle} className="ml-1 h-auto p-0 font-semibold text-foreground underline">
      {label}
    </Button>
  );

  if (source === "photo" && photoMeta) {
    return (
      <Alert>
        <MapPinIcon />
        <AlertDescription>
          <p>
            Using the location saved in this photo ({photoMeta.latitude.toFixed(4)},{" "}
            {photoMeta.longitude.toFixed(4)}){photoMeta.takenAt && <>, taken {photoMeta.takenAt.toLocaleString()}</>}.
            {hasDevice && toggle("Use my current location")}
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  if (source === "device") {
    return (
      <Alert>
        <MapPinIcon />
        <AlertDescription>
          <p>
            Your current location will be attached.
            {photoMeta ? toggle("Use the photo's location") : " This photo has no location data."}
          </p>
        </AlertDescription>
      </Alert>
    );
  }
  return (
    <Alert className="border-warning/40 text-warning">
      <TriangleAlertIcon />
      <AlertDescription className="text-warning/90">
        This photo has no location data and your location is off. Turn on location, or choose a photo taken with
        location enabled.
      </AlertDescription>
    </Alert>
  );
}
