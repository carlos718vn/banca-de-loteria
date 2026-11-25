// Suite de pruebas del servidor Banca de Lotería.
// Usa base aparte banca.test.db (DB_PATH) y puerto 18080. NO toca banca.db.
// Ejecución: node test.mjs   (levanta el servidor, prueba, lo apaga, borra la base de pruebas)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEST_DB = path.join(__dirname, 'banca.test.db');
const PORT = 18080;
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

let passed = 0, failed = 0;
function check(name, cond, extra = '') {
  if (cond) { passed++; console.log(`  PASS ${name}${extra ? ' — ' + extra : ''}`); }
  else { failed++; console.log(`  FAIL ${name}${extra ? ' — ' + extra : ''}`); }
}
async function call(action, args = {}) {
  const r = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, args }) });
  return r.json();
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // Esperar a que arranque
  for (let i = 0; i < 50; i++) {
    try { const r = await call('login', { usuario: 'admin', contrasena: 'admin' }); if (r.ok) break; } catch {}
    await sleep(200);
  }
  console.log('== login ==');
  const bad = await call('login', { usuario: 'admin', contrasena: 'mala' });
  check('login contraseña mala rechazado', bad.ok === false && /incorrectos/.test(bad.error || ''), JSON.stringify(bad));
  const noUser = await call('login', { usuario: 'nadie', contrasena: 'x' });
  check('login usuario inexistente rechazado', noUser.ok === false, JSON.stringify(noUser));
  const login = await call('login', { usuario: 'admin', contrasena: 'admin' });
  check('login admin/admin ok', login.ok === true && login.usuario?.rol === 'dueno', JSON.stringify(login.usuario));
  const T = login.token;
  const noToken = await call('getLoterias', {});
  check('sin token rechazado', noToken.ok === false, JSON.stringify(noToken));

  console.log('== loterías ==');
  const lots = await call('getLoterias', { token: T });
  check('getLoterias ok, 35 loterías (20 + 15 Anguila)', lots.ok && lots.loterias?.length === 35, `n=${lots.loterias?.length}`);
  const abierta = lots.loterias.find((l) => l.abierta);
  const cerrada = lots.loterias.find((l) => !l.abierta);
  check('hay al menos una lotería abierta', !!abierta, abierta?.nombre);
  check('hay al menos una lotería cerrada', !!cerrada, cerrada?.nombre);
  const anguila = lots.loterias.filter((l) => l.nombre.startsWith('Anguila'));
  check('15 sorteos de Anguila', anguila.length === 15, `n=${anguila.length}`);
  check('no existe LEIDSA Día', !lots.loterias.some((l) => /LEIDSA Día/i.test(l.nombre)));

  console.log('== ventas ==');
  const L = abierta.id;
  const hoy = new Date().toLocaleDateString('en-CA', { timeZone: 'America/Santo_Domingo' });
  async function vender(jugadas) {
    return call('createTicket', { token: T, loteriaId: L, jugadas });
  }
  const tQuin = await vender([{ tipo: 'quiniela', numero: '07', monto: 10 }]);
  check('vender quiniela 07 $10', tQuin.ok && tQuin.ticket.folio === '000001', JSON.stringify(tQuin.ticket?.folio));
  const tPale = await vender([{ tipo: 'pale', numero: '0715', monto: 2 }]);
  check('vender palé 07-15 $2', tPale.ok && tPale.ticket.folio === '000002', JSON.stringify(tPale.ticket?.folio));
  const tTrip = await vender([{ tipo: 'tripleta', numero: '071523', monto: 1 }]);
  check('vender tripleta 07-15-23 $1', tTrip.ok, JSON.stringify(tTrip.ticket?.folio));
  const tTrip2 = await vender([{ tipo: 'tripleta', numero: '071599', monto: 1 }]);
  check('vender tripleta 07-15-99 $1', tTrip2.ok, JSON.stringify(tTrip2.ticket?.folio));
  const tPale2 = await vender([{ tipo: 'pale', numero: '0799', monto: 2 }]);
  check('vender palé 07-99 $2', tPale2.ok, JSON.stringify(tPale2.ticket?.folio));
  const tQuin70 = await vender([{ tipo: 'quiniela', numero: '70', monto: 5 }]);
  check('vender quiniela 70 $5', tQuin70.ok, JSON.stringify(tQuin70.ticket?.folio));
  const cerrado = await call('createTicket', { token: T, loteriaId: cerrada.id, jugadas: [{ tipo: 'quiniela', numero: '07', monto: 10 }] });
  check('lotería cerrada rechazada', cerrado.ok === false && /cerrada/.test(cerrado.error || ''), cerrado.error);
  const monto0 = await vender([{ tipo: 'quiniela', numero: '07', monto: 0 }]);
  check('monto 0 rechazado', monto0.ok === false, monto0.error);
  const digMal = await vender([{ tipo: 'quiniela', numero: '0715', monto: 5 }]);
  check('quiniela con 4 dígitos rechazada', digMal.ok === false, digMal.error);
  const play3 = await vender([{ tipo: 'play3', numero: '123', modo: 'ST', monto: 5 }]);
  check('vender Play 3 123 ST $5 (premio por confirmar)', play3.ok, JSON.stringify(play3.ticket?.folio));
  const ult = await call('getUltimoTicket', { token: T });
  check('getUltimoTicket = Play 3', ult.ok && ult.ticket?.folio === play3.ticket.folio, ult.ticket?.folio);

  console.log('== resultados y premiados ==');
  const res = await call('saveResultado', { token: T, loteriaId: L, fecha: hoy, primera: '07', segunda: '15', tercera: '23' });
  check('saveResultado 07/15/23', res.ok === true, JSON.stringify(res.resultado));
  const resMal = await call('saveResultado', { token: T, loteriaId: L, fecha: hoy, primera: '7', segunda: '15', tercera: '23' });
  check('saveResultado con 1 dígito rechazado', resMal.ok === false, resMal.error);
  const prem = await call('getPremiados', { token: T, fecha: hoy });
  const porFolio = {};
  for (const p of prem.premiados || []) porFolio[p.ticket.folio] = p;
  check('getPremiados ok', prem.ok === true, `n=${prem.premiados?.length}`);
  check('quiniela 07 $10 -> $800', porFolio['000001']?.total_premio === 800, `salió ${porFolio['000001']?.total_premio}`);
  check('palé 07-15 $2 -> $3,000', porFolio['000002']?.total_premio === 3000, `salió ${porFolio['000002']?.total_premio}`);
  check('tripleta 07-15-23 $1 -> $20,000', porFolio['000003']?.total_premio === 20000, `salió ${porFolio['000003']?.total_premio}`);
  check('tripleta 07-15-99 $1 -> $500 (dos patas 1ra+2da)', porFolio['000004']?.total_premio === 500, `salió ${porFolio['000004']?.total_premio}`);
  check('palé 07-99 NO premiado', !porFolio['000005'], 'no debe aparecer');
  check('quiniela 70 NO premiada', !porFolio['000006'], 'no debe aparecer');
  check('Play 3 NO premiado (por confirmar)', !Object.values(porFolio).some((p) => p.ticket.folio === play3.ticket.folio), 'no debe aparecer');
  check('detalle quiniela', porFolio['000001']?.jugadas?.[0]?.detalle === 'Quiniela en 1ra', porFolio['000001']?.jugadas?.[0]?.detalle);

  console.log('== pagar / anular ==');
  const payMal = await call('payTicket', { token: T, folio: '000001', codigo: 'XXXXXX' });
  check('pagar con código malo rechazado', payMal.ok === false && /código/.test(payMal.error || ''), payMal.error);
  const pay = await call('payTicket', { token: T, folio: '000001', codigo: tQuin.ticket.codigo });
  check('pagar quiniela 07 -> premio $800', pay.ok && pay.premio === 800 && pay.ticket.estado === 'pagado', `premio=${pay.premio}`);
  const pay2 = await call('payTicket', { token: T, folio: '000001', codigo: tQuin.ticket.codigo });
  check('segundo pago rechazado (Ya está pagado)', pay2.ok === false && /Ya está pagado/.test(pay2.error || ''), pay2.error);
  const paySin = await call('payTicket', { token: T, folio: '000006', codigo: tQuin70.ticket.codigo });
  check('pagar ticket sin premio rechazado', paySin.ok === false && /no tiene premio/.test(paySin.error || ''), paySin.error);
  const voidMal = await call('voidTicket', { token: T, folio: '000006', codigo: 'XXXXXX' });
  check('anular con código malo rechazado', voidMal.ok === false, voidMal.error);
  const voidOk = await call('voidTicketByFolio', { token: T, folio: '000006', codigo: tQuin70.ticket.codigo });
  check('anular quiniela 70 con código correcto (alias voidTicketByFolio)', voidOk.ok && voidOk.ticket.estado === 'anulado', voidOk.ticket?.estado);
  const voidPagado = await call('voidTicket', { token: T, folio: '000001', codigo: tQuin.ticket.codigo });
  check('anular ticket pagado rechazado', voidPagado.ok === false && /Ya está pagado/.test(voidPagado.error || ''), voidPagado.error);

  console.log('== efectivo y resumen ==');
  // Vendidos (activos+pagados, sin anulado): 10+2+1+1+2+5(Play3)=21. Premios: 800+3000+20000+500=24300.
  const ef = await call('getEfectivo', { token: T, fecha: hoy });
  check('getEfectivo vendido = 21', ef.ok && ef.vendido === 21, `vendido=${ef.vendido}`);
  check('getEfectivo premios = 24300', ef.premios === 24300, `premios=${ef.premios}`);
  check('getEfectivo balance = 21-24300 = -24279', ef.balance === -24279, `balance=${ef.balance}`);
  check('getEfectivo numTickets=6, numPagados=1, totalPagado=800', ef.numTickets === 6 && ef.numPagados === 1 && ef.totalPagado === 800, JSON.stringify(ef));
  const resum = await call('getResumen', { token: T, desde: hoy, hasta: hoy });
  check('getResumen total_vendido=21, total_pagado=24300, total_neto=-24279, num_tickets=6',
    resum.total_vendido === 21 && resum.total_pagado === 24300 && resum.total_neto === -24279 && resum.num_tickets === 6,
    JSON.stringify({ tv: resum.total_vendido, tp: resum.total_pagado, tn: resum.total_neto, n: resum.num_tickets }));
  check('getResumen por_loteria suma 21', resum.por_loteria?.reduce((s, x) => s + x.total, 0) === 21, JSON.stringify(resum.por_loteria));

  console.log('== recargas y ajustes ==');
  const rec = await call('createRecarga', { token: T, monto: 500, nota: 'prueba' });
  check('createRecarga $500', rec.ok === true, JSON.stringify(rec.recarga));
  const lrec = await call('listRecargas', { token: T, desde: hoy, hasta: hoy });
  check('listRecargas trae 1', lrec.ok && lrec.recargas?.length === 1, `n=${lrec.recargas?.length}`);
  const aj = await call('getAjustes', { token: T });
  check('getAjustes nombre_banca=Mi Banca, ancho 58', aj.ok && aj.ajustes?.nombre_banca === 'Mi Banca' && aj.ajustes?.ancho_papel === '58', JSON.stringify(aj.ajustes));
  const saj = await call('saveAjustes', { token: T, ajustes: { telefono: '809-555-0100' } });
  check('saveAjustes ok', saj.ok === true, JSON.stringify(saj));

  console.log('== banqueras y roles ==');
  const cb = await call('createBanquera', { token: T, nombreBanca: 'Banca María', usuario: 'maria', contrasena: '1234' });
  check('createBanquera María', cb.ok === true, JSON.stringify(cb.banquera));
  const lb = await call('listBanqueras', { token: T });
  check('listBanqueras trae a María', lb.ok && lb.banqueras?.some((b) => b.usuario === 'maria'), JSON.stringify(lb.banqueras));
  const loginB = await call('login', { usuario: 'maria', contrasena: '1234' });
  check('login banquera maria ok', loginB.ok && loginB.usuario?.rol === 'banquera', JSON.stringify(loginB.usuario));
  const TB = loginB.token;
  const bSaveRes = await call('saveResultado', { token: TB, loteriaId: L, fecha: hoy, primera: '01', segunda: '02', tercera: '03' });
  check('banquera NO puede saveResultado', bSaveRes.ok === false, bSaveRes.error);
  const bListB = await call('listBanqueras', { token: TB });
  check('banquera NO puede listBanqueras', bListB.ok === false, bListB.error);
  const bSaveAj = await call('saveAjustes', { token: TB, ajustes: { telefono: 'x' } });
  check('banquera NO puede saveAjustes', bSaveAj.ok === false, bSaveAj.error);
  const bTickets = await call('listTickets', { token: TB, desde: hoy, hasta: hoy });
  check('banquera ve 0 tickets (solo su banca)', bTickets.ok && bTickets.tickets?.length === 0, `n=${bTickets.tickets?.length}`);
  const bVende = await call('createTicket', { token: TB, loteriaId: L, jugadas: [{ tipo: 'quiniela', numero: '07', monto: 20 }] });
  check('banquera vende quiniela 07 $20', bVende.ok === true, JSON.stringify(bVende.ticket?.folio));
  const bTickets2 = await call('listTickets', { token: TB, desde: hoy, hasta: hoy });
  check('banquera ahora ve solo su ticket (1)', bTickets2.ok && bTickets2.tickets?.length === 1 && bTickets2.tickets[0].banca === 'Banca María', `n=${bTickets2.tickets?.length}`);
  const aTickets = await call('listTickets', { token: T, desde: hoy, hasta: hoy });
  check('dueño ve todos (8 tickets)', aTickets.ok && aTickets.tickets?.length === 8, `n=${aTickets.tickets?.length}`);
  const bPayOtro = await call('payTicket', { token: TB, folio: '000002', codigo: tPale.ticket.codigo });
  check('banquera NO puede pagar ticket de otra banca', bPayOtro.ok === false, bPayOtro.error);
  // La banquera también gana con su quiniela 07 $20 -> $1600; el efectivo del dueño sube.
  const ef2 = await call('getEfectivo', { token: T, fecha: hoy });
  check('getEfectivo dueño tras venta banquera: vendido=41, premios=25900, balance=-25859',
    ef2.vendido === 41 && ef2.premios === 25900 && ef2.balance === -25859,
    `vendido=${ef2.vendido} premios=${ef2.premios} balance=${ef2.balance}`);
  const efB = await call('getEfectivo', { token: TB, fecha: hoy });
  check('getEfectivo banquera: vendido=20, premios=1600, balance=-1580',
    efB.vendido === 20 && efB.premios === 1600 && efB.balance === -1580,
    `vendido=${efB.vendido} premios=${efB.premios} balance=${efB.balance}`);

  console.log('== updateMiCuenta ==');
  const upd = await call('updateMiCuenta', { token: T, contrasena: 'nueva123' });
  check('updateMiCuenta cambia contraseña', upd.ok === true, JSON.stringify(upd.usuario));
  const loginVieja = await call('login', { usuario: 'admin', contrasena: 'admin' });
  check('contraseña vieja ya no entra', loginVieja.ok === false, JSON.stringify(loginVieja));
  const loginNueva = await call('login', { usuario: 'admin', contrasena: 'nueva123' });
  check('contraseña nueva entra', loginNueva.ok === true, JSON.stringify(loginNueva.usuario));
  const T2 = loginNueva.token;
  const updBack = await call('updateMiCuenta', { token: T2, contrasena: 'admin' });
  check('contraseña restaurada a admin', updBack.ok === true, JSON.stringify(updBack));
  const loginBack = await call('login', { usuario: 'admin', contrasena: 'admin' });
  check('login admin/admin de nuevo ok', loginBack.ok === true, '');

  console.log('== estáticos ==');
  const root = await fetch(`http://127.0.0.1:${PORT}/`);
  const clientExiste = fs.existsSync(path.join(__dirname, '..', 'client', 'index.html'));
  check('GET / responde 200 si existe client/index.html, 404 si no (sin caerse)',
    root.status === (clientExiste ? 200 : 404), `status=${root.status} clientExiste=${clientExiste}`);
  const act = await fetch(BASE, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'accionQueNoExiste', args: {} }) });
  const actJ = await act.json();
  check('acción desconocida -> ok:false', actJ.ok === false, JSON.stringify(actJ));

  console.log(`\nResultado: ${passed} PASS, ${failed} FAIL`);
  server.kill();
  await sleep(300);
  for (const f of [TEST_DB, TEST_DB + '-wal', TEST_DB + '-shm']) { try { fs.unlinkSync(f); } catch {} }
  // Verificar que banca.db de producción NO se tocó/creó por las pruebas
  const prodDb = path.join(__dirname, 'banca.db');
  console.log(`banca.db de producción existe tras las pruebas: ${fs.existsSync(prodDb)}`);
  process.exit(failed ? 1 : 0);
}

main().catch((e) => { console.error('ERROR TEST:', e); server.kill(); process.exit(1); });
