import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), "");

  // Example Tailscale target:
  // VITE_PROXY_TARGET=https://minimacs-mac-mini.tail8ebd56.ts.net:18790
  const proxyWsTarget = env.VITE_PROXY_WS_TARGET || env.VITE_PROXY_TARGET || "ws://127.0.0.1:18789";
  const proxyConfigTarget = env.VITE_PROXY_CONFIG_TARGET || env.VITE_PROXY_TARGET || "http://127.0.0.1:18790";

  return {
    plugins: [react()],
    server: {
      host: "0.0.0.0",
      port: 5173,
      allowedHosts: ["minimacs-mac-mini.tail8ebd56.ts.net"],
      proxy: {
        "/ws": {
          target: proxyWsTarget,
          ws: true,
          secure: proxyWsTarget.startsWith("wss://"),
          changeOrigin: true,
          rewrite: (path) => path.replace(/^\/ws/, ""),
        },
        "/api/config": {
          target: proxyConfigTarget,
          secure: proxyConfigTarget.startsWith("https://"),
          changeOrigin: true,
          rewrite: () => "/config",
        },
      },
    },
  };
});
