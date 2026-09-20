/**
 * An omitted `stream` must mean NON-streaming (OpenAI spec default).
 *
 * Defect: chatCore resolved `stream = body.stream !== false`, so a client that
 * omitted the field was treated as streaming. On the same-format (openai→openai)
 * path `translateRequest` skips translation entirely and never writes `stream`
 * into the outbound body, so the upstream answered with a plain
 * `chat.completion` JSON. The passthrough stream then forwarded that JSON
 * verbatim and appended `data: [DONE]`, producing a body that is a JSON object
 * with an SSE frame glued on — `json.loads` → "Extra data: line 1 column N".
 * Reproduced live against the DeepSeek upstream via 9router:
 *   POST /v1/chat/completions {model:ds/deepseek-v4-flash}  (no stream)
 *   -> content-type: text/event-stream, body ends `..."}data: [DONE]\n\n`
 * Seen with browser fetch (Accept: * / *), curl, and any OpenAI-compatible SDK
 * that omits `stream`.
 *
 * Rule: streaming only when the client actually asked for it — `stream: true`,
 * `Accept: text/event-stream`, or a provider that forces streaming upstream.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const { executeMock } = vi.hoisted(() => ({ executeMock: vi.fn() }));

vi.mock("../../open-sse/executors/index.js", () => ({
  getExecutor: vi.fn(() => ({
    execute: executeMock,
    refreshCredentials: vi.fn().mockResolvedValue(null),
  })),
}));

vi.mock("../../open-sse/utils/requestLogger.js", () => ({
  createRequestLogger: vi.fn(async () => ({
    logClientRawRequest: vi.fn(),
    logRawRequest: vi.fn(),
    logTargetRequest: vi.fn(),
    logError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/utils/clientDetector.js", () => ({
  detectClientTool: vi.fn(() => null),
  isNativePassthrough: vi.fn(() => false),
}));

vi.mock("../../open-sse/utils/bypassHandler.js", () => ({
  handleBypassRequest: vi.fn(() => null),
}));

vi.mock("../../open-sse/utils/streamHandler.js", () => ({
  createStreamController: vi.fn(() => ({
    signal: undefined,
    handleComplete: vi.fn(),
    handleError: vi.fn(),
  })),
}));

vi.mock("../../open-sse/services/tokenRefresh.js", () => ({
  refreshWithRetry: vi.fn(),
}));

vi.mock("../../open-sse/utils/proxyFetch.js", () => ({
  default: vi.fn(),
  proxyAwareFetch: vi.fn(),
}));

vi.mock("../../open-sse/translator/formats/claude.js", () => ({
  normalizeClaudePassthrough: vi.fn(),
  anchorClaudeCache: vi.fn(),
}));

vi.mock("../../open-sse/utils/toolDeduper.js", () => ({
  dedupeTools: vi.fn((tools) => ({ tools, stripped: [] })),
}));

vi.mock("../../open-sse/rtk/caveman.js", () => ({ injectCaveman: vi.fn() }));
vi.mock("../../open-sse/rtk/ponytail.js", () => ({ injectPonytail: vi.fn() }));
vi.mock("../../open-sse/rtk/index.js", () => ({
  compressMessages: vi.fn(() => null),
  formatRtkLog: vi.fn(() => ""),
}));
vi.mock("../../open-sse/rtk/headroom.js", () => ({
  compressWithHeadroom: vi.fn(async () => null),
  formatHeadroomLog: vi.fn(() => ""),
  formatHeadroomSizeLog: vi.fn(() => ""),
  isHeadroomPhantomSavings: vi.fn(() => false),
}));
vi.mock("../../open-sse/rtk/pxpipe.js", () => ({
  compressWithPxpipe: vi.fn(async () => ({ body: null, summary: null })),
}));

vi.mock("../../open-sse/providers/capabilities.js", () => ({
  getCapabilitiesForModel: vi.fn(() => ({})),
}));

vi.mock("../../open-sse/translator/concerns/modality.js", () => ({
  stripUnsupportedModalities: vi.fn(() => false),
}));

vi.mock("../../open-sse/translator/concerns/prefetch.js", () => ({
  prefetchRemoteImages: vi.fn(async () => 0),
}));

vi.mock("../../open-sse/handlers/chatCore/requestDetail.js", () => ({
  buildRequestDetail: vi.fn((detail) => detail),
  extractRequestConfig: vi.fn((body, stream) => ({ body, stream })),
  saveUsageStats: vi.fn(),
  formatDoneLine: vi.fn(() => ""),
  extractUsageFromResponse: vi.fn(() => null),
}));

// The response handlers are not under test — this test asserts the STREAM DECISION
// only (which is what the defect got wrong). Stub them so no real pipe/handler runs.
vi.mock("../../open-sse/handlers/chatCore/nonStreamingHandler.js", () => ({
  handleNonStreamingResponse: vi.fn(async () => ({ success: true, via: "non-streaming" })),
}));
vi.mock("../../open-sse/handlers/chatCore/streamingHandler.js", () => ({
  handleStreamingResponse: vi.fn(async () => ({ success: true, via: "streaming" })),
  buildOnStreamComplete: vi.fn(() => ({ onStreamComplete: vi.fn(), streamDetailId: "d1" })),
}));
vi.mock("../../open-sse/handlers/chatCore/sseToJsonHandler.js", () => ({
  handleForcedSSEToJson: vi.fn(async () => null),
  parseSSEToOpenAIResponse: vi.fn(() => null),
}));

vi.mock("../../open-sse/utils/error.js", () => ({
  createErrorResult: vi.fn((status, message) => ({ success: false, status, error: message })),
  formatProviderError: vi.fn((error) => error.message),
  parseUpstreamError: vi.fn(),
}));

vi.mock("@/lib/usageDb.js", () => ({
  trackPendingRequest: vi.fn(),
  appendRequestLog: vi.fn(() => Promise.resolve()),
  saveRequestDetail: vi.fn(() => Promise.resolve()),
}));

// Provider under test: a chat-native (openai→openai) provider with NO forceStream,
// i.e. exactly the shape that produced the defect (deepseek via ds/*).
function makeOptions({ bodyStream, accept } = {}) {
  const body = { model: "deepseek-v4-flash", messages: [{ role: "user", content: "hi" }] };
  if (bodyStream !== undefined) body.stream = bodyStream;

  const headers = {};
  if (accept !== undefined) headers.accept = accept;

  return {
    body,
    modelInfo: { provider: "deepseek", model: "deepseek-v4-flash" },
    credentials: { apiKey: "***", providerSpecificData: {} },
    clientRawRequest: { endpoint: "/v1/chat/completions", body, headers },
    connectionId: "test-connection",
    log: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  };
}

describe("omitted `stream` defaults to non-streaming (OpenAI spec)", () => {
  beforeEach(() => {
    executeMock.mockReset();
    // A plain chat.completion JSON, exactly what a chat-native upstream returns
    // for a non-streaming request.
    executeMock.mockResolvedValue({
      response: new Response(
        JSON.stringify({
          id: "chatcmpl-1",
          object: "chat.completion",
          choices: [{ index: 0, message: { role: "assistant", content: "PONG" }, finish_reason: "stop" }],
          usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
      url: "https://api.deepseek.com/chat/completions",
      headers: {},
      transformedBody: {},
    });
  });

  it("sends stream:false upstream when the client omits `stream` (curl / Accept: */*)", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    await handleChatCore(makeOptions({ accept: "*/*" }));

    expect(executeMock).toHaveBeenCalledTimes(1);
    // The regression: this used to be `true`, which took the SSE passthrough path
    // and glued `data: [DONE]` onto the upstream's JSON.
    expect(executeMock.mock.calls[0][0].stream).toBe(false);
  });

  it("sends stream:false upstream when no Accept header is present at all", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    await handleChatCore(makeOptions());

    expect(executeMock.mock.calls[0][0].stream).toBe(false);
  });

  it("still streams when the client sends `stream: true`", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    await handleChatCore(makeOptions({ bodyStream: true }));

    expect(executeMock.mock.calls[0][0].stream).toBe(true);
  });

  it("still streams when the client sends Accept: text/event-stream and omits `stream`", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    await handleChatCore(makeOptions({ accept: "text/event-stream" }));

    expect(executeMock.mock.calls[0][0].stream).toBe(true);
  });

  it("honours an explicit `stream: false`", async () => {
    const { handleChatCore } = await import("../../open-sse/handlers/chatCore.js");
    await handleChatCore(makeOptions({ bodyStream: false }));

    expect(executeMock.mock.calls[0][0].stream).toBe(false);
  });
});
