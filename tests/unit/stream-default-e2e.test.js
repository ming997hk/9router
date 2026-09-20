/**
 * End-to-end proof of the omitted-`stream` fix.
 *
 * ONLY the executor is mocked, and it returns exactly what the live upstream returned for a
 * request with no `stream` field: a plain chat.completion JSON with content-type
 * application/json. Everything below it is the REAL code path — chatCore's stream decision,
 * nonStreamingHandler, the Response object, the actual bytes the client receives.
 *
 * Reproduced live through the gateway before this fix:
 *   POST /v1/chat/completions {model:ds/deepseek-v4-flash}   (no stream field)
 *   -> 200 text/event-stream, body ends  `..."}data: [DONE]\n\n`
 *   -> json.loads / JSON.parse -> "Extra data: line 1 column 552"
 * Also reproduces on /v1/messages (Claude shape + the same glued [DONE]).
 */
import { describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
  saveRequestUsage: vi.fn(() => Promise.resolve()),
  logUsage: vi.fn(),
}));

// Keep the real requestDetail helpers (they build the recorded detail) but make
// saveUsageStats resolve — it is fire-and-forget and returns a promise in prod.
vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, saveUsageStats: vi.fn(() => Promise.resolve()) };
});

// Exactly the payload api.deepseek.com returned for a request with no `stream` field.
const UPSTREAM_JSON = JSON.stringify({
  id: "9a56108f-15f9-4b91-9d50-8516be38a35e",
  object: "chat.completion",
  created: 1789888733,
  model: "deepseek-flash",
  choices: [{ index: 0, message: { role: "assistant", content: "PONG", reasoning_content: "" }, logprobs: null, finish_reason: "stop" }],
  usage: { prompt_tokens: 457, completion_tokens: 3, total_tokens: 460 },
});

function options({ accept = "*/*", endpoint = "/v1/chat/completions" } = {}) {
  const body = { model: "ds/deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] };
  return {
    body,
    modelInfo: { provider: "deepseek", model: "deepseek-v4-flash" },
    credentials: { apiKey: "test", providerSpecificData: {} },
    clientRawRequest: { endpoint, body, headers: { accept } },
    connectionId: "prove-connection",
    log: { debug() {}, info() {}, warn() {}, error() {}, line() {}, errorLine() {} },
  };
}

describe("client omitting `stream` gets a parseable JSON body (real handlers)", () => {
  it("returns application/json that JSON.parse accepts, with no glued SSE frame", async () => {
    executeMock.mockReset();
    executeMock.mockResolvedValue({
      response: new Response(UPSTREAM_JSON, { status: 200, headers: { "content-type": "application/json" } }),
      url: "https://api.deepseek.com/chat/completions",
      headers: {},
      transformedBody: {},
    });

    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const result = await handleChatCore(options());

    expect(result.success).toBe(true);
    const text = await result.response.text();
    const ctype = result.response.headers.get("content-type") || "";

    // The defect: text/event-stream with `data: [DONE]` glued onto the upstream JSON.
    expect(ctype).toContain("application/json");
    expect(text).not.toContain("data: [DONE]");

    // The user-visible symptom: this used to throw "Extra data: line 1 column N".
    const parsed = JSON.parse(text);
    expect(parsed.choices[0].message.content).toBe("PONG");

    // Upstream contract untouched — the body is still sent as the client wrote it.
    expect(executeMock.mock.calls[0][0].stream).toBe(false);
  });

  it("still streams SSE when the client sends Accept: text/event-stream", async () => {
    executeMock.mockReset();
    executeMock.mockResolvedValue({
      response: new Response(
        'data: {"choices":[{"delta":{"content":"PONG"}}]}\n\ndata: [DONE]\n\n',
        { status: 200, headers: { "content-type": "text/event-stream" } },
      ),
      url: "https://api.deepseek.com/chat/completions",
      headers: {},
      transformedBody: {},
    });

    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    const result = await handleChatCore(options({ accept: "text/event-stream" }));

    expect(executeMock.mock.calls[0][0].stream).toBe(true);
    const text = await result.response.text();
    expect(text).toContain("PONG");
  });
});
