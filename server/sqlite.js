// Facade sobre @libsql/client que imita la API de node:sqlite.
//
//   db.prepare(sql).get(...)  → Promise<fila | undefined>
//   db.prepare(sql).all(...)  → Promise<fila[]>
//   db.prepare(sql).run(...)  → Promise<{ lastInsertRowid, changes }>
//
// Vive en su propio módulo (y no dentro de db.js) para que los tests puedan
// levantar la MISMA capa SQL contra un SQLite en memoria, sin importar el
// cliente singleton de db.js — importarlo dispararía las migraciones
// contra la base real.

export function createDb(client) {
  function prepare(sql) {
    return {
      all: (...args) =>
        client.execute({ sql, args, rowMode: "object" }).then((res) => res.rows),
      get: (...args) =>
        client.execute({ sql, args, rowMode: "object" }).then((res) => res.rows[0]),
      run: (...args) =>
        client.execute({ sql, args }).then((res) => ({
          lastInsertRowid:
            res.lastInsertRowid == null ? 0 : Number(res.lastInsertRowid),
          changes: res.rowsAffected,
        })),
    };
  }

  // Convierte las filas de un ResultSet (arrays) en objetos. client.batch() no
  // acepta rowMode, así que el mapeo se hace acá.
  function rowsToObjects(rs) {
    const named = [];
    for (const row of rs.rows) {
      const obj = {};
      for (let i = 0; i < rs.columns.length; i++) obj[rs.columns[i]] = row[i];
      named.push(obj);
    }
    return named;
  }

  return {
    prepare,
    exec: (sql) => client.executeMultiple(sql),
    // Batch atómico de varias sentencias en UN solo round-trip (importante con
    // Turso/HTTP). Devuelve un array con { lastInsertRowid, rowsAffected, rows }
    // y las filas ya convertidas a objetos.
    batch: (stmts, mode) =>
      client.batch(stmts, mode).then((results) =>
        results.map((rs) => ({
          lastInsertRowid: rs.lastInsertRowid,
          rowsAffected: rs.rowsAffected,
          rows: rowsToObjects(rs),
        }))
      ),
  };
}
