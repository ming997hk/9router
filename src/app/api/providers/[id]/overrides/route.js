import { NextResponse } from "next/server";
import { getSettings, updateSettings } from "@/lib/localDb";
import { PROVIDERS } from "open-sse/config/providers.js";
import { resolveProviderAlias } from "open-sse/services/model.js";

export const dynamic = "force-dynamic";

// Validation at the trust boundary — the UI also validates, but this is the gate.
const MAX_HEADERS = 20;
const MAX_HEADER_VALUE_LENGTH = 8192;
// Body overrides: a JSON object per model id ("*" = every model on this provider).
const MAX_BODY_OVERRIDE_CHARS = 16384;
// Request-identity fields — changing these silently would make a provider serve a
// different request than the client asked for. Everything else is a tuning knob.
const BLOCKED_BODY_KEYS = new Set(["model", "messages"]);
// RFC 7230 token subset: letters, digits, hyphen (no spaces, no unicode)
const HEADER_NAME_RE = /^[A-Za-z0-9-]+$/;
// Request-structure / auth headers a user override must never touch
const BLOCKED_HEADERS = new Set([
  "host",
  "content-length",
  "content-type",
  "connection",
  "transfer-encoding",
  "authorization",
  "cookie",
]);

/**
 * Validate + normalize an override payload. Returns { override } or { error }.
 * An override with no headers is normalized to null (= delete).
 */
function normalizeOverride({ headers, body }) {
  const out = {};

  if (headers !== undefined && headers !== null) {
    if (typeof headers !== "object" || Array.isArray(headers)) {
      return { error: "headers must be an object" };
    }
    const entries = Object.entries(headers).filter(([, v]) => v !== "" && v != null);
    if (entries.length > MAX_HEADERS) {
      return { error: `Too many headers (max ${MAX_HEADERS})` };
    }
    const clean = {};
    for (const [name, value] of entries) {
      if (!HEADER_NAME_RE.test(name)) {
        return { error: `Invalid header name: ${name}` };
      }
      if (typeof value !== "string" || /[\r\n]/.test(value)) {
        return { error: `Invalid value for header ${name}` };
      }
      if (value.length > MAX_HEADER_VALUE_LENGTH) {
        return { error: `Header ${name} value too long (max ${MAX_HEADER_VALUE_LENGTH})` };
      }
      if (BLOCKED_HEADERS.has(name.toLowerCase())) {
        return { error: `Header ${name} cannot be overridden` };
      }
      clean[name] = value;
    }
    if (Object.keys(clean).length) out.headers = clean;
  }

  // Body overrides: { "<model-id>"|"*": { ...params } }. Merged into the outgoing
  // body after translation, so a saved OpenRouter provider pin (or any other
  // per-model param) applies without the client sending it on every request.
  if (body !== undefined && body !== null) {
    if (typeof body !== "object" || Array.isArray(body)) {
      return { error: "body must be an object keyed by model id (\"*\" for all models)" };
    }
    const clean = {};
    for (const [modelKey, params] of Object.entries(body)) {
      if (!modelKey.trim()) continue;
      if (!params || typeof params !== "object" || Array.isArray(params)) {
        return { error: `body override for "${modelKey}" must be an object` };
      }
      const blocked = Object.keys(params).find((k) => BLOCKED_BODY_KEYS.has(k));
      if (blocked) {
        return { error: `"${blocked}" cannot be overridden (request identity)` };
      }
      if (Object.keys(params).length) clean[modelKey] = params;
    }
    if (JSON.stringify(clean).length > MAX_BODY_OVERRIDE_CHARS) {
      return { error: `Body overrides too large (max ${MAX_BODY_OVERRIDE_CHARS} chars)` };
    }
    if (Object.keys(clean).length) out.body = clean;
  }

  return { override: Object.keys(out).length ? out : null };
}

async function readOverrides() {
  const settings = await getSettings();
  return settings.providerOverrides || {};
}

/**
 * GET /api/providers/[id]/overrides — user override for this provider
 */
export async function GET(request, { params }) {
  try {
    const { id } = await params;
    // URL may use an alias (gcli, cc…) — key everything by canonical registry id
    const canonical = resolveProviderAlias(id);
    const override = (await readOverrides())[canonical] || {};
    // Built-in headers come straight from the registry transport — single source of
    // truth, so the UI pre-fills exactly what this provider sends upstream.
    return NextResponse.json({
      headers: override.headers || {},
      body: override.body || {},
      builtinHeaders: PROVIDERS[canonical]?.headers || {},
    });
  } catch (error) {
    console.log("Error getting provider overrides:", error);
    return NextResponse.json({ error: "Failed to get overrides" }, { status: 500 });
  }
}

/**
 * PUT /api/providers/[id]/overrides — body: { headers: {name: value}, body: {modelId: {...}} }
 * Empty payload clears the override.
 */
export async function PUT(request, { params }) {
  try {
    const { id } = await params;
    const canonical = resolveProviderAlias(id);
    const body = await request.json().catch(() => ({}));
    const { override, error } = normalizeOverride(body);
    if (error) {
      return NextResponse.json({ error }, { status: 400 });
    }
    const current = await readOverrides();
    const next = { ...current };
    if (override) next[canonical] = override;
    else delete next[canonical];
    await updateSettings({ providerOverrides: next });
    return NextResponse.json({ headers: override?.headers || {}, body: override?.body || {} });
  } catch (error) {
    console.log("Error saving provider overrides:", error);
    return NextResponse.json({ error: "Failed to save overrides" }, { status: 500 });
  }
}
