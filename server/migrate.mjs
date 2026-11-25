// Migración de datos vivos a Turso.
// Copia los datos de un archivo SQLite local (la base del artefacto
// original, app.db) a la base Turso de producción, mapeando por nombre:
//   - loterías por NOMBRE (los IDs cambian: el servidor nuevo siembra 35
//     loterías y el artefacto tenía 31; el nombre es lo que coincide)
//   - usuarios por NOMBRE DE USUARIO (el dueño 'admin' ya existe por la
//     siembra; las banqueras que falten se crean con su contraseña y rol)
//   - tickets, jugadas, resultados y recargas se copian con sus IDs
//     originales; las sesiones NO se migran (los usuarios vuelven a entrar).
//
// ORDEN CORRECTO: primero desplegar en Render y dejar que el servidor
// arranque una vez (crea el esquema y siembra admin + loterías), y DESPUÉS
// correr esta migración contra una base Turso VACÍA de ventas. Si la base
// destino ya tiene tickets, los que choquen por ID se saltan y se reportan.
//
// Uso:
//   TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... \
//     node migrate.mjs /ruta/a/app.db
//
// Requiere: @libsql/client (ya es dependencia del servidor).

import { createClient } from '@libsql/client';
import path from 'node:path';

const sourcePath = process.argv[2];
const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';

if (!sourcePath) {
  console.error('Uso: node migrate.mjs /ruta/a/app.db  (origen SQLite local)');
  process.exit(2);
}
if (!TURSO_URL || !TURSO_TOKEN) {
  console.error('Faltan TURSO_DATABASE_URL y TURSO_AUTH_TOKEN (variables de entorno).');
  process.exit(2);
}

