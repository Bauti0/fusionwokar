// ============================================================
// FUSIÓN WOK — MENÚ SUCURSAL TANDIL
// Datos REALES extraídos de https://menu.fu.do/fusionwoktandil
// Nombres, descripciones y precios (ARS) son los oficiales.
// ============================================================

// Salsas de "Elegí tu salsa" — se ofrecen como EXTRA opcional
// en los woks y también como producto suelto.
const SALSAS = [
  { id: "salsa-teriyaki", label: "Teriyaki", price: 1900, description: "agridulce, jengibre, ajo, miel y salsa de soja" },
  { id: "salsa-alioli", label: "Alioli", price: 1900, description: "mayonesa suave de ajo casera" },
  { id: "salsa-picante", label: "Picante", price: 1900, description: "salsa sriracha picante" },
  { id: "salsa-bbq", label: "BBQ", price: 1900, description: "salsa barbacoa clásica" },
  { id: "salsa-agridulce", label: "Agridulce china", price: 1900, description: "a base de ketchup y naranjas" },
  { id: "salsa-sweet-chilly", label: "Sweet Chilly", price: 1900, description: "agridulce con un toque picante" },
];

// Convierte las salsas en el formato "extras" del producto
const salsaExtras = () =>
  SALSAS.map(({ id, label, price }) => ({ id, label, price }));

// Opcionales que se ofrecen junto con la salsa al pedir un wok
// (o chow fan / mi fen / apto, que comparten la misma familia):
// palitos chinos gratis, y galleta de la fortuna con descuento por
// cantidad (no son excluyentes entre sí, pero 1 y 2 galletas sí lo son).
const woksExtras = () => [
  ...salsaExtras(),
  { id: "palitos-chinos", label: "Palitos chinos", price: 0 },
  { id: "galleta-fortuna-1", label: "Galleta de la fortuna (1 unidad)", price: 1500, group: "galleta", groupLabel: "Galleta de la fortuna" },
  { id: "galleta-fortuna-2", label: "Galleta de la fortuna x2", price: 2000, group: "galleta" },
];

