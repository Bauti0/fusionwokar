import { execFileSync } from "node:child_process";
import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Commit con el que se compiló la app (se muestra, chiquito, en el panel de
// admin). Se lee una sola vez al arrancar Vite. Si no hay git disponible
// (por ejemplo un build sin la carpeta .git) devuelve "?" y el panel no
// dibuja nada: es información decorativa, nunca debe romper el arranque.
function currentCommit() {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: import.meta.dirname,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "?";
  }
}

export default defineConfig({
  plugins: [react()],
  define: {
    __APP_COMMIT__: JSON.stringify(currentCommit()),
  },
  server: {
    proxy: {
      // En desarrollo, las llamadas a /api van al backend Express
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
      // En desarrollo, las imágenes de producto (/uploads/...) también
      // van al backend Express (en prod las sirve el propio Express).
      "/uploads": {
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