import { useEffect, useRef, useCallback } from "react";
import { useDeckStore } from "../lib/store";
import type { AgentConfig, DeckConfig } from "../types";

/**
 * Initialize the deck with config. Call once at app root.
 * Now properly handles dynamic agent updates including model changes.
 */
export function useDeckInit(config: Partial<DeckConfig>) {
  const initialize = useDeckStore((s) => s.initialize);
  const disconnect = useDeckStore((s) => s.disconnect);
  const prevAgentsRef = useRef<string>("");

  // Get a stable key for the agents array to detect changes (including model changes)
  const agentsKey = config.agents?.map(a => `${a.id}:${a.model}`).join(",") || "";

  useEffect(() => {
    // Only re-initialize if agents have actually changed (including model)
    if (prevAgentsRef.current !== agentsKey) {
      prevAgentsRef.current = agentsKey;
      
      // If we have agents, initialize (or re-initialize) the store
      if (config.agents && config.agents.length > 0) {
        initialize(config);
      }
    }

    return () => {
      disconnect();
    };
  }, [agentsKey, config.gatewayUrl, config.token]); // Re-run when agents or connection changes
}

/**
 * Get session data for a specific agent.
 */
export function useAgentSession(agentId: string) {
  return useDeckStore((s) => s.sessions[agentId]);
}

/**
 * Get the agent config by ID.
 */
export function useAgentConfig(agentId: string): AgentConfig | undefined {
  return useDeckStore((s) => s.config.agents.find((a) => a.id === agentId));
}

/**
 * Send a message to an agent. Returns a stable callback that resolves to
 * true when the send was accepted, false otherwise.
 */
export function useSendMessage(agentId: string) {
  const sendMessage = useDeckStore((s) => s.sendMessage);
  return useCallback(
    (text: string) => sendMessage(agentId, text),
    [agentId, sendMessage]
  );
}

/**
 * Auto-scroll a container to bottom when content changes.
 *
 * Design goals:
 *  1. Scroll to bottom on new messages AND on streaming chunks.
 *  2. Do NOT scroll if the user has manually scrolled up to read history.
 *  3. Resume auto-scroll when the user scrolls back near the bottom.
 *  4. Use behavior:"auto" (instant) — no smooth animations during streaming,
 *     which previously caused continuous scroll animations that blocked clicks.
 *
 * Implementation:
 *  - A scroll event listener tracks a "lockedToBottom" ref. When the user
 *    scrolls up more than 120px from the bottom, lock is released. When they
 *    scroll back within 120px, lock is re-acquired.
 *  - The dep effect only scrolls when lockedToBottom is true.
 *  - Callers should pass a dep that changes on BOTH new messages and streaming
 *    chunks (e.g. a string combining message count + last streaming text length).
 */
export function useAutoScroll(dep: unknown) {
  const ref = useRef<HTMLDivElement>(null);
  // Starts locked; updated by the scroll listener below.
  const lockedRef = useRef(true);

  // Attach a scroll listener once to track whether the user has scrolled up.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const onScroll = () => {
      const distanceFromBottom = el.scrollHeight - el.scrollTop - el.clientHeight;
      lockedRef.current = distanceFromBottom < 120;
    };

    el.addEventListener("scroll", onScroll, { passive: true });
    return () => el.removeEventListener("scroll", onScroll);
  }, []); // attach once, ref is stable

  // Scroll to bottom whenever dep changes, but only if locked to bottom.
  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    if (lockedRef.current) {
      // behavior:"auto" = instant, no ongoing animation → clicks never blocked.
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    }
  }, [dep]);

  return ref;
}

/**
 * Get global deck stats.
 */
export function useDeckStats() {
  const sessions = useDeckStore((s) => s.sessions);
  const connected = useDeckStore((s) => s.gatewayConnected);

  const agents = Object.values(sessions);
  const streaming = agents.filter((a) => a.status === "streaming").length;
  const thinking = agents.filter((a) => a.status === "thinking").length;
  const errors = agents.filter((a) => a.status === "error").length;
  const totalTokens = agents.reduce(
    (sum, a) => sum + (a.usage?.totalTokens ?? a.tokenCount),
    0
  );
  const waitingForUser = agents.filter((a) => {
    if (a.status !== "idle" || a.messages.length === 0) return false;
    const last = a.messages[a.messages.length - 1];
    return last.role === "assistant" && !last.streaming;
  }).length;

  return {
    gatewayConnected: connected,
    totalAgents: agents.length,
    streaming,
    thinking,
    active: streaming + thinking,
    idle: agents.length - streaming - thinking,
    errors,
    totalTokens,
    waitingForUser,
  };
}
