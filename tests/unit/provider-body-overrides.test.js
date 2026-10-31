import { describe, expect, it, vi, beforeEach } from "vitest";

// Capture what actually leaves the process: the merge happens inside execute(),
// so the only honest assertion is on the serialized outgoing request body.
const sent = [];
vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  proxyAwareFetch: vi.fn(async (url, options) => {
    sent.push({ url, body: JSON.parse(options.body) });
    return new Response(JSON.stringify({ choices: [{ message: { content: "ok" } }] }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }),
}));

const { DefaultExecutor } = await import("../../open-sse/executors/default.js");

const PROVIDER = "openai-compatible-overrides-test";
const CREDS = { apiKey: "sk-test", providerSpecificData: { baseUrl: "https://openrouter.ai/api/v1" } };
const MODEL = "deepseek/deepseek-v4.1-flash-1017";

function run({ providerOverrides, model = MODEL, body = null } = {}) {
  sent.length = 0;
  return new DefaultExecutor(PROVIDER)
    .execute({
      model,
      body: body || { model, messages: [{ role: "user", content: "hi" }], stream: false },
      stream: false,
      credentials: CREDS,
      signal: undefined,
      log: () => {},
      providerOverrides,
    })
    .then(() => sent[sent.length - 1]?.body);
}

describe("per-provider body overrides", () => {
  beforeEach(() => sent.splice(0));

  it("applies a model-keyed override and leaves the request identity intact", async () => {
    const out = await run({
      providerOverrides: { body: { [MODEL]: { provider: { only: ["morph/fp8"], allow_fallbacks: false } } } },
    });
    expect(out.provider).toEqual({ only: ["morph/fp8"], allow_fallbacks: false });
    expect(out.model).toBe(MODEL);
    expect(out.messages).toHaveLength(1);
  });

  it("does not leak a model-keyed override onto a different model", async () => {
    const out = await run({
      model: "minimax/minimax-m3:free",
      body: { model: "minimax/minimax-m3:free", messages: [{ role: "user", content: "hi" }] },
      providerOverrides: { body: { [MODEL]: { provider: { only: ["morph/fp8"] } } } },
    });
    expect(out.provider).toBeUndefined();
    expect(out.model).toBe("minimax/minimax-m3:free");
  });

  it('applies the "*" entry to every model and lets a model entry win over it', async () => {
    const anyModel = await run({ providerOverrides: { body: { "*": { service_tier: "flex" } } } });
    expect(anyModel.service_tier).toBe("flex");

    const both = await run({
      providerOverrides: {
        body: { "*": { service_tier: "flex", temperature: 0.1 }, [MODEL]: { temperature: 0.9 } },
      },
    });
    expect(both.service_tier).toBe("flex");
    expect(both.temperature).toBe(0.9);
  });

  it("never overrides model or messages", async () => {
    const out = await run({
      providerOverrides: { body: { "*": { model: "hijacked", messages: [] } } },
    });
    expect(out.model).toBe(MODEL);
    expect(out.messages).toHaveLength(1);
  });

  it("leaves the body untouched when there are no body overrides", async () => {
    const out = await run({ providerOverrides: { headers: { "x-y": "z" } } });
    expect(out.provider).toBeUndefined();
    expect(out.model).toBe(MODEL);
  });

  it("ignores malformed override shapes instead of throwing", async () => {
    for (const bad of [null, [], "nope", 42, { [MODEL]: [] }, { [MODEL]: "nope" }]) {
      const out = await run({ providerOverrides: { body: bad } });
      expect(out.model).toBe(MODEL);
    }
  });
});
