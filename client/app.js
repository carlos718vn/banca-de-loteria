/* Banca de Lotería — cliente de una sola página.
   Habla con el servidor SOLO por fetch relativo a ./actions.
   Sin librerías externas. */
'use strict';

/* ---------- Utilidades ---------- */
const $ = (id) => document.getElementById(id);
const fmt$ = (n) => '$' + Number(n || 0).toLocaleString('es-DO');
function hoyISO() {
  // Fecha de negocio en America/Santo_Domingo (UTC-4)
  const ahora = new Date(Date.now() - 4 * 3600 * 1000);
  return ahora.toISOString().slice(0, 10);
}
function fmtHora(hhmm) {
  if (!hhmm) return '';
  const [h, m] = hhmm.split(':').map(Number);
  const ap = h >= 12 ? 'PM' : 'AM';
  let hh = h % 12; if (hh === 0) hh = 12;
  return hh + ':' + String(m).padStart(2, '0') + ' ' + ap;
}
function mostrarMsg(el, texto, esError) {
  el.textContent = texto;
  el.className = esError ? 'error' : 'ok-msg';
  el.classList.remove('hidden');
}
function ocultarMsg(el) { el.classList.add('hidden'); el.textContent = ''; }
function esc(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

/* ---------- API ---------- */
async function api(action, args) {
  const cuerpo = { action, args: Object.assign({}, args || {}) };
  const token = localStorage.getItem('banca_token');
  if (token && action !== 'login') cuerpo.args.token = token;
  let resp;
  try {
    resp = await fetch('./actions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cuerpo),
    });
  } catch (e) {
    throw new Error('No hay conexión con el servidor. Revisa tu internet e inténtalo de nuevo.');
  }
  let data;
  try { data = await resp.json(); } catch (e) { throw new Error('El servidor respondió algo inesperado.'); }
  if (!data.ok) throw new Error(data.error || 'Error del servidor.');
  return data;
}

/* ---------- Estado ---------- */
let usuario = null;            // {id, nombre, usuario, rol, banca}
let loterias = [];
let loteriaSel = null;         // id de lotería seleccionada
let jugadas = [];              // jugadas del ticket en curso
let campoActivo = 'jugada';    // 'jugada' | 'monto'
let modoPlay = 'ST';           // ST | BX para Play 3 / Play 4
let ultimoTicket = null;
let timerAuto = null;

/* ---------- Sesión ---------- */
function guardarSesion(u, token) {
  usuario = u;
  localStorage.setItem('banca_token', token);
  localStorage.setItem('banca_usuario', JSON.stringify(u));
}
function cerrarSesion() {
  usuario = null;
  localStorage.removeItem('banca_token');
  localStorage.removeItem('banca_usuario');
  if (timerAuto) { clearInterval(timerAuto); timerAuto = null; }
  $('view-app').classList.add('hidden');
  $('view-login').classList.remove('hidden');
  $('loginContrasena').value = '';
}
async function restaurarSesion() {
  const tok = localStorage.getItem('banca_token');
  const u = localStorage.getItem('banca_usuario');
  if (!tok || !u) return;
  try {
    usuario = JSON.parse(u);
    await api('getLoterias'); // valida el token
    entrarApp();
  } catch (e) {
    cerrarSesion();
  }
}

function entrarApp() {
  $('view-login').classList.add('hidden');
  $('view-app').classList.remove('hidden');
  $('nombreBanca').textContent = usuario.rol === 'dueno'
    ? 'Dueño · ' + (usuario.nombre || '')
    : (usuario.banca || usuario.nombre || '');
  $('drawerUsuario').textContent = usuario.usuario + ' · ' + (usuario.rol === 'dueno' ? 'Dueño' : 'Banquera');
  construirMenuLateral();
  if (usuario.rol === 'dueno') {
    $('vistaBanquera').classList.add('hidden');
    $('vistaDueno').classList.remove('hidden');
    $('btnPuntos').classList.add('hidden');
    cargarDuenoResultados();
    cargarBanqueras();
    $('miNombre').value = usuario.nombre || '';
    $('miUsuario').value = usuario.usuario || '';
  } else {
    $('vistaDueno').classList.add('hidden');
    $('vistaBanquera').classList.remove('hidden');
    $('btnPuntos').classList.remove('hidden');
    mostrarSeccion('venta');
    cargarLoterias();
    refrescarCuadroVerde();
    const f = $('fechaResultados'); if (!f.value) f.value = hoyISO();
    const d = $('ventasDesde'); if (!d.value) d.value = hoyISO();
    const h = $('ventasHasta'); if (!h.value) h.value = hoyISO();
    if (timerAuto) clearInterval(timerAuto);
    timerAuto = setInterval(() => {
      if (usuario && usuario.rol !== 'dueno') {
        refrescarCuadroVerde();
        cargarLoterias(true);
      }
    }, 15000);
  }
}

/* ---------- Menú lateral ---------- */
function construirMenuLateral() {
  const nav = $('drawerNav');
  const items = usuario.rol === 'dueno'
    ? [['resultados', 'Números ganadores'], ['banqueras', 'Banqueras'], ['micuenta', 'Mi cuenta'], ['salir', 'Salir']]
    : [['venta', 'Lotería'], ['tickets', 'Tickets'], ['premiados', 'Tickets Premiados'],
       ['resultados', 'Números Ganadores'], ['ventas', 'Ventas'], ['efectivo', 'Efectivo'],
       ['cuadre', 'Cuadre General'], ['ayuda', 'Ayuda'], ['salir', 'Salir']];
  nav.innerHTML = '';
  items.forEach(([clave, texto]) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = texto;
    b.dataset.seccion = clave;
    b.addEventListener('click', () => {
      cerrarDrawer();
      if (clave === 'salir') { cerrarSesion(); return; }
      if (usuario.rol === 'dueno') mostrarTabDueno(clave);
      else mostrarSeccion(clave);
    });
    nav.appendChild(b);
  });
}
function abrirDrawer() { $('drawer').classList.remove('hidden'); $('drawerFondo').classList.remove('hidden'); }
function cerrarDrawer() { $('drawer').classList.add('hidden'); $('drawerFondo').classList.add('hidden'); }

function mostrarSeccion(clave) {
  document.querySelectorAll('#vistaBanquera .pantalla').forEach((s) => s.classList.remove('activa'));
  const mapa = { venta: 'sec-venta', tickets: 'sec-tickets', premiados: 'sec-premiados', resultados: 'sec-resultados', ventas: 'sec-ventas', efectivo: 'sec-efectivo', cuadre: 'sec-cuadre', ayuda: 'sec-ayuda' };
  const sec = $(mapa[clave] || 'sec-venta');
  if (sec) sec.classList.add('activa');
  document.querySelectorAll('#drawerNav button').forEach((b) => b.classList.toggle('sel', b.dataset.seccion === clave));
  if (clave === 'tickets') cargarTickets();
  if (clave === 'premiados') cargarPremiados();
  if (clave === 'resultados') cargarResultadosBanquera();
  if (clave === 'ventas') buscarVentas();
  if (clave === 'efectivo') cargarEfectivo();
  if (clave === 'cuadre') cargarCuadre();
}
function mostrarTabDueno(clave) {
  document.querySelectorAll('#vistaDueno .tabs button').forEach((b) => b.classList.toggle('sel', b.dataset.tab === clave));
  document.querySelectorAll('#vistaDueno .pantalla').forEach((s) => s.classList.remove('activa'));
  const sec = $('tab-' + clave);
  if (sec) sec.classList.add('activa');
  if (clave === 'resultados') cargarDuenoResultados();
  if (clave === 'banqueras') cargarBanqueras();
}

