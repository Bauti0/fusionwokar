// test/admin-routes-inventory.test.js — Inventario explícito de TODAS las rutas /api/admin/*
//
// Si alguien agrega un endpoint nuevo y no lo anota en ADMIN_ROUTES, este test FALLA.
// Tabla: ruta | método | requiere sesión | tipo de scope
//   scopeType:
//     - 'branch_admin'  → branch_admin forzado a su sucursal (scope = branch del admin)
//     - 'superadmin'    → solo superadmin (requireSuperadmin)
//     - 'none'          → sin scope (superadmin ve todo, branch_admin ve su sucursal)

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Cargar el server real para inspeccionar sus rutas
// Usamos require dinámico porque index.js tiene side-effects (DB, etc.)
// En su lugar, parseamos el archivo fuente para extraer las rutas registradas.

const fs = await import("node:fs");
const serverIndex = fs.readFileSync(resolve(__dirname, "../server/index.js"), "utf-8");

// Extraer todas las rutas app.METHOD("/api/admin/...") del source
function extractAdminRoutes(source) {
  const routes = [];
  const regex = /app\.(get|post|put|patch|delete)\(\s*["'`](\/api\/admin[^"'`]+)["'`]/g;
  let match;
  while ((match = regex.exec(source)) !== null) {
    const method = match[1].toUpperCase();
    let path = match[2];
    // Normalizar parámetros de ruta (:id → {id})
    path = path.replace(/:(\w+)/g, "{$1}");
    routes.push({ method, path });
  }
  return routes;
}

const DISCOVERED_ROUTES = extractAdminRoutes(serverIndex);

// ============================================================
// TABLA EXPLÍCITA DEFINITIVA — ACTUALIZAR AL AGREGAR RUTAS NUEVAS
// ============================================================
const ADMIN_ROUTES = [
  // Auth (login NO requiere sesión; logout y me sí)
  { method: "POST", path: "/api/admin/login", scopeType: "none" },
  { method: "POST", path: "/api/admin/logout", scopeType: "branch_admin" },
  { method: "POST", path: "/api/admin/logout-all", scopeType: "superadmin" },
  { method: "GET", path: "/api/admin/me", scopeType: "branch_admin" },
  { method: "POST", path: "/api/admin/upload", scopeType: "branch_admin" },

  // Orders
  { method: "GET", path: "/api/admin/orders", scopeType: "branch_admin" },
  { method: "GET", path: "/api/admin/orders/unseen", scopeType: "branch_admin" },
  { method: "POST", path: "/api/admin/orders/seen-all", scopeType: "branch_admin" },
  { method: "PATCH", path: "/api/admin/orders/{id}/seen", scopeType: "branch_admin" },
  { method: "GET", path: "/api/admin/orders/{id}", scopeType: "branch_admin" },
  { method: "PATCH", path: "/api/admin/orders/{id}/status", scopeType: "branch_admin" },
  { method: "POST", path: "/api/admin/orders/{id}/shipping", scopeType: "branch_admin" },
  { method: "POST", path: "/api/admin/orders/{id}/refund", scopeType: "branch_admin" },
  { method: "PATCH", path: "/api/admin/orders/{id}", scopeType: "branch_admin" },
  { method: "GET", path: "/api/admin/orders/{id}/audit", scopeType: "superadmin" },
  { method: "POST", path: "/api/admin/orders/{id}/seen", scopeType: "branch_admin" },
  { method: "POST", path: "/api/admin/orders/manual", scopeType: "branch_admin" },

  // Stats / Reports
  { method: "GET", path: "/api/admin/stats", scopeType: "branch_admin" },
  { method: "GET", path: "/api/admin/dashboard", scopeType: "branch_admin" },
  { method: "GET", path: "/api/admin/customers", scopeType: "branch_admin" },
  { method: "GET", path: "/api/admin/sales", scopeType: "branch_admin" },

  // Cash Register
  { method: "GET", path: "/api/admin/cash-register", scopeType: "branch_admin" },
  { method: "POST", path: "/api/admin/cash-register/open", scopeType: "branch_admin" },
  { method: "POST", path: "/api/admin/cash-register/{id}/close", scopeType: "branch_admin" },
  { method: "PATCH", path: "/api/admin/cash-register/{id}", scopeType: "superadmin" },
  { method: "DELETE", path: "/api/admin/cash-register/{id}", scopeType: "superadmin" },
  { method: "GET", path: "/api/admin/cash-register/deleted", scopeType: "superadmin" },
  { method: "GET", path: "/api/admin/cash-register/{id}/corrections", scopeType: "superadmin" },

  // Expenses
  { method: "GET", path: "/api/admin/expenses", scopeType: "branch_admin" },
  { method: "POST", path: "/api/admin/expenses", scopeType: "branch_admin" },
  { method: "PATCH", path: "/api/admin/expenses/{id}", scopeType: "branch_admin" },
  { method: "DELETE", path: "/api/admin/expenses/{id}", scopeType: "branch_admin" },

  // Branch Pause
  { method: "GET", path: "/api/admin/branch-pause", scopeType: "branch_admin" },
  { method: "PUT", path: "/api/admin/branch-pause", scopeType: "branch_admin" },

  // Branch Hours
  { method: "GET", path: "/api/admin/branch-hours", scopeType: "branch_admin" },
  { method: "PUT", path: "/api/admin/branch-hours", scopeType: "branch_admin" },

  // Products
  { method: "GET", path: "/api/admin/products", scopeType: "branch_admin" },
  { method: "POST", path: "/api/admin/products", scopeType: "branch_admin" },
  { method: "PUT", path: "/api/admin/products/{id}", scopeType: "branch_admin" },
  { method: "PATCH", path: "/api/admin/products/{id}/available", scopeType: "branch_admin" },
  { method: "DELETE", path: "/api/admin/products/{id}", scopeType: "branch_admin" },
  { method: "POST", path: "/api/admin/products/{id}/move", scopeType: "branch_admin" },

  // Extras
  { method: "GET", path: "/api/admin/extras", scopeType: "branch_admin" },
  { method: "PUT", path: "/api/admin/extras/{extraId}", scopeType: "branch_admin" },

  // Categories
  { method: "POST", path: "/api/admin/categories", scopeType: "branch_admin" },
  { method: "PUT", path: "/api/admin/categories/{id}", scopeType: "branch_admin" },
  { method: "DELETE", path: "/api/admin/categories/{id}", scopeType: "branch_admin" },
  { method: "POST", path: "/api/admin/categories/{id}/move", scopeType: "branch_admin" },

  // Groups
  { method: "PUT", path: "/api/admin/groups", scopeType: "branch_admin" },
  { method: "DELETE", path: "/api/admin/groups", scopeType: "branch_admin" },

  // Coupons
  { method: "GET", path: "/api/admin/coupons", scopeType: "branch_admin" },
  { method: "POST", path: "/api/admin/coupons", scopeType: "branch_admin" },
  { method: "PATCH", path: "/api/admin/coupons/{id}", scopeType: "branch_admin" },
  { method: "PUT", path: "/api/admin/coupons/{id}", scopeType: "branch_admin" },
  { method: "DELETE", path: "/api/admin/coupons/{id}", scopeType: "branch_admin" },

  // Users (solo superadmin)
  { method: "GET", path: "/api/admin/users", scopeType: "superadmin" },
  { method: "POST", path: "/api/admin/users", scopeType: "superadmin" },
  { method: "PUT", path: "/api/admin/users/{id}/password", scopeType: "superadmin" },
  { method: "PATCH", path: "/api/admin/users/{id}", scopeType: "superadmin" },
  { method: "DELETE", path: "/api/admin/users/{id}", scopeType: "superadmin" },
];

describe("Admin routes inventory", () => {
  it("todas las rutas descubiertas en index.js están en la tabla ADMIN_ROUTES", () => {
    const missing = [];
    for (const r of DISCOVERED_ROUTES) {
      const found = ADMIN_ROUTES.some(
        (t) => t.method === r.method && t.path === r.path
      );
      if (!found) {
        missing.push(`${r.method} ${r.path}`);
      }
    }
    if (missing.length > 0) {
      assert.fail(
        "Rutas NUEVAS detectadas en index.js que NO están en ADMIN_ROUTES:\n" +
          missing.map((m) => `  - ${m}`).join("\n") +
          "\n\nAgregalas a test/admin-routes-inventory.test.js en la tabla ADMIN_ROUTES."
      );
    }
  });

  it("todas las rutas de ADMIN_ROUTES existen realmente en index.js", () => {
    const missing = [];
    for (const t of ADMIN_ROUTES) {
      const found = DISCOVERED_ROUTES.some(
        (r) => r.method === t.method && r.path === t.path
      );
      if (!found) {
        missing.push(`${t.method} ${t.path}`);
      }
    }
    if (missing.length > 0) {
      assert.fail(
        "Rutas en ADMIN_ROUTES que YA NO EXISTEN en index.js (borradas o renombradas):\n" +
          missing.map((m) => `  - ${m}`).join("\n")
      );
    }
  });

  it("no hay duplicados en ADMIN_ROUTES", () => {
    const seen = new Set();
    const dupes = [];
    for (const t of ADMIN_ROUTES) {
      const key = `${t.method} ${t.path}`;
      if (seen.has(key)) dupes.push(key);
      seen.add(key);
    }
    if (dupes.length > 0) {
      assert.fail("Duplicados en ADMIN_ROUTES:\n" + dupes.map((d) => `  - ${d}`).join("\n"));
    }
  });

  it("scopeType es válido en todas las entradas", () => {
    const valid = ["branch_admin", "superadmin", "none"];
    const invalid = ADMIN_ROUTES.filter((t) => !valid.includes(t.scopeType));
    if (invalid.length > 0) {
      assert.fail(
        "scopeType inválido (debe ser 'branch_admin' | 'superadmin' | 'none'):\n" +
          invalid.map((t) => `  - ${t.method} ${t.path}: ${t.scopeType}`).join("\n")
      );
    }
  });
});

// Exportar para que otros tests lo usen
export { ADMIN_ROUTES, DISCOVERED_ROUTES };