export default {
  branchId: "tandil",
  categories: [
    {
      id: "novedades",
      name: "🔥NOVEDAD 신기함🥢",
      groups: [
        {
          name: null,
          products: [
            {
              id: "ramen-naruto-canre",
              name: "Ramen Naruto canre",
              price: 7000,
              description: "",
              available: true,
            },
            {
              id: "ramen-hong-shing-picante",
              name: "Ramen Hong Shing Picante",
              price: 7000,
              description: "",
              available: true,
            },
            {
              id: "ramen-hong-shing-red",
              name: "Ramen Hong Shing Red Super Picante",
              price: 7000,
              description: "",
              available: true,
            },
          ],
        },
      ],
    },
    {
      id: "promos",
      name: "PROMOS Y COMBOS 晋升",
      groups: [
        {
          name: null,
          products: [
            {
              id: "promo-wok-ice-tea",
              name: "Promo Wok + Ice Tea",
              price: 20900,
              description: "Wok a elección (no entran los de langostinos) + Ice Tea Coreano",
              available: true,
            },
            {
              id: "promo-compartir",
              name: "Promo para Compartir",
              price: 38900,
              description: "Incluye un mein de pollo, 6 dumplings fritos de cerdo y 2 ice tea",
              available: true,
            },
            {
              id: "promo-2-fan-teriyaki",
              name: "Promo 2 Fan a Elección (no incluye carne ni langostinos) + salsa teriyaki",
              price: 35900,
              description: "",
              available: true,
            },
            {
              id: "promo-2-fan",
              name: "Promo 2 Fan a Elección (no incluye langostinos)",
              price: 35000,
              description: "2 wok a elección con base de arroz + una salsa teriyaki",
              available: true,
            },
            {
              id: "combo-kung-fu",
              image: "/uploads/products/combo-kung-fu.jpg",
              name: "Combo Kung Fu (1 Persona)",
              price: 22900,
              description: "1 mein de pollo + 1 bao de bondiola braseada",
              available: true,
            },
            {
              id: "combo-wok-dumplings",
              name: "Combo Wok + Dumplings Fritos (para compartir)",
              price: 29900,
              description: "1 wok de spaguettis con pollo + 6 dumplings de cerdo fritos con salsa agridulce china",
              available: true,
            },
          ],
        },
      ],
    },
    {
      id: "bebidas",
      name: "BEBIDAS 飲み物",
      groups: [
        {
          name: "Gaseosas y Jugos",
          products: [
            { id: "ice-tea-limon", name: "Ice Tea Limón (Coreano)", price: 5000, available: true },
            { id: "ramune-uva", name: "Ramune Uva (gaseosa japonesa con bolita de vidrio)", price: 10000, available: true },
            { id: "jugo-coreano-pina", name: "Jugo Coreano Piña", price: 7000, available: true },
            { id: "gaseosa-pokemon-pikachu", name: "Gaseosa Pokémon (Pikachu) sabor lima", price: 8000, available: true },
            { id: "gaseosa-sailor-moon-chibi", name: "Gaseosa Sailor Moon (Chibi Moon) sabor lychee", price: 8000, available: true },
            { id: "gaseosa-sailor-moon-mercury", name: "Gaseosa Sailor Moon (Mercury) sabor pera", price: 8000, available: true },
            { id: "jugo-coreano-uva", name: "Jugo Coreano Uva", price: 7000, available: true },
            { id: "ice-tea-jazmin", name: "Ice Tea té verde jazmín (Coreano)", price: 6000, available: true },
            { id: "ice-tea-menta", name: "Ice Tea con menta y peperina (Coreano)", price: 6000, available: true },
            { id: "gaseosa-limon", name: "Gaseosa sabor limón (Coreana)", price: 5000, available: true },
            { id: "gaseosa-cherry", name: "Gaseosa sabor cherry (Coreana)", price: 6000, available: true },
            { id: "gaseosa-pomelo", name: "Gaseosa sabor pomelo (Coreana)", price: 6000, available: true },
            { id: "jugo-arandanos", name: "Jugo de arándanos (Chino)", price: 4000, available: true },
            { id: "jugo-uva-chino", name: "Jugo de uva (Chino)", price: 4000, available: true },
            { id: "ice-tea-miku-verde", name: "Ice Tea verde edición Hatsune Miku (Coreano)", price: 5000, available: true },
            { id: "ice-tea-miku-negro", name: "Ice Tea negro edición Hatsune Miku (Coreano)", price: 5000, available: true },
            { id: "ice-tea-miku-oolong", name: "Ice Tea oolong azul edición Hatsune Miku (Coreano)", price: 5000, available: true },
            { id: "gaseosa-frutilla", name: "Gaseosa sabor frutilla (Coreana)", price: 5000, available: true },
            { id: "gaseosa-mango", name: "Gaseosa sabor mango (Coreana)", price: 5000, available: true },
          ],
        },
        {
          name: "Bebidas con alcohol",
          products: [
            { id: "soju-uva", name: "Soju Coreano sabor uva", price: 8000, available: true },
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
            { id: "mi-fen-apto-veggie", name: "Mi Fen Apto Veggie", price: 16900, extras: woksExtras(), available: true },
            { id: "mi-fen-apto-pollo", name: "Mi Fen Apto Pollo", price: 16900, image: "/uploads/products/mi-fen-apto-pollo.jpg", extras: woksExtras(), available: true },
            { id: "mi-fen-apto-cerdo", name: "Mi Fen Apto Cerdo", price: 16900, extras: woksExtras(), available: true },
            { id: "mi-fen-apto-carne", name: "Mi Fen Apto Carne", price: 17900, extras: woksExtras(), available: true },
            { id: "mi-fen-apto-mixto", name: "Mi Fen Apto Mixto", price: 17900, extras: woksExtras(), available: true },
            { id: "fan-apto-langostinos", name: "Fan Apto Langostinos", price: 22900, image: "/uploads/products/fan-apto-langostinos.jpg", extras: woksExtras(), available: true },
            { id: "fan-apto-veggie", name: "Fan Apto Veggie", price: 16900, image: "/uploads/products/fan-apto-veggie.jpg", extras: woksExtras(), available: true },
            { id: "fan-apto-pollo", name: "Fan Apto Pollo", price: 16900, image: "/uploads/products/fan-apto-pollo.jpg", extras: woksExtras(), available: true },
            { id: "fan-apto-cerdo", name: "Fan Apto Cerdo", price: 16900, extras: woksExtras(), available: true },
            { id: "fan-apto-mixto", name: "Fan Apto Mixto", price: 16900, image: "/uploads/products/fan-apto-mixto.jpg", extras: woksExtras(), available: true },
            { id: "fan-apto-carne", name: "Fan Apto Carne", price: 16900, extras: woksExtras(), available: true },
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
              id: "chow-mein-langostinos",
              image: "/uploads/products/chow-mein-langostinos.jpg",
              name: "Chow mein de langostinos",
              price: 23900,
              description:
                "Langostinos dorados al wok con spaguettis, cebolla, morrones, vegetales y un toque de ajo, salteados en salsa de soja umami. Terminado con verdeo fresco y sésamo tostado.",
              extras: woksExtras(),
              available: true,
            },
            {
              id: "chow-mein-carne",
              image: "/uploads/products/chow-mein-carne.jpg",
              name: "Chow mein de carne",
              price: 18900,
              description:
                "Salteado de carne vacuna al wok con spaguettis, cebolla, morrones y ajo, en base de salsa de soja. Coronado con verdeo fresco y sésamo tostado.",
              extras: woksExtras(),
              available: true,
            },
            {
              id: "chow-mein-mixto",
              image: "/uploads/products/chow-mein-mixto.jpg",
              name: "Chow mein mixto",
              price: 18900,
              description:
                "Carne de vaca, cerdo y pollo salteados con cebollas, morrones, zucchinis, zanahorias, verdeo y sésamo tostado.",
              extras: woksExtras(),
              available: true,
            },
            {
              id: "chow-mein-cerdo",
              image: "/uploads/products/chow-mein-cerdo.jpg",
              name: "Chow mein de cerdo",
              price: 17900,
              description:
                "Cerdo salteado con cebollas, morrones, zucchinis, zanahorias, verdeo y sésamo tostado.",
              extras: woksExtras(),
              available: true,
            },
            {
              id: "chow-mein-pollo",
              image: "/uploads/products/chow-mein-pollo.jpg",
              name: "Chow mein de pollo",
              price: 17900,
              description:
                "Pollo salteado con cebollas, morrones, zucchinis, zanahorias, verdeo y sésamo tostado.",
              extras: woksExtras(),
              available: true,
            },
            {
              id: "chow-mein-veggie",
              image: "/uploads/products/chow-mein-veggie.jpg",
              name: "Chow mein veggie",
              price: 17900,
              description:
                "Brócoli, cebollas, morrones, zucchinis y zanahorias salteados en aceite de ajo y salsa de soja, con sésamo tostado.",
              extras: woksExtras(),
              available: true,
            },
          ],
        },
        {
          name: "Chow Fan (Arroz)",
          products: [
            { id: "chow-fan-langostinos", name: "Chow fan de langostinos", price: 23900, image: "/uploads/products/chow-fan-langostinos.jpg", extras: woksExtras(), available: true },
            { id: "chow-fan-carne", name: "Chow fan de carne", price: 18900, image: "/uploads/products/chow-fan-carne.jpg", extras: woksExtras(), available: true },
            { id: "chow-fan-mixto", name: "Chow fan mixto", price: 18900, image: "/uploads/products/chow-fan-mixto.jpg", extras: woksExtras(), available: true },
            { id: "chow-fan-cerdo", name: "Chow fan de cerdo", price: 17900, image: "/uploads/products/chow-fan-cerdo.jpg", extras: woksExtras(), available: true },
            { id: "chow-fan-pollo", name: "Chow fan de pollo", price: 17900, image: "/uploads/products/chow-fan-pollo.jpg", extras: woksExtras(), available: true },
            { id: "chow-fan-veggie", name: "Chow fan veggie", price: 17900, image: "/uploads/products/chow-fan-veggie.jpg", extras: woksExtras(), available: true },
          ],
        },
        {
          name: "Chow Mi Fen (Fideos de arroz)",
          products: [
            { id: "chow-mi-fen-langostinos", name: "Chow mi fen de langostinos", price: 24900, image: "/uploads/products/chow-mi-fen-langostinos.jpg", extras: woksExtras(), available: true },
            { id: "chow-mi-fen-carne", name: "Chow mi fen de carne", price: 19900, image: "/uploads/products/chow-mi-fen-carne.jpg", extras: woksExtras(), available: true },
            { id: "chow-mi-fen-mixto", name: "Chow mi fen mixto", price: 19900, image: "/uploads/products/chow-mi-fen-mixto.jpg", extras: woksExtras(), available: true },
            { id: "chow-mi-fen-cerdo", name: "Chow mi fen de cerdo", price: 18900, image: "/uploads/products/chow-mi-fen-cerdo.jpg", extras: woksExtras(), available: true },
            { id: "chow-mi-fen-pollo", name: "Chow mi fen de pollo", price: 18900, image: "/uploads/products/chow-mi-fen-pollo.jpg", extras: woksExtras(), available: true },
            { id: "chow-mi-fen-veggie", name: "Chow mi fen veggie", price: 18900, image: "/uploads/products/chow-mi-fen-veggie.jpg", extras: woksExtras(), available: true },
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
              id: "spring-carne",
              name: "Spring Carne",
              price: 13900,
              description:
                "4 arrolladitos rellenos de cebolla, puerro, verdeo, zanahoria y carne picada, envueltos en masa philo y fritos, con salsa agridulce china",
              available: true,
            },
          ],
        },
      ],
    },
    {
      id: "galleta-fortuna",
      name: "GALLETA FORTUNA 幸運餅乾",
      groups: [
        {
          name: null,
          products: [
            { id: "galleta-fortuna-1", name: "Galleta Fortuna (1 unidad)", price: 1500, image: "/uploads/products/galleta-fortuna-1.jpg", available: true },
            { id: "galleta-fortuna-2", name: "Galleta de la Fortuna x2", price: 2000, image: "/uploads/products/galleta-fortuna-2.jpg", available: true },
          ],
        },
      ],
    },
    {
      id: "postres",
      name: "POSTRES デザート",
      groups: [
        {
          name: "Choco Chocky — sticks crocantes bañados",
          products: [
            { id: "choco-chocky-oreo", name: "Choco Chocky Oreo", price: 5000, available: true },
            { id: "choco-chocky-almendras", name: "Choco Chocky Almendras", price: 5000, available: true },
            { id: "choco-chocky-chocolate", name: "Choco Chocky Chocolate", price: 5000, available: true },
            { id: "choco-chocky-frutilla", name: "Choco Chocky Frutilla", price: 5000, available: true },
            { id: "choco-chocky-mango", name: "Choco Chocky Mango", price: 5000, available: true },
            { id: "choco-chocky-matcha", name: "Choco Chocky Matcha", price: 5000, available: true },
            { id: "choco-chocky-coconut", name: "Choco Chocky Coconut", price: 5000, available: true },
            { id: "choco-chocky-durian", name: "Choco Chocky Durian", price: 5000, available: true },
          ],
        },
      ],
    },
    {
      id: "dumplings",
      name: "DUMPLINGS 餃子",
      groups: [
        {
          name: null,
          products: [
            {
              id: "dumpling-cerdo-x6",
              image: "/uploads/products/dumpling-cerdo-x6.jpg",
              name: "Dumpling de Cerdo x6",
              price: 12500,
              description:
                "Raviol chino relleno de cerdo, verdeo, jengibre, aceite de sésamo y cebolla, con salsa teriyaki",
              available: true,
            },
          ],
        },
      ],
    },
    {
      id: "baos",
      name: "BAOS 包包",
      groups: [
        {
          name: null,
          products: [
            {
              id: "bao-bondiola-braseada",
              image: "/uploads/products/bao-bondiola-braseada.jpg",
              name: "Bao Bondiola Braseada (x2 con salsa)",
              price: 12500,
              description: "Pan chino esponjoso al vapor, relleno de bondiola braseada y verduras",
              available: true,
            },
          ],
        },
      ],
    },
  ],
};
