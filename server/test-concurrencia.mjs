// Prueba de concurrencia: 20 ventas simultáneas deben dar 20 folios distintos.
// Usa base aparte y puerto 18081. Borra la base al final.
// Ejecución: node test-concurrencia.mjs
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createClient } from '@libsql/client';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, 'banca.conc.db');
const PORT = 18081;
const BASE = `http://127.0.0.1:${PORT}/actions`;

for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
  try { fs.unlinkSync(f); } catch {}
}

const server = spawn('node', ['server.js'], {
  cwd: __dirname,
  env: { ...process.env, DB_PATH: TEST_DB, PORT: String(PORT) },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function call(action, args = {}) {
  const r = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, args }) });
  return r.json();
}

async function main() {
  // Esperar a que arranque
  for (let i = 0; i < 50; i++) {
    try { const r = await call('login', { usuario: 'admin', contrasena: 'admin' }); if (r.ok) break; } catch {}
    await sleep(200);
  }
  // Forzar una lotería abierta a esta hora (00:00-23:59) para poder vender de noche.
  const db = createClient({ url: 'file:' + TEST_DB });
  await db.execute({ sql: 'UPDATE loterias SET abre = ?, cierra = ? WHERE nombre = ?', args: ['00:00', '23:59', 'Loteka Noche'] });
  db.close();

  const login = await call('login', { usuario: 'admin', contrasena: 'admin' });
  if (!login.ok) { console.log('LOGIN FALLÓ', login); process.exit(1); }
  const T = login.token;
  const lots = await call('getLoterias', { token: T });
  const lot = lots.loterias.find((l) => l.nombre === 'Loteka Noche');
  console.log('Loteka Noche abierta:', lot.abierta);

  // 20 ventas simultáneas
  const N = 20;
  const resultados = await Promise.all(
    Array.from({ length: N }, (_, i) =>
      call('createTicket', { token: T, loteriaId: lot.id, jugadas: [{ tipo: 'quiniela', numero: String(10 + i).padStart(2, '0'), monto: 10 }] })
    )
  );
  const ok = resultados.filter((r) => r.ok);
  const fallos = resultados.filter((r) => !r.ok);
  const folios = ok.map((r) => r.ticket.folio);
  const unicos = new Set(folios);
  console.log(`Ventas OK: ${ok.length}/${N} | Fallos: ${fallos.length} | Folios únicos: ${unicos.size}`);
  console.log('Folios:', [...unicos].sort().join(', '));
  if (fallos.length) console.log('Errores:', JSON.stringify(fallos.slice(0, 3)));
  const bien = ok.length === N && unicos.size === N;
  console.log(bien ? 'CONCURRENCIA OK: 20 ventas, 20 folios distintos, 0 fallos.' : 'CONCURRENCIA FALLÓ.');
  server.kill();
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) {
    try { fs.unlinkSync(f); } catch {}
  }
  process.exit(bien ? 0 : 1);
}
main().catch((e) => { console.error(e); server.kill(); process.exit(1); });
