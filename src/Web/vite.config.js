import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

const target = process.env.XPATHED_URL ?? "http://127.0.0.1:8080";
function proxy(destination, ws = false) {
  return {
    target: destination,
    ws,
    changeOrigin: true,
    configure(proxyServer) {
      function forwardOrigin(proxyRequest, request) {
        if (request.headers.origin === `http://${request.headers.host}`) {
          proxyRequest.setHeader("Origin", new URL(destination).origin);
        }
      }
      proxyServer.on("proxyReq", forwardOrigin);
      proxyServer.on("proxyReqWs", forwardOrigin);
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: "127.0.0.1",
    strictPort: true,
    proxy: {
      "/api": proxy(target),
      "/health": proxy(target),
      "/view": proxy(process.env.XPATHED_BROWSER_URL ?? target, true),
    },
  },
});
