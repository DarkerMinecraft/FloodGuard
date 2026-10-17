// Runs once per server start. Schedules the flood alert check (lib/alerts.ts) so
// subscribers are warned while their app is closed.
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs") return;

  const minutes = Number(process.env.ALERT_CHECK_INTERVAL_MINUTES?.trim() || 10);
  if (!(minutes > 0)) return;

  const { alertsConfigured, runAlertCheck } = await import("@/lib/alerts");
  if (!alertsConfigured) return;

  const run = () => runAlertCheck().catch((err) => console.error("Scheduled alert check failed", err));
  // Don't keep the process alive just for the timer.
  console.info(`Alert checks scheduled every ${minutes} min`);
  setInterval(run, minutes * 60_000).unref();
  setTimeout(run, 30_000).unref();
}
