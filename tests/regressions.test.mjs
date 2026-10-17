import assert from "node:assert/strict";
import { createECDH, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import test from "node:test";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual TypeScript modules with external services replaced. No Azure
// credentials, database, network, or additional test dependencies are needed.
const require = createRequire(import.meta.url);
const root = new URL("../", import.meta.url);
function load(file, mocks = {}, globals = {}, env = {}) {
  const code = ts.transpileModule(readFileSync(new URL(file, root), "utf8"), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022, esModuleInterop: true },
  }).outputText;
  const sandboxModule = { exports: {} };
  vm.runInNewContext(code, {
    module: sandboxModule, exports: sandboxModule.exports,
    require: (name) => name === "server-only" ? {} : Object.hasOwn(mocks, name) ? mocks[name] : require(name),
    process: { env }, Buffer, URL, Request, Response, Blob, FormData, AbortSignal,
    console: { info() {}, warn() {}, error() {}, log() {} },
    setTimeout, clearTimeout, setInterval, clearInterval,
    ...globals,
  }, { filename: file });
  return sandboxModule.exports;
}

const geo = load("lib/geo.ts");
const push = load("lib/push-validation.ts");
const ecdh = createECDH("prime256v1");
ecdh.generateKeys();
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/example",
  keys: { p256dh: ecdh.getPublicKey().toString("base64url"), auth: randomBytes(16).toString("base64url") },
};
const unique = Object.assign(new Error("duplicate"), { code: "P2002" });
function alerts(database, sendNotification = async () => {}, configured = false) {
  return load("lib/alerts.ts", {
    "@/lib/db": { db: () => database, dbConfigured: configured, isUniqueViolation: (err) => err.code === "P2002" },
    "@/lib/geo": geo,
    "@/lib/push-validation": push,
    "@/lib/threat": { THREAT_LEVELS: ["none", "low", "moderate", "high", "severe"], assessThreat: async () => ({ level: "low", headline: "Risk" }) },
    "web-push": { sendNotification, setVapidDetails() {} },
  }, {}, { NEXT_PUBLIC_VAPID_PUBLIC_KEY: "test", VAPID_PRIVATE_KEY: "test" });
}

test("coordinates reject empty, whitespace, missing and out-of-range values; zero is valid", () => {
  for (const query of ["lat=&lng=0", "lat=%20&lng=1", "lat=0", "lat=91&lng=0", "lat=0&lng=-181", "lat=NaN&lng=0"]) {
    assert.equal(geo.parseLatLng(new URLSearchParams(query)), null, query);
  }
  assert.equal(geo.parseLatLng(new URLSearchParams("lat=0&lng=0")).latitude, 0);
  assert.ok(Number.isFinite(geo.distanceKm(38.21817248128655, 57.543307452986735, -38.21817248128655, 237.54330745298674)));
});

test("push destinations reject SSRF targets, misleading host suffixes, credentials and ports", () => {
  for (const endpoint of ["https://127.0.0.1/a", "https://169.254.169.254/", "https://internal.example/", "https://fcm.googleapis.com.evil.test/a", "https://evilpush.apple.com/a", "https://user@fcm.googleapis.com/a", "https://fcm.googleapis.com:444/a", "http://fcm.googleapis.com/a", "not a url"]) {
    assert.equal(push.isPushEndpoint(endpoint), false, endpoint);
  }
  for (const endpoint of [subscription.endpoint, "https://updates.push.services.mozilla.com/wpush/v2/a", "https://web.push.apple.com/a", "https://wns2-db5p.notify.windows.com/a"]) {
    assert.equal(push.isPushEndpoint(endpoint), true, endpoint);
  }
});

test("push keys must contain a real P-256 point and a 16-byte auth secret", () => {
  assert.equal(push.isPushSubscription(subscription), true);
  for (const keys of [{ ...subscription.keys, auth: "" }, { ...subscription.keys, auth: "x".repeat(22) }, { ...subscription.keys, p256dh: Buffer.alloc(65, 4).toString("base64url") }]) {
    assert.equal(push.isPushSubscription({ ...subscription, keys }), false);
  }
});

