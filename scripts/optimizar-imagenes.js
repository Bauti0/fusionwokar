// scripts/optimizar-imagenes.js
// Genera variantes optimizadas (WebP 400/800px) para imágenes ya cargadas.
// Uso:
//   node --env-file=.env scripts/optimizar-imagenes.js           # dry-run (por defecto)
//   node --env-file=.env scripts/optimizar-imagenes.js --apply   # escribe en la BD
//   node --env-file=.env scripts/optimizar-imagenes.js --apply --limit 10
//   node --env-file=.env scripts/optimizar-imagenes.js --help

import { createClient } from "@libsql/client";
import sharp from "sharp";
import { createDb } from "../server/sqlite.js";
import { now } from "../server/db.js";

const TURSO_DATABASE_URL = process.env.TURSO_DATABASE_URL;
const TURSO_AUTH_TOKEN = process.env.TURSO_AUTH_TOKEN;

if (!TURSO_DATABASE_URL) {
  console.error("❌ Falta TURSO_DATABASE_URL en .env");
  process.exit(1);
}

const args = process.argv.slice(2);
const dryRun = !args.includes("--apply");
const limitIdx = args.indexOf("--limit");
const limit = limitIdx >= 0 && args[limitIdx + 1] ? parseInt(args[limitIdx + 1], 10) : null;
const help = args.includes("--help") || args.includes("-h");

if (help) {
  console.log(`
Uso: node --env-file=.env scripts/optimizar-imagenes.js [opciones]

Opciones:
  --apply          Escribe las variantes en la BD (por defecto: dry-run)
  --limit N        Procesa solo las primeras N imágenes
  --help, -h       Muestra esta ayuda

Ejemplos:
  node --env-file=.env scripts/optimizar-imagenes.js              # dry-run
  node --env-file=.env scripts/optimizar-imagenes.js --apply      # escribe todo
  node --env-file=.env scripts/optimizar-imagenes.js --apply --limit 10  # solo 10
`);
  process.exit(0);
}

