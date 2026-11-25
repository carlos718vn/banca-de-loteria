# SPEC — Banca de Lotería pública (puerto independiente)

## Objetivo
Reimplementación independiente (puerto, NO copia) de la app "Banca de Lotería" para que
funcione fuera de Muse: un servidor público gratis + una APK Android (WebView).
Cada banquera con su banca es una sucursal; todas comparten los mismos datos en vivo:
los números ganadores que pone el dueño llegan a todas las sucursales, y los reportes
de ventas de cada sucursal llegan al dueño.

## PROHIBIDO
- NO leer, copiar ni abrir nada de `~/workspace/ts-spaces/banca-de-loteria/` (son los
  archivos del artefacto original). Reimplementar SOLO desde este SPEC.
- NO crear cuentas en ningún servicio ni usar tarjetas. Todo gratis y sin cuentas.
- NO inventar reglas de premios ni horarios: usar solo los de este SPEC. Lo que está
  marcado "POR CONFIRMAR" se deja como está indicado y se anota como pendiente.

## Arquitectura
- Directorio del proyecto: `~/workspace/banca-de-loteria-public/`
  - `server/` — Node.js 24 (sin dependencias externas salvo las imprescindibles),
    SQLite con `node:sqlite` (ya verificado que funciona), base de datos `banca.db`.
  - `client/` — aplicación web de una sola página (HTML + CSS + JS, sin build),
    servida como archivos estáticos por el mismo servidor.
- El servidor sirve el cliente en `/` y expone la API en `POST /actions`.
- El cliente usa rutas RELATIVAS (`fetch('./actions')` o `fetch('/actions')`), NUNCA
  `localhost` ni una URL fija, para que funcione en cualquier host.
- Zona horaria: America/Santo_Domingo (UTC-4). Todas las fechas/horas de negocio se
  calculan en esa zona. Fecha de negocio: `YYYY-MM-DD`. Hora: `HH:MM:SS` (24 h).

## Modelo de datos (SQLite, tablas y columnas)
- `usuarios`: id INTEGER PK, nombre TEXT (nombre de la banca para banqueras; nombre
  del dueño para el dueño), usuario TEXT UNIQUE, contrasena TEXT (guardar SHA-256 hex,
  NUNCA en texto claro), rol TEXT ('dueno' | 'banquera'), activo INTEGER (1/0),
  creado_en TEXT.
- `loterias`: id INTEGER PK, nombre TEXT, abre TEXT ('HH:MM'), cierra TEXT ('HH:MM'),
  orden INTEGER.
- `resultados`: id INTEGER PK, loteria_id INTEGER, fecha TEXT ('YYYY-MM-DD'),
  primera TEXT (2 dígitos), segunda TEXT, tercera TEXT. Único por (loteria_id, fecha).
- `tickets`: id INTEGER PK, folio TEXT UNIQUE (6 dígitos con ceros, 000001...),
  codigo TEXT (6 caracteres A-Z0-9, único, impreso en el papel), loteria_id INTEGER,
  usuario_id INTEGER (quién vendió), banca TEXT (nombre de la banca), fecha TEXT,
  hora TEXT, total INTEGER (RD$, suma de montos), estado TEXT
  ('activo' | 'anulado' | 'pagado'), pagado_at TEXT NULL.
- `jugadas`: id INTEGER PK, ticket_id INTEGER, tipo TEXT
  ('quiniela' | 'pale' | 'tripleta' | 'play3' | 'play3back' | 'play4'),
  numero TEXT (tal como se jugó: '07', '0230', '012030', '123', '-123', '-1234'),
  modo TEXT NULL ('ST' | 'BX' solo para play3/play4), monto INTEGER (RD$).
- `recargas`: id INTEGER PK, usuario_id INTEGER, banca TEXT, monto INTEGER,
  nota TEXT, fecha TEXT, hora TEXT.
- `ajustes`: id INTEGER PK, clave TEXT UNIQUE, valor TEXT. (Claves: nombre_banca,
  telefono, direccion, mensaje_ticket, ancho_papel ('58' por defecto), impresora).
- `sesiones`: token TEXT PK, usuario_id INTEGER, creado_en TEXT.

## API — POST /actions, cuerpo JSON {action, args}
Respuesta siempre JSON: `{ok:true, ...datos}` o `{ok:false, error:"mensaje"}`.
Todas las acciones salvo `login` requieren `args.token` válido (sesión). El rol se
deriva del token. La banquera solo ve y opera SU banca; el dueño ve todas.

