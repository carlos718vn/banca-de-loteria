// Banca de Lotería — servidor público independiente.
// Reimplementación desde SPEC.md (~/workspace/banca-de-loteria-public/SPEC.md).
// Node.js, sin framework: solo el módulo `http` incorporado y `@libsql/client`.
// API: POST /actions  {action, args} -> {ok:true,...} | {ok:false, error:"..."}
// Estáticos: sirve ../client/ en / (si no existe, 404 en / sin caerse).
// Zona horaria de negocio: America/Santo_Domingo (UTC-4).
//
// Base de datos (una sola vía de acceso, variable de entorno):
//   - Si TURSO_DATABASE_URL está definido -> Turso (libSQL remoto, persistente).
//     Requiere TURSO_AUTH_TOKEN. Es la base de producción en Render.
//   - Si no -> archivo SQLite local con el mismo cliente libSQL
//     (DB_PATH o banca.db junto a este archivo). Es lo que usan las pruebas
//     (DB_PATH=banca.test.db) y el desarrollo local.
// El dialecto SQL es SQLite en los dos modos, así que el esquema y las
// consultas son idénticas. Todas las operaciones de base de datos son
// asíncronas (el cliente libSQL no tiene API síncrona).

import http from 'node:http';
import { createClient } from '@libsql/client';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'banca.db');
const TURSO_URL = process.env.TURSO_DATABASE_URL || '';
const TURSO_TOKEN = process.env.TURSO_AUTH_TOKEN || '';
const PORT = parseInt(process.env.PORT || '8080', 10);
const CLIENT_DIR = path.join(__dirname, '..', 'client');
const TZ = 'America/Santo_Domingo';

// ---------------------------------------------------------------------------
// Tiempo (Santo Domingo)
// ---------------------------------------------------------------------------
function sdNow(d = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(d).reduce((o, p) => { o[p.type] = p.value; return o; }, {});
  const fecha = `${parts.year}-${parts.month}-${parts.day}`;
  const hora = `${parts.hour}:${parts.minute}:${parts.second}`;
  return { fecha, hora, hhmm: hora.slice(0, 5) };
}

function fmt12(hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  const ampm = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
}

// ---------------------------------------------------------------------------
// Base de datos (adaptador libSQL, misma API de uso que node:sqlite)
// ---------------------------------------------------------------------------
const client = TURSO_URL
  ? createClient({ url: TURSO_URL, authToken: TURSO_TOKEN || undefined })
  : createClient({ url: 'file:' + path.resolve(DB_PATH) });

// libSQL devuelve lastInsertRowid como bigint y las filas como objetos
// {columna: valor} (igual que node:sqlite). Normalizamos los bigint a Number
// para que el JSON de respuesta no falle.
function normRow(row) {
  if (!row || typeof row !== 'object') return row;
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' ? Number(v) : v;
  return out;
}

const db = {
  async exec(sql) { await client.executeMultiple(sql); },
  prepare(sql) {
    return {
      async get(...params) {
        const r = await client.execute({ sql, args: params });
        return normRow(r.rows[0]);
      },
      async all(...params) {
        const r = await client.execute({ sql, args: params });
        return r.rows.map(normRow);
      },
      async run(...params) {
        const r = await client.execute({ sql, args: params });
        return {
          lastInsertRowid: r.lastInsertRowid === undefined || r.lastInsertRowid === null
            ? undefined : Number(r.lastInsertRowid),
          changes: r.rowsAffected,
        };
      },
    };
  },
};

const SCHEMA = `
CREATE TABLE IF NOT EXISTS usuarios (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  usuario TEXT UNIQUE NOT NULL,
  contrasena TEXT NOT NULL,
  rol TEXT NOT NULL,
  activo INTEGER NOT NULL DEFAULT 1,
  creado_en TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS loterias (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  nombre TEXT NOT NULL,
  abre TEXT NOT NULL,
  cierra TEXT NOT NULL,
  orden INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS resultados (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  loteria_id INTEGER NOT NULL,
  fecha TEXT NOT NULL,
  primera TEXT NOT NULL,
  segunda TEXT NOT NULL,
  tercera TEXT NOT NULL,
  UNIQUE(loteria_id, fecha)
);
CREATE TABLE IF NOT EXISTS tickets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  folio TEXT UNIQUE NOT NULL,
  codigo TEXT UNIQUE NOT NULL,
  loteria_id INTEGER NOT NULL,
  usuario_id INTEGER NOT NULL,
  banca TEXT NOT NULL,
  fecha TEXT NOT NULL,
  hora TEXT NOT NULL,
  total INTEGER NOT NULL,
  estado TEXT NOT NULL DEFAULT 'activo',
  pagado_at TEXT
);
CREATE TABLE IF NOT EXISTS jugadas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ticket_id INTEGER NOT NULL,
  tipo TEXT NOT NULL,
  numero TEXT NOT NULL,
  modo TEXT,
  monto INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS recargas (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  usuario_id INTEGER NOT NULL,
  banca TEXT NOT NULL,
  monto INTEGER NOT NULL,
  nota TEXT,
  fecha TEXT NOT NULL,
  hora TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS ajustes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  clave TEXT UNIQUE NOT NULL,
  valor TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS sesiones (
  token TEXT PRIMARY KEY,
  usuario_id INTEGER NOT NULL,
  creado_en TEXT NOT NULL
);
`;

