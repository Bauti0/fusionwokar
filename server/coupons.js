// ============================================================
// Contabilidad de cupones.
//
// El invariante que este modulo mantiene:
//
//   coupons.used_count = pedidos que YA CONSUMIERON el cupon
//                      + pedidos que todavia lo están SOSTENIENDO
//                        (reservado y pendiente, o pagado)
//
// Que eso sea mantenible exige saber, para cada pedido, si su reserva
// sigue viva. Antes no habia donde anotarlo: releaseCoupon recibia solo
// el codigo del cupon, no el pedido, asi que no podia distinguir
// "libero esta reserva" de "esta reserva ya la libere otra vez" — y solo
// el MAX(x-1, 0) le impedia bajar de cero.
//
// orders.coupon_released_at es ese lugar de memoria: NULL mientras el
// pedido sostiene el uso, now() una vez liberado. Todas las funciones
// reciben `db` por parametro para poder probarse contra un SQLite en
// memoria sin levantar el server.
// ============================================================

function now() {
  return new Date().toISOString();
}

// Resuelve la fila de un cupón para una sucursal: el local de ESA
// sucursal o el global (branch = ''). Con la unicidad GLOBAL del código
// (opción 2 del dueño) solo puede haber una fila por código, pero el
// orden lo deja explícito por si algún día se relaja: el local gana al
// global. Sin `branch`, busca solo por código (comportamiento original).
export async function findCouponRow(db, code, branch) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return null;
  if (branch) {
    return await db
      .prepare(
        "SELECT * FROM coupons WHERE code = ? AND (branch = ? OR branch = '') ORDER BY branch != '' DESC LIMIT 1"
      )
      .get(clean, branch);
  }
  return await db.prepare("SELECT * FROM coupons WHERE code = ?").get(clean);
}

// Valida un cupón contra la BD y calcula el descuento. `branch` es la
// sucursal del PEDIDO (nunca algo que mande el cliente por su cuenta):
// un cupón local de otra sucursal no aplica.
export async function applyCoupon(db, code, total, branch) {
  const clean = String(code || "").trim().toUpperCase();
  if (!clean) return { error: "Falta el código del cupón" };
  let row;
  if (branch) {
    row = await findCouponRow(db, clean, branch);
    if (!row) {
      // Distinguir "no existe" de "existe pero es de otra sucursal":
      // el cliente tiene que saber si tipeó mal o si el cupón simplemente
      // no vale acá (sin revelar de cuál sucursal es).
      const exists = await db.prepare("SELECT 1 FROM coupons WHERE code = ?").get(clean);
      if (exists) return { error: "Este cupón no es válido para esta sucursal" };
      return { error: "El cupón no existe" };
    }
  } else {
    row = await db.prepare("SELECT * FROM coupons WHERE code = ?").get(clean);
    if (!row) return { error: "El cupón no existe" };
  }
  if (row.active !== 1) return { error: "El cupón ya no está activo" };
  if (row.max_uses > 0 && row.used_count >= row.max_uses) {
    return { error: "El cupón ya no tiene usos disponibles" };
  }
  if (row.expires_at) {
    const exp = new Date(row.expires_at);
    if (isNaN(exp.getTime()) || exp.getTime() < Date.now()) return { error: "El cupón está vencido" };
  }
  if (total < row.min_total) return { error: `El cupón requiere un pedido mínimo de $${row.min_total}` };
  let discount;
  if (row.type === "percent") discount = Math.round((total * row.value) / 100);
  else discount = row.value;
  discount = Math.min(Math.max(discount, 0), total);
  return { code: row.code, discount };
}

// Reserva/liberación atómica de un uso de cupón. La reserva usa un UPDATE
// condicional (no SELECT + UPDATE separados): si dos checkouts simultáneos
// usan el mismo cupón de un solo uso, solo uno logra reservar. Se reserva
// ANTES de cualquier await (ej. createOrder de Mercado Pago) y se
// libera si el pedido nunca llega a crearse. Con `branch`, la fila tiene
// que valer para esa sucursal (local de ella o global).
export async function reserveCoupon(db, code, branch) {
  if (!code) return true; // no hay cupón, nada que reservar
  if (branch) {
    const result = await db
      .prepare(`
        UPDATE coupons SET used_count = used_count + 1, updated_at = ?
        WHERE code = ? AND (branch = ? OR branch = '') AND active = 1
          AND (max_uses = 0 OR used_count < max_uses)
      `)
      .run(now(), code, branch);
    return result.changes > 0;
  }
  const result = await db
    .prepare(`
      UPDATE coupons SET used_count = used_count + 1, updated_at = ?
      WHERE code = ? AND active = 1 AND (max_uses = 0 OR used_count < max_uses)
    `)
    .run(now(), code);
  return result.changes > 0;
}