/* ---------- Detección de jugadas por dígitos ---------- */
function detectar(numeroCrudo) {
  const crudo = String(numeroCrudo || '').trim();
  if (!crudo) return null;
  let box = false;
  let s = crudo;
  if (s.endsWith('.')) { box = true; s = s.slice(0, -1); }
  const negativo = s.startsWith('-');
  const digitos = negativo ? s.slice(1) : s;
  if (!/^\d+$/.test(digitos)) return { error: 'La jugada solo lleva números (y guión al inicio para Play 3 Back / Play 4).' };
  const n = digitos.length;
  if (!negativo && n === 2) return { tipo: 'quiniela', numero: digitos, modo: null, etiqueta: 'Quiniela' };
  if (!negativo && n === 4) return { tipo: 'pale', numero: digitos, modo: null, etiqueta: 'Palé' };
  if (!negativo && n === 6) return { tipo: 'tripleta', numero: digitos, modo: null, etiqueta: 'Tripleta' };
  if (!negativo && n === 3) return { tipo: 'play3', numero: digitos, modo: box ? 'BX' : modoPlay, etiqueta: box ? 'Play 3 Box' : 'Play 3 ' + modoPlay };
  if (negativo && n === 3) return { tipo: 'play3back', numero: '-' + digitos, modo: null, etiqueta: 'Play 3 Back' };
  if (negativo && n === 4) return { tipo: 'play4', numero: '-' + digitos, modo: box ? 'BX' : modoPlay, etiqueta: box ? 'Play 4 Box' : 'Play 4 ' + modoPlay };
  return { error: 'Número no válido. Quiniela 2 dígitos, palé 4, tripleta 6, Play 3 de 3, Play 4 con guión y 4.' };
}
function actualizarDeteccion() {
  const det = detectar($('inpJugada').value);
  const el = $('detTipo');
  const mb = $('modoBtns');
  if (!det) { el.textContent = ''; mb.classList.add('hidden'); return; }
  if (det.error) { el.textContent = det.error; el.style.color = 'var(--rojo)'; mb.classList.add('hidden'); return; }
  el.style.color = 'var(--verde)';
  el.textContent = det.etiqueta + ' · ' + det.numero;
  if (det.tipo === 'play3' || det.tipo === 'play4') {
    mb.classList.remove('hidden');
    mb.querySelectorAll('button').forEach((b) => b.classList.toggle('sel', b.dataset.modo === det.modo));
  } else mb.classList.add('hidden');
}

/* ---------- Loterías ---------- */
async function cargarLoterias(silencioso) {
  try {
    const data = await api('getLoterias');
    loterias = data.loterias || [];
    renderLoterias();
  } catch (e) {
    if (!silencioso) mostrarMsg($('ventaError'), e.message, true);
  }
}
function renderLoterias() {
  const cont = $('listaLoterias');
  cont.innerHTML = '';
  if (!loterias.length) { cont.innerHTML = '<p class="muted">No hay loterías cargadas.</p>'; return; }
  loterias.forEach((lot) => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'lot-btn' + (loteriaSel === lot.id ? ' sel' : '') + (lot.abierta ? '' : ' cerrada');
    b.innerHTML = '<b>' + esc(lot.nombre) + '</b>' +
      '<span class="horario">' + fmtHora(lot.abre) + ' - ' + fmtHora(lot.cierra) + '</span><br>' +
      (lot.abierta
        ? '<span class="sello-abierta">Abierta</span>'
        : '<span class="sello-cerrada">Cerrada</span>');
    b.title = lot.abreTexto || '';
    b.addEventListener('click', () => {
      loteriaSel = lot.id;
      renderLoterias();
      if (lot.abierta) {
        $('loteriaSelTxt').textContent = lot.nombre + ' · ' + fmtHora(lot.abre) + ' - ' + fmtHora(lot.cierra);
        ocultarMsg($('ventaError'));
      } else {
        $('loteriaSelTxt').textContent = lot.nombre + ' está cerrada. ' + (lot.abreTexto || '');
        mostrarMsg($('ventaError'), 'La lotería ' + lot.nombre + ' está cerrada. ' + (lot.abreTexto || ''), true);
      }
    });
    cont.appendChild(b);
  });
}
function loteriaSeleccionada() { return loterias.find((l) => l.id === loteriaSel) || null; }

/* ---------- Cuadro verde (Total del día) ---------- */
async function refrescarCuadroVerde() {
  try {
    const data = await api('getEfectivo', { fecha: hoyISO() });
    const balance = Number(data.balance || 0);
    $('totalDia').textContent = fmt$(balance);
    $('ventaDia').textContent = fmt$(data.vendido || 0);
    $('premioDia').textContent = fmt$(data.premios || 0);
    const cuadro = $('cuadroVerde');
    const rotulo = $('rotuloPerdida');
    if (balance < 0) { cuadro.classList.add('negativo'); rotulo.classList.remove('hidden'); }
    else { cuadro.classList.remove('negativo'); rotulo.classList.add('hidden'); }
  } catch (e) { /* se reintenta en el próximo ciclo de 15 s */ }
}

/* ---------- Jugadas en curso ---------- */
function renderJugadas() {
  const grupos = { quiniela: $('colQuinielas'), pale: $('colPales'), tripleta: $('colTripletas') };
  Object.values(grupos).forEach((c) => { c.innerHTML = ''; });
  const vacio = { quiniela: true, pale: true, tripleta: true };
  jugadas.forEach((j, idx) => {
    const col = j.tipo === 'pale' ? grupos.pale : j.tipo === 'tripleta' ? grupos.tripleta : grupos.quiniela;
    vacio[j.tipo === 'pale' ? 'pale' : j.tipo === 'tripleta' ? 'tripleta' : 'quiniela'] = false;
    const div = document.createElement('div');
    div.className = 'jugada-item';
    const etiqueta = j.tipo === 'quiniela' ? '' : j.tipo === 'pale' ? '' : j.tipo === 'tripleta' ? '' : ' · ' + j.tipo.toUpperCase() + (j.modo ? ' ' + j.modo : '');
    div.innerHTML = '<span class="num">' + esc(j.numero) + esc(etiqueta) + '</span><span>' + fmt$(j.monto) + '</span>';
    const q = document.createElement('button');
    q.type = 'button'; q.className = 'quitar'; q.textContent = '×'; q.title = 'Quitar';
    q.addEventListener('click', () => { jugadas.splice(idx, 1); renderJugadas(); });
    div.appendChild(q);
    col.appendChild(div);
  });
  if (vacio.quiniela) grupos.quiniela.innerHTML = '<p class="muted">—</p>';
  if (vacio.pale) grupos.pale.innerHTML = '<p class="muted">—</p>';
  if (vacio.tripleta) grupos.tripleta.innerHTML = '<p class="muted">—</p>';
}
function agregarJugada() {
  const det = detectar($('inpJugada').value);
  if (!det) { mostrarMsg($('ventaError'), 'Escribe primero el número de la jugada.', true); return false; }
  if (det.error) { mostrarMsg($('ventaError'), det.error, true); return false; }
  const monto = parseInt(String($('inpMonto').value).replace(/[^\d]/g, ''), 10);
  if (!monto || monto <= 0) { mostrarMsg($('ventaError'), 'El monto debe ser mayor que 0.', true); return false; }
  const lot = loteriaSeleccionada();
  if (!lot) { mostrarMsg($('ventaError'), 'Elige primero una lotería.', true); return false; }
  if (!lot.abierta) { mostrarMsg($('ventaError'), 'La lotería ' + lot.nombre + ' está cerrada. ' + (lot.abreTexto || ''), true); return false; }
  jugadas.push({ tipo: det.tipo, numero: det.numero, modo: det.modo || null, monto });
  $('inpJugada').value = '';
  $('inpMonto').value = '';
  ocultarMsg($('ventaError'));
  ocultarMsg($('ventaOk'));
  renderJugadas();
  actualizarDeteccion();
  enfocarCampo('jugada');
  return true;
}
function totalJugadas() { return jugadas.reduce((a, j) => a + j.monto, 0); }

