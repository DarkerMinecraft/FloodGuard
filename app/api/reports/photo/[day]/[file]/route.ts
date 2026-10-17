import { downloadReportPhoto } from "@/lib/azure-storage";

/** Serves an approved report photo from the private container. */
export async function GET(_request: Request, ctx: RouteContext<"/api/reports/photo/[day]/[file]">) {
  const { day, file } = await ctx.params;
  try {
    const photo = await downloadReportPhoto(`${day}/${file}`);
    // Only approved photos are public; rejected and unchecked ones look like they don't exist.
    if (!photo || photo.moderation !== "approved") return new Response("Not found", { status: 404 });
    return new Response(new Uint8Array(photo.data), {
      headers: {
        "Content-Type": photo.contentType,
        // Blobs are write-once (uploads use If-None-Match: *), so the bytes never change.
        "Cache-Control": "public, max-age=86400, immutable",
        "X-Content-Type-Options": "nosniff",
      },
    });
  } catch (err) {
    console.error("Report photo download failed", err);
    return new Response("Couldn't load photo", { status: 502 });
  }
}
