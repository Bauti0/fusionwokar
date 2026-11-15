// setup-server.js - Arranca el servidor Express + Vite preview para E2E
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { config } from 'dotenv';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Cargar variables de entorno
config({ path: resolve(__dirname, '..', '.env.e2e') });

const PORT = process.env.PORT || 4001;
const VITE_PORT = 4173;

console.log(`[E2E Server] Iniciando servidor en puerto ${PORT}...`);
console.log(`[E2E Server] Vite preview en puerto ${VITE_PORT}...`);

// Arrancar servidor Express
const serverProcess = spawn('node', ['../server/index.js'], {
  cwd: __dirname,
  stdio: 'inherit',
  env: { ...process.env, PORT: String(PORT) }
});

serverProcess.on('error', (err) => {
  console.error('[E2E Server] Error al arrancar servidor:', err);
  process.exit(1);
});

// Arrancar Vite preview - usar npx.cmd en Windows
const isWindows = process.platform === 'win32';
const viteProcess = spawn(isWindows ? 'npx.cmd' : 'npx', ['vite', 'preview', '--port', String(VITE_PORT), '--host'], {
  cwd: resolve(__dirname, '..'),
  stdio: 'inherit',
  env: { ...process.env, NODE_ENV: 'production' }
});

viteProcess.on('error', (err) => {
  console.error('[E2E Server] Error al arrancar Vite preview:', err);
  process.exit(1);
});

// Manejar señales de cierre
function cleanup() {
  console.log('[E2E Server] Cerrando procesos...');
  serverProcess.kill();
  viteProcess.kill();
  process.exit(0);
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
process.on('exit', cleanup);

// Esperar a que ambos estén listos
await new Promise((resolve) => setTimeout(resolve, 3000));
console.log('[E2E Server] Servidores listos');