async function main() {
  console.log(`🔧 Migración de imágenes - ${dryRun ? "DRY-RUN (solo cuenta/estima)" : "APLICA CAMBIOS"}`);
  if (limit) console.log(`   Límite: ${limit} imágenes`);

  const client = createClient({ url: TURSO_DATABASE_URL, authToken: TURSO_AUTH_TOKEN });
  const db = createDb(client);

  // Verificar que existe la tabla de variantes
  const tables = await db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='product_image_variants'").get();
  if (!tables) {
    console.error("❌ La tabla product_image_variants no existe. Ejecutá primero las migraciones (reiniciá el server).");
    process.exit(1);
  }

  // Obtener todas las imágenes que no tienen variantes aún
  const images = await db.prepare(`
    SELECT pi.id, pi.mime, pi.data, pi.updated_at,
           (SELECT COUNT(*) FROM product_image_variants piv WHERE piv.image_id = pi.id) as variant_count
    FROM product_images pi
    WHERE NOT EXISTS (
      SELECT 1 FROM product_image_variants piv WHERE piv.image_id = pi.id AND piv.width IN (400, 800)
    )
    ORDER BY pi.id
  `).all();

  console.log(`\n📊 Imágenes totales en product_images: ${images.length}`);
  console.log(`   Sin variantes (400/800px): ${images.filter(i => i.variant_count === 0).length}`);
  console.log(`   Con algunas variantes: ${images.filter(i => i.variant_count > 0 && i.variant_count < 2).length}`);
  console.log(`   Completas (400 y 800): ${images.filter(i => i.variant_count >= 2).length}\n`);

  if (images.length === 0) {
    console.log("✅ No hay imágenes para procesar (todas ya tienen variantes).");
    return;
  }

  const toProcess = limit ? images.slice(0, limit) : images;
  console.log(`🔄 Procesando ${toProcess.length} imagen(es)...\n`);

  let totalOriginalBytes = 0;
  let totalVariantBytes = 0;
  let processed = 0;
  let skipped = 0;
  let errors = 0;

  const results = [];

  for (const img of toProcess) {
    const originalBuf = Buffer.from(img.data);
    const originalBytes = originalBuf.length;
    totalOriginalBytes += originalBytes;

    // Obtener dimensiones originales
    let originalWidth = 0;
    let originalHeight = 0;
    try {
      const meta = await sharp(originalBuf, { limitInputPixels: 30 * 1024 * 1024 }).metadata();
      originalWidth = meta.width || 0;
      originalHeight = meta.height || 0;
    } catch (e) {
      console.error(`  ⚠️  Imagen ${img.id}: no se pudo leer metadatos (${e.message}), saltando`);
      errors++;
      continue;
    }

    const variantWidths = [400, 800].filter(w => originalWidth > w);
    if (variantWidths.length === 0) {
      console.log(`  ⏭️  Imagen ${img.id}: ${originalWidth}x${originalHeight} - ya es menor que 400px, sin variantes`);
      skipped++;
      continue;
    }

    // Procesar imagen principal a WebP q80 max 1200px (igual que en upload)
    let mainBuf;
    try {
      mainBuf = await sharp(originalBuf)
        .rotate()
        .withMetadata(false)
        .resize({ width: 1200, height: 1200, fit: "inside", withoutEnlargement: true })
        .webp({ quality: 80, effort: 4 })
        .toBuffer();
    } catch (e) {
      console.error(`  ⚠️  Imagen ${img.id}: error procesando principal (${e.message}), saltando`);
      errors++;
      continue;
    }

    const mainBytes = mainBuf.length;
    const useOptimized = mainBytes < originalBytes;
    const finalMainBuf = useOptimized ? mainBuf : originalBuf;
    const finalMainMime = useOptimized ? "image/webp" : img.mime;
    const finalMainBytes = finalMainBuf.length;

    // Generar variantes
    const variantResults = [];
    for (const w of variantWidths) {
      try {
        const variantBuf = await sharp(finalMainBuf)
          .resize({ width: w, fit: "inside", withoutEnlargement: true })
          .webp({ quality: 80, effort: 4 })
          .toBuffer();

        // Solo guardar si pesa menos que la imagen principal final
        if (variantBuf.length < finalMainBytes) {
          variantResults.push({ width: w, bytes: variantBuf.length, buf: variantBuf });
          totalVariantBytes += variantBuf.length;
        }
      } catch (e) {
        console.error(`    ⚠️  Variante ${w}px falló: ${e.message}`);
      }
    }

    const savings = originalBytes - finalMainBytes - variantResults.reduce((s, v) => s + v.bytes, 0);
    const savingsPct = originalBytes > 0 ? ((savings / originalBytes) * 100).toFixed(1) : "0";

    results.push({
      id: img.id,
      originalBytes,
      originalSize: `${(originalBytes / 1024).toFixed(1)} KB`,
      optimizedBytes: finalMainBytes,
      optimizedSize: `${(finalMainBytes / 1024).toFixed(1)} KB`,
      variantCount: variantResults.length,
      variantSizes: variantResults.map(v => `${v.width}px: ${(v.bytes / 1024).toFixed(1)} KB`).join(", "),
      savingsBytes: savings,
      savingsPct: `${savingsPct}%`,
    });

    if (!dryRun) {
      // Actualizar imagen principal si se optimizó
      if (useOptimized) {
        await db.prepare(
          "UPDATE product_images SET mime = ?, data = ?, bytes = ?, updated_at = ? WHERE id = ?"
        ).run(finalMainMime, finalMainBuf, finalMainBytes, now(), img.id);
      }

      // Guardar variantes (idempotente: INSERT OR REPLACE)
      for (const v of variantResults) {
        await db.prepare(
          "INSERT OR REPLACE INTO product_image_variants (image_id, width, mime, data, bytes, created_at) VALUES (?, ?, ?, ?, ?, ?)"
        ).run(img.id, v.width, "image/webp", v.buf, v.bytes, now());
      }
    }

    processed++;
    if (processed % 10 === 0) console.log(`  ... ${processed}/${toProcess.length}`);
  }

  // Tabla de resultados
  console.log("\n📋 RESULTADOS:");
  console.log("┌────┬────────────┬────────────┬──────────┬──────────────────────┬──────────┬─────────┐");
  console.log("│ ID │ Original   │ Optimizada │ Variantes│ Tamaños variantes    │ Ahorro   │ %       │");
  console.log("├────┼────────────┼────────────┼──────────┼──────────────────────┼──────────┼─────────┤");
  for (const r of results) {
    const idStr = String(r.id).padStart(4);
    const orig = r.originalSize.padStart(10);
    const opt = r.optimizedSize.padStart(10);
    const vcount = String(r.variantCount).padStart(8);
    const vsizes = r.variantSizes.padStart(20);
    const savings = `${(r.savingsBytes / 1024).toFixed(1)} KB`.padStart(8);
    const pct = r.savingsPct.padStart(7);
    console.log(`│ ${idStr} │ ${orig} │ ${opt} │ ${vcount} │ ${vsizes} │ ${savings} │ ${pct} │`);
  }
  console.log("└────┴────────────┴────────────┴──────────┴──────────────────────┴──────────┴─────────┘");

  const totalSavings = results.reduce((s, r) => s + r.savingsBytes, 0);
  const totalSavingsPct = totalOriginalBytes > 0 ? ((totalSavings / totalOriginalBytes) * 100).toFixed(1) : "0";

  console.log(`\n📈 RESUMEN:`);
  console.log(`   Imágenes procesadas: ${processed}`);
  console.log(`   Saltadas (ya pequeñas): ${skipped}`);
  console.log(`   Errores: ${errors}`);
  console.log(`   Peso original total: ${(totalOriginalBytes / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   Peso estimado optimizado + variantes: ${((totalOriginalBytes - totalSavings) / 1024 / 1024).toFixed(2)} MB`);
  console.log(`   Ahorro estimado: ${(totalSavings / 1024 / 1024).toFixed(2)} MB (${totalSavingsPct}%)`);

  if (dryRun) {
    console.log(`\n⚠️  DRY-RUN: No se escribieron cambios. Usá --apply para guardar.`);
  } else {
    console.log(`\n✅ Migración completada.`);
  }

  await client.close();
}

main().catch(err => {
  console.error("❌ Error fatal:", err);
  process.exit(1);
});