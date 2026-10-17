import "server-only";

export class BodyTooLargeError extends Error {}

/** Bound actual bytes before parsing, including chunked uploads. */
async function limitedBody(request: Request, maxBytes: number): Promise<Blob> {
  if (Number(request.headers.get("content-length")) > maxBytes) throw new BodyTooLargeError();
  if (!request.body) throw new Error("Missing request body");
  const reader = request.body.getReader();
  const chunks: ArrayBuffer[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw new BodyTooLargeError();
      }
      chunks.push(value.slice().buffer as ArrayBuffer);
    }
  } finally {
    reader.releaseLock();
  }
  return new Blob(chunks);
}

export async function limitedFormData(request: Request, maxBytes: number): Promise<FormData> {
  return new Response(await limitedBody(request, maxBytes), {
    headers: { "Content-Type": request.headers.get("content-type") ?? "" },
  }).formData();
}

/** Alert settings are small; never buffer arbitrarily large JSON request bodies. */
export async function limitedJson(request: Request, maxBytes = 16 * 1024): Promise<unknown> {
  return JSON.parse(await (await limitedBody(request, maxBytes)).text());
}
