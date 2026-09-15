import "dotenv/config";
import { createClient } from "@libsql/client";
import tandil from "../../src/data/menu.tandil.js";
import necochea from "../../src/data/menu.necochea.js";

const url = process.env.TURSO_DATABASE_URL;
const token = process.env.TURSO_AUTH_TOKEN;
if (!url || !token) {
  console.error("Falta TURSO_DATABASE_URL o TURSO_AUTH_TOKEN en .env");
  process.exit(1);
}

const client = createClient({ url, authToken: token });
const menus = { tandil, necochea };

let updated = 0,
  skipped = 0,
  missing = 0;

for (const [branch, menu] of Object.entries(menus)) {
  for (const cat of menu.categories) {
    for (const g of cat.groups) {
      for (const p of g.products) {
        if (!p.image) {
          skipped++;
          continue;
        }
        const ts = new Date().toISOString();
        const res = await client.execute({
          sql: "UPDATE products SET image = ?, updated_at = ? WHERE branch = ? AND product_id = ?",
          args: [p.image, ts, branch, p.id],
        });
        if (res.rowsAffected === 1) {
          updated++;
          console.log(`OK ${branch}/${p.id} → ${p.image}`);
        } else {
          missing++;
          console.warn(`! ${branch}/${p.id} no encontrado en DB`);
        }
      }
    }
  }
}

console.log(`\nListo: ${updated} actualizados, ${missing} no encontrados, ${skipped} sin imagen`);
process.exit(0);
