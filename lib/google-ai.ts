import "server-only";

// Google AI (Gemini API, Google AI Studio key) for two jobs:
// - GEMINI_VISION: a regular Gemini model looks at each report photo once, at upload, to
//   decide whether it shows flooding and describe how bad it is (lib/moderation.ts).
// - GEMMA: Gemma 4 makes the text-only alert decision from those findings plus the
//   river, rain and sea-level data (lib/threat.ts). It never sees photos.
const GEMINI_API = "https://generativelanguage.googleapis.com/v1beta/models";

export type ModelPair = { primary: string; fallback: string };

export const GEMINI_VISION: ModelPair = {
  primary: process.env.GEMINI_VISION_MODEL?.trim() || "gemini-3.5-flash",
  fallback: process.env.GEMINI_VISION_FALLBACK_MODEL?.trim() || "gemini-3.1-flash-lite",
};

// Gemini returns intermittent 500/503 "high demand" errors; the fallback usually has capacity.
export const GEMMA: ModelPair = {
  primary: process.env.GEMMA_MODEL?.trim() || "gemma-4-26b-a4b-it",
  fallback: process.env.GEMMA_FALLBACK_MODEL?.trim() || "gemma-4-31b-it",
};

export type AiPart = { text: string } | { inlineData: { mimeType: string; data: string } };

/** Google's own safety filters refused the input or output (e.g. an explicit image). */
export class AiBlockedError extends Error {}

export function googleAiConfigured(): boolean {
  return Boolean(process.env.GEMINI_API_KEY);
}

/** Runs one prompt and returns the parsed JSON matching `schema`. Callers must still validate it. */
export async function generateJson(options: {
  models: ModelPair;
  system: string;
  parts: AiPart[];
  schema: object;
  maxOutputTokens?: number;
  timeoutMs?: number;
}): Promise<unknown> {
  const requestFor = (model: string) => {
    // Gemini 3 models think before answering: keep it short, and leave room for those
    // tokens in the cap. Google recommends their default temperature for them; Gemma
    // gets temperature 0 so the same input gives the same answer.
    const gemini3 = model.startsWith("gemini-3");
    return JSON.stringify({
      systemInstruction: { parts: [{ text: options.system }] },
      contents: [{ role: "user", parts: options.parts }],
      generationConfig: {
        responseMimeType: "application/json",
        responseSchema: options.schema,
        maxOutputTokens: (options.maxOutputTokens ?? 1024) + (gemini3 ? 2048 : 0),
        ...(gemini3 ? { thinkingConfig: { thinkingLevel: "low" } } : { temperature: 0 }),
      },
    });
  };
  // A timeout or network error comes back as null and is treated like a 5xx.
  const call = (model: string): Promise<Response | null> =>
    fetch(`${GEMINI_API}/${model}:generateContent`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-goog-api-key": process.env.GEMINI_API_KEY! },
      body: requestFor(model),
      signal: AbortSignal.timeout(options.timeoutMs ?? 30_000),
    }).catch((err: Error) => {
      console.warn(`Google AI: ${model} request failed (${err.name})`);
      return null;
    });
  const transient = (r: Response | null) => !r || r.status >= 500 || r.status === 429;

  const { primary, fallback } = options.models;
  let res = await call(primary);
  // One retry clears most transient errors; if not, try the fallback model.
  if (transient(res)) {
    await new Promise((r) => setTimeout(r, 1500));
    res = await call(primary);
  }
  if (transient(res) && fallback && fallback !== primary) {
    console.warn(`Google AI: ${primary} unavailable (${res?.status ?? "timeout"}), trying ${fallback}`);
    res = await call(fallback);
  }
  if (!res) throw new Error("Gemini API unreachable or timed out");
  if (!res.ok) throw new Error(`Gemini API ${res.status}: ${(await res.text()).slice(0, 300)}`);

  const body = (await res.json()) as {
    promptFeedback?: { blockReason?: string };
    candidates?: { finishReason?: string; content?: { parts?: { text?: string; thought?: boolean }[] } }[];
  };
  if (body.promptFeedback?.blockReason) throw new AiBlockedError(`Input blocked: ${body.promptFeedback.blockReason}`);
  const candidate = body.candidates?.[0];
  const finish = candidate?.finishReason;
  if (finish && ["SAFETY", "PROHIBITED_CONTENT", "BLOCKLIST", "SPII", "IMAGE_SAFETY"].includes(finish)) {
    throw new AiBlockedError(`Output blocked: ${finish}`);
  }
  if (finish && finish !== "STOP") throw new Error(`Model stopped early: ${finish}`);
  const text = candidate?.content?.parts?.filter((p) => !p.thought).map((p) => p.text ?? "").join("") ?? "";
  return parseFirstJson(text);
}

/**
 * Models occasionally follow the schema-constrained JSON with extra text (a second
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
    throw new Error(`Model returned unparseable JSON: ${text.slice(0, 200)}`);
  }
}
