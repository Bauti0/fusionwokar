import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      // En desarrollo, las llamadas a /api van al backend Express
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
  build: {
    target: "es2020",
    // Separar React/router en un chunk propio (casi nunca cambia): con hash
    // inmutable el navegador lo reutiliza sin volver a descargarlo en cada
    // deploy, y el app-code queda en chunks chicos (además del code splitting
    // por rutas con React.lazy).
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes("node_modules/react") || id.includes("node_modules/scheduler")) {
            return "react-vendor";
          }
          if (id.includes("node_modules/react-router-dom") || id.includes("node_modules/react-router")) {
            return "router-vendor";
          }
        },
      },
    },
  },
});