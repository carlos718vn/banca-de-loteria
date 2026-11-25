// Migración de datos vivos a Turso.
// Copia los datos de un archivo SQLite local (la base del artefacto
// original, app.db) a la base Turso de producción.
//
// ESQUEMA REAL DEL ARTEFACTO (verificado 2026-11-24, NO el del SPEC):
//   usuarios: id, usuario, contrasena, banca_nombre, rol, activo, created_at(ms)
//   loterias: id, nombre, letra, hora_apertura, hora_cierre, orden
//   tickets:  id, folio, sorteo(NOMBRE lotería), cliente, total, estado,
//             created_at(ms), codigo, pagado_at(ms|null)
//   jugadas:  id, ticket_id, tipo, numeros("03-24" / "03-24-69"), monto
//   resultados: id, fecha, loteria(NOMBRE), primero, segundo, tercero, created_at(ms)
//   recargas y ajustes existen pero con otro esquema y 0 filas: no se migran.
//   sesiones no existe: no se migra (los usuarios vuelven a entrar).
//
// MAPEO AL ESQUEMA NUEVO (servidor Render/Turso):
//   - usuarios.nombre = banca_nombre (en el servidor nuevo, nombre ES la banca;
//     el ticket.banca sale de u.nombre). creado_en = created_at en SD.
//     El admin ya existe por la siembra: se le actualiza el nombre a su banca.
//   - loterías por NOMBRE normalizado (minúsculas, "new york" -> "ny");
//     no se insertan, la siembra manda. Nombres que no coinciden se avisan
//     y sus tickets/resultados se saltan.
//   - resultados: loteria (nombre) -> loteria_id; primero->primera, etc.
//   - tickets: el artefacto NO guarda quién vendió ni la banca; se asignan
//     al dueño (admin) con banca = nombre de su banca. fecha/hora salen de
//     created_at (ms) en hora de Santo Domingo. pagado_at ms -> texto o null.
//   - jugadas: numero = numeros sin guiones ("03-24" -> "0324"); modo = null.
//
// ORDEN CORRECTO: primero desplegar en Render y dejar que el servidor
// arranque una vez (crea el esquema y siembra admin + loterías), y DESPUÉS
// correr esta migración contra una base Turso VACÍA de ventas. Si la base
// destino ya tiene tickets, los que choquen por ID se saltan y se reportan.
//
// Uso:
//   TURSO_DATABASE_URL=<redacted>
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

// --- Fecha/hora de Santo Domingo desde milisegundos (mismo formato que server.js sdNow) ---
const TZ = 'America/Santo_Domingo';
function sdParts(ms) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(ms)).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  return { fecha: `${parts.year}-${parts.month}-${parts.day}`, hora: `${parts.hour}:${parts.minute}:${parts.second}` };
}
function sdDateTime(ms) {
  const { fecha, hora } = sdParts(ms);
  return `${fecha} ${hora}`;
}

// --- Normalizar nombre de lotería para el mapeo ---
function normNombre(n) {
  return String(n || '').trim().toLowerCase().replace(/new york/g, 'ny').replace(/\s+/g, ' ');
}

const report = { copiados: {}, saltados: {}, avisos: [] };
function bump(tabla, n, saltados = 0) {
  report.copiados[tabla] = (report.copiados[tabla] || 0) + n;
  if (saltados) report.saltados[tabla] = (report.saltados[tabla] || 0) + saltados;
}

await dst.executeMultiple(SCHEMA);

// --- usuarios: nombre = banca_nombre; creado_en = created_at en SD ---
const srcUsuarios = await q(src, 'SELECT * FROM usuarios ORDER BY id');
const dstUsuarios = await q(dst, 'SELECT id, usuario, nombre FROM usuarios');
const usuarioMap = new Map(dstUsuarios.map((u) => [u.usuario, u.id]));
const usuarioNombre = new Map(dstUsuarios.map((u) => [u.usuario, u.nombre]));
let nUsu = 0;
for (const u of srcUsuarios) {
  const nombre = (u.banca_nombre && String(u.banca_nombre).trim()) || u.usuario;
  const creadoEn = u.created_at ? sdDateTime(u.created_at) : '2026-11-24 00:00:00';
  if (usuarioMap.has(u.usuario)) {
    // Ya existe (admin por la siembra): actualizar su nombre a su banca real.
    await dst.execute({ sql: 'UPDATE usuarios SET nombre = ? WHERE usuario = ?', args: [nombre, u.usuario] });
    usuarioNombre.set(u.usuario, nombre);
    continue;
  }
  const r = await dst.execute({
    sql: 'INSERT INTO usuarios (nombre, usuario, contrasena, rol, activo, creado_en) VALUES (?, ?, ?, ?, ?, ?)',
    args: [nombre, u.usuario, u.contrasena, u.rol, u.activo ? 1 : 0, creadoEn],
  });
  usuarioMap.set(u.usuario, Number(r.lastInsertRowid));
  usuarioNombre.set(u.usuario, nombre);
  nUsu++;
}
bump('usuarios', nUsu);