test("subscription updates require the original auth secret even after a create race", async () => {
  let row;
  const api = alerts({ pushSubscription: {
    async create({ data }) { if (row) throw unique; row = { ...data }; },
    async updateMany({ where, data }) {
      if (row.endpoint !== where.endpoint || row.auth !== where.auth) return { count: 0 };
      Object.assign(row, data);
      return { count: 1 };
    },
  } });
  assert.equal(await api.upsertSubscription(subscription, "moderate"), true);
  const attacker = { ...subscription, keys: { ...subscription.keys, auth: randomBytes(16).toString("base64url") } };
  assert.equal(await api.upsertSubscription(attacker, "low"), false);
  assert.equal(row.minLevel, "moderate");
  assert.equal(row.auth, subscription.keys.auth);
  assert.equal(await api.upsertSubscription(subscription, "severe"), true);
  assert.equal(row.minLevel, "severe");
});

test("saved-place cap holds for simultaneous transactions serialized by a row lock", async () => {
  let queue = Promise.resolve();
  let count = 0;
  const api = alerts({ async $transaction(fn) {
    let release;
    let locked = false;
    try {
      return await fn({
        async $queryRaw(strings, id) {
          assert.match(strings.join("?"), /FOR UPDATE/);
          assert.equal(id, "subscriber");
          const previous = queue;
          queue = new Promise((resolve) => { release = resolve; });
          await previous;
          locked = true;
        },
        alertPlace: {
          async count() { assert.equal(locked, true); return count; },
          async create() { count++; },
        },
      });
    } finally { release?.(); }
  } });
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) => api.addPlace("subscriber", `Place ${i}`, 0, 0)));
  assert.equal(count, 5);
  assert.equal(results.filter((r) => r === null).length, 5);
  assert.equal(results.filter((r) => typeof r === "string").length, 3);
});

test("report push failures release claims and retry once; successful sends stay deduplicated", async () => {
  const claims = new Set();
  let attempts = 0;
  const place = { id: "place", kind: "saved", label: "Home", latitude: 0, longitude: 0,
    subscription: { id: "sub", ...subscription, ...subscription.keys } };
  const database = {
    alertPlace: { async findMany() { return [place]; } },
    report: { async findMany() { return [{ id: "report", latitude: 0, longitude: 0, note: "Flood" }]; } },
    alertSent: {
      async createMany({ data }) { const key = data[0].ref; if (claims.has(key)) return { count: 0 }; claims.add(key); return { count: 1 }; },
      async deleteMany({ where }) { where.ref.in.forEach((ref) => claims.delete(ref)); },
    },
  };
  const api = alerts(database, async (_subscription, _payload, options) => {
    assert.equal(options.timeout, 10_000);
    if (++attempts === 1) throw Object.assign(new Error("unavailable"), { statusCode: 503 });
  }, true);
  await api.checkNewReportAlerts();
  assert.equal(claims.size, 0);
  await api.checkNewReportAlerts();
  await api.checkNewReportAlerts();
  assert.equal(attempts, 2);
  assert.equal(claims.size, 1);
  // Validation at send time must protect legacy database rows too.
  claims.clear();
  place.subscription.endpoint = "https://169.254.169.254/metadata";
  await api.checkNewReportAlerts();
  assert.equal(attempts, 2);
});

test("first report initializes backfill before uploading and accepts an already-imported ID", async () => {
  const events = [];
  const key = "2026-10-17/00000000-0000-4000-8000-000000000001.jpg";
  const stored = { key, latitude: 0, longitude: 0, accuracy: null, note: "", submittedAt: new Date().toISOString(), locationSource: "device", takenAt: null, moderation: "approved" };
  const api = load("lib/report-store.ts", {
    "@/lib/db": { dbConfigured: true, db: () => ({ report: {
      async count() { events.push("count"); return 0; },
      async upsert({ where, create, update }) {
        events.push("upsert"); assert.equal(where.id, create.id); assert.equal(Object.keys(update).length, 0);
      },
    } }) },
    "@/lib/azure-storage": {
      async listRecentReports() { events.push("backfill"); return []; },
      async uploadReportPhoto() { events.push("upload"); return { id: key.split("/")[1].slice(0, -4), blobName: `pending/${key}` }; },
    },
  }, {}, { AZURE_STORAGE_ACCOUNT_URL: "https://example.blob.core.windows.net" });
  await api.saveReport({ ...stored, moderation: { status: "approved", reason: "OK" } });
  assert.deepEqual(events, ["count", "backfill", "upload", "upsert"]);
});

