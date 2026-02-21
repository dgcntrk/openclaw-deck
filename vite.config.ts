import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

const GATEWAY_HTTP_TARGET = "http://127.0.0.1:18789";
const GATEWAY_WS_TARGET = "ws://127.0.0.1:18789";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: 5173,
    proxy: {
      "/ws": {
        target: GATEWAY_WS_TARGET,
        ws: true,
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/ws/, ""),
        configure: (proxy) => {
          proxy.on("proxyReqWs", (proxyReq) => {
            proxyReq.setHeader("origin", "http://localhost:18789");
            proxyReq.setHeader("host", "localhost:18789");
            proxyReq.setHeader("x-forwarded-proto", "https");
            proxyReq.setHeader("x-forwarded-host", "localhost:18789");
          });
        },
      },
      "/api/config": {
        target: GATEWAY_HTTP_TARGET,
        changeOrigin: true,
        rewrite: () => "/config",
      },
    },
  },
});
