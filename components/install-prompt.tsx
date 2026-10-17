"use client";

import { useEffect, useState } from "react";
import { DownloadIcon } from "lucide-react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

type BeforeInstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function InstallPrompt() {
  const [platform, setPlatform] = useState<"ios" | "other" | "installed" | null>(null);
  const [deferred, setDeferred] = useState<BeforeInstallPromptEvent | null>(null);

  useEffect(() => {
    const standalone =
      window.matchMedia("(display-mode: standalone)").matches ||
      (navigator as Navigator & { standalone?: boolean }).standalone === true;
    const ios =
      /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    // Browser capabilities cannot be read during server rendering.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setPlatform(standalone ? "installed" : ios ? "ios" : "other");

    // Chrome/Edge/Samsung Internet on Android fire this when the app is installable.
    const onPrompt = (e: Event) => {
      e.preventDefault();
      setDeferred(e as BeforeInstallPromptEvent);
    };
    const onInstalled = () => setPlatform("installed");
    window.addEventListener("beforeinstallprompt", onPrompt);
    window.addEventListener("appinstalled", onInstalled);
    return () => {
      window.removeEventListener("beforeinstallprompt", onPrompt);
      window.removeEventListener("appinstalled", onInstalled);
    };
  }, []);

  if (platform === null || platform === "installed") return null;
  if (platform === "other" && !deferred) return null;

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="font-semibold">Install FloodGuard</CardTitle>
        <CardDescription className="leading-6">
          {platform === "ios" ? (
            <>
              Tap the <strong className="text-foreground">Share</strong> button in Safari, then choose{" "}
              <strong className="text-foreground">Add to Home Screen</strong> to get FloodGuard as an app.
            </>
          ) : (
            "Add FloodGuard to your home screen for quick access to warnings."
          )}
        </CardDescription>
      </CardHeader>
      {platform !== "ios" && (
        <CardContent>
          <Button
            size="lg"
            className="h-11 w-full rounded-xl font-semibold"
            onClick={async () => {
              await deferred?.prompt();
              const choice = await deferred?.userChoice;
              setDeferred(null);
              if (choice?.outcome === "accepted") toast.success("FloodGuard is being added to your home screen");
            }}
          >
            <DownloadIcon /> Install app
          </Button>
        </CardContent>
      )}
    </Card>
  );
}