const noData = { rivers: [], rain: null, seaLevel: null, errors: ["offline"] };
function threat({ data = noData, reports = [], photosOnly = false, reportError = false } = {}) {
  return load("lib/threat.ts", {
    "@/lib/azure-storage": {}, "@/lib/config": { PHOTOS_ONLY: photosOnly },
    "@/lib/flood-data": { fetchFloodData: async () => data },
    "@/lib/gemma": { gemmaConfigured: () => false },
    "@/lib/reports": { nearbyReports: async () => { if (reportError) throw new Error("storage offline"); return reports; } },
  });
}

test("missing environmental data and failed report lookups cannot become all-clear assessments", async () => {
  await assert.rejects(threat().assessThreat(0, 0), /unavailable/);
  await assert.rejects(threat({ photosOnly: true, reportError: true }).assessThreat(0, 0), /storage offline/);
});

test("partial data fallback acknowledges gaps and a nearby report produces at least low risk", async () => {
  const partial = await threat({ data: { ...noData, rain: { next24hMm: 0, maxHourlyNext24hMm: 0 } } }).assessThreat(0, 0);
  assert.equal(partial.confidence, "low");
  assert.match(partial.headline, /available data/);
  assert.doesNotMatch(partial.summary, /look normal/);
  const reported = await threat({ reports: [{ latitude: 0, longitude: 0, distanceKm: 1 }] }).assessThreat(0, 0);
  assert.equal(reported.level, "low");
});

test("malformed null moderation output stays pending rather than throwing", async () => {
  const { moderateReport } = load("lib/moderation.ts", { "@/lib/gemma": {
    GemmaBlockedError: class extends Error {}, gemmaConfigured: () => true, generateJson: async () => null,
  } });
  assert.equal((await moderateReport({ data: new Uint8Array(), contentType: "image/jpeg", note: "" })).status, "pending");
});

test("multipart parser rejects actual oversize chunked bodies despite a false Content-Length", async () => {
  const { limitedFormData, BodyTooLargeError } = load("lib/request-body.ts");
  let cancelled = false;
  const stream = new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(6)); controller.enqueue(new Uint8Array(6)); },
    cancel() { cancelled = true; },
  });
  const request = new Request("https://example.test", { method: "POST", body: stream, duplex: "half", headers: { "Content-Length": "1", "Content-Type": "multipart/form-data; boundary=example" } });
  await assert.rejects(limitedFormData(request, 10), BodyTooLargeError);
  assert.equal(cancelled, true);
});

test("bounded multipart parser still parses valid form uploads", async () => {
  const { limitedFormData } = load("lib/request-body.ts");
  const form = new FormData();
  form.set("note", "Road is flooded");
  const request = new Request("https://example.test", { method: "POST", body: form });
  assert.equal((await limitedFormData(request, 1000)).get("note"), "Road is flooded");
});

test("JSON settings reject oversized actual bodies and still accept small JSON", async () => {
  const { limitedJson, BodyTooLargeError } = load("lib/request-body.ts");
  const request = new Request("https://example.test", { method: "PUT", body: '"' + "x".repeat(50) + '"', headers: { "Content-Length": "1" } });
  await assert.rejects(limitedJson(request, 10), BodyTooLargeError);
  const valid = await limitedJson(new Request("https://example.test", { method: "PUT", body: '{"latitude":0}' }));
  assert.equal(valid.latitude, 0);
});

