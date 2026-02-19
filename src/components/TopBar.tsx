import { useState, useEffect } from "react";
import { useDeckStats } from "../hooks";
import { useDeckStore } from "../lib/store";
import { ThemeSwitcher } from "./ThemeSwitcher";
import styles from "./TopBar.module.css";

const TABS = ["All Agents", "Active", "Queued", "Completed"] as const;

export function TopBar({
  activeTab,
  onTabChange,
  onAddAgent,
}: {
  activeTab: string;
  onTabChange: (tab: string) => void;
  onAddAgent: () => void;
}) {
  const stats = useDeckStats();
  const agents = useDeckStore((s) => s.config.agents);
  const sessions = useDeckStore((s) => s.sessions);
  const [time, setTime] = useState(new Date());
  const [handoffState, setHandoffState] = useState<"idle" | "ok" | "error">("idle");

  useEffect(() => {
    const t = setInterval(() => setTime(new Date()), 1000);
    return () => clearInterval(t);
  }, []);

  const buildHandoffSummary = () => {
    const lines: string[] = [];
    lines.push(`# OpenClaw Deck Handoff`);
    lines.push(`Generated: ${new Date().toISOString()}`);
    lines.push("");

    for (const agent of agents) {
      const session = sessions[agent.id];
      const messages = session?.messages ?? [];
      const lastAssistant = [...messages].reverse().find((m) => m.role === "assistant" && m.text?.trim());
      const status = session?.status ?? "idle";
      const sessionKey = `agent:main:${agent.id}`;

      lines.push(`## ${agent.name} (${agent.id})`);
      lines.push(`- Status: ${status}`);
      lines.push(`- Session Key: ${sessionKey}`);
      lines.push(`- Last Assistant Output:`);
      lines.push(lastAssistant ? `  ${lastAssistant.text.slice(0, 500).replace(/\n/g, "\n  ")}` : "  (none yet)");
      lines.push("");
    }

    return lines.join("\n");
  };

  const copyHandoff = async () => {
    try {
      await navigator.clipboard.writeText(buildHandoffSummary());
      setHandoffState("ok");
    } catch {
      setHandoffState("error");
    } finally {
      setTimeout(() => setHandoffState("idle"), 1800);
    }
  };

  return (
    <div className={styles.bar}>
      {/* Logo */}
      <div className={styles.logo}>
        <div className={styles.logoIcon}>◈</div>
        <span className={styles.logoText}>OpenClaw</span>
        <span className={styles.logoBadge}>DECK</span>
      </div>

      {/* Tabs */}
      <div className={styles.tabs}>
        {TABS.map((tab) => (
          <button
            key={tab}
            className={`${styles.tab} ${activeTab === tab ? styles.tabActive : ""}`}
            onClick={() => onTabChange(tab)}
          >
            {tab}
            {tab === "All Agents" && (
              <span className={styles.tabCount}>{stats.totalAgents}</span>
            )}
            {tab === "Active" && stats.active > 0 && (
              <span className={styles.tabCount}>{stats.active}</span>
            )}
          </button>
        ))}
      </div>

      {/* Stats */}
      <div className={styles.stats}>
        <div className={styles.stat}>
          <div
            className={styles.statDot}
            style={{
              backgroundColor: stats.gatewayConnected ? "#34d399" : "#ef4444",
            }}
          />
          <span>
            <span
              style={{
                color: stats.gatewayConnected ? "#34d399" : "#ef4444",
              }}
            >
              {stats.active}
            </span>{" "}
            streaming
          </span>
        </div>
        <div className={styles.stat}>
          tokens:{" "}
          <span className={styles.statValue}>
            {stats.totalTokens.toLocaleString()}
          </span>
        </div>
        <div className={styles.stat}>
          {time.toLocaleTimeString("en-US", {
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit",
            hour12: false,
          })}
        </div>
      </div>

      <ThemeSwitcher />

      <button className={styles.handoffBtn} onClick={copyHandoff}>
        {handoffState === "ok"
          ? "✓ Handoff Copied"
          : handoffState === "error"
            ? "⚠ Copy Failed"
            : "Copy Handoff"}
      </button>

      <button className={styles.addBtn} onClick={onAddAgent}>
        <span>+</span> New Agent
      </button>
    </div>
  );
}
