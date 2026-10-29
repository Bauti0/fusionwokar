import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { formatAuditEdits } from "../src/utils/orderEdit.js";
import { formatPrice } from "../src/utils/format.js";

// Formato del historial de cambios del modal de detalle (solo superadmin).
// Las filas de prueba tienen la forma REAL de order_audit_log (id, field,
// old_value, new_value, old_total, new_total, admin_user_id, admin_username,
// admin_role, admin_branch, created_at; ordenadas del más reciente al más
// viejo), que es lo que devuelve getAuditLogs de server/order-edit.js.
//
// Una edición que toca modo + dirección + envío guarda TRES FILAS (todas
// con el mismo admin_username y created_at) y en la pantalla tiene que
// aparecer como UNA sola edición con tres líneas.

const FILA = {
  id: 1,
  field: "orderMode",
  old_value: "delivery",
  new_value: "pickup",
  old_total: 19000,
  new_total: 17000,
  admin_user_id: null,
  admin_username: "bauti",
  admin_role: "superadmin",
  admin_branch: "",
  created_at: "2026-10-07T10:00:00.000Z",
};
const fila = (extra) => ({ ...FILA, ...extra });

describe("formatAuditEdits", () => {
  it("pedido sin cambios: devuelve una lista vacía", () => {
    assert.deepEqual(formatAuditEdits([]), []);
  });

  it("agrupa las 3 filas de un delivery→mostrador en una sola edición", () => {
    // El backend guarda una fila por campo (modo, dirección, envío); el
    // panel muestra el autor, la fecha y el total UNA vez por edición.
    const edits = formatAuditEdits([
      fila({ id: 3, field: "orderMode", old_value: "delivery", new_value: "pickup" }),
      fila({ id: 4, field: "address", old_value: "Av. San Martín 123", new_value: "" }),
      fila({ id: 5, field: "shipping", old_value: "2000", new_value: "0" }),
    ]);
    assert.equal(edits.length, 1);
    assert.equal(edits[0].lineas.length, 3);
    assert.deepEqual(edits[0].lineas.map((l) => l.campo), [
      "Tipo de entrega",
      "Dirección",
      "Envío",
    ]);
    // Total una sola vez, con los extremos de la edición.
    assert.equal(edits[0].cambioTotal, true);
    assert.equal(edits[0].totalDe, 19000);
    assert.equal(edits[0].totalA, 17000);
  });

  it("dos ediciones distintas (otro timestamp) quedan separadas", () => {
    const edits = formatAuditEdits([
      fila({
        id: 2,
        field: "paymentMethod",
        old_value: "mercadopago",
        new_value: "efectivo",
        old_total: 15000,
        new_total: 15000,
        created_at: "2026-10-07T12:00:00.000Z",
      }),
      fila({
        id: 1,
        field: "orderMode",
        old_value: "pickup",
        new_value: "delivery",
        old_total: 13000,
        new_total: 14500,
        admin_username: "tandil",
        admin_role: "branch_admin",
        admin_branch: "tandil",
        created_at: "2026-10-06T12:00:00.000Z",
      }),
    ]);
    assert.equal(edits.length, 2);
    assert.equal(edits[0].autor, "bauti");
    // Efectivo↔MercadoPago no cambia el total: no se muestra la línea Total.
    assert.equal(edits[0].cambioTotal, false);
    // El branch_admin conserva su sucursal para mostrarla; el superadmin
    // queda en "" y el panel NO le dibuja sucursal.
    assert.equal(edits[1].sucursal, "tandil");
    assert.equal(edits[1].cambioTotal, true);
  });

  it("los valores salen en lenguaje legible", () => {
    const ed = formatAuditEdits([
      fila({ field: "orderMode", old_value: "delivery", new_value: "pickup" }),
    ])[0];
    assert.deepEqual(ed.lineas[0], {
      campo: "Tipo de entrega",
      de: "Delivery",
      a: "Mostrador",
    });

    const pago = formatAuditEdits([
      fila({ field: "paymentMethod", old_value: "mercadopago", new_value: "transferencia" }),
    ])[0];
    assert.deepEqual(pago.lineas[0], {
      campo: "Medio de pago",
      de: "MercadoPago",
      a: "Transferencia",
    });

    // Envío en ARS como el resto del panel.
    const envio = formatAuditEdits([
      fila({ field: "shipping", old_value: "2000", new_value: "0" }),
    ])[0];
    assert.equal(envio.lineas[0].de, formatPrice(2000));
    assert.equal(envio.lineas[0].a, formatPrice(0));

    // Dirección borrada al pasar a mostrador: se muestra el valor anterior
    // y el vacío nuevo queda como "—" (no un hueco).
    const dir = formatAuditEdits([
      fila({ field: "address", old_value: "Calle 1", new_value: "" }),
    ])[0];
    assert.deepEqual(dir.lineas[0], { campo: "Dirección", de: "Calle 1", a: "—" });
  });

  it("la fecha se muestra en hora de Argentina", () => {
    const ed = formatAuditEdits([fila()])[0];
    const esperada = new Date(FILA.created_at).toLocaleString("es-AR", {
      timeZone: "America/Argentina/Buenos_Aires",
    });
    assert.equal(ed.fecha, esperada);
  });
});