function sha256(s) {
  return crypto.createHash('sha256').update(String(s)).digest('hex');
}

// Semilla de loterías (SPEC — Horarios). Todas abren 06:00 salvo Anguila,
// cuyos sorteos abren cuando cierra el anterior.
function loteriasSemilla() {
  const base = [
    ['Loteka Noche', '19:55'],
    ['Primera Día', '12:00'],
    ['Primera Noche', '19:55'],
    ['LoteDom', '12:00'],
    ['La Suerte Día', '12:25'],
    ['La Suerte Noche', '17:50'],
    ['Real Día', '12:55'],
    ['Real Noche', '19:55'],
    ['Nacional Tarde', '14:30'],
    ['Nacional Noche', '20:50'],
    ['Gana Más', '14:30'],
    ['LEIDSA Noche', '20:55'],
    ['QP Noche', '19:55'],          // POR CONFIRMAR (hora de cierre)
    ['LTK', '19:55'],               // POR CONFIRMAR (hora de cierre)
    ['NY Tarde', '15:20'],
    ['NY Noche', '23:00'],
    ['Florida AM', '14:20'],
    ['Florida Noche', '22:20'],
    ['Florida Tarde', '19:55'],     // POR CONFIRMAR (hora de cierre)
    ['Primera Tarde', '15:00'],     // POR CONFIRMAR (hora de cierre)
  ];
  const list = base.map(([nombre, cierra]) => ({ nombre, abre: '06:00', cierra }));
  // Anguila: 15 sorteos, uno cada hora, de 7:55 AM a 9:55 PM.
  const anguilaHoras = ['07:55', '08:55', '09:55', '10:55', '11:55', '12:55', '13:55', '14:55', '15:55', '16:55', '17:55', '18:55', '19:55', '20:55', '21:55'];
  let abrePrev = '06:00';
  for (const cierra of anguilaHoras) {
    list.push({ nombre: `Anguila ${fmt12(cierra)}`, abre: abrePrev, cierra });
    abrePrev = cierra;
  }
  return list;
}

async function sembrar() {
  const nUsuarios = (await db.prepare('SELECT COUNT(*) c FROM usuarios').get())?.c ?? 0;
  if (nUsuarios === 0) {
    const ahora = sdNow();
    await db.prepare(`INSERT INTO usuarios (nombre, usuario, contrasena, rol, activo, creado_en)
      VALUES (?, 'admin', ?, 'dueno', 1, ?)`).run('Banca', sha256('admin'), `${ahora.fecha} ${ahora.hora}`);
  }
  const nLot = (await db.prepare('SELECT COUNT(*) c FROM loterias').get())?.c ?? 0;
  if (nLot === 0) {
    const ins = db.prepare('INSERT INTO loterias (nombre, abre, cierra, orden) VALUES (?, ?, ?, ?)');
    for (const [i, l] of loteriasSemilla().entries()) await ins.run(l.nombre, l.abre, l.cierra, i + 1);
  }
  const ajustesDef = { nombre_banca: 'Mi Banca', ancho_papel: '58', impresora: '' };
  for (const [clave, valor] of Object.entries(ajustesDef)) {
    await db.prepare('INSERT OR IGNORE INTO ajustes (clave, valor) VALUES (?, ?)').run(clave, valor);
  }
}