// --- loterías: mapa por nombre normalizado (no se insertan; la siembra manda) ---
const srcLots = await q(src, 'SELECT * FROM loterias ORDER BY id');
const dstLots = await q(dst, 'SELECT id, nombre FROM loterias');
const lotMap = new Map(dstLots.map((l) => [normNombre(l.nombre), l.id]));
const srcLotNombre = new Map(srcLots.map((l) => [l.id, l.nombre]));
for (const l of srcLots) {
  if (!lotMap.has(normNombre(l.nombre))) report.avisos.push(`Lotería del origen sin equivalente en destino: "${l.nombre}" (sus tickets/resultados se saltan).`);
}
function lotDestinoPorNombre(nombre) {
  return lotMap.get(normNombre(nombre));
}

// El artefacto no guarda quién vendió cada ticket: se asignan al dueño.
const adminId = usuarioMap.get('admin');
const adminBanca = usuarioNombre.get('admin') || 'Mi Banca';
if (!adminId) { console.error('No existe el usuario admin en destino; abortando.'); process.exit(3); }

// --- resultados ---
const srcRes = await q(src, 'SELECT * FROM resultados ORDER BY id');
let nRes = 0, sRes = 0;
for (const r of srcRes) {
  const lid = lotDestinoPorNombre(r.loteria);
  if (!lid) { sRes++; report.avisos.push(`Resultado ${r.fecha} "${r.loteria}" saltado (lotería sin equivalente).`); continue; }
  await dst.execute({
    sql: `INSERT INTO resultados (loteria_id, fecha, primera, segunda, tercera) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(loteria_id, fecha) DO UPDATE SET primera = excluded.primera, segunda = excluded.segunda, tercera = excluded.tercera`,
    args: [lid, r.fecha, r.primero, r.segundo, r.tercero],
  });
  nRes++;
}
bump('resultados', nRes, sRes);

// --- tickets + jugadas (se preservan los IDs) ---
const srcTickets = await q(src, 'SELECT * FROM tickets ORDER BY id');
const dstTicketIds = new Set((await q(dst, 'SELECT id FROM tickets')).map((t) => t.id));
let nTik = 0, sTik = 0, nJug = 0;
for (const t of srcTickets) {
  const lid = lotDestinoPorNombre(t.sorteo);
  if (!lid) { sTik++; report.avisos.push(`Ticket folio ${t.folio} saltado (lotería "${t.sorteo}" sin equivalente).`); continue; }
  if (dstTicketIds.has(t.id)) { sTik++; report.avisos.push(`Ticket folio ${t.folio} (id ${t.id}) ya existe en destino, se salta.`); continue; }
  const { fecha, hora } = t.created_at ? sdParts(t.created_at) : { fecha: '2026-11-24', hora: '00:00:00' };
  const pagadoAt = t.pagado_at ? sdDateTime(t.pagado_at) : null;
  await dst.execute({
    sql: `INSERT INTO tickets (id, folio, codigo, loteria_id, usuario_id, banca, fecha, hora, total, estado, pagado_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [t.id, t.folio, t.codigo, lid, adminId, adminBanca, fecha, hora, t.total, t.estado, pagadoAt],
  });
  const jugadas = await q(src, 'SELECT * FROM jugadas WHERE ticket_id = ? ORDER BY id', [t.id]);
  for (const j of jugadas) {
    await dst.execute({
      sql: 'INSERT INTO jugadas (id, ticket_id, tipo, numero, modo, monto) VALUES (?, ?, ?, ?, ?, ?)',
      args: [j.id, j.ticket_id, j.tipo, String(j.numeros).replace(/-/g, ''), null, j.monto],
    });
    nJug++;
  }
  nTik++;
}
bump('tickets', nTik, sTik);
bump('jugadas', nJug);

// recargas y ajustes del artefacto tienen otro esquema y 0 filas: no se migran.
console.log('Migración terminada.');
console.log('Copiados:', JSON.stringify(report.copiados));
console.log('Saltados:', JSON.stringify(report.saltados));
if (report.avisos.length) {
  console.log('Avisos:');
  for (const a of report.avisos) console.log(' - ' + a);
}
src.close();
dst.close();
