// ============================================================
// FUSIÓN WOK — MENÚ SUCURSAL NECOCHEA
// ============================================================
// Datos extraídos de https://menu.fu.do/fusionwok (precios
// oficiales de esa sucursal, que difieren de los de Tandil).
//
// CONFIRMADO POR EL CLIENTE (agosto 2026): en Necochea NO se
// venden las categorías NOVEDADES (BAO BURGERS), DUMPLINGS,
// BAOS, BAO BUNS, BEBIDAS, GALLETA FORTUNA ni POSTRES, ni la
// subsección "Entraditas" de APTO. No se incluyen a propósito.
// ============================================================

// Salsas de "Elegí tu salsa" — mismas 6 opciones que en Tandil,
// a $1.900. Se ofrecen como EXTRA opcional en los woks.
const SALSAS = [
  { id: "salsa-teriyaki", label: "Teriyaki", price: 1900, description: "agridulce, jengibre, ajo, miel y salsa de soja" },
  { id: "salsa-alioli", label: "Alioli", price: 1900, description: "mayonesa suave de ajo casera" },
  { id: "salsa-picante", label: "Picante", price: 1900, description: "salsa sriracha picante" },
  { id: "salsa-bbq", label: "BBQ", price: 1900, description: "salsa barbacoa clásica" },
  { id: "salsa-agridulce", label: "Agridulce china", price: 1900, description: "a base de ketchup y naranjas" },
  { id: "salsa-sweet-chilly", label: "Sweet Chilly", price: 1900, description: "agridulce con un toque picante" },
];

const salsaExtras = () =>
  SALSAS.map(({ id, label, price }) => ({
    id,
    label,
    price,
    subgroup: "salsas",
    subgroupLabel: "SALSAS ADICIONALES",
  }));

// Opcionales que se ofrecen junto con la salsa al pedir un wok
// (o chow fan / mi fen / apto, que comparten la misma familia):
// palitos chinos gratis (categoría "PALITOS DESCARTABLES"), y galleta
// de la fortuna con descuento por cantidad (no son excluyentes entre
// sí, pero 1 y 2 galletas sí lo son).
const woksExtras = () => [
  ...salsaExtras(),
  { id: "palitos-chinos", label: "Palitos chinos", price: 0, subgroup: "palitos", subgroupLabel: "PALITOS DESCARTABLES" },
  { id: "galleta-fortuna-1", label: "Galleta de la fortuna (1 unidad)", price: 1500, group: "galleta", subgroup: "galleta", subgroupLabel: "GALLETAS" },
  { id: "galleta-fortuna-2", label: "Galleta de la fortuna x2", price: 2000, group: "galleta", subgroup: "galleta" },
];

