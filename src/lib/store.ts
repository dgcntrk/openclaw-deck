import { create } from "zustand";
import type {
  AgentConfig,
  AgentSession,
  AgentStatus,
  ChatMessage,
  DeckConfig,
  GatewayEvent,
  SessionUsage,
} from "../types";
import { GatewayClient } from "./gateway-client";
import { themes, applyTheme } from "../themes";

// ─── Default Config ───

const ENV_GATEWAY_URL = (import.meta.env.VITE_GATEWAY_URL as string | undefined)?.trim();
const ENV_GATEWAY_TOKEN = (import.meta.env.VITE_GATEWAY_TOKEN as string | undefined)?.trim();

const TELEGRAM_METADATA_BLOCK_RE =
  /Conversation info \(untrusted metadata\):\s*```json\s*[\s\S]*?```\s*/gi;

function stripTelegramMetadataEnvelope(text: string): string {
  return text.replace(TELEGRAM_METADATA_BLOCK_RE, "").trim();
}

function normalizeNoiseToken(text: string): string {
  return text.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

function isNoiseMessage(text: string): boolean {
  const trimmed = text.trim();
  const token = normalizeNoiseToken(trimmed);

  if (trimmed.startsWith("[System Message]")) return true;
  if (
    trimmed
      .toLowerCase()
      .includes("a completed subagent task is ready for user delivery")
  ) {
    return true;
  }

  return token === "heartbeat_ok" || token === "no_reply";
}

function resolveGatewayUrl(envUrl?: string): string {
  // 1. Check URL params (like official Control UI: ?gatewayUrl=wss://...)
  const urlParams = new URLSearchParams(window.location.search);
  const paramUrl = urlParams.get("gatewayUrl") || urlParams.get("gateway");
  if (paramUrl) return paramUrl;

  if (!envUrl) envUrl = "/ws";
  // Already a full ws:// or wss:// URL
  if (envUrl.startsWith("ws://") || envUrl.startsWith("wss://")) return envUrl;

  // 2. If accessed over HTTPS (e.g. Tailscale Serve), connect directly to
  //    the gateway WSS on port 18790 instead of proxying through Vite.
  //    The Vite proxy strips WebCrypto device identity headers.
  if (window.location.protocol === "https:") {
    return `wss://${window.location.hostname}:18790`;
  }

  // 3. Relative path like "/ws" — resolve against current page origin (local dev)
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}${envUrl}`;
}

const DEFAULT_CONFIG: DeckConfig = {
  gatewayUrl: resolveGatewayUrl(ENV_GATEWAY_URL),
  token: ENV_GATEWAY_TOKEN || undefined,
  agents: [],
};

// ─── Store Shape ───

interface DeckStore {
  config: DeckConfig;
  sessions: Record<string, AgentSession>;
  gatewayConnected: boolean;
  columnOrder: string[];
  client: GatewayClient | null;
  theme: string;

  // Actions
  initialize: (config: Partial<DeckConfig>) => void;
  addAgent: (agent: AgentConfig) => void;
  removeAgent: (agentId: string) => void;
  reorderColumns: (order: string[]) => void;
  sendMessage: (agentId: string, text: string) => Promise<boolean>;
  setAgentStatus: (agentId: string, status: AgentStatus) => void;
  appendMessageChunk: (agentId: string, runId: string, chunk: string) => void;
  finalizeMessage: (agentId: string, runId: string) => void;
  handleGatewayEvent: (event: GatewayEvent) => void;
  createAgentOnGateway: (agent: AgentConfig) => Promise<void>;
  deleteAgentOnGateway: (agentId: string) => Promise<void>;
  disconnect: () => void;
  setTheme: (themeId: string) => void;
}

// ─── Helpers ───

function createSession(agentId: string): AgentSession {
  return {
    agentId,
    status: "idle",
    messages: [],
    activeRunId: null,
    activeRunIds: [],
    tokenCount: 0,
    connected: false,
  };
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Route runIds back to their deck column even when gateway events omit sessionKey.
const runToAgent = new Map<string, string>();
// Sticky "last active" column for events that arrive without session/run context.
let lastActiveAgentId: string | null = null;

function agentFromSessionKey(
  sessionKey: string | undefined,
  sessions: Record<string, AgentSession>
): string | null {
  if (!sessionKey) return null;
  const parts = sessionKey.split(":");

  // Legacy shape: agent:<agentId>
  // Only this 2-part form may fall back to p1.
  if (parts.length === 2) {
    const p1 = parts[1];
    if (p1 && sessions[p1]) return p1;
  }

  // Multi-session shape: agent:<gatewayAgentId>:<sessionId>
  // e.g. agent:main:agent-2  → column "agent-2"
  // e.g. agent:main:main     → column "main"
  const p2 = parts[2];
  if (p2 && sessions[p2]) return p2;

  // Known non-column segments should never route to a deck column.
  if (p2 === "subagent" || p2 === "cron") return null;

  // For 3+ parts, do not fall back to p1 (gateway agent id), otherwise
  // subagent/cron events can bleed into the main column.
  if (parts.length >= 3) return null;

  // Last-resort for any other unexpected shape.
  const last = parts[parts.length - 1];
  if (last && sessions[last]) return last;

  return null;
}

function extractSessionKey(payload: Record<string, unknown>): string | undefined {
  const direct = (payload.sessionKey ?? payload.session) as string | undefined;
  if (typeof direct === "string" && direct) return direct;

  // Some event producers nest session data under message/data/session objects.
  const message = payload.message as Record<string, unknown> | undefined;
  const data = payload.data as Record<string, unknown> | undefined;
  const nestedCandidates = [message, data, payload.session as Record<string, unknown> | undefined];

  for (const obj of nestedCandidates) {
    if (!obj) continue;
    const key = (obj.sessionKey ?? obj.session ?? (obj.session as Record<string, unknown> | undefined)?.key) as
      | string
      | undefined;
    if (typeof key === "string" && key) return key;
  }

  return undefined;
}

function resolveAgentId(
  payload: Record<string, unknown>,
  sessions: Record<string, AgentSession>,
  options?: { allowContextlessFallback?: boolean }
): string {
  const runId = payload.runId as string | undefined;
  const sessionKey = extractSessionKey(payload);

  // 1) Explicit id fields if present
  const explicit =
    (payload.agentId as string | undefined) ??
    (payload.targetAgentId as string | undefined) ??
    (payload.columnId as string | undefined);
  if (explicit && sessions[explicit]) return explicit;

  // 2) Session key routing
  const fromSession = agentFromSessionKey(sessionKey, sessions);
  if (fromSession) return fromSession;

  // 3) Sticky run routing (critical for events missing sessionKey)
  if (runId && runToAgent.has(runId)) {
    return runToAgent.get(runId)!;
  }

  // 4) Active run fallback
  if (runId) {
    for (const [agentId, s] of Object.entries(sessions)) {
      if (s.activeRunId === runId || s.activeRunIds?.includes(runId)) return agentId;
    }
  }

  // 5) If sessionKey exists but didn't match any column, DROP the event
  //    by returning a sentinel. This prevents cross-session bleed where
  //    subagent/cron events from one agent appear in another's column.
  if (sessionKey) return "__unroutable__";

  // 6) For safety, context-less events are dropped unless explicitly allowed.
  //    This protects column/session isolation from cross-session bleed.
  if (!options?.allowContextlessFallback) return "__unroutable__";

  for (const [agentId, s] of Object.entries(sessions)) {
    if (s.activeRunId || (s.activeRunIds?.length ?? 0) > 0) return agentId;
  }

  if (lastActiveAgentId && sessions[lastActiveAgentId]) return lastActiveAgentId;

  const firstAgentId = Object.keys(sessions)[0];
  return firstAgentId ?? "__unroutable__";
}

function isAnnouncementPayload(
  payload: Record<string, unknown>,
  message?: Record<string, unknown>
): boolean {
  const kind =
    (message?.kind as string | undefined) ??
    (payload.kind as string | undefined) ??
    (payload.type as string | undefined);

  if (message?.announcement === true || payload.announcement === true) {
    return true;
  }

  return (
    kind === "announcement" ||
    kind === "subagent_announcement" ||
    kind === "system_announcement"
  );
}

function deriveStatusFromActiveRuns(
  session: AgentSession,
  messages: ChatMessage[],
  activeRunIds: string[]
): AgentStatus {
  if (activeRunIds.length === 0) return "idle";

  if (session.status === "tool_use") return "tool_use";

  const activeSet = new Set(activeRunIds);
  const hasStreaming = messages.some(
    (m) => !!m.streaming && !!m.runId && activeSet.has(m.runId)
  );
  return hasStreaming ? "streaming" : "thinking";
}

/** Convert raw gateway chat.history messages into ChatMessage[] */
function parseHistoryMessages(
  raw?: Array<{
    role?: string;
    content?: Array<{ type?: string; text?: string }> | string;
    timestamp?: number;
    __openclaw?: { kind?: string };
  }>
): ChatMessage[] {
  if (!Array.isArray(raw)) return [];

  const result: ChatMessage[] = [];
  for (const msg of raw) {
    const role = msg.role;
    if (!role) continue;

    // Skip tool/function messages and compaction markers
    if (role === "tool" || role === "toolresult" || role === "function") continue;
    if (msg.__openclaw?.kind === "compaction") continue;

    // Extract text content
    let text = "";
    if (Array.isArray(msg.content)) {
      text = msg.content
        .filter((p) => p.type === "text" && p.text)
        .map((p) => p.text)
        .join("");
    } else if (typeof msg.content === "string") {
      text = msg.content;
    }

    // Strip Telegram metadata envelope from user messages
    text = stripTelegramMetadataEnvelope(text);

    // Skip empty and noise messages
    const trimmedText = text.trim();
    if (!trimmedText) continue;
    if (isNoiseMessage(trimmedText)) continue;

    // Map role to ChatMessage role
    let chatRole: ChatMessage["role"];
    if (role === "user") {
      chatRole = "user";
    } else if (role === "assistant") {
      chatRole = "assistant";
    } else if (role === "system") {
      chatRole = "announcement";
    } else {
      continue;
    }

    result.push({
      id: makeId(),
      role: chatRole,
      text,
      timestamp: msg.timestamp ?? Date.now(),
      announcement: chatRole === "announcement",
    });
  }

  return result;
}

// ─── Store ───

export const useDeckStore = create<DeckStore>((set, get) => ({
  config: DEFAULT_CONFIG,
  sessions: {},
  gatewayConnected: false,
  columnOrder: [],
  client: null,
  theme: 'midnight',

  initialize: (partialConfig) => {
    const config = { ...DEFAULT_CONFIG, ...partialConfig };
    const sessions: Record<string, AgentSession> = {};
    const columnOrder: string[] = [];

    for (const agent of config.agents) {
      sessions[agent.id] = createSession(agent.id);
      columnOrder.push(agent.id);
    }

    // Create the gateway client
    const client = new GatewayClient({
      url: config.gatewayUrl,
      token: config.token,
      onEvent: (event) => get().handleGatewayEvent(event),
      onConnection: (connected) => {
        set({ gatewayConnected: connected });
        if (connected) {
          // Mark all agent sessions as connected
          const sessions = { ...get().sessions };
          for (const id of Object.keys(sessions)) {
            sessions[id] = { ...sessions[id], connected: true };
          }
          set({ sessions });

          // Load chat history for sessions that have no messages
          for (const agentId of Object.keys(sessions)) {
            if (sessions[agentId].messages.length > 0) continue;
            // Session key format: agent:main:<columnId>
            // All columns are sessions under gateway agent "main"
            const sessionKey = `agent:main:${agentId}`;
            client
              .chatHistory(sessionKey, 50)
              .then((res) => {
                const data = res as {
                  messages?: Array<{
                    role?: string;
                    content?:
                      | Array<{ type?: string; text?: string }>
                      | string;
                    timestamp?: number;
                    __openclaw?: { kind?: string };
                  }>;
                };
                const historyMsgs = parseHistoryMessages(data?.messages);
                if (historyMsgs.length === 0) return;

                set((state) => {
                  const session = state.sessions[agentId];
                  if (!session || session.messages.length > 0) return state;
                  return {
                    sessions: {
                      ...state.sessions,
                      [agentId]: {
                        ...session,
                        messages: historyMsgs,
                      },
                    },
                  };
                });
              })
              .catch((err) => {
                console.warn(
                  `[DeckStore] Failed to load history for ${agentId}:`,
                  err
                );
              });
          }
        }
      },
    });

    set({ config, sessions, columnOrder, client });
    client.connect();
  },

  addAgent: (agent) => {
    set((state) => ({
      config: {
        ...state.config,
        agents: [...state.config.agents, agent],
      },
      sessions: {
        ...state.sessions,
        [agent.id]: createSession(agent.id),
      },
      columnOrder: [...state.columnOrder, agent.id],
    }));
  },

  removeAgent: (agentId) => {
    if (agentId === "main") return;
    set((state) => {
      const { [agentId]: _, ...sessions } = state.sessions;
      return {
        config: {
          ...state.config,
          agents: state.config.agents.filter((a) => a.id !== agentId),
        },
        sessions,
        columnOrder: state.columnOrder.filter((id) => id !== agentId),
      };
    });
  },

  reorderColumns: (order) => set({ columnOrder: order }),

  sendMessage: async (agentId, text) => {
    const { client } = get();
    if (!client?.connected) {
      console.error("Gateway not connected");
      return false;
    }

    // Add user message immediately
    const userMsg: ChatMessage = {
      id: makeId(),
      role: "user",
      text,
      timestamp: Date.now(),
    };

    if (!get().sessions[agentId]) return false;

    set((state) => {
      const session = state.sessions[agentId];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [agentId]: {
            ...session,
            messages: [...session.messages, userMsg],
            status: "thinking",
          },
        },
      };
    });

    try {
      // All columns are sessions under gateway agent "main".
      // Session key: agent:main:<columnId> — this discriminates between columns.
      const sessionKey = `agent:main:${agentId}`;
      const { runId } = await client.runAgent("main", text, sessionKey);
      runToAgent.set(runId, agentId);
      lastActiveAgentId = agentId;

      // Create placeholder assistant message for streaming
      const assistantMsg: ChatMessage = {
        id: makeId(),
        role: "assistant",
        text: "",
        timestamp: Date.now(),
        streaming: true,
        runId,
      };

      set((state) => {
        const session = state.sessions[agentId];
        if (!session) return state;
        return {
          sessions: {
            ...state.sessions,
            [agentId]: {
              ...session,
              messages: [...session.messages, assistantMsg],
              activeRunId: runId,
              activeRunIds: [...session.activeRunIds, runId],
              status: "streaming",
            },
          },
        };
      });
      return true;
    } catch (err) {
      console.error(`Failed to run agent ${agentId}:`, err);
      set((state) => {
        const session = state.sessions[agentId];
        if (!session) return state;
        return {
          sessions: {
            ...state.sessions,
            [agentId]: {
              ...session,
              status: "error",
            },
          },
        };
      });
      return false;
    }
  },

  setAgentStatus: (agentId, status) => {
    set((state) => {
      const session = state.sessions[agentId];
      if (!session) return state;
      return {
        sessions: {
          ...state.sessions,
          [agentId]: {
            ...session,
            status,
          },
        },
      };
    });
  },

  appendMessageChunk: (agentId, runId, chunk) => {
    set((state) => {
      const session = state.sessions[agentId];
      if (!session || !session.messages) return state;

      const existingIdx = session.messages.findIndex((msg) => msg.runId === runId);
      const hasExisting = existingIdx >= 0;

      const messages = hasExisting
        ? session.messages.map((msg) => {
            if (msg.runId === runId && msg.streaming) {
              return { ...msg, text: msg.text + chunk };
            }
            return msg;
          })
        : [
            ...session.messages,
            {
              id: makeId(),
              role: "assistant" as const,
              text: chunk,
              timestamp: Date.now(),
              streaming: true,
              runId,
            },
          ];

      const activeRunIds = session.activeRunIds.includes(runId)
        ? session.activeRunIds
        : [...session.activeRunIds, runId];

      return {
        sessions: {
          ...state.sessions,
          [agentId]: {
            ...session,
            messages,
            tokenCount: session.tokenCount + chunk.length, // approximate
            activeRunId: runId,
            activeRunIds,
            status: "streaming",
          },
        },
      };
    });
  },

  finalizeMessage: (agentId, runId) => {
    runToAgent.delete(runId);
    set((state) => {
      const session = state.sessions[agentId];
      if (!session || !session.messages) return state;

      const messages = (session.messages || [])
        .map((msg) => {
          if (msg.runId === runId) {
            return { ...msg, streaming: false };
          }
          return msg;
        })
        .filter((msg) => {
          // Remove finalized messages that are pure noise (e.g. HEARTBEAT_OK responses)
          if (msg.runId === runId && !msg.streaming && isNoiseMessage(msg.text)) {
            return false;
          }
          return true;
        });

      const activeRunIds = session.activeRunIds.filter((id) => id !== runId);
      const nextActiveRunId = activeRunIds.length > 0 ? activeRunIds[activeRunIds.length - 1] : null;
      const nextStatus = deriveStatusFromActiveRuns(session, messages, activeRunIds);

      return {
        sessions: {
          ...state.sessions,
          [agentId]: {
            ...session,
            messages,
            activeRunId: nextActiveRunId,
            activeRunIds,
            status: nextStatus,
          },
        },
      };
    });
  },

  handleGatewayEvent: (event) => {
    const payload = event.payload as Record<string, unknown>;
    switch (event.event) {
      // Agent streaming events
      // Format: { runId, stream: "assistant"|"lifecycle"|"tool_use", data: {...}, sessionKey: "agent:<id>:<key>" }
      case "agent": {
        const runId = payload.runId as string;
        const stream = payload.stream as string | undefined;
        const data = payload.data as Record<string, unknown> | undefined;
        const agentId = resolveAgentId(payload, get().sessions);

        // Drop events that don't belong to any deck column
        if (agentId === "__unroutable__") break;

        lastActiveAgentId = agentId;

        if (runId) {
          runToAgent.set(runId, agentId);
        }

        if (stream === "assistant" && data?.delta) {
          get().appendMessageChunk(agentId, runId, data.delta as string);
          get().setAgentStatus(agentId, "streaming");
        } else if (stream === "lifecycle") {
          const phase = data?.phase as string | undefined;
          if (phase === "start") {
            // Backfill user message: gateway doesn't push user messages
            // over WS, so fetch latest history to grab the triggering message.
            const sessionKey = extractSessionKey(payload);
            if (sessionKey) {
              const client = get().client;
              if (client) {
                client.chatHistory(sessionKey, 5).then((data: any) => {
                  const msgs = data?.messages as Array<any> | undefined;
                  if (!msgs) return;
                  // Find user messages not yet in deck
                  const session = get().sessions[agentId];
                  if (!session) return;
                  const historyUserMsgs = parseHistoryMessages(
                    msgs.filter((m: any) => m.role === "user")
                  );
                  if (historyUserMsgs.length === 0) return;
                  // Only add the last user message if not already present
                  const lastUserMsg = historyUserMsgs[historyUserMsgs.length - 1];
                  const isDuplicate = session.messages.some(
                    (m) => m.role === "user" && m.text === lastUserMsg.text && Date.now() - m.timestamp < 30000
                  );
                  if (isDuplicate) return;
                  set((s) => {
                    const sess = s.sessions[agentId];
                    if (!sess) return s;
                    // Keep streaming placeholder at tail
                    const tail = sess.messages[sess.messages.length - 1];
                    const streamingTail = tail?.streaming ? tail : null;
                    const base = streamingTail
                      ? sess.messages.slice(0, -1)
                      : sess.messages;
                    const messages = streamingTail
                      ? [...base, lastUserMsg, streamingTail]
                      : [...base, lastUserMsg];
                    return {
                      sessions: {
                        ...s.sessions,
                        [agentId]: { ...sess, messages },
                      },
                    };
                  });
                }).catch(() => {});
              }
            }

            // Check if a placeholder message already exists for this runId
            const session = get().sessions[agentId];
            const hasPlaceholder = session?.messages.some(
              (msg) => msg.runId === runId
            );

            if (!hasPlaceholder && session) {
              // Server-initiated turn (sub-agent announcement) — no
              // placeholder was created by sendMessage(). Create one now
              // so streaming chunks have somewhere to land.
              const isAnnouncement = isAnnouncementPayload(payload, data);
              const placeholderMsg: ChatMessage = {
                id: makeId(),
                role: isAnnouncement ? "announcement" : "assistant",
                text: "",
                timestamp: Date.now(),
                streaming: true,
                runId,
                announcement: isAnnouncement,
              };

              set((state) => ({
                sessions: {
                  ...state.sessions,
                  [agentId]: {
                    ...state.sessions[agentId],
                    messages: [
                      ...state.sessions[agentId].messages,
                      placeholderMsg,
                    ],
                    activeRunId: runId,
                    activeRunIds: state.sessions[agentId].activeRunIds.includes(runId)
                      ? state.sessions[agentId].activeRunIds
                      : [...state.sessions[agentId].activeRunIds, runId],
                  },
                },
              }));
            }

            get().setAgentStatus(agentId, "thinking");
          } else if (phase === "end") {
            get().finalizeMessage(agentId, runId);
          }
        } else if (stream === "tool_use") {
          get().setAgentStatus(agentId, "tool_use");
        }
        break;
      }

      // Presence changes (agents coming online/offline)
      case "presence": {
        const agents = payload.agents as
          | Record<string, { online: boolean }>
          | undefined;
        if (agents) {
          set((state) => {
            const sessions = { ...state.sessions };
            for (const [id, info] of Object.entries(agents)) {
              if (sessions[id]) {
                sessions[id] = {
                  ...sessions[id],
                  connected: info.online,
                  status: info.online ? sessions[id].status : "disconnected",
                };
              }
            }
            return { sessions };
          });
        }
        break;
      }

      // Tick events (keep-alive, can update token counts, etc.)
      case "tick": {
        // Could update token usage, cost, etc.
        break;
      }

      // Gateway/system events that are expected but don't currently drive UI state.
      // Acknowledge silently to avoid "Unhandled event" console spam.
      case "health":
      case "heartbeat":
      case "cron": {
        break;
      }

      // Context compaction dividers
      case "compaction": {
        const agentId = resolveAgentId(payload, get().sessions);
        if (agentId === "__unroutable__") break;
        const beforeTokens = (payload.beforeTokens as number) ?? 0;
        const afterTokens = (payload.afterTokens as number) ?? 0;
        const droppedMessages = (payload.droppedMessages as number) ?? 0;

        const compactionMsg: ChatMessage = {
          id: makeId(),
          role: "compaction",
          text: "",
          timestamp: Date.now(),
          compaction: { beforeTokens, afterTokens, droppedMessages },
        };

        set((state) => {
          const session = state.sessions[agentId];
          if (!session) return state;
          return {
            sessions: {
              ...state.sessions,
              [agentId]: {
                ...session,
                messages: [...session.messages, compactionMsg],
              },
            },
          };
        });
        break;
      }

      // Real usage data from gateway
      case "sessions.usage": {
        const agentId = resolveAgentId(payload, get().sessions);
        if (agentId === "__unroutable__") break;
        const usage = payload.usage as SessionUsage | undefined;

        if (usage) {
          set((state) => {
            const session = state.sessions[agentId];
            if (!session) return state;
            return {
              sessions: {
                ...state.sessions,
                [agentId]: {
                  ...session,
                  usage,
                  tokenCount: usage.totalTokens,
                },
              },
            };
          });
        }
        break;
      }

      // Chat events — server-initiated messages (sub-agent announcements, cron results)
      // These arrive for ALL session messages; we only render ones not already
      // tracked by the 'agent' event handler.
      case "chat": {
        const state = payload.state as string | undefined;
        const runId = payload.runId as string | undefined;
        const agentId = resolveAgentId(payload, get().sessions);

        // Drop events that don't belong to any deck column
        if (agentId === "__unroutable__") break;

        lastActiveAgentId = agentId;

        const session = get().sessions[agentId];
        if (!session) break;

        // Skip transient states; process completed/standalone messages.
        // Gateway commonly uses state="final", but some producers may omit state.
        if (state && state !== "final") break;

        // FIX (bug: replies not appearing): When chat:final arrives and the runId
        // is already tracked by the agent/lifecycle handler, use it as a backup
        // signal to finalize the message. The lifecycle:end event can be missed on
        // reconnect/network glitch, leaving messages stuck with streaming=true.
        if (state === "final" && runId && session.messages.some((m) => m.runId === runId)) {
          get().finalizeMessage(agentId, runId);
          break;
        }

        // Extract text from the message content array
        const message = (payload.message ?? payload.data ?? payload.content) as Record<string, unknown> | null | undefined;
        if (!message) break;

        const role = message.role as string | undefined;
        const contentParts = (message.content ?? message.text ?? message.body) as
          | Array<{ type?: string; text?: string }>
          | string
          | undefined;

        let text = "";
        if (Array.isArray(contentParts)) {
          text = contentParts
            .filter((p) => p.type === "text" && p.text)
            .map((p) => p.text)
            .join("");
        } else if (typeof contentParts === "string") {
          text = contentParts;
        }

        // Strip Telegram metadata envelope from user messages
        text = stripTelegramMetadataEnvelope(text);

        // WHITELIST FILTER — skip noise
        const trimmedText = text.trim();
        if (!trimmedText) break;
        if (isNoiseMessage(trimmedText)) break;
        if (role === "tool" || role === "toolresult" || role === "function") break;

        // Dedup: skip if this runId is already tracked by the 'agent' handler
        // (non-final case handled above; this catches edge cases without state)
        if (runId && session.messages.some((m) => m.runId === runId)) break;

        // Dedup without suppressing legitimate repeated content:
        // - Prefer strong identity (runId)
        // - For runless events, only suppress same-role same-text bursts scoped
        //   to explicit sessionKey windows.
        const sessionKey = extractSessionKey(payload);
        const lastMsg = session.messages[session.messages.length - 1];
        if (
          !runId &&
          sessionKey &&
          lastMsg &&
          lastMsg.role === (role === "system" ? "announcement" : role) &&
          lastMsg.text === text &&
          Date.now() - lastMsg.timestamp < 1500
        ) {
          break;
        }

        // Render inbound/outbound completed messages not already tracked by the
        // streaming 'agent' handler.
        if (role === "assistant" || role === "system" || role === "user") {
          const announcement = role === "system" || isAnnouncementPayload(payload, message);
          const mappedRole: ChatMessage["role"] =
            role === "user" ? "user" : announcement ? "announcement" : "assistant";

          const chatMsg: ChatMessage = {
            id: makeId(),
            role: mappedRole,
            text,
            timestamp: Date.now(),
            announcement: mappedRole === "announcement",
            runId: runId ?? undefined,
          };

          set((s) => {
            const sess = s.sessions[agentId];
            if (!sess) return s;
            // Keep any actively-streaming placeholder at the tail so it stays
            // visible. Insert new chat messages before it so the stream reply
            // is never buried below incoming system/cron/heartbeat messages.
            const tail = sess.messages[sess.messages.length - 1];
            const streamingTail = tail?.streaming ? tail : null;
            const base = streamingTail
              ? sess.messages.slice(0, -1)
              : sess.messages;
            const messages = streamingTail
              ? [...base, chatMsg, streamingTail]
              : [...base, chatMsg];
            return {
              sessions: {
                ...s.sessions,
                [agentId]: { ...sess, messages },
              },
            };
          });
        }
        break;
      }

      default:
        console.log("[DeckStore] Unhandled event:", event.event, payload);
    }
  },

  createAgentOnGateway: async (agent) => {
    const { client } = get();
    try {
      if (client?.connected) {
        await client.createAgent({
          id: agent.id,
          name: agent.name,
          model: agent.model,
          context: agent.context,
          shell: agent.shell,
        });
      }
    } catch (err) {
      console.warn("[DeckStore] Gateway createAgent failed, adding locally:", err);
    }
    get().addAgent(agent);
  },

  deleteAgentOnGateway: async (agentId) => {
    if (agentId === "main") return;
    const { client } = get();
    try {
      if (client?.connected) {
        await client.deleteAgent(agentId);
      }
    } catch (err) {
      console.warn("[DeckStore] Gateway deleteAgent failed, removing locally:", err);
    }
    get().removeAgent(agentId);
  },

  disconnect: () => {
    get().client?.disconnect();
    set({ gatewayConnected: false, client: null });
  },

  setTheme: (themeId: string) => {
    set({ theme: themeId });
    const theme = themes[themeId];
    if (theme) {
      applyTheme(theme);
    }
  },
}));
