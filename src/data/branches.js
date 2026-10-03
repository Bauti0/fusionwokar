// ============================================================
// FUSIÓN WOK — Sucursales
// Datos reales. Acá se configuran teléfonos, horarios y el
// color de acento sutil que diferencia cada local.
// ============================================================

export const BRANCHES = {
  necochea: {
    id: "necochea",
    name: "Necochea",
    address: "Diagonal San Martín 1258, Necochea",
    whatsapp: "542262480511", // wa.me/542262480511
    areaCode: "2262",
    // Ejemplo que se muestra en el campo "Celular". Va por sucursal porque
    // antes estaba fijo en todos los formularios y le mostrábamos el código
    // de área de Necochea a los clientes de Tandil.
    phonePlaceholder: "Ej: 2262 555555",
    instagram: "fusionwoknecochea",
    // Acento de marca sutil: 🔴 rojo (como en su Instagram)
    accentColor: "#E5342E",
    // Horarios mostrados según modalidad (delivery / retiro).
    // El toggle de modalidad en el checkout cambia lo que se muestra.
    hours: {
      delivery: "11:00 a 15:00 · 19:30 a 23:30",
      pickup: "11:00 a 15:00 · 19:30 a 23:30",
    },
    // Ventanas de apertura estructuradas (para validar programación y
    // mostrar "abierto/cerrado"). Deben reflejar el texto de `hours`:
    //   day: 0=dom, 1=lun … 6=sáb · from/to en formato "HH:MM" (hora local)
    openWindows: [
      { days: [0, 1, 2, 3, 4, 5, 6], from: "11:00", to: "15:00" },
      { days: [0, 1, 2, 3, 4, 5, 6], from: "19:30", to: "23:30" },
    ],
    // Info de delivery mostrada en el menú y el checkout. Si no hay un costo
    // fijo se muestra el texto de referencia (sin inventar números).
    deliveryInfo: "Costo de envío según tu zona · Te lo confirmamos por WhatsApp",
    // Delivery en esta sucursal
    supportsDelivery: true,
  },
  tandil: {
    id: "tandil",
    name: "Tandil",
    address: "Chacabuco 660, Tandil",
    whatsapp: "542494611402", // wa.me/542494611402
    areaCode: "249",
    // Mismo ejemplo, con el código de área de Tandil (los celulares de
    // Tandil son de 10 dígitos: 249 + 7).
    phonePlaceholder: "Ej: 249 4555555",
    instagram: "fusionwoktandil",
    // Acento de marca sutil: ⚫ negro (como en su Instagram)
    accentColor: "#111111",
    hours: {
      delivery:
        "Dom–Jue 11:30 a 15:30 y 19:00 a 23:00 · Vie y Sáb 11:30 a 15:30 y 19:30 a 23:30",
      pickup:
        "Dom–Jue 11:30 a 15:30 y 19:00 a 23:00 · Vie y Sáb 11:30 a 15:30 y 19:30 a 23:30",
    },
    openWindows: [
      { days: [0, 1, 2, 3, 4], from: "11:30", to: "15:30" },
      { days: [0, 1, 2, 3, 4], from: "19:00", to: "23:00" },
      { days: [5, 6], from: "11:30", to: "15:30" },
      { days: [5, 6], from: "19:30", to: "23:30" },
    ],
    deliveryInfo: "Envío: $4.000 hasta 20 cuadras a la redonda · +$100 por cuadra extra. Ingresá tu dirección y te mostramos el costo.",
    supportsDelivery: true,
  },
};

export const BRANCH_LIST = Object.values(BRANCHES);

// Placeholder del campo "Celular" cuando el componente todavía no sabe la
// sucursal (ej: la Landing antes de que elijas una). Es el de Necochea,
// que es lo que se mostró siempre.
export const DEFAULT_PHONE_PLACEHOLDER = BRANCHES.necochea.phonePlaceholder;

// Placeholder del campo "Celular" para una sucursal. Acepta el id (string) o
// el objeto de sucursal completo, y cae en el ejemplo de Necochea si la
// sucursal no existe o no define `phonePlaceholder`.
export function phonePlaceholderFor(branch) {
  const id = typeof branch === "string" ? branch : branch?.id;
  return BRANCHES[id]?.phonePlaceholder || DEFAULT_PHONE_PLACEHOLDER;
}

// Instagram general de la marca (cuenta de ambas sucursales)
export const BRAND = {
  name: "Fusión Wok",
  slogan: "Auténtica comida asiática · Al wok y más",
  specialties: "Woks · Dumplings · Baos · Spring Rolls",
  instagram: "fusionwok.ar",
  tiktok: "fusionwok.ar",
  linktree: "https://linktr.ee/Fusionwok.ar",
  logo: "/assets/logo-wok.jpeg",
};