// Inicialización: esquema + semilla antes de escuchar.
if (!TURSO_URL) {
  // Solo en archivo local (en Turso remoto el PRAGMA no aplica).
  await client.execute('PRAGMA journal_mode = WAL');
}
await db.exec(SCHEMA);
await sembrar();

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------
function err(msg) { const e = new Error(msg); e.isApp = true; return e; }
function requireFields(args, fields) {
  for (const f of fields) {
    if (args[f] === undefined || args[f] === null || args[f] === '') throw err(`Falta el campo ${f}.`);
  }
}
async function getUsuarioByToken(token) {
  if (!token) throw err('Sesión no válida. Inicia sesión de nuevo.');
  const ses = await db.prepare('SELECT usuario_id FROM sesiones WHERE token = ?').get(token);
  if (!ses) throw err('Sesión no válida. Inicia sesión de nuevo.');
  const u = await db.prepare('SELECT id, nombre, usuario, rol, activo FROM usuarios WHERE id = ?').get(ses.usuario_id);
  if (!u || !u.activo) throw err('Sesión no válida. Inicia sesión de nuevo.');
  return u;
}
function requireDueno(u) {
  if (u.rol !== 'dueno') throw err('Solo el dueño puede hacer esto.');
}
function isDueno(u) { return u.rol === 'dueno'; }

// Filtro de banca: la banquera solo ve/opera su banca (por usuario_id).
function bancaWhere(u) {
  return isDueno(u) ? { sql: '', params: [] } : { sql: ' AND t.usuario_id = ?', params: [u.id] };
}

function loteriaAbierta(lot, hhmm) {
  return lot.abre <= hhmm && hhmm < lot.cierra;
}

// ---------------------------------------------------------------------------
// Motor de premios (SPEC — exacto)
// ---------------------------------------------------------------------------
// Devuelve {premio, detalle} o {premio:0, detalle} si no gana.
// Play 3 / Play 3 Back / Play 4: premio 0, detalle "Premio por confirmar"
// (matemática POR CONFIRMAR con el usuario).
function calcularPremio(jugada, res) {
  if (!res) return { premio: 0, detalle: 'Sin resultado' };
  const { tipo, numero, monto } = jugada;
  const { primera, segunda, tercera } = res;
  if (tipo === 'quiniela') {
    if (numero === primera) return { premio: 80 * monto, detalle: 'Quiniela en 1ra' };
    if (numero === segunda) return { premio: 8 * monto, detalle: 'Quiniela en 2da' };
    if (numero === tercera) return { premio: 4 * monto, detalle: 'Quiniela en 3ra' };
    return { premio: 0, detalle: 'Sin premio' };
  }
  if (tipo === 'pale') {
    const n1 = numero.slice(0, 2), n2 = numero.slice(2, 4);
    if (n1 === primera && n2 === segunda) return { premio: 1500 * monto, detalle: 'Palé ganador (1ra y 2da)' };
    if (n1 === segunda && n2 === tercera) return { premio: 100 * monto, detalle: 'Palé ganador (2da y 3ra)' };
    // Palé en 1ra+3ra paga 0 por ahora — POR CONFIRMAR.
    return { premio: 0, detalle: 'Sin premio' };
  }
  if (tipo === 'tripleta') {
    const a = numero.slice(0, 2), b = numero.slice(2, 4), c = numero.slice(4, 6);
    if (a === primera && b === segunda && c === tercera) return { premio: 20000 * monto, detalle: 'Tripleta ganadora' };
    if (a === primera && b === segunda) return { premio: 500 * monto, detalle: 'Tripleta con dos patas (1ra y 2da)' };
    if (a === primera && c === tercera) return { premio: 500 * monto, detalle: 'Tripleta con dos patas (1ra y 3ra)' };
    if (b === segunda && c === tercera) return { premio: 100 * monto, detalle: 'Tripleta con dos patas (2da y 3ra)' };
    return { premio: 0, detalle: 'Sin premio' };
  }
  if (tipo === 'play3' || tipo === 'play3back' || tipo === 'play4') {
    return { premio: 0, detalle: 'Premio por confirmar' };
  }
  return { premio: 0, detalle: 'Sin premio' };
}

// Premio total de un ticket (según el resultado de su lotería y fecha).
async function premioTicket(ticketId, loteriaId, fecha) {
  const res = await db.prepare('SELECT primera, segunda, tercera FROM resultados WHERE loteria_id = ? AND fecha = ?').get(loteriaId, fecha);
  if (!res) return { total: 0, jugadas: [] };
  const jugadas = await db.prepare('SELECT tipo, numero, modo, monto FROM jugadas WHERE ticket_id = ?').all(ticketId);
  let total = 0;
  const det = jugadas.map((j) => {
    const r = calcularPremio(j, res);
    total += r.premio;
    return { ...j, premio: r.premio, detalle: r.detalle };
  });
  return { total, jugadas: det };
}

