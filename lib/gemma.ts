import "server-only";

// Gemma 4 through the Gemini API (Google AI Studio key). Gemma 4 is multimodal and
// supports system instructions and schema-constrained JSON output.
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";
const MODEL = process.env.GEMMA_MODEL?.trim() || "gemma-4-26b-a4b-it";
// Tried when the main model keeps failing (Gemini returns intermittent 500/503 "high
// demand" errors). Slower, but usually has capacity when the main one doesn't.
const FALLBACK_MODEL = process.env.GEMMA_FALLBACK_MODEL?.trim() || "gemma-4-31b-it";

export type GemmaPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/** Google's own safety filters refused the input or output (e.g. an explicit image). */
export class GemmaBlockedError extends Error {}

export function gemmaConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/** Runs one prompt and returns the parsed JSON matching `schema`. Callers must still validate it. */
export async function generateJson(options: {
  system: string;
  parts: GemmaPart[];
  schema: object;
  maxOutputTokens?: number;
  timeoutMs?: number;
}): Promise<unknown> {
  const request = JSON.stringify({
    systemInstruction: { parts: [{ text: options.system }] },
    contents: [{ role: "user", parts: options.parts }],
    // temperature 0 so the same input gives the same answer; the token cap stops a runaway generation.
    generationConfig: {
      responseMimeType: "application/json",
      responseSchema: options.schema,
      temperature: 0,
      maxOutputTokens: options.maxOutputTokens ?? 1024,
    },
  });
  // A timeout or network error comes back as null and is treated like a 5xx.
  const call = (model: string): Promise<Response | null> =>
    fetch(`${GEMINI_API}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
      body: request,
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    }).catch((err: Error) => {
      console.warn(`Gemma: ${model} request failed (${err.name})`);
      return null;
    });
  const transient = (r: Response | null) => !r || r.status >= 500 || r.status === 429;

  let res = await call(MODEL);
  // One retry clears most transient errors; if not, try the fallback model.
  if (transient(res)) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await call(MODEL);
  }
  if (transient(res) && FALLBACK_MODEL && FALLBACK_MODEL !== MODEL) {
    console.warn(`Gemma: ${MODEL} unavailable (${res?.status ?? "timeout"}), trying ${FALLBACK_MODEL}`);
    res = await call(FALLBACK_MODEL);
  }
  if (!res) throw new Error("Gemini API unreachable or timed out");
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const body = (await res.json()) as {
    promptFeedback?: { blockReason?: string };
    candidates?: { finishReason?: string; content?: { parts?: { text?: string }[] } }[];
  };
  if (body.promptFeedback?.blockReason) throw new GemmaBlockedError(`Input blocked: ${body.promptFeedback.blockReason}`);
  const candidate = body.candidates?.[0];
  const finish = candidate?.finishReason;
  if (finish && ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"].includes(finish)) {
    throw new GemmaBlockedError(`Output blocked: ${finish}`);
  }
  if (finish && finish !== "STOP") throw new Error(`Gemma stopped early: ${finish}`);
  return parseFirstJson(candidate?.content?.parts?.map((p) => p.text ?? "").join("") ?? "");
}

/**
 * Gemma occasionally follows the schema-constrained JSON with extra text (a second
 * object, a stray line). Parse the first complete top-level object and ignore the rest.
 */
function parseFirstJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    let depth = 0;
    let inString = false;
    for (let i = start; start >= 0 && i < text.length; i++) {
      const c = text[i];
      if (inString) {
        if (c === "\\") i++;
        else if (c === '"') inString = false;
      } else if (c === '"') inString = true;
      else if (c === "{") depth++;
      else if (c === "}" && --depth === 0) return JSON.parse(text.slice(start, i + 1));
    }
    throw new Error(`Gemma returned unparseable JSON: ${text.slice(0, 200)}`);
  }
}
