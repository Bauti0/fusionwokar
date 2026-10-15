// ============================================================
// FUSIÓN WOK — helpers puros de extras/adicionales.
//
// Módulo sin side-effects (como public-order.js): importable por
// los tests sin disparar las migraciones de db.js. El flag
// `available` por extra (sección "Adicionales" del panel) se filtra
// acá: un extra con available:false no aparece en el menú público
// ni en el catálogo que valida precios de un pedido.
// ============================================================

// Filtra los extras disponibles para el cliente. Los extras de las
// filas viejas no tienen el flag: se consideran disponibles
// (available !== false).
export function availableExtras(extras) {
  return (extras || []).filter((e) => e.available !== false);
}