async function ticketConJugadas(row) {
  const jugadas = await db.prepare('SELECT tipo, numero, modo, monto FROM jugadas WHERE ticket_id = ?').all(row.id);
  const lot = await db.prepare('SELECT nombre FROM loterias WHERE id = ?').get(row.loteria_id);
  return {
    id: row.id, folio: row.folio, codigo: row.codigo,
    loteria: lot ? lot.nombre : null, loteriaId: row.loteria_id,
    banca: row.banca, fecha: row.fecha, hora: row.hora,
    total: row.total, estado: row.estado, pagado_at: row.pagado_at || null,
    jugadas,
  };
}

// ---------------------------------------------------------------------------
// Validación de jugadas
// ---------------------------------------------------------------------------
function validarJugadas(jugadas) {
  if (!Array.isArray(jugadas) || jugadas.length === 0) throw err('El ticket no tiene jugadas.');
  return jugadas.map((j) => {
    if (!j || typeof j !== 'object') throw err('Jugada inválida.');
    let { tipo, numero, modo, monto } = j;
    if (typeof numero !== 'string') throw err('Número de jugada inválido.');
    numero = numero.trim();
    // Atajo Box: número + "."  (ej. "123." = Play 3 Box, "-1234." = Play 4 Box)
    if (numero.endsWith('.')) { numero = numero.slice(0, -1); modo = 'BX'; }
    if (modo !== undefined && modo !== null && modo !== 'ST' && modo !== 'BX') throw err('Modo inválido (solo ST o BX).');
    monto = Number(monto);
    if (!Number.isInteger(monto) || monto <= 0) throw err('El monto debe ser mayor que 0.');
    const patrones = {
      quiniela: /^\d{2}$/,
      pale: /^\d{4}$/,
      tripleta: /^\d{6}$/,
      play3: /^\d{3}$/,
      play3back: /^-\d{3}$/,
      play4: /^-\d{4}$/,
    };
    if (!tipo || !patrones[tipo]) {
      // Inferir por dígitos si no viene tipo válido.
      const dig = numero.replace('-', '');
      if (/^\d{2}$/.test(numero)) tipo = 'quiniela';
      else if (/^\d{4}$/.test(numero)) tipo = 'pale';
      else if (/^\d{6}$/.test(numero)) tipo = 'tripleta';
      else if (/^\d{3}$/.test(numero)) tipo = 'play3';
      else if (/^-\d{3}$/.test(numero)) tipo = 'play3back';
      else if (/^-\d{4}$/.test(numero)) tipo = 'play4';
      else throw err(`Número inválido: ${numero}.`);
    }
    if (!patrones[tipo].test(numero)) throw err(`Número inválido para ${tipo}: ${numero}.`);
    if ((tipo === 'play3' || tipo === 'play4') && modo && modo !== 'ST' && modo !== 'BX') throw err('Modo inválido (solo ST o BX).');
    return { tipo, numero, modo: modo || null, monto };
  });
}

async function generarCodigo() {
  const alfabeto = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // sin 0/O ni 1/I
  for (let intento = 0; intento < 20; intento++) {
    let codigo = '';
    for (let i = 0; i < 6; i++) codigo += alfabeto[crypto.randomInt(alfabeto.length)];
    const existe = await db.prepare('SELECT 1 FROM tickets WHERE codigo = ?').get(codigo);
    if (!existe) return codigo;
  }
  throw err('No se pudo generar el código del ticket. Inténtalo de nuevo.');
}