// Libera el uso que sostenía UN pedido.
//
// Idempotente por construcción: el UPDATE condicional hace de mutex. El
// primer request que pasa coupon_released_at de NULL a now() es el único
// que baja el contador; todos los que llegan después ven changes === 0 y
// no tocan nada. No hay ventana entre leer y escribir porque el marcado y
// la decisión ocurren en la misma sentencia.
//
// Devuelve true solo si este llamado fue el que liberó.
//
// La guarda contra 'refunded' es a proposito, aunque hoy ningun call site
// liberate un pedido devuelto: son los que evitan hacerlo. Repetir la
// precondicion en la primitiva evita que un call site futuro reintroduzca
// esta misma clase de bug (o que un cambio de criterio en el webhook la
// reintroduzca sin que nadie se entere).
//
// Con `branch` (la sucursal del PEDIDO), el contador se baja SOLO de la
// fila resuelta por findCouponRow: si el cupón no vale para esa sucursal,
// no había reserva de esa fila que devolver. Sin `branch`, se baja por
// código (comportamiento original, pedidos viejos).
export async function releaseOrderCoupon(db, orderId, code, branch) {
  if (!orderId || !code) return false;
  const marked = await db
    .prepare(
      `UPDATE orders SET coupon_released_at = ?
       WHERE id = ? AND coupon_code = ? AND coupon_released_at IS NULL
         AND payment_status != 'refunded'`
    )
    .run(now(), orderId, code);
  if (marked.changes === 0) return false;
  if (branch) {
    const row = await findCouponRow(db, code, branch);
    if (row) {
      // Por código, no por id: la unicidad del código es GLOBAL (opción 2
      // del dueño), así que es la misma fila — y no depende de la clave
      // primaria que use el esquema.
      await db
        .prepare("UPDATE coupons SET used_count = MAX(used_count - 1, 0), updated_at = ? WHERE code = ?")
        .run(now(), row.code);
    }
  } else {
    await db
      .prepare("UPDATE coupons SET used_count = MAX(used_count - 1, 0), updated_at = ? WHERE code = ?")
      .run(now(), code);
  }
  return true;
}

// Libera una reserva SIN fila de pedido: el INSERT del pedido falló y no
// quedó nada que marcar (ver createOrder). No hay webhook ni sweep que
// puedan volver a liberarla, porque los dos buscan pedidos en la tabla.
// Con `branch`, baja SOLO la fila resuelta (igual que releaseOrderCoupon).
export async function releaseOrphanReservation(db, code, branch) {
  if (!code) return false;
  if (branch) {
    const row = await findCouponRow(db, code, branch);
    if (row) {
      await db
        .prepare("UPDATE coupons SET used_count = MAX(used_count - 1, 0), updated_at = ? WHERE code = ?")
        .run(now(), row.code);
    }
    return true;
  }
  await db
    .prepare("UPDATE coupons SET used_count = MAX(used_count - 1, 0), updated_at = ? WHERE code = ?")
    .run(now(), code);
  return true;
}

// Libera reservas huérfanas: pedidos Mercado Pago en estados que nunca van
// a cobrar (pending abandonados hace +30 min, rechazados, cancelados).
// Sin esto, un cupón con límite de usos se quemaba para siempre con pedidos
// que nunca se pagaron. Corre antes de reservar, para que un cupón siempre
// tenga su cupo real.
//
// "refunded" NO va en la lista: si el pedido se pagó y después se devolvió,
// el cupón se consumió de verdad (si se liberara, el cliente podría usarlo,
// pedir, devolver y volver a usarlo). Igual en el webhook.
//
// El filtro `coupon_released_at IS NULL` es lo que hace esto idempotente:
// cada pedido entra al sweep UNA vez en su vida. Antes este SELECT no
// tenía ese filtro (y además colapsaba con DISTINCT los pedidos viejos
// del mismo cupón), así que cada creación de pedido volvía a restar los
// mismos usos y el tope de usos quedaba anulado.
export async function releaseStaleCouponReservations(db) {
  try {
    const cutoff = new Date(Date.now() - 30 * 60000).toISOString();
    const rows = await db
      .prepare(
        `SELECT id, coupon_code AS code, branch FROM orders
         WHERE coupon_code IS NOT NULL AND coupon_code != ''
           AND coupon_released_at IS NULL
           AND payment_status IN ('pending', 'rejected', 'cancelled')
           AND created_at < ?`
      )
      .all(cutoff);
    for (const r of rows) await releaseOrderCoupon(db, r.id, r.code, r.branch);
  } catch (err) {
    // No debe tumbar la creación de un pedido: el sweep es una corrección
    // opportunista y un fallo acá se paga con el cupón quemado, no con la
    // venta perdida.
    console.error("releaseStaleCouponReservations:", err.message);
  }
}