const src = createClient({ url: 'file:' + path.resolve(sourcePath) });
const dst = createClient({ url: TURSO_URL, authToken: TURSO_TOKEN });

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL, usuario TEXT UNIQUE NOT NULL,
  contrasena TEXT NOT NULL, rol TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1, creado_en TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS loterias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL, abre TEXT NOT NULL, cierra TEXT NOT NULL, orden INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resultados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loteria_id INTEGER NOT NULL, fecha TEXT NOT NULL,
  primera TEXT NOT NULL, segunda TEXT NOT NULL, tercera TEXT NOT NULL,
  UNIQUE(loteria_id, fecha)
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folio TEXT UNIQUE NOT NULL, codigo TEXT UNIQUE NOT NULL,
  loteria_id INTEGER NOT NULL, usuario_id INTEGER NOT NULL,
  banca TEXT NOT NULL, fecha TEXT NOT NULL, hora TEXT NOT NULL,
  total INTEGER NOT NULL, estado TEXT NOT NULL DEFAULT 'activo', pagado_at TEXT
);
CREATE TABLE IF NOT EXISTS jugadas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL, tipo TEXT NOT NULL,
  numero TEXT NOT NULL, modo TEXT, monto INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recargas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL, banca TEXT NOT NULL,
  monto INTEGER NOT NULL, nota TEXT, fecha TEXT NOT NULL, hora TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ajustes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clave TEXT UNIQUE NOT NULL, valor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY, usuario_id INTEGER NOT NULL, creado_en TEXT NOT NULL
);
`;

async function q(c, sql, args = []) {
  const r = await c.execute({ sql, args });
  return r.rows;
}

const report = { copiados: {}, saltados: {}, avisos: [] };
function bump(tabla, n, saltados = 0) {
  report.copiados[tabla] = (report.copiados[tabla] || 0) + n;
  if (saltados) report.saltados[tabla] = (report.saltados[tabla] || 0) + saltados;
}

await dst.executeMultiple(SCHEMA);

// --- usuarios: mapear por nombre de usuario ---
const srcUsuarios = await q(src, 'SELECT * FROM usuarios ORDER BY id');
const dstUsuarios = await q(dst, 'SELECT id, usuario FROM usuarios');
const usuarioMap = new Map(dstUsuarios.map((u) => [u.usuario, u.id]));
let nUsu = 0;
for (const u of srcUsuarios) {
  if (usuarioMap.has(u.usuario)) continue; // admin ya existe por la siembra
  const r = await dst.execute({
    sql: 'INSERT INTO usuarios (nombre, usuario, contrasena, rol, activo, creado_en) VALUES (?, ?, ?, ?, ?, ?)',
    args: [u.nombre, u.usuario, u.contrasena, u.rol, u.activo, u.creado_en],
  });
  usuarioMap.set(u.usuario, Number(r.lastInsertRowid));
  nUsu++;
}
bump('usuarios', nUsu);

// --- loterías: mapa por nombre (no se insertan; la siembra manda) ---
const srcLots = await q(src, 'SELECT * FROM loterias ORDER BY id');
const dstLots = await q(dst, 'SELECT id, nombre FROM loterias');
const lotMap = new Map(dstLots.map((l) => [l.nombre, l.id]));
const srcLotNombre = new Map(srcLots.map((l) => [l.id, l.nombre]));
for (const l of srcLots) {
  if (!lotMap.has(l.nombre)) report.avisos.push(`Lotería del origen sin equivalente en destino: "${l.nombre}" (sus tickets/resultados se saltan).`);
}
function lotDestino(idOrigen) {
  const nombre = srcLotNombre.get(idOrigen);
  return nombre ? lotMap.get(nombre) : undefined;
}
function usuDestino(idOrigen) {
  const u = srcUsuarios.find((x) => x.id === idOrigen);
  return u ? usuarioMap.get(u.usuario) : undefined;
}

// --- resultados ---
const srcRes = await q(src, 'SELECT * FROM resultados ORDER BY id');
let nRes = 0, sRes = 0;
for (const r of srcRes) {
  const lid = lotDestino(r.loteria_id);
  if (!lid) { sRes++; continue; }
  await dst.execute({
    sql: `INSERT INTO resultados (loteria_id, fecha, primera, segunda, tercera) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(loteria_id, fecha) DO UPDATE SET primera = excluded.primera, segunda = excluded.segunda, tercera = excluded.tercera`,
    args: [lid, r.fecha, r.primera, r.segunda, r.tercera],
  });
  nRes++;
}
bump('resultados', nRes, sRes);

// --- tickets + jugadas (se preservan los IDs) ---
const srcTickets = await q(src, 'SELECT * FROM tickets ORDER BY id');
const dstTicketIds = new Set((await q(dst, 'SELECT id FROM tickets')).map((t) => t.id));
let nTik = 0, sTik = 0, nJug = 0;
for (const t of srcTickets) {
  const lid = lotDestino(t.loteria_id);
  const uid = usuDestino(t.usuario_id);
  if (!lid || !uid) { sTik++; report.avisos.push(`Ticket folio ${t.folio} saltado (lotería o usuario sin equivalente).`); continue; }
  if (dstTicketIds.has(t.id)) { sTik++; report.avisos.push(`Ticket folio ${t.folio} (id ${t.id}) ya existe en destino, se salta.`); continue; }
  await dst.execute({
    sql: `INSERT INTO tickets (id, folio, codigo, loteria_id, usuario_id, banca, fecha, hora, total, estado, pagado_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [t.id, t.folio, t.codigo, lid, uid, t.banca, t.fecha, t.hora, t.total, t.estado, t.pagado_at],
  });
  const jugadas = await q(src, 'SELECT * FROM jugadas WHERE ticket_id = ? ORDER BY id', [t.id]);
  for (const j of jugadas) {
    await dst.execute({
      sql: 'INSERT INTO jugadas (id, ticket_id, tipo, numero, modo, monto) VALUES (?, ?, ?, ?, ?, ?)',
      args: [j.id, j.ticket_id, j.tipo, j.numero, j.modo, j.monto],
    });
    nJug++;
  }
  nTik++;
}
bump('tickets', nTik, sTik);
bump('jugadas', nJug);

// --- recargas ---
const srcRec = await q(src, 'SELECT * FROM recargas ORDER BY id');
let nRec = 0, sRec = 0;
for (const r of srcRec) {
  const uid = usuDestino(r.usuario_id);
  if (!uid) { sRec++; continue; }
  await dst.execute({
    sql: 'INSERT INTO recargas (id, usuario_id, banca, monto, nota, fecha, hora) VALUES (?, ?, ?, ?, ?, ?, ?)',
    args: [r.id, uid, r.banca, r.monto, r.nota, r.fecha, r.hora],
  });
  nRec++;
}
bump('recargas', nRec, sRec);

// --- ajustes (sin pisar los del destino) ---
const srcAj = await q(src, 'SELECT * FROM ajustes');
let nAj = 0;
for (const a of srcAj) {
  await dst.execute({
    sql: 'INSERT OR IGNORE INTO ajustes (clave, valor) VALUES (?, ?)',
    args: [a.clave, a.valor],
  });
  nAj++;
}
bump('ajustes', nAj);

console.log('Migración terminada.');
console.log('Copiados:', JSON.stringify(report.copiados));
console.log('Saltados:', JSON.stringify(report.saltados));
if (report.avisos.length) {
  console.log('Avisos:');
  for (const a of report.avisos) console.log(' - ' + a);
}
src.close();
dst.close();
