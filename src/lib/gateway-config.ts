import type { AgentConfig } from "../types";

const ENV_DEFAULT_MODEL = (import.meta.env.VITE_DEFAULT_MODEL as string | undefined)?.trim();

// Fallback model if gateway fetch fails
export const FALLBACK_MODEL = ENV_DEFAULT_MODEL || "anthropic/claude-opus-4-6";

// Fallback models list for AddAgentModal
export const FALLBACK_MODELS = [
  { id: "anthropic/claude-opus-4-6", name: "Opus 4.6" },
  { id: "anthropic/claude-sonnet-4-5", name: "Sonnet 4.5" },
  { id: "moonshot/kimi-k2.5", name: "Kimi K2.5" },
  { id: "kimi-coding/k2p5", name: "Kimi K2.5 (Coding)" },
];

export interface GatewayInfo {
  defaultModel: string;
  availableModels: Array<{ id: string; name: string }>;
}

function normalizeModelMap(config: any): Array<{ id: string; name: string }> {
  const models =
    config?.agents?.defaults?.models ||
    config?.agents?.models ||
    config?.models ||
    {};

  if (!models || typeof models !== "object") return [];

  return Object.entries(models).map(([id, info]: [string, any]) => ({
    id,
    name: info?.alias || info?.name || id.split("/").pop() || id,
  }));
}

async function fetchConfigJson(url: string, headers: Record<string, string>) {
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`${url} -> HTTP ${res.status}`);

  const contentType = res.headers.get("content-type") || "";
  if (!contentType.includes("application/json")) {
    throw new Error(`${url} -> non-JSON response (${contentType || "unknown"})`);
  }

  return res.json();
}

/**
 * Fetch gateway configuration including available models.
 * Falls back to hardcoded/env defaults if fetch fails.
 */
export async function fetchGatewayConfig(
  gatewayUrl: string,
  token?: string
): Promise<GatewayInfo> {
  const headers: Record<string, string> = {
    Accept: "application/json",
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;

  try {
    // Try common proxied paths; some setups expose one but not the other.
    let config: any;
    try {
      config = await fetchConfigJson("/config", headers);
    } catch {
      config = await fetchConfigJson("/api/config", headers);
    }

    const modelList = normalizeModelMap(config);
    const defaultModel =
      config?.agents?.defaults?.model?.primary ||
      config?.agents?.defaults?.model ||
      modelList[0]?.id ||
      FALLBACK_MODEL;

    return {
      defaultModel,
      availableModels: modelList.length > 0 ? modelList : FALLBACK_MODELS,
    };
  } catch (err) {
    console.warn("[GatewayConfig] Failed to fetch models, using fallback:", err);
    return {
      defaultModel: FALLBACK_MODEL,
      availableModels: FALLBACK_MODELS,
    };
  }
}

/**
 * Build default agents with dynamic model from gateway config.
 */
export function buildDefaultAgents(
  count: number,
  defaultModel: string = FALLBACK_MODEL
): AgentConfig[] {
  const AGENT_ACCENTS = [
    "#22d3ee",
    "#a78bfa",
    "#34d399",
    "#f59e0b",
    "#f472b6",
    "#60a5fa",
    "#facc15",
    "#fb7185",
    "#4ade80",
    "#c084fc",
    "#f97316",
    "#2dd4bf",
  ];

  return Array.from({ length: count }, (_, i) => {
    const agentId = i === 0 ? "main" : `agent-${i + 1}`;
    const agentName = i === 0 ? "Main" : `Agent ${i + 1}`;

    return {
      id: agentId,
      name: agentName,
      icon: String(i + 1),
      accent: AGENT_ACCENTS[i % AGENT_ACCENTS.length],
      context: "",
      model: defaultModel,
    };
  });
}