export default {
  branchId: "necochea",
  categories: [
    {
      id: "promos",
      name: "PROMOS Y COMBOS 晋升",
      groups: [
        {
          name: null,
          products: [
            {
              id: "combo-compartir-springs-mein",
              name: "Combo para Compartir (Springs y mein pollo)",
              price: 28900,
              description: "1 wok de pollo con base spaguettis y 4 spring rolls más salsa china",
              available: true,
            },
          ],
        },
      ],
    },
    {
      id: "woks",
      name: "WOKS 炒鍋",
      groups: [
        {
          name: "Chow Mein (Spaguettis)",
          products: [
            {
              id: "chow-mein-carne",
              image: "/uploads/products/chow-mein-carne.jpg",
              name: "Chow mein de carne",
              price: 18900,
              description:
                "Salteado de carne vacuna al wok con spaguettis, cebolla, morrones y ajo, en una base de salsa de soja. Coronado con verdeo fresco y sésamo tostado. Jugoso, sabroso y lleno de carácter oriental.",
              extras: woksExtras(),
              available: true,
            },
            {
              id: "chow-mein-cerdo",
              image: "/uploads/products/chow-mein-cerdo.jpg",
              name: "Chow mein de cerdo",
              price: 18900,
              description:
                "Salteado al wok de carne de cerdo, con cebollas, morrones, zucchinis, zanahorias, verdeo y topping de semillas de sésamo tostado.",
              extras: woksExtras(),
              available: true,
            },
            {
              id: "chow-mein-pollo",
              image: "/uploads/products/chow-mein-pollo.jpg",
              name: "Chow mein de pollo",
              price: 18900,
              description:
                "Salteado al wok de pollo, con cebollas, morrones, zucchinis, zanahorias, verdeo y topping de semillas de sésamo tostado.",
              extras: woksExtras(),
              available: true,
            },
            {
              id: "chow-mein-veggie",
              image: "/uploads/products/chow-mein-veggie.jpg",
              name: "Chow mein Veggie",
              price: 18900,
              description:
                "Salteado al wok de verduras: brócoli, cebollas, morrones, zucchinis, zanahorias, verdeo, en aceite de ajo, salsa de soja y topping de semillas de sésamo tostado.",
              extras: woksExtras(),
              available: true,
            },
          ],
        },
        {
          name: "Chow Fan (Arroz)",
          products: [
            { id: "chow-fan-carne", name: "Chow fan de carne", price: 18900, image: "/uploads/products/chow-fan-carne.jpg", extras: woksExtras(), available: true },
            { id: "chow-fan-mixto", name: "Chow Fan Mixto", price: 18900, image: "/uploads/products/chow-fan-mixto.jpg", extras: woksExtras(), available: true },
            { id: "chow-fan-cerdo", name: "Chow fan de cerdo", price: 18900, image: "/uploads/products/chow-fan-cerdo.jpg", extras: woksExtras(), available: true },
            { id: "chow-fan-pollo", name: "Chow fan de pollo", price: 18900, image: "/uploads/products/chow-fan-pollo.jpg", extras: woksExtras(), available: true },
            { id: "chow-fan-veggie", name: "Chow fan Veggie", price: 18900, image: "/uploads/products/chow-fan-veggie.jpg", extras: woksExtras(), available: true },
          ],
        },
        {
          name: "Chow Mi Fen (Fideos de arroz)",
          products: [
            { id: "chow-mi-fen-carne", name: "Chow mi fen de carne", price: 19900, image: "/uploads/products/chow-mi-fen-carne.jpg", extras: woksExtras(), available: true },
            { id: "chow-mi-fen-mixto", name: "Chow Mi Fen Mixto", price: 19900, image: "/uploads/products/chow-mi-fen-mixto.jpg", extras: woksExtras(), available: true },
            { id: "chow-mi-fen-cerdo", name: "Chow mi fen de cerdo", price: 19900, image: "/uploads/products/chow-mi-fen-cerdo.jpg", extras: woksExtras(), available: true },
            { id: "chow-mi-fen-pollo", name: "Chow mi fen de pollo", price: 19900, image: "/uploads/products/chow-mi-fen-pollo.jpg", extras: woksExtras(), available: true },
            { id: "chow-mi-fen-veggie", name: "Chow mi fen Veggie", price: 19900, image: "/uploads/products/chow-mi-fen-veggie.jpg", extras: woksExtras(), available: true },
          ],
        },
      ],
    },
    {
      id: "spring-rolls",
      name: "ARROLLADITOS PRIMAVERA (Spring Rolls) 春巻",
      groups: [
        {
          name: null,
          products: [
            {
              id: "spring-veggie",
              name: "Spring Veggie",
              price: 14900,
              description:
                "4 arrolladitos veggie rellenos de cebolla, puerro, verdeo y zanahoria, envueltos en masa philo y fritos, acompañados de salsa agridulce china",
              available: true,
            },
            {
              id: "spring-carne",
              name: "Spring Carne",
              price: 14900,
              description:
                "4 arrolladitos de carne rellenos de cebolla, puerro, verdeo, zanahoria y carne picada, envueltos en masa philo y fritos, acompañados de salsa agridulce china",
              available: true,
            },
            {
              id: "degustacion-spring-rolls",
              name: "Degustación Spring Rolls",
              price: 15900,
              description:
                "Degustación de arrolladitos primavera: 2 unidades de carne y 2 unidades de verdura, más salsa agridulce china",
              available: true,
            },
          ],
        },
      ],
    },
    {
      id: "apto",
      name: "APTO (SIN TACC) ノータック",
      groups: [
        {
          name: "Woks",
          products: [
            { id: "mi-fen-apto-veggie", name: "Mi Fen Apto Veggie", price: 19900, extras: woksExtras(), available: true },
            { id: "mi-fen-apto-pollo", name: "Mi Fen Apto Pollo", price: 19900, image: "/uploads/products/mi-fen-apto-pollo.jpg", extras: woksExtras(), available: true },
            { id: "mi-fen-apto-carne", name: "Mi Fen Apto Carne", price: 19900, extras: woksExtras(), available: true },
            { id: "mi-fen-apto-mixto", name: "Mi Fen Apto Mixto", price: 19900, extras: woksExtras(), available: true },
            { id: "fan-apto-veggie", name: "Fan Apto Veggie", price: 18900, image: "/uploads/products/fan-apto-veggie.jpg", extras: woksExtras(), available: true },
            { id: "fan-apto-pollo", name: "Fan Apto Pollo", price: 18900, image: "/uploads/products/fan-apto-pollo.jpg", extras: woksExtras(), available: true },
            { id: "fan-apto-mixto", name: "Fan Apto Mixto", price: 18900, image: "/uploads/products/fan-apto-mixto.jpg", extras: woksExtras(), available: true },
            { id: "fan-apto-carne", name: "Fan Apto Carne", price: 18900, extras: woksExtras(), available: true },
          ],
        },
      ],
    },
  ],
};
