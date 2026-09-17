// ============================================================
// SEO server-side para la SPA
// El HTML servido es un shell (todo el contenido vive en el bundle).
// Este módulo reescribe el HTML base con:
//   - title / description por ruta (y por sucursal vía ?branch=)
//   - canonical y URLs absolutas (og:image, etc.) con el dominio real
//   - JSON-LD (Organization/WebSite, Restaurant por sucursal)
//   - noindex en páginas que no deben capturar Google (admin, tracking)
// ============================================================
import { BRANCHES, BRAND } from "../src/data/branches.js";

const BASE_DESC =
  "Auténtica comida asiática · Al wok y más. Delivery y take away en Necochea y Tandil. Pedí online y pagá con Mercado Pago.";

export const SEO_DEFAULTS = {
  title: "Fusión Wok · Pedidos online",
  description: BASE_DESC,
};

const DAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];

function escAttr(s) {
  return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escText(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatPhone(whatsapp) {
  const d = String(whatsapp || "").replace(/\D/g, "");
  return d.length >= 10 ? `+${d}` : "";
}

function openingHoursSpecification(openWindows) {
  if (!Array.isArray(openWindows)) return undefined;
  const out = [];
  for (const w of openWindows) {
    const days = (w.days || []).map((d) => DAYS[d]).filter(Boolean);
    if (!days.length) continue;
    out.push({
      "@type": "OpeningHoursSpecification",
      dayOfWeek: days,
      opens: `${w.from}:00`,
      closes: `${w.to}:00`,
    });
  }
  return out.length ? out : undefined;
}

function restaurantJsonLd(branch, baseUrl) {
  const phone = formatPhone(branch.whatsapp);
  const opens = openingHoursSpecification(branch.openWindows);
  return {
    "@type": ["LocalBusiness", "Restaurant"],
    "@id": `${baseUrl}/#branch-${branch.id}`,
    name: `Fusión Wok ${branch.name}`,
    description: `${BRAND.slogan} · Delivery y take away en ${branch.name}. Pedí online directo a la casa, sin intermediarios.`,
    url: `${baseUrl}/?branch=${branch.id}`,
    image: `${baseUrl}/assets/logo-wok.jpeg`,
    address: {
      "@type": "PostalAddress",
      addressLocality: branch.name,
      addressCountry: "AR",
      streetAddress: branch.address,
    },
    ...(phone ? { telephone: phone } : {}),
    ...(opens ? { openingHoursSpecification: opens } : {}),
    servesCuisine: "Comida asiática, Wok",
  };
}

function routeInfo(pathname, query, baseUrl) {
  const branchId = query.branch === "tandil" ? "tandil" : query.branch === "necochea" ? "necochea" : null;

  if (pathname.startsWith("/admin")) {
    return {
      noindex: true,
      title: "Panel de gestión · Fusión Wok",
      description: "Panel de gestión de pedidos de Fusión Wok.",
      jsonLd: [],
    };
  }

  if (pathname.startsWith("/track/")) {
    const num = pathname.split("/")[2] || "";
    return {
      noindex: true,
      title: num ? `Pedido #${num} · Fusión Wok` : "Seguí tu pedido · Fusión Wok",
      description: "Estado en vivo de tu pedido de Fusión Wok: confirmado, en cocina, en camino.",
      jsonLd: [],
    };
  }

  if (pathname.startsWith("/track")) {
    return {
      title: "Seguí tu pedido · Fusión Wok",
      description: "Buscá tu pedido de Fusión Wok y seguilo en vivo, desde la cocina hasta tu puerta.",
      jsonLd: [],
    };
  }

  if (branchId) {
    const branch = BRANCHES[branchId];
    return {
      title: `Fusión Wok ${branch.name} · Menú y pedidos online`,
      description: `Pedí comida asiática online en ${branch.name} (${branch.address}) y pagá con Mercado Pago. Woks, dumplings, baos y más.`,
      jsonLd: [restaurantJsonLd(branch, baseUrl)],
    };
  }

  return {
    title: SEO_DEFAULTS.title,
    description: SEO_DEFAULTS.description,
    jsonLd: [
      {
        "@type": "Organization",
        "@id": `${baseUrl}/#org`,
        name: "Fusión Wok",
        url: baseUrl,
        logo: `${baseUrl}/assets/logo-wok.jpeg`,
      },
      {
        "@type": "WebSite",
        "@id": `${baseUrl}/#website`,
        url: baseUrl,
        name: "Fusión Wok · Pedidos online",
        description: SEO_DEFAULTS.description,
        inLanguage: "es-AR",
        publisher: { "@id": `${baseUrl}/#org` },
      },
    ],
  };
}

export function enhanceHtml(html, { pathname = "/", query = {}, baseUrl = "", canonicalPath = "", nonce = "" }) {
  const info = routeInfo(pathname, query, baseUrl);
  const title = info.title || SEO_DEFAULTS.title;
  const description = info.description || SEO_DEFAULTS.description;
  const canonical = `${baseUrl}${canonicalPath || pathname}`;
  const ogImage = `${baseUrl}/assets/logo-wok.jpeg`;

  let out = html;
  out = out.replace(/<title>.*?<\/title>/, `<title>${escText(title)}</title>`);
  out = out.replace(/(<meta property="og:title" content=")[^"]*(")/, `$1${escAttr(title)}$2`);
  out = out.replace(/(<meta name="twitter:title" content=")[^"]*(")/, `$1${escAttr(title)}$2`);
  out = out.replace(/(<meta name="description" content=")[^"]*(")/, `$1${escAttr(description)}$2`);
  out = out.replace(/(<meta property="og:description" content=")[^"]*(")/, `$1${escAttr(description)}$2`);
  out = out.replace(/(<meta name="twitter:description" content=")[^"]*(")/, `$1${escAttr(description)}$2`);
  out = out.replace(/(<link rel="canonical" href=")[^"]*(")/, `$1${escAttr(canonical)}$2`);
  out = out.replace(/(<meta property="og:url" content=")[^"]*(")/, `$1${escAttr(canonical)}$2`);
  out = out.replace(/(<meta property="og:image" content=")[^"]*(")/, `$1${escAttr(ogImage)}$2`);
  out = out.replace(/(<meta name="twitter:image" content=")[^"]*(")/, `$1${escAttr(ogImage)}$2`);
  if (info.noindex) {
    out = out.replace(/<meta name="robots" content="[^"]*" \/>/, '<meta name="robots" content="noindex,follow" />');
  }
  const json = JSON.stringify(info.jsonLd);
  // Nonce para el CSP: el JSON-LD es el único <script> inline del HTML servido.
  // Con 'nonce-<n>' en script-src, el navegador lo acepta y bloquea cualquier
  // otro script inline inyectado.
  const nonceAttr = nonce ? ` nonce="${nonce}"` : "";
  out = out.replace(
    /<script type="application\/ld\+json" id="seo-jsonld"><\/script>/,
    () => `<script type="application/ld+json" id="seo-jsonld"${nonceAttr}>${json}</script>`
  );
  return out;
}