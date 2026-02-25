import { beforeEach, describe, expect, it } from "vitest";
import { useDeckStore, shouldSuppressStreamingTokenPreview, isNoiseMessage } from "./store";

describe("streaming noise filter regressions", () => {
  const agentId = "main";

  beforeEach(() => {
    useDeckStore.setState({
      config: {
        gatewayUrl: "ws://localhost:18789",
        token: undefined,
        agents: [],
      },
      sessions: {
        [agentId]: {
          agentId,
          status: "idle",
          messages: [],
          activeRunId: null,
          activeRunIds: [],
          tokenCount: 0,
          connected: true,
        },
      },
      gatewayConnected: false,
      columnOrder: [agentId],
      client: null,
      theme: "midnight",
    } as any);
  });

  it("preserves spacing and punctuation when text streams across chunks", () => {
    const runId = "run-spacing";
    const { appendMessageChunk, finalizeMessage } = useDeckStore.getState();

    appendMessageChunk(agentId, runId, "Hey");
    appendMessageChunk(agentId, runId, " there");
    appendMessageChunk(agentId, runId, ", friend!");
    finalizeMessage(agentId, runId);

    const session = useDeckStore.getState().sessions[agentId];
    const msg = session.messages.find((m) => m.runId === runId);

    expect(msg?.text).toBe("Hey there, friend!");
    expect(msg?.streaming).toBe(false);
  });

  it("never renders NO_REPLY token while streaming and removes it on finalize", () => {
    const runId = "run-no-reply";
    const { appendMessageChunk, finalizeMessage } = useDeckStore.getState();

    appendMessageChunk(agentId, runId, "NO");
    appendMessageChunk(agentId, runId, "_RE");
    appendMessageChunk(agentId, runId, "PLY");

    let session = useDeckStore.getState().sessions[agentId];
    const streamingMsg = session.messages.find((m) => m.runId === runId);
    expect(streamingMsg?.text).toBe("");

    finalizeMessage(agentId, runId);
    session = useDeckStore.getState().sessions[agentId];

    expect(session.messages.some((m) => m.runId === runId)).toBe(false);
  });

  it("never renders HEARTBEAT_OK token while streaming and removes it on finalize", () => {
    const runId = "run-heartbeat-ok";
    const { appendMessageChunk, finalizeMessage } = useDeckStore.getState();

    appendMessageChunk(agentId, runId, "HEART");
    appendMessageChunk(agentId, runId, "BEAT");
    appendMessageChunk(agentId, runId, "_OK");

    let session = useDeckStore.getState().sessions[agentId];
    const streamingMsg = session.messages.find((m) => m.runId === runId);
    expect(streamingMsg?.text).toBe("");

    finalizeMessage(agentId, runId);
    session = useDeckStore.getState().sessions[agentId];

    expect(session.messages.some((m) => m.runId === runId)).toBe(false);
  });

  it("does not suppress legitimate messages starting with N/H", () => {
    const { appendMessageChunk, finalizeMessage } = useDeckStore.getState();

    const cases = [
      { runId: "run-hi", text: "Hi there" },
      { runId: "run-now", text: "Now this works" },
      { runId: "run-hello", text: "Hello" },
    ];

    for (const c of cases) {
      appendMessageChunk(agentId, c.runId, c.text);
      finalizeMessage(agentId, c.runId);
    }

    const session = useDeckStore.getState().sessions[agentId];
    for (const c of cases) {
      const msg = session.messages.find((m) => m.runId === c.runId);
      expect(msg?.text).toBe(c.text);
    }
  });

  it("disambiguates token-like prefixes once they become normal text", () => {
    const runId = "run-disambiguation";
    const { appendMessageChunk, finalizeMessage } = useDeckStore.getState();

    appendMessageChunk(agentId, runId, "NO");
    appendMessageChunk(agentId, runId, "w this works");
    finalizeMessage(agentId, runId);

    const session = useDeckStore.getState().sessions[agentId];
    const msg = session.messages.find((m) => m.runId === runId);

    expect(msg?.text).toBe("NOw this works");
  });

  it("helper guards only suppress token prefixes and keep normal text", () => {
    expect(shouldSuppressStreamingTokenPreview("NO")).toBe(true);
    expect(shouldSuppressStreamingTokenPreview("HEART")).toBe(true);
    expect(shouldSuppressStreamingTokenPreview("Hi")).toBe(false);
    expect(shouldSuppressStreamingTokenPreview("Now this works")).toBe(false);

    expect(isNoiseMessage("NO_REPLY")).toBe(true);
    expect(isNoiseMessage("HEARTBEAT_OK")).toBe(true);
    expect(isNoiseMessage("Hello")).toBe(false);
  });
});
