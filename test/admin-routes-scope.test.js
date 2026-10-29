// test/admin-routes-scope.test.js — Tests parametrizados de scope por ruta (versión simplificada)
//
// Para CADA ruta en ADMIN_ROUTES verifica la lógica de scope SIN levantar Express completo.
// Usa las funciones reales de admin-queries.js que ya tienen tests de scope.
// Este test solo verifica que la tabla ADMIN_ROUTES cubre los endpoints críticos.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { ADMIN_ROUTES } from "./admin-routes-inventory.test.js";

describe("Admin routes — scope table coverage", () => {
  // Verificar que todos los endpoints CRÍTICOS de escritura tengan scopeType = 'branch_admin' o 'superadmin'
  const criticalWriteEndpoints = [
    // Orders
    "PATCH /api/admin/orders/{id}/status",
    "POST /api/admin/orders/{id}/shipping",
    "POST /api/admin/orders/{id}/refund",
    "PATCH /api/admin/orders/{id}",
    "POST /api/admin/orders/{id}/seen",
    "POST /api/admin/orders/seen-all",
    "POST /api/admin/orders/manual",
    // Cash register
    "POST /api/admin/cash-register/open",
    "POST /api/admin/cash-register/{id}/close",
    "PATCH /api/admin/cash-register/{id}",
    "DELETE /api/admin/cash-register/{id}",
    // Expenses
    "POST /api/admin/expenses",
    "PATCH /api/admin/expenses/{id}",
    "DELETE /api/admin/expenses/{id}",
    // Branch pause
    "PUT /api/admin/branch-pause",
    // Branch hours
    "PUT /api/admin/branch-hours",
    // Products
    "POST /api/admin/products",
    "PUT /api/admin/products/{id}",
    "PATCH /api/admin/products/{id}/available",
    "DELETE /api/admin/products/{id}",
    "POST /api/admin/products/{id}/move",
    // Extras
    "PUT /api/admin/extras/{extraId}",
    // Categories
    "POST /api/admin/categories",
    "PUT /api/admin/categories/{id}",
    "DELETE /api/admin/categories/{id}",
    "POST /api/admin/categories/{id}/move",
    // Groups
    "PUT /api/admin/groups",
    "DELETE /api/admin/groups",
    // Coupons
    "POST /api/admin/coupons",
    "PATCH /api/admin/coupons/{id}",
    "PUT /api/admin/coupons/{id}",
    "DELETE /api/admin/coupons/{id}",
    // Users
    "POST /api/admin/users",
    "PUT /api/admin/users/{id}/password",
    "PATCH /api/admin/users/{id}",
    "DELETE /api/admin/users/{id}",
    // Upload
    "POST /api/admin/upload",
  ];

  it("todos los endpoints críticos de escritura están en ADMIN_ROUTES con scope correcto", () => {
    const missing = [];
    const wrongScope = [];

    for (const endpoint of criticalWriteEndpoints) {
      const [method, path] = endpoint.split(" ");
      const found = ADMIN_ROUTES.find(r => r.method === method && r.path === path);
      if (!found) {
        missing.push(endpoint);
      } else if (found.scopeType === "none") {
        wrongScope.push(`${endpoint} → scopeType: ${found.scopeType}`);
      }
    }

    if (missing.length > 0) {
      assert.fail("Endpoints críticos FALTANTES en ADMIN_ROUTES:\n" + missing.map(m => `  - ${m}`).join("\n"));
    }
    if (wrongScope.length > 0) {
      assert.fail("Endpoints críticos con scopeType 'none' (deberían ser 'branch_admin' o 'superadmin'):\n" + wrongScope.join("\n"));
    }
  });

  // Verificar que TODOS los endpoints con scopeType 'superadmin' son realmente solo para superadmin
  it("endpoints marcados como 'superadmin' son realmente sensibles", () => {
    const superadminRoutes = ADMIN_ROUTES.filter(r => r.scopeType === "superadmin");
    const expectedSuperadmin = [
      "POST /api/admin/logout-all",
      "GET /api/admin/orders/{id}/audit",
      "PATCH /api/admin/cash-register/{id}",
      "DELETE /api/admin/cash-register/{id}",
      "GET /api/admin/cash-register/deleted",
      "GET /api/admin/cash-register/{id}/corrections",
      "GET /api/admin/users",
      "POST /api/admin/users",
      "PUT /api/admin/users/{id}/password",
      "PATCH /api/admin/users/{id}",
      "DELETE /api/admin/users/{id}",
    ];

    for (const expected of expectedSuperadmin) {
      const [method, path] = expected.split(" ");
      const found = superadminRoutes.find(r => r.method === method && r.path === path);
      if (!found) {
        assert.fail(`Endpoint que DEBERÍA ser superadmin pero no lo está: ${expected}`);
      }
    }
  });

  // Verificar que no hay endpoints de lectura marcados como 'superadmin' innecesariamente
  it("endpoints de lectura NO están marcados como 'superadmin' a menos que sea auditoría/usuarios", () => {
    const superadminReads = ADMIN_ROUTES.filter(r =>
      r.scopeType === "superadmin" && ["GET"].includes(r.method)
    );

    const allowedSuperadminReads = [
      "POST /api/admin/logout-all",
      "GET /api/admin/orders/{id}/audit",
      "GET /api/admin/cash-register/deleted",
      "GET /api/admin/cash-register/{id}/corrections",
      "GET /api/admin/users",
    ];

    for (const route of superadminReads) {
      const key = `${route.method} ${route.path}`;
      if (!allowedSuperadminReads.includes(key)) {
        assert.fail(`Endpoint de lectura marcado como superadmin innecesariamente: ${key}`);
      }
    }
  });

  // Verificar que branch_admin routes no incluyen operaciones que deberían ser superadmin
  it("no hay operaciones de superadmin marcadas como 'branch_admin'", () => {
    const branchAdminWrites = ADMIN_ROUTES.filter(r =>
      r.scopeType === "branch_admin" && ["POST", "PUT", "PATCH", "DELETE"].includes(r.method)
    );

    // Estas operaciones NUNCA deberían ser branch_admin
    const forbiddenForBranchAdmin = [
      "PATCH /api/admin/cash-register/{id}",
      "DELETE /api/admin/cash-register/{id}",
      "GET /api/admin/cash-register/deleted",
      "GET /api/admin/cash-register/{id}/corrections",
      "POST /api/admin/users",
      "PUT /api/admin/users/{id}/password",
      "PATCH /api/admin/users/{id}",
      "DELETE /api/admin/users/{id}",
    ];

    for (const forbidden of forbiddenForBranchAdmin) {
      const [method, path] = forbidden.split(" ");
      const found = branchAdminWrites.find(r => r.method === method && r.path === path);
      if (found) {
        assert.fail(`Operación de superadmin marcada incorrectamente como branch_admin: ${forbidden}`);
      }
    }
  });
});