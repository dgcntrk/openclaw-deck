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

function resolveGatewayUrl(envUrl?: string): string {
  if (!envUrl) envUrl = "/ws";
  // Already a full ws:// or wss:// URL
  if (envUrl.startsWith("ws://") || envUrl.startsWith("wss://")) return envUrl;
  // Relative path like "/ws" — resolve against current page origin
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
  sendMessage: (agentId: string, text: string) => Promise<void>;
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
    tokenCount: 0,
    connected: false,
  };
}

function makeId(): string {
  return `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}

// Route runIds back to their deck column even when gateway events omit sessionKey.
const runToAgent = new Map<string, string>();

function agentFromSessionKey(
  sessionKey: string | undefined,
  sessions: Record<string, AgentSession>
): string | null {
  if (!sessionKey) return null;
  const parts = sessionKey.split(":");

  // Standard shape: agent:<agentId>:main (e.g. agent:main-3:main)
  // The agentId is always parts[1]
  const p1 = parts[1];
  if (p1 && sessions[p1]) return p1;

  // Subagent/cron sessions: agent:<agentId>:subagent:<uuid> or agent:<agentId>:cron:<uuid>
  // Already handled by p1 check above

  // Fallback: check parts[2] and last segment
  const p2 = parts[2];
  if (p2 && sessions[p2]) return p2;

  const last = parts[parts.length - 1];
  if (last && sessions[last]) return last;

  return null;
}

function resolveAgentId(
  payload: Record<string, unknown>,
  sessions: Record<string, AgentSession>
): string {
  const runId = payload.runId as string | undefined;
  const sessionKey = (payload.sessionKey ?? payload.session) as string | undefined;

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
      if (s.activeRunId === runId) return agentId;
    }
  }

  // 5) If sessionKey exists but didn't match any column, DROP the event
  //    by returning a sentinel. This prevents cross-session bleed where
  //    subagent/cron events from one agent appear in another's column.
  if (sessionKey) return "__unroutable__";

  return "main";
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
    text = text.replace(/Conversation info \(untrusted metadata\):\s*```json\s*\{[^}]*\}\s*```\s*/g, "").trim();

    // Skip empty, heartbeat, and NO_REPLY messages
    if (!text.trim()) continue;
    if (/HEARTBEAT_OK|heartbeat|NO_REPLY/i.test(text)) continue;

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
            const sessionKey = `agent:${agentId}:main`;
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
    const { client, sessions } = get();
    if (!client?.connected) {
      console.error("Gateway not connected");
      return;
    }

    // Add user message immediately
    const userMsg: ChatMessage = {
      id: makeId(),
      role: "user",
      text,
      timestamp: Date.now(),
    };

    const session = sessions[agentId];
    if (!session) return;

    set((state) => ({
      sessions: {
        ...state.sessions,
        [agentId]: {
          ...session,
          messages: [...session.messages, userMsg],
          status: "thinking",
        },
      },
    }));

    try {
      // Each column routes to its own agent on the gateway.
      const sessionKey = `agent:${agentId}:main`;
      const { runId } = await client.runAgent(agentId, text, sessionKey);
      runToAgent.set(runId, agentId);

      // Create placeholder assistant message for streaming
      const assistantMsg: ChatMessage = {
        id: makeId(),
        role: "assistant",
        text: "",
        timestamp: Date.now(),
        streaming: true,
        runId,
      };

      set((state) => ({
        sessions: {
          ...state.sessions,
          [agentId]: {
            ...state.sessions[agentId],
            messages: [...state.sessions[agentId].messages, assistantMsg],
            activeRunId: runId,
            status: "streaming",
          },
        },
      }));
    } catch (err) {
      console.error(`Failed to run agent ${agentId}:`, err);
      set((state) => ({
        sessions: {
          ...state.sessions,
          [agentId]: {
            ...state.sessions[agentId],
            status: "error",
          },
        },
      }));
    }
  },

  setAgentStatus: (agentId, status) => {
    set((state) => ({
      sessions: {
        ...state.sessions,
        [agentId]: {
          ...state.sessions[agentId],
          status,
        },
      },
    }));
  },

  appendMessageChunk: (agentId, runId, chunk) => {
    set((state) => {
      const session = state.sessions[agentId];
      if (!session || !session.messages) return state;

      const messages = (session.messages || []).map((msg) => {
        if (msg.runId === runId && msg.streaming) {
          return { ...msg, text: msg.text + chunk };
        }
        return msg;
      });

      return {
        sessions: {
          ...state.sessions,
          [agentId]: {
            ...session,
            messages,
            tokenCount: session.tokenCount + chunk.length, // approximate
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

      const messages = (session.messages || []).map((msg) => {
        if (msg.runId === runId) {
          return { ...msg, streaming: false };
        }
        return msg;
      });

      return {
        sessions: {
          ...state.sessions,
          [agentId]: {
            ...session,
            messages,
            activeRunId: null,
            status: "idle",
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
            const sessionKey = payload.sessionKey as string | undefined;
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
                    return {
                      sessions: {
                        ...s.sessions,
                        [agentId]: {
                          ...sess,
                          messages: [...sess.messages, lastUserMsg],
                        },
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
              const isAnnouncement = session.status === "idle";
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

        const session = get().sessions[agentId];
        if (!session) break;

        // Skip transient states; process completed/standalone messages.
        // Gateway commonly uses state="final", but some producers may omit state.
        if (state && state !== "final") break;

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
        text = text.replace(/Conversation info \(untrusted metadata\):\s*```json\s*\{[^}]*\}\s*```\s*/g, "").trim();

        // WHITELIST FILTER — skip noise
        if (!text.trim()) break;
        if (/HEARTBEAT_OK|heartbeat/i.test(text)) break;
        if (role === "tool" || role === "function") break;

        // Dedup: skip if this runId is already tracked by the 'agent' handler
        if (runId && session.messages.some((m) => m.runId === runId)) break;

        // Dedup: skip if the last message has identical text within 5 seconds
        const lastMsg = session.messages[session.messages.length - 1];
        if (
          lastMsg &&
          lastMsg.text === text &&
          Date.now() - lastMsg.timestamp < 5000
        ) {
          break;
        }

        // Render inbound/outbound completed messages not already tracked by the
        // streaming 'agent' handler. Keep assistant/system as announcements, but
        // include user messages so Telegram inbound text appears in deck chat.
        if (role === "assistant" || role === "system" || role === "user") {
          const mappedRole: ChatMessage["role"] =
            role === "user" ? "user" : "announcement";

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
            return {
              sessions: {
                ...s.sessions,
                [agentId]: {
                  ...sess,
                  messages: [...sess.messages, chatMsg],
                },
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
