// global-teardown.js - Limpieza después de E2E
import { unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Import serverInstance from global-setup
let serverInstance = null;
try {
  const mod = await import('./global-setup.js');
  serverInstance = mod.serverInstance;
} catch {}

export default async function globalTeardown() {
  console.log('[E2E] Limpiando base de datos temporal...');
  if (serverInstance) {
    console.log('[E2E] Cerrando servidor...');
    await new Promise(resolve => serverInstance.close(resolve));
  }
  for (const f of ['test-e2e.db', 'test-e2e.db-shm', 'test-e2e.db-wal', '.env.e2e']) {
    try { unlinkSync(resolve(__dirname, '..', f)); } catch {}
  }
  console.log('[E2E] Limpieza completada');
}