/* ---------- Vender ---------- */
async function vender() {
  ocultarMsg($('ventaError')); ocultarMsg($('ventaOk'));
  if (!jugadas.length) { mostrarMsg($('ventaError'), 'No hay jugadas. Agrega al menos una jugada antes de vender.', true); return; }
  const lot = loteriaSeleccionada();
  if (!lot) { mostrarMsg($('ventaError'), 'Elige primero una lotería.', true); return; }
  if (!lot.abierta) { mostrarMsg($('ventaError'), 'La lotería ' + lot.nombre + ' está cerrada. ' + (lot.abreTexto || ''), true); return; }
  const btn = $('btnVender');
  btn.disabled = true;
  try {
    const data = await api('createTicket', {
      loteriaId: lot.id,
      jugadas: jugadas.map((j) => ({ tipo: j.tipo, numero: j.numero, modo: j.modo || null, monto: j.monto })),
    });
    ultimoTicket = data.ticket;
    jugadas = [];
    renderJugadas();
    mostrarMsg($('ventaOk'), 'Ticket vendido. Folio ' + data.ticket.folio + ' · Código ' + data.ticket.codigo + '.', false);
    refrescarCuadroVerde();
    mostrarTicket(data.ticket);
  } catch (e) {
    mostrarMsg($('ventaError'), e.message, true);
  } finally { btn.disabled = false; }
}