1. `login` {usuario, contrasena} → {ok, token, usuario:{id, nombre, usuario, rol, banca}}
   Error si no existe, contraseña mala o banquera inactiva: "Usuario o contraseña incorrectos."
2. `getLoterias` {token} → {ok, loterias:[{id, nombre, abre, cierra, abierta, abreTexto}]}
   `abierta` = abre <= ahora < cierra (hora de Santo Domingo). `abreTexto` = "Abre a las 6:00 AM"
   o "Cerrada · abre 6:00 AM" según el caso.
3. `createTicket` {token, loteriaId, jugadas:[{tipo, numero, modo, monto}]} →
   {ok, ticket:{id, folio, codigo, loteria, fecha, hora, total, jugadas}}.
   Rechazar si la lotería está cerrada: "La lotería X está cerrada. Abre a las 6:00 AM y
   cierra a las 7:55 PM." Validar tipos por dígitos (ver Reglas de jugadas).
4. `listTickets` {token, desde, hasta} → {ok, tickets:[{id, folio, codigo, loteria,
   banca, fecha, hora, total, estado, jugadas:[{tipo, numero, modo, monto}]}]}.
   Banquera: solo su banca. Dueño: todas.
5. `getUltimoTicket` {token} → {ok, ticket|null} (último ticket de la banca del que llama).
6. `voidTicket` {token, folio, codigo} → {ok, ticket}. Requiere el código del papel.
   Rechazar si ya está pagado ("Ya está pagado") o ya anulado.
   `voidTicketByFolio` {token, folio, codigo} → idéntico (alias, también exige código).
7. `payTicket` {token, folio, codigo} → {ok, ticket, premio}. Requiere el código del
   papel. Rechazar si anulado, si ya pagado ("Ya está pagado") o si no tiene premio
   ("Este ticket no tiene premio"). Marca estado='pagado', pagado_at=ahora. `premio` es
   el total a pagar (ver Motor de premios).
8. `getResultados` {token, fecha} → {ok, resultados:[{id, loteriaId, loteria, fecha,
   primera, segunda, tercera}]}. Fecha por defecto: hoy.
9. `saveResultado` {token, loteriaId, fecha, primera, segunda, tercera} → {ok, resultado}.
   SOLO dueño. Upsert por (loteriaId, fecha). Números de 2 dígitos (00-99).
10. `deleteResultado` {token, id} → {ok}. SOLO dueño.
11. `getPremiados` {token, fecha} → {ok, premiados:[{ticket, jugadas:[{tipo, numero,
    modo, monto, premio, detalle}], total_premio}]}. Solo tickets con premio > 0.
    `detalle` es texto como "Quiniela en 1ra", "Palé ganador (1ra y 2da)",
    "Tripleta con dos patas (1ra y 3ra)". Banquera: su banca. Dueño: todas.
12. `getEfectivo` {token, fecha} → {ok, vendido, premios, balance, numTickets,
    numPagados, totalPagado}. vendido = suma de tickets activos+pagados del día (sin
    anulados). premios = suma de premios a pagar del día (tickets premiados, estén
    pagados o no). balance = vendido - premios (puede ser negativo).
13. `getResumen` {token, desde, hasta} → {ok, total_vendido, total_pagado, total_neto,
    num_tickets, por_loteria:[{loteria, numTickets, total}],
    por_banca:[{banca, total_vendido, total_pagado, total_neto}]}.
    `por_banca` solo tiene sentido para el dueño (todas las sucursales); para la
    banquera es su banca. Totales netos del rango (NO día por día).
14. `createRecarga` {token, monto, nota} → {ok, recarga}. Registra una recarga.
15. `listRecargas` {token, desde, hasta} → {ok, recargas:[{id, monto, nota, fecha, hora, banca}]}.
16. `getAjustes` {token} → {ok, ajustes:{...}}.
17. `createBanquera` {token, nombreBanca, usuario, contrasena} → {ok, banquera}.
    SOLO dueño. Crea usuarios rol='banquera', activo=1.
18. `listBanqueras` {token} → {ok, banqueras:[{id, nombre, usuario, activo}]}. SOLO dueño.
19. `updateBanquera` {token, id, usuario?, contrasena?, nombre?, activo?} → {ok}.
    SOLO dueño. `nombre` es el nombre de la banca.
20. `updateMiCuenta` {token, nombre?, usuario?, contrasena?} → {ok, usuario}.
    El dueño cambia su propio nombre, usuario y contraseña.
21. `saveAjustes` {token, ajustes:{...}} → {ok}. SOLO dueño. (Acción extra para que el
    dueño pueda cambiar ajustes; el cliente no tiene que exponerla en la v1.)

