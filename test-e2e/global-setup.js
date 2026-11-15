// global-setup.js - Configura la base de datos temporal y arranca el servidor para E2E
import { createClient } from '@libsql/client';
import { createDb } from '../server/sqlite.js';
import { hashToken, hashPassword } from '../server/auth.js';
import { unlinkSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEST_DB = `file:${resolve(__dirname, '..', 'test-e2e.db')}`;

async function setupDatabase() {
  console.log('[E2E] Configurando base de datos temporal...');
  
  // Limpiar archivos de BD previos
  for (const f of ['test-e2e.db', 'test-e2e.db-shm', 'test-e2e.db-wal']) {
    const fullPath = resolve(__dirname, '..', f);
    try { unlinkSync(fullPath); } catch {}
  }

  const client = createClient({ url: TEST_DB, authToken: '' });
  const db = createDb(client);

  // Crear tablas necesarias
  await db.exec(`
    CREATE TABLE admin_tokens (
      token TEXT PRIMARY KEY,
      created_at TEXT NOT NULL,
      admin_user_id INTEGER,
      role TEXT NOT NULL DEFAULT 'superadmin',
      branch TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE admin_users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      username TEXT UNIQUE NOT NULL COLLATE NOCASE,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'branch_admin',
      branch TEXT NOT NULL DEFAULT '',
      active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE admin_config (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
    CREATE TABLE webhook_requests (
      request_id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL
    );
    CREATE TABLE branch_shipping_settings (
      branch TEXT PRIMARY KEY,
      auto_enabled INTEGER NOT NULL DEFAULT 1,
      origin_address TEXT NOT NULL DEFAULT '',
      origin_lat REAL,
      origin_lng REAL,
      center_lat REAL,
      center_lng REAL,
      search_radius_km REAL,
      base_cost INTEGER NOT NULL DEFAULT 0,
      flat_blocks INTEGER NOT NULL DEFAULT 0,
      per_block INTEGER NOT NULL DEFAULT 0,
      max_blocks INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL,
      updated_by TEXT NOT NULL DEFAULT ''
    );
    CREATE TABLE branch_shipping_settings_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      branch TEXT NOT NULL,
      admin_user_id INTEGER,
      admin_username TEXT NOT NULL,
      admin_role TEXT NOT NULL,
      field TEXT NOT NULL,
      old_value TEXT,
      new_value TEXT,
      created_at TEXT NOT NULL
    );
    CREATE INDEX idx_shipping_settings_log_branch ON branch_shipping_settings_log(branch);
    CREATE INDEX idx_shipping_settings_log_created ON branch_shipping_settings_log(created_at);
  `);

  // Insertar superadmin
  const superHash = hashPassword('SuperSecret123');
  await db.prepare(`
    INSERT INTO admin_users (username, password_hash, role, branch, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('superadmin', superHash, 'superadmin', '', 1, new Date().toISOString(), new Date().toISOString());

  // Insertar branch_admin para Tandil
  const tandilHash = hashPassword('tandilpass123');
  await db.prepare(`
    INSERT INTO admin_users (username, password_hash, role, branch, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('tandil1', tandilHash, 'branch_admin', 'tandil', 1, new Date().toISOString(), new Date().toISOString());

  // Insertar branch_admin para Necochea
  const necocheaHash = hashPassword('necocheapass123');
  await db.prepare(`
    INSERT INTO admin_users (username, password_hash, role, branch, active, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run('necochea1', necocheaHash, 'branch_admin', 'necochea', 1, new Date().toISOString(), new Date().toISOString());

  // Sembrar configuración de envío para ambas sucursales
  const now = new Date().toISOString();
  const insertShipping = db.prepare(`
    INSERT INTO branch_shipping_settings
    (branch, auto_enabled, origin_address, origin_lat, origin_lng, center_lat, center_lng, search_radius_km, base_cost, flat_blocks, per_block, max_blocks, updated_at, updated_by)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Tandil
  await insertShipping.run(
    'tandil',
    1,
    'Chacabuco 660, Tandil, Buenos Aires, Argentina',
    -37.32154,
    -59.13024,
    -37.32154,
    -59.13024,
    50,
    4000,
    20,
    100,
    0,
    now,
    'sistema'
  );

  // Necochea
  await insertShipping.run(
    'necochea',
    1,
    'Diagonal San Martín 1258, Necochea, Buenos Aires, Argentina',
    -38.5670514,
    -58.7293811,
    -38.5670514,
    -58.7293811,
    14,
    4000,
    20,
    100,
    0,
    now,
    'sistema'
  );

  console.log('[E2E] Base de datos configurada con usuarios y configuración de envío');

  // Guardar variables de entorno para el servidor
  const envContent = `
TEST_MODE=true
DEMO_MODE=true
TURSO_DATABASE_URL=${TEST_DB}
TURSO_AUTH_TOKEN=
MP_WEBHOOK_SECRET=secreto-de-prueba-del-webhook-fusionwok
ADMIN_USER=superadmin
ADMIN_PASSWORD=SuperSecret123
PORT=3001
VITE_API_URL=http://localhost:3001
  `.trim();

  writeFileSync(resolve(__dirname, '..', '.env.e2e'), envContent);
  console.log('[E2E] Archivo .env.e2e creado');
}

async function buildClient() {
  console.log('[E2E] Construyendo cliente Vite...');
  return new Promise((resolve, reject) => {
    // Use shell: true on Windows to handle npm.cmd properly
    const build = spawn('npm', ['run', 'build'], { 
      stdio: 'inherit',
      shell: true,
      env: { ...process.env, NODE_ENV: 'production' }
    });
    build.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Build failed with code ${code}`));
    });
  });
}

async function startServer() {
  console.log('[E2E] Iniciando servidor Express en puerto 3001...');
  // Load .env.e2e BEFORE importing server (so dotenv/config picks it up)
  const { config: dotenvConfig } = await import('dotenv');
  const { resolve } = await import('node:path');
  dotenvConfig({ path: resolve(__dirname, '..', '.env.e2e'), override: true });
  
  // Now import the server - it will load dotenv/config which now sees our vars
  const mod = await import('../server/index.js');
  const app = mod.app;
  const PORT = 3001;
  
  return new Promise((resolve) => {
    const server = app.listen(PORT, () => {
      console.log(`🌱 Fusión Wok API corriendo en http://localhost:${PORT}`);
      console.log(`   Modo demo: SÍ (sin credenciales reales)`);
      resolve(server);
    });
  });
}

let serverInstance = null;

export default async function globalSetup() {
  await setupDatabase();
  await buildClient();
  serverInstance = await startServer();
  console.log('[E2E] Global setup completado');
}

export { serverInstance };