test("deleted places and expired subscriptions cannot abort alerts for other subscribers", async () => {
  const makePlace = (id, subId) => ({ id, kind: "saved", label: id, latitude: 0, longitude: 0,
    subscription: { id: subId, ...subscription, ...subscription.keys } });
  const places = [makePlace("deleted", "gone-place"), makePlace("expired", "expired"), makePlace("stale", "expired"), makePlace("active", "active")];
  const claims = [];
  const delivered = [];
  const database = {
    alertPlace: { findMany: async () => places },
    report: { findMany: async () => [{ id: "report", latitude: 0, longitude: 0, note: "Flood" }] },
    alertSent: {
      async createMany({ data }) {
        const id = data[0].placeId;
        claims.push(id);
        if (id === "deleted") throw Object.assign(new Error("place deleted"), { code: "P2003" });
        return { count: 1 };
      },
      async deleteMany() {},
    },
    pushSubscription: { async deleteMany() {} },
  };
  const api = alerts(database, async (_sub, payload) => {
    const notification = JSON.parse(payload);
    delivered.push(notification.tag);
    if (notification.tag === "reports-expired") throw Object.assign(new Error("expired"), { statusCode: 410 });
  }, true);
  await api.checkNewReportAlerts();
  assert.deepEqual(claims, ["deleted", "expired", "active"]);
  assert.deepEqual(delivered, ["reports-expired", "reports-active"]);
});

test("a place removed during threat bookkeeping does not stop the full check", async () => {
  const places = ["deleted", "active"].map((id) => ({ id, kind: "saved", label: id, latitude: 0, longitude: 0,
    notifiedLevel: "high", subscription: { id, minLevel: "high", ...subscription, ...subscription.keys } }));
  const updated = [];
  const api = alerts({
    alertPlace: { findMany: async () => places, async update({ where }) {
      updated.push(where.id);
      if (where.id === "deleted") throw Object.assign(new Error("deleted"), { code: "P2025" });
    } },
    report: { findMany: async () => [] },
  }, undefined, true);
  await api.runAlertCheck();
  assert.deepEqual(updated, ["deleted", "active"]);
});

test("missing or partial rain readings are unavailable, never silently treated as zero", async () => {
  const now = new Date(); now.setUTCMinutes(0, 0, 0);
  const times = Array.from({ length: 24 }, (_, i) => new Date(now.getTime() + i * 3_600_000).toISOString().slice(0, 16));
  for (const precipitation of [[], Array(24).fill(null), [null, ...Array(23).fill(0)]]) {
    const api = load("lib/flood-data.ts", {}, { fetch: async (url) => Response.json(
      url.includes("flood-api") ? [] : url.includes("marine-api") ? { hourly: { time: [], sea_level_height_msl: [] } } :
        { hourly: { time: times, precipitation }, daily: { time: [], precipitation_sum: [], precipitation_probability_max: [] } },
    ) });
    const data = await api.fetchFloodData(0, 0);
    assert.equal(data.rain, null);
    assert.equal(data.errors.length, 1);
    assert.match(data.errors[0], /missing hourly readings/);
  }
});