// ---------------------------------------------------------------------------
// Acciones
// ---------------------------------------------------------------------------
const actions = {
  async login(args) {
    requireFields(args, ['usuario', 'contrasena']);
    const u = await db.prepare('SELECT * FROM usuarios WHERE usuario = ?').get(args.usuario);
    if (!u || u.contrasena !== sha256(args.contrasena) || !u.activo) {
      throw err('Usuario o contraseña incorrectos.');
    }
    const token = crypto.randomBytes(32).toString('hex');
    const ahora = sdNow();
    await db.prepare('INSERT INTO sesiones (token, usuario_id, creado_en) VALUES (?, ?, ?)')
      .run(token, u.id, `${ahora.fecha} ${ahora.hora}`);
    return { token, usuario: { id: u.id, nombre: u.nombre, usuario: u.usuario, rol: u.rol, banca: u.nombre } };
  },

  async getLoterias(args) {
    const u = await getUsuarioByToken(args.token);
    void u;
    const { hhmm } = sdNow();
    const loterias = (await db.prepare('SELECT * FROM loterias ORDER BY orden').all()).map((l) => {
      const abierta = loteriaAbierta(l, hhmm);
      return {
        id: l.id, nombre: l.nombre, abre: l.abre, cierra: l.cierra, abierta,
        abreTexto: abierta ? `Abre a las ${fmt12(l.abre)}` : `Cerrada · abre ${fmt12(l.abre)}`,
      };
    });
    return { loterias };
  },

  async createTicket(args) {
    const u = await getUsuarioByToken(args.token);
    requireFields(args, ['loteriaId', 'jugadas']);
    const lot = await db.prepare('SELECT * FROM loterias WHERE id = ?').get(args.loteriaId);
    if (!lot) throw err('Lotería no encontrada.');
    const { fecha, hora, hhmm } = sdNow();
    if (!loteriaAbierta(lot, hhmm)) {
      throw err(`La lotería ${lot.nombre} está cerrada. Abre a las ${fmt12(lot.abre)} y cierra a las ${fmt12(lot.cierra)}.`);
    }
    const jugadas = validarJugadas(args.jugadas);
    const total = jugadas.reduce((s, j) => s + j.monto, 0);
    const banca = u.nombre;
    const ins = db.prepare(`INSERT INTO tickets (folio, codigo, loteria_id, usuario_id, banca, fecha, hora, total, estado)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'activo')`);
    // El folio es MAX+1. Si dos banqueras venden en el mismo instante, ambas
    // leen el mismo MAX y una choca con el UNIQUE: reintentar con el siguiente.
    let r;
    for (let intento = 0; intento < 5; intento++) {
      const codigo = await generarCodigo();
      const maxFolio = (await db.prepare('SELECT MAX(CAST(folio AS INTEGER)) m FROM tickets').get())?.m;
      const folio = String((maxFolio || 0) + 1).padStart(6, '0');
      try {
        r = await ins.run(folio, codigo, lot.id, u.id, banca, fecha, hora, total);
        break;
      } catch (e) {
        const esChoque = /UNIQUE constraint/i.test(String((e && e.message) || ''));
        if (!esChoque) throw e;
        if (intento === 4) throw err('No se pudo guardar el ticket. Inténtalo de nuevo.');
      }
    }
    const insJ = db.prepare('INSERT INTO jugadas (ticket_id, tipo, numero, modo, monto) VALUES (?, ?, ?, ?, ?)');
    for (const j of jugadas) await insJ.run(r.lastInsertRowid, j.tipo, j.numero, j.modo, j.monto);
    const ticket = await ticketConJugadas(await db.prepare('SELECT * FROM tickets WHERE id = ?').get(r.lastInsertRowid));
    return { ticket };
  },

  async listTickets(args) {
    const u = await getUsuarioByToken(args.token);
    const { fecha: hoy } = sdNow();
    const desde = args.desde || hoy, hasta = args.hasta || hoy;
    const bw = bancaWhere(u);
    const rows = await db.prepare(`SELECT t.* FROM tickets t WHERE t.fecha BETWEEN ? AND ? ${bw.sql} ORDER BY t.fecha DESC, t.id DESC`)
      .all(desde, hasta, ...bw.params);
    return { tickets: await Promise.all(rows.map(ticketConJugadas)) };
  },

  async getUltimoTicket(args) {
    const u = await getUsuarioByToken(args.token);
    const bw = bancaWhere(u);
    const row = await db.prepare(`SELECT t.* FROM tickets t WHERE 1=1 ${bw.sql} ORDER BY t.id DESC LIMIT 1`).get(...bw.params);
    return { ticket: row ? await ticketConJugadas(row) : null };
  },

  async _anular(args) {
    const u = await getUsuarioByToken(args.token);
    requireFields(args, ['folio', 'codigo']);
    const row = await db.prepare('SELECT * FROM tickets WHERE folio = ?').get(String(args.folio));
    if (!row) throw err('Ticket no encontrado.');
    if (!isDueno(u) && row.usuario_id !== u.id) throw err('Este ticket no es de tu banca.');
    if (row.codigo !== String(args.codigo)) throw err('El código no coincide con el ticket.');
    if (row.estado === 'pagado') throw err('Ya está pagado.');
    if (row.estado === 'anulado') throw err('Este ticket ya está anulado.');
    await db.prepare("UPDATE tickets SET estado = 'anulado' WHERE id = ?").run(row.id);
    return { ticket: await ticketConJugadas(await db.prepare('SELECT * FROM tickets WHERE id = ?').get(row.id)) };
  },
  async voidTicket(args) { return actions._anular(args); },
  async voidTicketByFolio(args) { return actions._anular(args); },

  async payTicket(args) {
    const u = await getUsuarioByToken(args.token);
    requireFields(args, ['folio', 'codigo']);
    const row = await db.prepare('SELECT * FROM tickets WHERE folio = ?').get(String(args.folio));
    if (!row) throw err('Ticket no encontrado.');
    if (!isDueno(u) && row.usuario_id !== u.id) throw err('Este ticket no es de tu banca.');
    if (row.codigo !== String(args.codigo)) throw err('El código no coincide con el ticket.');
    if (row.estado === 'anulado') throw err('Este ticket está anulado.');
    if (row.estado === 'pagado') throw err('Ya está pagado.');
    const { total: premio } = await premioTicket(row.id, row.loteria_id, row.fecha);
    if (premio <= 0) throw err('Este ticket no tiene premio.');
    const { fecha, hora } = sdNow();
    await db.prepare("UPDATE tickets SET estado = 'pagado', pagado_at = ? WHERE id = ?").run(`${fecha} ${hora}`, row.id);
    return { ticket: await ticketConJugadas(await db.prepare('SELECT * FROM tickets WHERE id = ?').get(row.id)), premio };
  },

  async getResultados(args) {
    const u = await getUsuarioByToken(args.token);
    void u;
    const fecha = args.fecha || sdNow().fecha;
    const rows = await db.prepare(`SELECT r.*, l.nombre AS loteria FROM resultados r
      JOIN loterias l ON l.id = r.loteria_id WHERE r.fecha = ? ORDER BY l.orden`).all(fecha);
    return { resultados: rows.map((r) => ({ id: r.id, loteriaId: r.loteria_id, loteria: r.loteria, fecha: r.fecha, primera: r.primera, segunda: r.segunda, tercera: r.tercera })) };
  },

  async saveResultado(args) {
    const u = await getUsuarioByToken(args.token);
    requireDueno(u);
    requireFields(args, ['loteriaId', 'fecha', 'primera', 'segunda', 'tercera']);
    const lot = await db.prepare('SELECT * FROM loterias WHERE id = ?').get(args.loteriaId);
    if (!lot) throw err('Lotería no encontrada.');
    for (const k of ['primera', 'segunda', 'tercera']) {
      if (!/^\d{2}$/.test(String(args[k]))) throw err(`El número ${k} debe tener 2 dígitos (00-99).`);
    }
    await db.prepare(`INSERT INTO resultados (loteria_id, fecha, primera, segunda, tercera) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(loteria_id, fecha) DO UPDATE SET primera = excluded.primera, segunda = excluded.segunda, tercera = excluded.tercera`)
      .run(args.loteriaId, args.fecha, args.primera, args.segunda, args.tercera);
    const row = await db.prepare('SELECT * FROM resultados WHERE loteria_id = ? AND fecha = ?').get(args.loteriaId, args.fecha);
    return { resultado: { id: row.id, loteriaId: row.loteria_id, loteria: lot.nombre, fecha: row.fecha, primera: row.primera, segunda: row.segunda, tercera: row.tercera } };
  },

  async deleteResultado(args) {
    const u = await getUsuarioByToken(args.token);
    requireDueno(u);
    requireFields(args, ['id']);
    const r = await db.prepare('DELETE FROM resultados WHERE id = ?').run(args.id);
    if (r.changes === 0) throw err('Resultado no encontrado.');
    return {};
  },

  async getPremiados(args) {
    const u = await getUsuarioByToken(args.token);
    const fecha = args.fecha || sdNow().fecha;
    const bw = bancaWhere(u);
    const rows = await db.prepare(`SELECT t.* FROM tickets t WHERE t.fecha = ? AND t.estado != 'anulado' ${bw.sql} ORDER BY t.id DESC`)
      .all(fecha, ...bw.params);
    const premiados = [];
    for (const row of rows) {
      const { total, jugadas } = await premioTicket(row.id, row.loteria_id, row.fecha);
      if (total > 0) premiados.push({ ticket: await ticketConJugadas(row), jugadas, total_premio: total });
    }
    return { premiados };
  },

  async getEfectivo(args) {
    const u = await getUsuarioByToken(args.token);
    const fecha = args.fecha || sdNow().fecha;
    const bw = bancaWhere(u);
    const rows = await db.prepare(`SELECT t.* FROM tickets t WHERE t.fecha = ? ${bw.sql}`).all(fecha, ...bw.params);
    let vendido = 0, premios = 0, numTickets = 0, numPagados = 0, totalPagado = 0;
    for (const row of rows) {
      if (row.estado === 'anulado') continue;
      vendido += row.total;
      numTickets += 1;
      const { total: premio } = await premioTicket(row.id, row.loteria_id, row.fecha);
      premios += premio;
      if (row.estado === 'pagado') { numPagados += 1; totalPagado += premio; }
    }
    return { vendido, premios, balance: vendido - premios, numTickets, numPagados, totalPagado };
  },

  async getResumen(args) {
    const u = await getUsuarioByToken(args.token);
    const { fecha: hoy } = sdNow();
    const desde = args.desde || hoy, hasta = args.hasta || hoy;
    const bw = bancaWhere(u);
    const rows = await db.prepare(`SELECT t.* FROM tickets t WHERE t.fecha BETWEEN ? AND ? ${bw.sql}`).all(desde, hasta, ...bw.params);
    let total_vendido = 0, total_pagado = 0, num_tickets = 0;
    const porLot = new Map(), porBan = new Map();
    for (const row of rows) {
      if (row.estado === 'anulado') continue;
      num_tickets += 1;
      total_vendido += row.total;
      const { total: premio } = await premioTicket(row.id, row.loteria_id, row.fecha);
      total_pagado += premio;
      const lot = await db.prepare('SELECT nombre FROM loterias WHERE id = ?').get(row.loteria_id);
      const ln = lot ? lot.nombre : '—';
      const pl = porLot.get(ln) || { loteria: ln, numTickets: 0, total: 0 };
      pl.numTickets += 1; pl.total += row.total; porLot.set(ln, pl);
      const pb = porBan.get(row.banca) || { banca: row.banca, total_vendido: 0, total_pagado: 0, total_neto: 0 };
      pb.total_vendido += row.total; pb.total_pagado += premio; porBan.set(row.banca, pb);
    }
    const por_banca = [...porBan.values()].map((b) => ({ ...b, total_neto: b.total_vendido - b.total_pagado }));
    return {
      total_vendido, total_pagado, total_neto: total_vendido - total_pagado, num_tickets,
      por_loteria: [...porLot.values()], por_banca,
    };
  },

  async createRecarga(args) {
    const u = await getUsuarioByToken(args.token);
    requireFields(args, ['monto']);
    const monto = Number(args.monto);
    if (!Number.isInteger(monto) || monto <= 0) throw err('El monto debe ser mayor que 0.');
    const { fecha, hora } = sdNow();
    const r = await db.prepare('INSERT INTO recargas (usuario_id, banca, monto, nota, fecha, hora) VALUES (?, ?, ?, ?, ?, ?)')
      .run(u.id, u.nombre, monto, args.nota || null, fecha, hora);
    const row = await db.prepare('SELECT * FROM recargas WHERE id = ?').get(r.lastInsertRowid);
    return { recarga: { id: row.id, monto: row.monto, nota: row.nota, fecha: row.fecha, hora: row.hora, banca: row.banca } };
  },

  async listRecargas(args) {
    const u = await getUsuarioByToken(args.token);
    const { fecha: hoy } = sdNow();
    const desde = args.desde || hoy, hasta = args.hasta || hoy;
    const where = isDueno(u) ? '' : ' AND usuario_id = ?';
    const params = isDueno(u) ? [desde, hasta] : [desde, hasta, u.id];
    const rows = await db.prepare(`SELECT * FROM recargas WHERE fecha BETWEEN ? AND ? ${where} ORDER BY fecha DESC, id DESC`).all(...params);
    return { recargas: rows.map((r) => ({ id: r.id, monto: r.monto, nota: r.nota, fecha: r.fecha, hora: r.hora, banca: r.banca })) };
  },

  async getAjustes(args) {
    const u = await getUsuarioByToken(args.token);
    void u;
    const rows = await db.prepare('SELECT clave, valor FROM ajustes').all();
    const ajustes = {};
    for (const r of rows) ajustes[r.clave] = r.valor;
    return { ajustes };
  },

  async saveAjustes(args) {
    const u = await getUsuarioByToken(args.token);
    requireDueno(u);
    if (!args.ajustes || typeof args.ajustes !== 'object') throw err('Faltan los ajustes.');
    const up = db.prepare('INSERT INTO ajustes (clave, valor) VALUES (?, ?) ON CONFLICT(clave) DO UPDATE SET valor = excluded.valor');
    for (const [k, v] of Object.entries(args.ajustes)) await up.run(k, String(v));
    return {};
  },

  async createBanquera(args) {
    const u = await getUsuarioByToken(args.token);
    requireDueno(u);
    requireFields(args, ['nombreBanca', 'usuario', 'contrasena']);
    const existe = await db.prepare('SELECT 1 FROM usuarios WHERE usuario = ?').get(args.usuario);
    if (existe) throw err('Ese usuario ya existe.');
    const ahora = sdNow();
    const r = await db.prepare(`INSERT INTO usuarios (nombre, usuario, contrasena, rol, activo, creado_en)
      VALUES (?, ?, ?, 'banquera', 1, ?)`).run(args.nombreBanca, args.usuario, sha256(args.contrasena), `${ahora.fecha} ${ahora.hora}`);
    const row = await db.prepare('SELECT id, nombre, usuario, activo FROM usuarios WHERE id = ?').get(r.lastInsertRowid);
    return { banquera: row };
  },

  async listBanqueras(args) {
    const u = await getUsuarioByToken(args.token);
    requireDueno(u);
    const rows = await db.prepare("SELECT id, nombre, usuario, activo FROM usuarios WHERE rol = 'banquera' ORDER BY id").all();
    return { banqueras: rows };
  },

  async updateBanquera(args) {
    const u = await getUsuarioByToken(args.token);
    requireDueno(u);
    requireFields(args, ['id']);
    const b = await db.prepare("SELECT * FROM usuarios WHERE id = ? AND rol = 'banquera'").get(args.id);
    if (!b) throw err('Banquera no encontrada.');
    if (args.usuario && args.usuario !== b.usuario) {
      const existe = await db.prepare('SELECT 1 FROM usuarios WHERE usuario = ?').get(args.usuario);
      if (existe) throw err('Ese usuario ya existe.');
      await db.prepare('UPDATE usuarios SET usuario = ? WHERE id = ?').run(args.usuario, b.id);
    }
    if (args.contrasena) await db.prepare('UPDATE usuarios SET contrasena = ? WHERE id = ?').run(sha256(args.contrasena), b.id);
    if (args.nombre) await db.prepare('UPDATE usuarios SET nombre = ? WHERE id = ?').run(args.nombre, b.id);
    if (args.activo !== undefined && args.activo !== null) {
      await db.prepare('UPDATE usuarios SET activo = ? WHERE id = ?').run(args.activo ? 1 : 0, b.id);
    }
    return {};
  },

  async updateMiCuenta(args) {
    const u = await getUsuarioByToken(args.token);
    requireDueno(u);
    if (args.usuario && args.usuario !== u.usuario) {
      const existe = await db.prepare('SELECT 1 FROM usuarios WHERE usuario = ?').get(args.usuario);
      if (existe) throw err('Ese usuario ya existe.');
      await db.prepare('UPDATE usuarios SET usuario = ? WHERE id = ?').run(args.usuario, u.id);
    }
    if (args.contrasena) await db.prepare('UPDATE usuarios SET contrasena = ? WHERE id = ?').run(sha256(args.contrasena), u.id);
    if (args.nombre) await db.prepare('UPDATE usuarios SET nombre = ? WHERE id = ?').run(args.nombre, u.id);
    const row = await db.prepare('SELECT id, nombre, usuario, rol, activo FROM usuarios WHERE id = ?').get(u.id);
    return { usuario: { id: row.id, nombre: row.nombre, usuario: row.usuario, rol: row.rol, banca: row.nombre } };
  },
};

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.webmanifest': 'application/manifest+json',
  '.txt': 'text/plain; charset=utf-8',
};

