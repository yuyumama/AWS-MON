import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// ローカルでは /api プレフィックスを apps/api (localhost:8080) にプロキシする。
// 本番は CloudFront で同一オリジンに載せる想定(フェーズ4で対応)。
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      "/api": {
        target: "http://localhost:8080",
        changeOrigin: true,
        rewrite: (path) => path.replace(/^\/api/, ""),
      },
    },
  },
});