## Reglas de jugadas (detección por dígitos, el cliente la aplica al escribir)
- 2 dígitos → quiniela. 4 dígitos → palé (dos números de 2). 6 dígitos → tripleta
  (tres números de 2). 3 dígitos → Play 3 (luego elegir ST o BX con "/").
  "-" + 3 dígitos → Play 3 Back. "-" + 4 dígitos → Play 4 (ST/BX con "/").
  Atajo Box: número + "." (ej. "123." = Play 3 Box, "-1234." = Play 4 Box).
- Flujo: número → Enter → monto → Enter → se agrega. Teclado numérico en pantalla
  con 1-9, "-", "0", ".", borrar y ENTER grande.
- Monto debe ser > 0. Validar en servidor y cliente.

## Motor de premios (servidor; se usa en getPremiados, payTicket, getEfectivo, getResumen)
Resultado del sorteo: primera, segunda, tercera (2 dígitos cada una).
- Quiniela (2 dígitos, coincidencia EXACTA): numero == primera → 80 × monto;
  == segunda → 8 × monto; == tercera → 4 × monto; si no → 0.
- Palé (4 dígitos = n1+n2): n1==primera && n2==segunda → 1500 × monto;
  n1==segunda && n2==tercera → 100 × monto; en cualquier otro caso → 0.
  (Si solo sale un número, NO está premiado. Palé en 1ra+3ra → 0 por ahora:
  POR CONFIRMAR con el usuario si paga y cuánto.)
- Tripleta (6 dígitos = a+b+c): a==primera && b==segunda && c==tercera → 20000 × monto;
  si no, dos patas: a==primera && b==segunda → 500 × monto;
  a==primera && c==tercera → 500 × monto; b==segunda && c==tercera → 100 × monto;
  si no → 0. (Comprobar la completa primero.)
- Play 3 / Play 3 Back / Play 4: MATEMÁTICA POR CONFIRMAR con el usuario. El servidor
  devuelve premio 0 con detalle "Premio por confirmar" y NO los marca como ganadores.
  Anotar como pendiente, no inventar multiplicadores.

## Horarios (todas abren 06:00 AM, hora de Santo Domingo; cierra = fin de venta)
- Loteka Noche 19:55 · Primera Día 12:00 · Primera Noche 19:55 · LoteDom 12:00
- La Suerte Día 12:25 · La Suerte Noche 17:50 · Real Día 12:55 · Real Noche 19:55
- Nacional Tarde 14:30 · Nacional Noche 20:50 · Gana Más 14:30 · LEIDSA Noche 20:55
  (LEIDSA Día NO existe, no sembrarla)
- QP Noche 19:55 (POR CONFIRMAR) · LTK 19:55 (POR CONFIRMAR)
- NY Tarde 15:20 · NY Noche 23:00 · Florida AM 14:20 · Florida Noche 22:20
- Florida Tarde 19:55 (POR CONFIRMAR) · Primera Tarde 15:00 (POR CONFIRMAR)
- Anguila: 15 sorteos aparte, uno cada hora: "Anguila 7:55 AM" abre 06:00 cierra 07:55;
  "Anguila 8:55 AM" abre 07:55 cierra 08:55; así hasta "Anguila 9:55 PM" abre 20:55
  cierra 21:55. Después de las 21:55 queda cerrada hasta las 06:00 del otro día.
  (La venta de cada sorteo abre cuando cierra el anterior.)
- Las horas valen igual todos los días (no hay calendario dominical aparte).

## Semilla inicial (al crear la base de datos vacía)
- Usuario dueño: usuario `admin`, contraseña `admin` (guardar su hash SHA-256),
  nombre "Banca", rol 'dueno', activo 1.
- Loterías: sembrar la lista de Horarios de arriba (con sus horas de apertura/cierre).
- ajustes: nombre_banca "Mi Banca", ancho_papel "58", impresora "".
- NO sembrar tickets ni resultados de prueba en la base de producción. (Para las
  pruebas locales, usar una base aparte `banca.test.db`.)