/* ---------- Ticket en papel (HTML + PNG 58mm en canvas) ---------- */
function lineasTicket(t) {
  return {
    titulo: (usuario && usuario.rol === 'dueno') ? 'Banca de Lotería' : (t.banca || usuario.nombre || 'Banca de Lotería'),
    loteria: t.loteria || '',
    folio: t.folio, codigo: t.codigo, fecha: t.fecha, hora: t.hora, total: t.total,
    jugadas: t.jugadas || [],
  };
}
function htmlPapelTicket(t) {
  const d = lineasTicket(t);
  let jug = '';
  d.jugadas.forEach((j) => {
    const etiqueta = j.tipo === 'quiniela' ? 'Quiniela' : j.tipo === 'pale' ? 'Palé' : j.tipo === 'tripleta' ? 'Tripleta'
      : j.tipo === 'play3' ? 'Play 3' + (j.modo ? ' ' + j.modo : '') : j.tipo === 'play3back' ? 'Play 3 Back'
      : j.tipo === 'play4' ? 'Play 4' + (j.modo ? ' ' + j.modo : '') : j.tipo;
    jug += '<div class="linea"><span>' + esc(etiqueta) + ' ' + esc(j.numero) + '</span><span>' + fmt$(j.monto) + '</span></div>';
  });
  return '<div class="papel">' +
    '<div class="t1">' + esc(d.titulo) + '</div>' +
    '<div class="t2">' + esc(d.loteria) + '</div><hr>' +
    '<div class="linea"><span>Folio</span><span><b>' + esc(d.folio) + '</b></span></div>' +
    '<div class="linea"><span>Código</span><span><b>' + esc(d.codigo) + '</b></span></div>' +
    '<div class="linea"><span>Fecha</span><span>' + esc(d.fecha) + ' ' + esc(d.hora || '') + '</span></div><hr>' +
    jug + '<hr>' +
    '<div class="linea grande"><span>TOTAL</span><span>' + fmt$(d.total) + '</span></div>' +
    '<div class="centro t2" style="margin-top:8px">¡Buena suerte!</div>' +
    '</div>';
}
function dibujarTicketCanvas(t) {
  // Papel térmico 58mm ≈ 448 px de ancho a ~196 dpi
  const W = 448, LH = 30;
  const d = lineasTicket(t);
  const filas = [];
  filas.push({ txt: d.titulo, grande: true, centro: true });
  filas.push({ txt: d.loteria, centro: true });
  filas.push({ hr: true });
  filas.push({ izq: 'Folio', der: d.folio });
  filas.push({ izq: 'Código', der: d.codigo });
  filas.push({ izq: 'Fecha', der: (d.fecha || '') + ' ' + (d.hora || '') });
  filas.push({ hr: true });
  d.jugadas.forEach((j) => {
    const etiqueta = j.tipo === 'quiniela' ? 'Quiniela' : j.tipo === 'pale' ? 'Palé' : j.tipo === 'tripleta' ? 'Tripleta'
      : j.tipo === 'play3' ? 'Play 3' + (j.modo ? ' ' + j.modo : '') : j.tipo === 'play3back' ? 'Play 3 Back'
      : j.tipo === 'play4' ? 'Play 4' + (j.modo ? ' ' + j.modo : '') : j.tipo;
    filas.push({ izq: etiqueta + ' ' + j.numero, der: fmt$(j.monto) });
  });
  filas.push({ hr: true });
  filas.push({ izq: 'TOTAL', der: fmt$(d.total), grande: true });
  filas.push({ txt: '¡Buena suerte!', centro: true });
  const H = 24 + filas.length * LH + 24;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000000'; ctx.textBaseline = 'middle';
  let y = 24 + LH / 2;
  filas.forEach((f) => {
    if (f.hr) {
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(16, y); ctx.lineTo(W - 16, y); ctx.stroke();
      ctx.setLineDash([]);
    } else if (f.txt) {
      ctx.font = (f.grande ? 'bold 26px' : '20px') + ' monospace';
      ctx.textAlign = 'center';
      ctx.fillText(f.txt, W / 2, y);
      ctx.textAlign = 'left';
    } else {
      ctx.font = (f.grande ? 'bold 26px' : '20px') + ' monospace';
      ctx.textAlign = 'left';
      ctx.fillText(f.izq, 16, y);
      ctx.textAlign = 'right';
      ctx.fillText(f.der, W - 16, y);
      ctx.textAlign = 'left';
    }
    y += LH;
  });
  return cv;
}
function guardarImagenTicket(t) {
  const cv = dibujarTicketCanvas(t);
  cv.toBlob((blob) => {
    if (!blob) { alert('No se pudo crear la imagen del ticket.'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'ticket-' + t.folio + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}
async function compartirTicket(t) {
  const cv = dibujarTicketCanvas(t);
  cv.toBlob(async (blob) => {
    if (!blob) { alert('No se pudo crear la imagen del ticket.'); return; }
    const archivo = new File([blob], 'ticket-' + t.folio + '.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
      try { await navigator.share({ files: [archivo], title: 'Ticket ' + t.folio }); return; } catch (e) { /* cancelado */ return; }
    }
    if (navigator.share) {
      try { await navigator.share({ title: 'Ticket ' + t.folio, text: 'Ticket ' + t.folio + ' · Código ' + t.codigo + ' · Total ' + fmt$(t.total) }); return; } catch (e) { return; }
    }
    guardarImagenTicket(t); // si no se puede compartir, se descarga
  }, 'image/png');
}
/* Impresión directa: en la APK, la imagen va a la impresora térmica por
   Bluetooth (puente nativo). Si no hay puente (navegador web), usa Compartir. */
function imprimirTicket(t) {
  const cv = dibujarTicketCanvas(t);
  if (window.BancaBridge && typeof window.BancaBridge.imprimir === 'function') {
    const dataUrl = cv.toDataURL('image/png');
    window.BancaBridge.imprimir(dataUrl.split(',')[1]);
    return;
  }
  compartirTicket(t);
}
function mostrarTicket(t) {
  abrirModal('Ticket vendido', htmlPapelTicket(t), [
    { texto: '🖨️ Imprimir', clase: 'btn', fn: () => imprimirTicket(t) },
    { texto: '💾 Guardar imagen', clase: 'btn', fn: () => guardarImagenTicket(t) },
    { texto: '📤 Compartir', clase: 'btn', fn: () => compartirTicket(t) },
    { texto: 'Cerrar', clase: 'btn secundario', fn: cerrarModal },
  ]);
}

/* ---------- Reporte de Ventas (ticket solo resumen neto) ---------- */
function htmlPapelReporte(res, desde, hasta) {
  let desglose = '';
  (res.por_loteria || []).forEach((p) => {
    desglose += '<div class="linea"><span>' + esc(p.loteria) + ' (' + p.numTickets + ')</span><span>' + fmt$(p.total) + '</span></div>';
  });
  const neto = Number(res.total_neto || 0);
  return '<div class="papel">' +
    '<div class="t1">REPORTE DE VENTAS</div>' +
    '<div class="t2">' + esc(desde) + ' al ' + esc(hasta) + '</div><hr>' +
    '<div class="linea"><span>Venta total</span><span>' + fmt$(res.total_vendido) + '</span></div>' +
    '<div class="linea"><span>Premios</span><span>' + fmt$(res.total_pagado) + '</span></div>' +
    '<div class="linea grande"><span>TOTAL</span><span>' + fmt$(neto) + '</span></div>' +
    (neto < 0 ? '<div class="centro"><b>EN PÉRDIDA</b></div>' : '') +
    '<div class="linea"><span>Tickets</span><span>' + (res.num_tickets || 0) + '</span></div><hr>' +
    desglose +
    '</div>';
}
function dibujarReporteCanvas(res, desde, hasta) {
  const W = 448, LH = 30;
  const neto = Number(res.total_neto || 0);
  const filas = [
    { txt: 'REPORTE DE VENTAS', grande: true, centro: true },
    { txt: desde + ' al ' + hasta, centro: true },
    { hr: true },
    { izq: 'Venta total', der: fmt$(res.total_vendido) },
    { izq: 'Premios', der: fmt$(res.total_pagado) },
    { izq: 'TOTAL', der: fmt$(neto), grande: true },
  ];
  if (neto < 0) filas.push({ txt: 'EN PÉRDIDA', centro: true });
  filas.push({ izq: 'Tickets', der: String(res.num_tickets || 0) });
  filas.push({ hr: true });
  (res.por_loteria || []).forEach((p) => filas.push({ izq: p.loteria + ' (' + p.numTickets + ')', der: fmt$(p.total) }));
  const H = 24 + filas.length * LH + 24;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff'; ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = '#000000'; ctx.textBaseline = 'middle';
  let y = 24 + LH / 2;
  filas.forEach((f) => {
    if (f.hr) {
      ctx.setLineDash([6, 5]);
      ctx.beginPath(); ctx.moveTo(16, y); ctx.lineTo(W - 16, y); ctx.stroke();
      ctx.setLineDash([]);
    } else if (f.txt) {
      ctx.font = (f.grande ? 'bold 26px' : '20px') + ' monospace';
      ctx.textAlign = 'center'; ctx.fillText(f.txt, W / 2, y); ctx.textAlign = 'left';
    } else {
      ctx.font = (f.grande ? 'bold 26px' : '20px') + ' monospace';
      ctx.textAlign = 'left'; ctx.fillText(f.izq, 16, y);
      ctx.textAlign = 'right'; ctx.fillText(f.der, W - 16, y); ctx.textAlign = 'left';
    }
    y += LH;
  });
  return cv;
}
function guardarImagenReporte(res, desde, hasta) {
  const cv = dibujarReporteCanvas(res, desde, hasta);
  cv.toBlob((blob) => {
    if (!blob) { alert('No se pudo crear la imagen del reporte.'); return; }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'reporte-' + desde + '-a-' + hasta + '.png';
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }, 'image/png');
}
async function compartirReporte(res, desde, hasta) {
  const cv = dibujarReporteCanvas(res, desde, hasta);
  cv.toBlob(async (blob) => {
    if (!blob) { alert('No se pudo crear la imagen del reporte.'); return; }
    const archivo = new File([blob], 'reporte-' + desde + '.png', { type: 'image/png' });
    if (navigator.canShare && navigator.canShare({ files: [archivo] })) {
      try { await navigator.share({ files: [archivo], title: 'Reporte de ventas' }); return; } catch (e) { return; }
    }
    guardarImagenReporte(res, desde, hasta);
  }, 'image/png');
}
/* Impresión directa del reporte: igual que el ticket, por el puente nativo. */
function imprimirReporte(res, desde, hasta) {
  const cv = dibujarReporteCanvas(res, desde, hasta);
  if (window.BancaBridge && typeof window.BancaBridge.imprimir === 'function') {
    const dataUrl = cv.toDataURL('image/png');
    window.BancaBridge.imprimir(dataUrl.split(',')[1]);
    return;
  }
  compartirReporte(res, desde, hasta);
}

/* ---------- Modal genérico ---------- */
function abrirModal(titulo, html, botones) {
  $('modalTitulo').textContent = titulo;
  $('modalCuerpo').innerHTML = html;
  const cont = $('modalBotones');
  cont.innerHTML = '';
  (botones || [{ texto: 'Cerrar', clase: 'btn secundario', fn: cerrarModal }]).forEach((b) => {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = b.clase || 'btn';
    btn.textContent = b.texto;
    btn.addEventListener('click', b.fn);
    cont.appendChild(btn);
  });
  $('modalFondo').classList.remove('hidden');
}
function cerrarModal() { $('modalFondo').classList.add('hidden'); }

/* ---------- Teclado ---------- */
function enfocarCampo(cual) {
  campoActivo = cual;
  $('inpJugada').classList.toggle('campo-activo', cual === 'jugada');
  $('inpMonto').classList.toggle('campo-activo', cual === 'monto');
  (cual === 'jugada' ? $('inpJugada') : $('inpMonto')).focus();
}
function tecla(k) {
  const inp = campoActivo === 'jugada' ? $('inpJugada') : $('inpMonto');
  if (k === 'borrar') { inp.value = inp.value.slice(0, -1); }
  else if (k === 'enter') {
    if (campoActivo === 'jugada') { enfocarCampo('monto'); }
    else agregarJugada();
  } else {
    if (campoActivo === 'monto' && (k === '-' || k === '.')) return; // el monto solo lleva dígitos
    inp.value += k;
  }
  if (campoActivo === 'jugada') actualizarDeteccion();
}

/* ---------- Ligar / Generar / Automática / Devuelta ---------- */
function aleatorio(n) { let s = ''; for (let i = 0; i < n; i++) s += Math.floor(Math.random() * 10); return s; }
function ligar(modoAvanzado) {
  const quins = jugadas.filter((j) => j.tipo === 'quiniela');
  if (quins.length < 2) { mostrarMsg($('ventaError'), 'Para ligar necesitas al menos 2 quinielas en la lista.', true); return; }
  const hacer = (seleccionadas) => {
    const monto = parseInt(String($('inpMonto').value).replace(/[^\d]/g, ''), 10) || seleccionadas[0].monto;
    let creados = 0;
    for (let i = 0; i < seleccionadas.length; i++) {
      for (let j = i + 1; j < seleccionadas.length; j++) {
        jugadas.push({ tipo: 'pale', numero: seleccionadas[i].numero + seleccionadas[j].numero, modo: null, monto });
        creados++;
      }
    }
    renderJugadas();
    mostrarMsg($('ventaOk'), 'Se crearon ' + creados + ' palés ligando las quinielas.', false);
  };
  if (!modoAvanzado) { hacer(quins); return; }
  // Ligar Avanzado: elegir qué quinielas combinar
  const checks = quins.map((q, i) =>
    '<label><input type="checkbox" class="ligar-chk" data-i="' + i + '" checked> ' + esc(q.numero) + ' · ' + fmt$(q.monto) + '</label>').join('');
  abrirModal('Ligar Avanzado',
    '<p class="ayuda-txt">Marca las quinielas que quieres combinar en palés. Se combinan todas entre sí.</p><div class="check-line">' + checks + '</div>',
    [
      { texto: 'Ligar seleccionadas', clase: 'btn', fn: () => {
        const sel = [];
        document.querySelectorAll('.ligar-chk:checked').forEach((c) => sel.push(quins[Number(c.dataset.i)]));
        cerrarModal();
        if (sel.length < 2) { mostrarMsg($('ventaError'), 'Marca al menos 2 quinielas para ligar.', true); return; }
        hacer(sel);
      } },
      { texto: 'Cancelar', clase: 'btn secundario', fn: cerrarModal },
    ]);
}
function generar(tipo) {
  const numero = tipo === 'pale' ? aleatorio(4) : aleatorio(6);
  $('inpJugada').value = numero;
  enfocarCampo('monto');
  actualizarDeteccion();
  mostrarMsg($('ventaOk'), (tipo === 'pale' ? 'Palé' : 'Tripleta') + ' generado: ' + numero + '. Escribe el monto y pulsa ENTER.', false);
}
function jugadaAutomatica() {
  const tipos = ['quiniela', 'pale', 'tripleta'];
  const tipo = tipos[Math.floor(Math.random() * tipos.length)];
  const numero = tipo === 'quiniela' ? aleatorio(2) : tipo === 'pale' ? aleatorio(4) : aleatorio(6);
  $('inpJugada').value = numero;
  enfocarCampo('monto');
  actualizarDeteccion();
  mostrarMsg($('ventaOk'), 'Jugada automática: ' + numero + '. Escribe el monto y pulsa ENTER.', false);
}
function devuelta() {
  const total = totalJugadas();
  abrirModal('Devuelta',
    '<p class="ayuda-txt">Total de las jugadas: <b>' + fmt$(total) + '</b></p>' +
    '<label for="devRecibido">Dinero recibido (RD$)</label>' +
    '<input type="number" id="devRecibido" min="0" placeholder="0">' +
    '<div id="devResultado" style="margin-top:10px;font-size:18px;font-weight:700"></div>',
    [{ texto: 'Cerrar', clase: 'btn secundario', fn: cerrarModal }]);
  $('devRecibido').addEventListener('input', () => {
    const rec = parseInt($('devRecibido').value, 10) || 0;
    const cambio = rec - total;
    $('devResultado').textContent = cambio < 0 ? 'Faltan ' + fmt$(Math.abs(cambio)) : 'Devuelta: ' + fmt$(cambio);
    $('devResultado').style.color = cambio < 0 ? 'var(--rojo)' : 'var(--verde-oscuro)';
  });
  $('devRecibido').focus();
}
async function ultimoTicketFn() {
  try {
    const data = await api('getUltimoTicket');
    if (!data.ticket) { alert('Todavía no hay tickets vendidos.'); return; }
    ultimoTicket = data.ticket;
    mostrarTicket(data.ticket);
  } catch (e) { alert(e.message); }
}

/* ---------- Tickets (lista, pagar, cancelar) ---------- */
async function cargarTickets() {
  const cont = $('listaTickets');
  cont.innerHTML = '<p class="muted">Cargando…</p>';
  try {
    const data = await api('listTickets', { desde: hoyISO(), hasta: hoyISO() });
    const tickets = data.tickets || [];
    if (!tickets.length) { cont.innerHTML = '<p class="muted">No hay tickets hoy.</p>'; return; }
    cont.innerHTML = '';
    tickets.forEach((t) => {
      const div = document.createElement('div');
      div.className = 'ticket-row';
      const estado = t.estado === 'activo' ? '<span class="pill activo">Activo</span>'
        : t.estado === 'anulado' ? '<span class="pill anulado">Anulado</span>'
        : '<span class="pill pagado">Pagado</span>';
      const jug = (t.jugadas || []).map((j) => esc(j.numero) + ' · ' + fmt$(j.monto)).join('<br>');
      div.innerHTML = '<div class="fila"><b>#' + esc(t.folio) + ' · ' + esc(t.loteria || '') + '</b>' + estado + '</div>' +
        '<div class="fila"><span>' + esc(t.fecha) + ' ' + esc(t.hora || '') + '</span><span>' + fmt$(t.total) + '</span></div>' +
        '<div style="font-size:13px;margin-top:4px">' + jug + '</div>';
      const ver = document.createElement('button');
      ver.type = 'button'; ver.className = 'btn secundario chico'; ver.textContent = 'Ver ticket';
      ver.style.marginTop = '6px';
      ver.addEventListener('click', () => mostrarTicket(t));
      div.appendChild(ver);
      cont.appendChild(div);
    });
  } catch (e) { cont.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}
async function pagarTicket() {
  const folio = $('pagarFolio').value.trim();
  const codigo = $('pagarSerial').value.trim().toUpperCase();
  const msg = $('pagarMsg');
  if (!folio || !codigo) { mostrarMsg(msg, 'Escribe el #Ticket y el #Serial del papel.', true); return; }
  try {
    const data = await api('payTicket', { folio, codigo });
    mostrarMsg(msg, 'Ticket ' + folio + ' pagado. Premio a pagar: ' + fmt$(data.premio) + '.', false);
    refrescarCuadroVerde();
    cargarTickets();
  } catch (e) { mostrarMsg(msg, e.message, true); }
}
async function cancelarTicket() {
  const folio = $('cancelFolio').value.trim();
  const codigo = $('cancelSerial').value.trim().toUpperCase();
  const msg = $('cancelMsg');
  if (!folio || !codigo) { mostrarMsg(msg, 'Escribe el #Ticket y el #Serial del papel.', true); return; }
  if (!confirm('¿Seguro que quieres cancelar el ticket ' + folio + '?')) return;
  try {
    await api('voidTicket', { folio, codigo });
    mostrarMsg(msg, 'Ticket ' + folio + ' cancelado.', false);
    refrescarCuadroVerde();
    cargarTickets();
  } catch (e) { mostrarMsg(msg, e.message, true); }
}

/* ---------- Tickets Premiados ---------- */
async function cargarPremiados() {
  const cont = $('listaPremiados');
  cont.innerHTML = '<p class="muted">Cargando…</p>';
  try {
    const data = await api('getPremiados', { fecha: hoyISO() });
    const lista = data.premiados || [];
    if (!lista.length) { cont.innerHTML = '<p class="muted">Hoy no hay tickets premiados todavía. Cuando el dueño ponga los números ganadores, aparecerán aquí.</p>'; return; }
    cont.innerHTML = '';
    lista.forEach((p) => {
      const t = p.ticket;
      const div = document.createElement('div');
      div.className = 'ticket-row';
      let jug = '';
      (p.jugadas || []).forEach((j) => {
        jug += '<div class="fila"><span>' + esc(j.numero) + ' · ' + esc(j.detalle || '') + '</span><span class="monto-pos">' + fmt$(j.premio) + '</span></div>';
      });
      div.innerHTML = '<div class="fila"><b>#' + esc(t.folio) + ' · ' + esc(t.loteria || '') + '</b><span class="pill premiado">Premiado</span></div>' +
        '<div class="fila"><span>' + esc(t.fecha) + ' ' + esc(t.hora || '') + '</span><span>Total a pagar: <b>' + fmt$(p.total_premio) + '</b></span></div>' + jug;
      cont.appendChild(div);
    });
  } catch (e) { cont.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}

/* ---------- Números Ganadores (banquera: solo lectura) ---------- */
async function cargarResultadosBanquera() {
  const cont = $('listaResultados');
  const fecha = $('fechaResultados').value || hoyISO();
  cont.innerHTML = '<p class="muted">Cargando…</p>';
  try {
    const data = await api('getResultados', { fecha });
    const res = data.resultados || [];
    if (!res.length) { cont.innerHTML = '<p class="muted">Los números ganadores aún no están.</p>'; return; }
    cont.innerHTML = '';
    res.forEach((r) => {
      const div = document.createElement('div');
      div.className = 'ticket-row';
      div.innerHTML = '<div class="fila"><b>' + esc(r.loteria) + '</b><span>' + esc(r.primera) + ' - ' + esc(r.segunda) + ' - ' + esc(r.tercera) + '</span></div>';
      cont.appendChild(div);
    });
  } catch (e) { cont.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}

/* ---------- Ventas ---------- */
async function buscarVentas() {
  const desde = $('ventasDesde').value || hoyISO();
  const hasta = $('ventasHasta').value || hoyISO();
  try {
    const data = await api('getResumen', { desde, hasta });
    const neto = Number(data.total_neto || 0);
    $('ventasTotal').textContent = fmt$(neto);
    $('ventasVenta').textContent = fmt$(data.total_vendido || 0);
    $('ventasPremio').textContent = fmt$(data.total_pagado || 0);
    $('cuadroVentas').classList.toggle('negativo', neto < 0);
    $('ventasPerdida').classList.toggle('hidden', neto >= 0);
    let html = '<div class="card"><h3>Desglose por lotería</h3>';
    const porLot = data.por_loteria || [];
    if (!porLot.length) html += '<p class="muted">No hay ventas en ese rango.</p>';
    else {
      html += '<table><tr><th>Lotería</th><th>Tickets</th><th>Total</th></tr>';
      porLot.forEach((p) => { html += '<tr><td>' + esc(p.loteria) + '</td><td>' + p.numTickets + '</td><td>' + fmt$(p.total) + '</td></tr>'; });
      html += '</table>';
    }
    html += '<p style="margin-top:10px">Tickets vendidos: <b>' + (data.num_tickets || 0) + '</b></p></div>';
    $('ventasDetalle').innerHTML = html;
    $('btnImprimirReporte').onclick = () => {
      abrirModal('Reporte de ventas', htmlPapelReporte(data, desde, hasta), [
        { texto: '🖨️ Imprimir', clase: 'btn', fn: () => imprimirReporte(data, desde, hasta) },
        { texto: '💾 Guardar imagen', clase: 'btn', fn: () => guardarImagenReporte(data, desde, hasta) },
        { texto: '📤 Compartir', clase: 'btn', fn: () => compartirReporte(data, desde, hasta) },
        { texto: 'Cerrar', clase: 'btn secundario', fn: cerrarModal },
      ]);
    };
  } catch (e) {
    $('ventasDetalle').innerHTML = '<p class="error">' + esc(e.message) + '</p>';
  }
}

/* ---------- Efectivo ---------- */
async function cargarEfectivo() {
  const box = $('efectivoBox');
  try {
    const data = await api('getEfectivo', { fecha: hoyISO() });
    const balance = Number(data.balance || 0);
    box.innerHTML = '<div class="cuadro-verde' + (balance < 0 ? ' negativo' : '') + '" style="margin:0 0 12px">' +
      '<div class="etiqueta">Efectivo de hoy</div>' +
      '<div class="total">' + fmt$(balance) + '</div>' +
      '<div class="desglose"><span>Venta <b>' + fmt$(data.vendido) + '</b></span><span>Premio <b>' + fmt$(data.premios) + '</b></span></div>' +
      (balance < 0 ? '<div><span class="perdida">en pérdida</span></div>' : '') +
      '</div>' +
      '<div class="card"><div class="fila" style="display:flex;justify-content:space-between"><span>Tickets vendidos</span><b>' + (data.numTickets || 0) + '</b></div>' +
      '<div style="display:flex;justify-content:space-between"><span>Tickets pagados</span><b>' + (data.numPagados || 0) + '</b></div>' +
      '<div style="display:flex;justify-content:space-between"><span>Total pagado</span><b>' + fmt$(data.totalPagado) + '</b></div></div>';
  } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
  try {
    const rec = await api('listRecargas', { desde: hoyISO(), hasta: hoyISO() });
    const lista = rec.recargas || [];
    $('listaRecargas').innerHTML = lista.length
      ? lista.map((r) => '<div class="fila" style="display:flex;justify-content:space-between"><span>' + esc(r.hora || '') + ' · ' + esc(r.nota || '') + '</span><b>' + fmt$(r.monto) + '</b></div>').join('')
      : '<p class="muted">No hay recargas hoy.</p>';
  } catch (e) { /* opcional */ }
}

/* ---------- Cuadre General ---------- */
async function cargarCuadre() {
  const box = $('cuadreBox');
  try {
    const data = await api('getResumen', { desde: hoyISO(), hasta: hoyISO() });
    const neto = Number(data.total_neto || 0);
    let html = '<div class="cuadro-verde' + (neto < 0 ? ' negativo' : '') + '" style="margin:0 0 12px">' +
      '<div class="etiqueta">Cuadre de hoy</div>' +
      '<div class="total">' + fmt$(neto) + '</div>' +
      '<div class="desglose"><span>Venta <b>' + fmt$(data.total_vendido) + '</b></span><span>Premio <b>' + fmt$(data.total_pagado) + '</b></span></div>' +
      (neto < 0 ? '<div><span class="perdida">en pérdida</span></div>' : '') + '</div>';
    html += '<div class="card"><h3>Por lotería</h3>';
    const porLot = data.por_loteria || [];
    if (!porLot.length) html += '<p class="muted">No hay ventas hoy.</p>';
    else {
      html += '<table><tr><th>Lotería</th><th>Tickets</th><th>Total</th></tr>';
      porLot.forEach((p) => { html += '<tr><td>' + esc(p.loteria) + '</td><td>' + p.numTickets + '</td><td>' + fmt$(p.total) + '</td></tr>'; });
      html += '</table>';
    }
    html += '<p style="margin-top:10px">Tickets vendidos: <b>' + (data.num_tickets || 0) + '</b></p></div>';
    box.innerHTML = html;
  } catch (e) { box.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}

/* ---------- DUEÑO: Números ganadores ---------- */
async function cargarDuenoResultados() {
  const cont = $('duenoResultados');
  const fecha = $('fechaDueno').value || hoyISO();
  cont.innerHTML = '<p class="muted">Cargando…</p>';
  try {
    const [lots, res] = await Promise.all([api('getLoterias'), api('getResultados', { fecha })]);
    const mapa = {};
    (res.resultados || []).forEach((r) => { mapa[r.loteriaId] = r; });
    cont.innerHTML = '';
    (lots.loterias || []).forEach((lot) => {
      const r = mapa[lot.id];
      const row = document.createElement('div');
      row.className = 'res-row';
      row.innerHTML = '<span class="nombre">' + esc(lot.nombre) + '</span>' +
        '<input type="text" inputmode="numeric" maxlength="2" placeholder="1ra" value="' + esc(r ? r.primera : '') + '" data-campo="primera">' +
        '<input type="text" inputmode="numeric" maxlength="2" placeholder="2da" value="' + esc(r ? r.segunda : '') + '" data-campo="segunda">' +
        '<input type="text" inputmode="numeric" maxlength="2" placeholder="3ra" value="' + esc(r ? r.tercera : '') + '" data-campo="tercera">';
      const btnG = document.createElement('button');
      btnG.type = 'button'; btnG.className = 'btn chico'; btnG.textContent = 'Guardar';
      btnG.addEventListener('click', async () => {
        const p = row.querySelector('[data-campo=primera]').value.trim();
        const s = row.querySelector('[data-campo=segunda]').value.trim();
        const t = row.querySelector('[data-campo=tercera]').value.trim();
        if (!/^\d{2}$/.test(p) || !/^\d{2}$/.test(s) || !/^\d{2}$/.test(t)) {
          mostrarMsg($('resMsg'), 'Los tres números de ' + lot.nombre + ' deben tener 2 dígitos (00-99).', true); return;
        }
        try {
          await api('saveResultado', { loteriaId: lot.id, fecha, primera: p, segunda: s, tercera: t });
          mostrarMsg($('resMsg'), 'Números de ' + lot.nombre + ' guardados.', false);
        } catch (e) { mostrarMsg($('resMsg'), e.message, true); }
      });
      const btnQ = document.createElement('button');
      btnQ.type = 'button'; btnQ.className = 'btn secundario chico'; btnQ.textContent = 'Quitar';
      btnQ.disabled = !r;
      btnQ.addEventListener('click', async () => {
        if (!r) return;
        try {
          await api('deleteResultado', { id: r.id });
          mostrarMsg($('resMsg'), 'Números de ' + lot.nombre + ' quitados.', false);
          cargarDuenoResultados();
        } catch (e) { mostrarMsg($('resMsg'), e.message, true); }
      });
      row.appendChild(btnG);
      row.appendChild(btnQ);
      cont.appendChild(row);
    });
  } catch (e) { cont.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}

/* ---------- DUEÑO: Banqueras ---------- */
async function cargarBanqueras() {
  const cont = $('listaBanqueras');
  cont.innerHTML = '<p class="muted">Cargando…</p>';
  try {
    const data = await api('listBanqueras');
    const lista = data.banqueras || [];
    if (!lista.length) { cont.innerHTML = '<p class="muted">No hay banqueras todavía.</p>'; return; }
    cont.innerHTML = '';
    lista.forEach((b) => {
      const card = document.createElement('div');
      card.className = 'card';
      card.innerHTML = '<div style="display:flex;justify-content:space-between;align-items:center"><b>' + esc(b.nombre) + '</b><span class="pill ' + (b.activo ? 'activo' : 'anulado') + '">' + (b.activo ? 'Activa' : 'Inactiva') + '</span></div>' +
        '<p class="muted">Usuario: ' + esc(b.usuario) + '</p>' +
        '<label>Nombre de la banca</label><input type="text" data-f="nombre" value="' + esc(b.nombre) + '">' +
        '<label>Usuario</label><input type="text" data-f="usuario" value="' + esc(b.usuario) + '" autocomplete="off">' +
        '<label>Contraseña nueva (vacía = no cambia)</label><input type="password" data-f="contrasena" autocomplete="new-password">';
      const fila = document.createElement('div');
      fila.style.cssText = 'display:flex;gap:8px;margin-top:10px';
      const btnG = document.createElement('button');
      btnG.type = 'button'; btnG.className = 'btn'; btnG.textContent = 'Guardar cambios';
      btnG.addEventListener('click', async () => {
        const args = { id: b.id, nombre: card.querySelector('[data-f=nombre]').value.trim(), usuario: card.querySelector('[data-f=usuario]').value.trim() };
        const pass = card.querySelector('[data-f=contrasena]').value;
        if (pass) args.contrasena = pass;
        try { await api('updateBanquera', args); mostrarMsg($('banqueraMsg'), 'Banquera actualizada.', false); cargarBanqueras(); }
        catch (e) { mostrarMsg($('banqueraMsg'), e.message, true); }
      });
      const btnA = document.createElement('button');
      btnA.type = 'button'; btnA.className = 'btn secundario'; btnA.textContent = b.activo ? 'Desactivar' : 'Activar';
      btnA.addEventListener('click', async () => {
        try { await api('updateBanquera', { id: b.id, activo: b.activo ? 0 : 1 }); mostrarMsg($('banqueraMsg'), 'Acceso ' + (b.activo ? 'desactivado' : 'activado') + '.', false); cargarBanqueras(); }
        catch (e) { mostrarMsg($('banqueraMsg'), e.message, true); }
      });
      fila.appendChild(btnG); fila.appendChild(btnA);
      card.appendChild(fila);
      cont.appendChild(card);
    });
  } catch (e) { cont.innerHTML = '<p class="error">' + esc(e.message) + '</p>'; }
}

/* ---------- Instalar app (PWA) ---------- */
let deferredPrompt = null;
window.addEventListener('beforeinstallprompt', (e) => { e.preventDefault(); deferredPrompt = e; });
async function instalarApp() {
  if (deferredPrompt) {
    deferredPrompt.prompt();
    try { await deferredPrompt.userChoice; } catch (e) { /* ignorar */ }
    deferredPrompt = null;
    return;
  }
  abrirModal('Instalar app en el teléfono',
    '<p class="ayuda-txt"><b>En Android (Chrome):</b></p>' +
    '<p class="ayuda-txt">1. Toca el menú <b>⋮</b> de Chrome (arriba a la derecha).<br>2. Toca <b>"Instalar app"</b> o <b>"Agregar a pantalla principal"</b>.<br>3. Confirma. La app quedará como un ícono en tu teléfono y abrirá a pantalla completa.</p>' +
    '<p class="ayuda-txt"><b>En iPhone (Safari):</b></p>' +
    '<p class="ayuda-txt">1. Toca el botón <b>Compartir</b> (el cuadrado con la flecha).<br>2. Baja y toca <b>"Agregar a inicio"</b>.<br>3. Toca <b>Agregar</b>.</p>' +
    '<p class="ayuda-txt">La app funciona con internet, porque los datos viven en el servidor y se comparten entre todas las sucursales.</p>',
    [{ texto: 'Cerrar', clase: 'btn secundario', fn: cerrarModal }]);
}

/* ---------- Eventos ---------- */
function init() {
  // Login
  $('formLogin').addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = e.target.querySelector('button[type=submit]');
    btn.disabled = true;
    ocultarMsg($('loginError'));
    try {
      const data = await api('login', { usuario: $('loginUsuario').value.trim(), contrasena: $('loginContrasena').value });
      guardarSesion(data.usuario, data.token);
      entrarApp();
    } catch (err) {
      mostrarMsg($('loginError'), err.message || 'Usuario o contraseña incorrectos.', true);
    } finally { btn.disabled = false; }
  });
  $('btnInstalarLogin').addEventListener('click', instalarApp);
  $('btnInstalar').addEventListener('click', instalarApp);

  // Menús
  $('btnMenu').addEventListener('click', abrirDrawer);
  $('drawerFondo').addEventListener('click', cerrarDrawer);
  $('btnPuntos').addEventListener('click', (e) => { e.stopPropagation(); $('menuPuntos').classList.toggle('hidden'); });
  document.addEventListener('click', (e) => {
    if (!$('menuPuntos').classList.contains('hidden') && !e.target.closest('#menuPuntos') && e.target.id !== 'btnPuntos') $('menuPuntos').classList.add('hidden');
  });
  $('menuPuntos').addEventListener('click', (e) => {
    const acc = e.target.closest('button') && e.target.closest('button').dataset.acc;
    if (!acc) return;
    $('menuPuntos').classList.add('hidden');
    if (acc === 'ligar') ligar(false);
    else if (acc === 'ligarAvanzado') ligar(true);
    else if (acc === 'genPale') generar('pale');
    else if (acc === 'genTripleta') generar('tripleta');
    else if (acc === 'auto') jugadaAutomatica();
    else if (acc === 'devuelta') devuelta();
    else if (acc === 'ultimo') ultimoTicketFn();
  });

  // Venta: campos y teclado
  $('inpJugada').addEventListener('focus', () => enfocarCampo('jugada'));
  $('inpMonto').addEventListener('focus', () => enfocarCampo('monto'));
  $('inpJugada').addEventListener('input', actualizarDeteccion);
  $('inpJugada').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); enfocarCampo('monto'); } });
  $('inpMonto').addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); agregarJugada(); } });
  $('teclado').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (b) tecla(b.dataset.k);
  });
  $('modoBtns').addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    modoPlay = b.dataset.modo;
    actualizarDeteccion();
  });
  $('btnCopiar').addEventListener('click', async () => {
    const lot = loteriaSeleccionada();
    const texto = (lot ? lot.nombre + '\n' : '') + jugadas.map((j) => j.numero + '  ' + fmt$(j.monto)).join('\n') +
      (jugadas.length ? '\nTotal: ' + fmt$(totalJugadas()) : '');
    if (!texto) { mostrarMsg($('ventaError'), 'No hay jugadas para copiar.', true); return; }
    try { await navigator.clipboard.writeText(texto); mostrarMsg($('ventaOk'), 'Jugadas copiadas.', false); }
    catch (e) { mostrarMsg($('ventaError'), 'No se pudo copiar. Copia el texto a mano.', true); }
  });
  $('btnLimpiar').addEventListener('click', () => {
    jugadas = [];
    $('inpJugada').value = '';
    $('inpMonto').value = '';
    ocultarMsg($('ventaError')); ocultarMsg($('ventaOk'));
    renderJugadas(); actualizarDeteccion(); enfocarCampo('jugada');
  });
  $('btnVender').addEventListener('click', vender);

  // Tickets
  $('btnPagar').addEventListener('click', pagarTicket);
  $('btnCancelar').addEventListener('click', cancelarTicket);
  $('btnRefrescarTickets').addEventListener('click', cargarTickets);

  // Resultados banquera
  $('fechaResultados').addEventListener('change', cargarResultadosBanquera);

  // Ventas
  $('btnBuscarVentas').addEventListener('click', buscarVentas);

  // Efectivo: recarga
  $('btnRecarga').addEventListener('click', async () => {
    const monto = parseInt($('recargaMonto').value, 10);
    const msg = $('recargaMsg');
    if (!monto || monto <= 0) { mostrarMsg(msg, 'El monto de la recarga debe ser mayor que 0.', true); return; }
    try {
      await api('createRecarga', { monto, nota: $('recargaNota').value.trim() });
      mostrarMsg(msg, 'Recarga de ' + fmt$(monto) + ' registrada.', false);
      $('recargaMonto').value = ''; $('recargaNota').value = '';
      cargarEfectivo();
    } catch (e) { mostrarMsg(msg, e.message, true); }
  });

  // Dueño: tabs
  document.querySelectorAll('#vistaDueno .tabs button').forEach((b) => {
    b.addEventListener('click', () => mostrarTabDueno(b.dataset.tab));
  });
  $('fechaDueno').addEventListener('change', cargarDuenoResultados);
  $('btnCrearBanquera').addEventListener('click', async () => {
    const nombreBanca = $('nuevaBanca').value.trim();
    const usu = $('nuevoUsuario').value.trim();
    const pass = $('nuevaContrasena').value;
    const msg = $('banqueraMsg');
    if (!nombreBanca || !usu || !pass) { mostrarMsg(msg, 'Escribe el nombre de la banca, el usuario y la contraseña.', true); return; }
    try {
      await api('createBanquera', { nombreBanca, usuario: usu, contrasena: pass });
      mostrarMsg(msg, 'Banquera ' + nombreBanca + ' creada.', false);
      $('nuevaBanca').value = ''; $('nuevoUsuario').value = ''; $('nuevaContrasena').value = '';
      cargarBanqueras();
    } catch (e) { mostrarMsg(msg, e.message, true); }
  });
  $('btnGuardarCuenta').addEventListener('click', async () => {
    const args = { nombre: $('miNombre').value.trim(), usuario: $('miUsuario').value.trim() };
    const pass = $('miContrasena').value;
    if (pass) args.contrasena = pass;
    const msg = $('cuentaMsg');
    try {
      const data = await api('updateMiCuenta', args);
      usuario = data.usuario || usuario;
      localStorage.setItem('banca_usuario', JSON.stringify(usuario));
      $('miContrasena').value = '';
      mostrarMsg(msg, 'Tu cuenta fue actualizada.', false);
    } catch (e) { mostrarMsg(msg, e.message, true); }
  });

  // Modal: cerrar al tocar el fondo
  $('modalFondo').addEventListener('click', (e) => { if (e.target === $('modalFondo')) cerrarModal(); });

  // Fechas por defecto
  const f = $('fechaResultados'); if (!f.value) f.value = hoyISO();
  const fd = $('fechaDueno'); if (!fd.value) fd.value = hoyISO();
  const vd = $('ventasDesde'); if (!vd.value) vd.value = hoyISO();
  const vh = $('ventasHasta'); if (!vh.value) vh.value = hoyISO();

  renderJugadas();
  restaurarSesion();
}
document.addEventListener('DOMContentLoaded', init);