function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(body);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (req.method === 'POST' && url.pathname === '/actions') {
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 1_000_000) req.destroy(); });
    req.on('end', async () => {
      let payload;
      try { payload = JSON.parse(body || '{}'); } catch { return sendJson(res, 400, { ok: false, error: 'Cuerpo JSON inválido.' }); }
      const fn = actions[payload.action];
      if (!fn) return sendJson(res, 400, { ok: false, error: `Acción desconocida: ${payload.action}` });
      try {
        const out = await fn(payload.args || {});
        sendJson(res, 200, { ok: true, ...out });
      } catch (e) {
        sendJson(res, 200, { ok: false, error: e.message || 'Error interno.' });
      }
    });
    return;
  }
  if (req.method === 'GET') {
    // Estáticos de ../client/
    let rel = decodeURIComponent(url.pathname);
    if (rel === '/') rel = '/index.html';
    const safe = path.normalize(rel).replace(/^(\.\.[\/\\])+/, '');
    const file = path.join(CLIENT_DIR, safe);
    if (!file.startsWith(CLIENT_DIR)) { res.writeHead(403); return res.end('Prohibido'); }
    fs.readFile(file, (e, data) => {
      if (e) { res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }); return res.end('No encontrado'); }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
      res.end(data);
    });
    return;
  }
  res.writeHead(404); res.end('No encontrado');
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Banca de Lotería escuchando en 0.0.0.0:${PORT} (DB: ${TURSO_URL ? 'Turso remoto' : DB_PATH})`);
});
