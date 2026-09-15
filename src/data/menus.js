// ============================================================
// FUSIÓN WOK — Índice de menús por sucursal
// ============================================================
import menuNecochea from "./menu.necochea.js";
import menuTandil from "./menu.tandil.js";

export const MENUS = {
  necochea: menuNecochea,
  tandil: menuTandil,
};

// Helper: devuelve el menú de una sucursal por id
export function getMenu(branchId) {
  return MENUS[branchId] || null;
}

// Helper: aplanar todos los productos de un menú
// (categoría → grupo → producto), útil para búsqueda y carrito
export function flattenMenu(menu) {
  const flat = [];
  for (const cat of menu.categories) {
    for (const group of cat.groups) {
      for (const product of group.products) {
        flat.push({ ...product, categoryId: cat.id, groupName: group.name });
      }
    }
  }
  return flat;
}

// Helper: encontrar un producto por id dentro de un menú
export function findProduct(menu, productId) {
  return flattenMenu(menu).find((p) => p.id === productId) || null;
}