test("stopping location sharing waits for in-flight PUTs and rolls back if deletion fails", async () => {
  for (const deleteFails of [false, true]) {
    const slots = [];
    const effects = [];
    let cursor = 0;
    let effectCursor = 0;
    const react = {
      useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
      useRef(initial) { const i = cursor++; if (!(i in slots)) slots[i] = { current: initial }; return slots[i]; },
      useCallback(callback, deps) {
        const i = cursor++;
        if (!slots[i] || !deps.every((value, j) => value === slots[i].deps[j])) slots[i] = { callback, deps };
        return slots[i].callback;
      },
      useEffect(callback, deps) {
        const i = effectCursor++;
        if (effects[i] && deps.every((value, j) => value === effects[i].deps[j])) return;
        effects[i]?.cleanup?.();
        effects[i] = { callback, deps, pending: true };
      },
    };
    const requests = [];
    let releasePut;
    let preference = "true";
    const browserSub = { endpoint: subscription.endpoint, toJSON: () => subscription };
    const { useAlerts } = load("lib/use-alerts.ts", { react, "@/lib/serial-queue": load("lib/serial-queue.ts") }, {
      localStorage: { getItem: () => preference, setItem: (_key, value) => { preference = value; } },
      window: { PushManager: class {}, Notification: {} },
      navigator: { serviceWorker: { ready: Promise.resolve({ pushManager: { getSubscription: async () => browserSub } }) } },
      Notification: { permission: "granted" },
      fetch: async (url, init) => {
        if (url.endsWith("/places")) return Response.json({ places: [{ id: "last", kind: "last" }], minLevel: "moderate", maxSaved: 5 });
        requests.push(init.method);
        if (init.method === "PUT") return new Promise((resolve) => { releasePut = () => resolve(new Response(null, { status: 204 })); });
        return deleteFails ? Response.json({ error: "Couldn't clear location" }, { status: 502 }) : new Response(null, { status: 204 });
      },
    }, { NEXT_PUBLIC_VAPID_PUBLIC_KEY: "test" });
    const coords = { latitude: 0, longitude: 0 };
    function HookHarness() { cursor = 0; effectCursor = 0; return useAlerts(coords); }
    async function flush() {
      for (const effect of effects) if (effect.pending) { effect.pending = false; effect.cleanup = effect.callback(); }
      await new Promise((resolve) => setImmediate(resolve));
    }
    HookHarness(); await flush();
    HookHarness(); await flush();
    assert.deepEqual(requests, ["PUT"]);
    const stopping = HookHarness().setShareLocation(false);
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(requests, ["PUT"], "DELETE must wait for the outstanding PUT");
    releasePut();
    const error = await stopping;
    assert.deepEqual(requests, ["PUT", "DELETE"]);
    const result = HookHarness();
    assert.equal(result.shareLocation, deleteFails);
    assert.equal(preference, String(deleteFails));
    if (deleteFails) assert.match(error, /clear location/);
    else {
      assert.equal(error, null);
      assert.equal(result.places.some((place) => place.kind === "last"), false);
    }
  }
});

test("offline navigation with no cache always returns a Response", async () => {
  const listeners = {};
  vm.runInNewContext(readFileSync(new URL("public/sw.js", root), "utf8"), {
    self: { addEventListener: (name, callback) => { listeners[name] = callback; } },
    caches: { match: async () => undefined }, fetch: async () => { throw new Error("offline"); }, Response,
  });
  let response;
  listeners.fetch({ request: { method: "GET", mode: "navigate" }, respondWith: (promise) => { response = promise; } });
  const result = await response;
  assert.equal(result.status, 503);
  assert.match(await result.text(), /offline/);
});

test("location changes hide previous-cell data immediately and fetch failures clear it", async () => {
  const slots = [];
  const effects = [];
  let cursor = 0;
  let effectCursor = 0;
  let fail = false;
  const react = {
    useState(initial) { const i = cursor++; if (!(i in slots)) slots[i] = initial; return [slots[i], (value) => { slots[i] = typeof value === "function" ? value(slots[i]) : value; }]; },
    useCallback(callback) { return callback; },
    useEffect(callback, deps) {
      const i = effectCursor++;
      const previous = effects[i];
      if (previous && deps.every((value, j) => value === previous.deps[j])) return;
      previous?.cleanup?.();
      effects[i] = { callback, deps, pending: true };
    },
  };
  const { useFloodInfo } = load("lib/use-flood-info.ts", { react }, {
    fetch: async (url) => fail ? Response.json({ error: "offline" }, { status: 502 }) : Response.json(url.startsWith("/api/threat") ? { level: "high" } : { reports: [{ id: "old" }], maxAgeHours: 48 }),
    setInterval: () => 1, clearInterval() {},
  });
  function HookHarness(latitude) { cursor = 0; effectCursor = 0; return useFloodInfo({ latitude, longitude: 0 }); }
  async function flush() { for (const effect of effects) if (effect.pending) { effect.pending = false; effect.cleanup = effect.callback(); } await new Promise((resolve) => setImmediate(resolve)); }
  HookHarness(1); await flush();
  assert.equal(HookHarness(1).threat.data.level, "high");
  const moved = HookHarness(2);
  assert.equal(moved.threat.data, null);
  assert.equal(moved.reports.data, null);
  fail = true; await flush();
  const failed = HookHarness(2);
  assert.equal(failed.threat.data, null);
  assert.equal(failed.threat.error, "offline");
  assert.equal(failed.reports.data, null);
});