## Cliente (pantallas y comportamiento)
Estilo: verde como la app original (encabezado verde, cuadro verde con el total),
celular, en español. Inicio de sesión (usuario/contraseña). Según el rol:
- BANQUERA: solo vender. Pantalla de venta: encabezado con menú, nombre de la banca
  y el cuadro verde con el Total grande (venta del día menos premios del día; en rojo
  con rótulo "en pérdida" si es negativo) y adentro en chiquito "Venta $X" y "Premio $X".
  Selector de lotería con su horario ("LOTEKA NOCHE 06:00 AM - 07:55 PM") y sello
  "Cerrada" fuera de hora. Casillas Jugada (####) y Monto ($). Botones COPIAR, LIMPIAR,
  VENDER. Columnas Quinielas / Palés / Tripletas. Teclado numérico con Enter y Borrar.
  Menú lateral: Lotería (vender), Tickets, Tickets Premiados, Números Ganadores (SOLO
  lectura: ve los números que puso el dueño o "aún no están"), Ventas (reporte con
  filtro Desde/Hasta + botón "Imprimir reporte"), Efectivo, Cuadre General, Ayuda,
  Salir. NO hay Configuraciones ni editor de loterías para la banquera.
  - "Pagar un ticket": #Ticket + #Serial (código del papel). "Cancelar ticket":
    #Ticket + #Serial. Sin el código correcto no se anula ni se paga.
  - Ticket: al vender, mostrar el ticket en papel (folio, código, fecha/hora, jugadas,
    total) con Guardar imagen / Compartir (imagen PNG del ticket, 58mm) para la
    impresora térmica por Bluetooth.
  - Imprimir reporte (en Ventas): abre el ticket del reporte en papel con Guardar
    imagen / Compartir. El ticket trae SOLO el resumen neto del rango (rango de fechas,
    Venta total, Premios, TOTAL con "EN PÉRDIDA" si es negativo, cantidad de tickets y
    desglose por lotería). NADA día por día.
  - Ligar / Ligar Avanzado en el menú ⋮ (combinar quinielas en palés), Generar Palé,
    Generar Tripleta, Jugada Automática, Devuelta (calculadora de cambio), Último Ticket.
  - Ayuda: reglas (quiniela 2 dígitos, palé 4, tripleta 6, Play 3 de 3 con ST/BX,
    Play 4 con guión y 4 con ST/BX, atajo Box con "+"/".").
  - La pantalla se actualiza sola cada 15 segundos (para que los números ganadores
    del dueño le lleguen de una vez).
- DUEÑO: panel sin reportes, con pestañas: "Números ganadores" (poner, corregir o
  quitar los números de cada sorteo por día; se reflejan de una vez en la banquera),
  "Banqueras" (agregar con nombre de banca + usuario + contraseña; editar usuario,
  contraseña, nombre de banca y activar/desactivar acceso) y "Mi cuenta" (cambiar su
  propio nombre, usuario y contraseña).
- Manifest PWA + íconos (192/512) para "Agregar a pantalla principal". Botón
  "Instalar app en el teléfono" con los pasos.
- El ticket ganador le sale a la banquera como premiado con lo que hay que pagarle, y
  ese monto se rebaja del total. NO hay ninguna casilla aparte que diga "pérdida".

## Servidor (requisitos)
- Node.js 24, sin framework pesado (usar el módulo `http` incorporado). SQLite con
  `node:sqlite` (DatabaseSync). Un solo archivo de base de datos `banca.db` junto al
  servidor. Crear las tablas si no existen y sembrar loterías + admin si están vacías.
- Puerto configurable por variable de entorno `PORT` (por defecto 8080). Escuchar en
  0.0.0.0. Servir los archivos de `client/` y responder `POST /actions`.
- Validar en el servidor: lotería abierta, tipos por dígitos, monto > 0, rol para
  acciones de dueño, código del ticket para anular/pagar. Errores claros en español.
- Folio secuencial por día o global con 6 dígitos (000001...). Código de 6 caracteres
  (A-Z, 0-9, sin caracteres confusos como 0/O y 1/I) generado con `crypto.randomInt`,
  único (reintentar si choca).
- Escribir un `README.md` con cómo arrancar el servidor y cómo probar cada acción
  con curl. Probar de punta a punta con la base de pruebas (no tocar banca.db de
  producción): login, vender quiniela/palé/tripleta, poner resultado, verificar
  premiados y que el balance cuadre.

## Pendientes que NO se resuelven aquí (anotar en el README y en el reporte)
- Matemática de premios de Play 3 / Play 3 Back / Play 4 (POR CONFIRMAR).
- Horas de cierre de QP Noche, LTK, Florida Tarde y Primera Tarde (POR CONFIRMAR).
- Palé en 1ra+3ra: hoy paga 0 (POR CONFIRMAR si paga y cuánto).
- La URL pública del túnel cambia cada vez que se reinicia; la APK lleva la URL
  configurable (ver SPEC de la APK en el reporte final, no en este SPEC).
