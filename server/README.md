# Banca de Lotería — Servidor público

Reimplementación independiente desde `../SPEC.md`. Node.js, con una sola
dependencia: `@libsql/client` (base de datos libSQL/Turso). Sin framework.
Base de datos: Turso (libSQL remoto, persistente) si se definen
`TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN`; si no, archivo SQLite local
(`banca.db` junto al servidor, o `DB_PATH`).

## Arrancar

```bash
cd server
node server.js            # puerto 8080 por defecto
PORT=3000 node server.js  # otro puerto
```

El servidor escucha en `0.0.0.0`. Sirve el cliente web de `../client/` en `/`
(si esa carpeta aún no existe, arranca igual y responde 404 en `/` sin caerse)
y expone la API en `POST /actions`.

Variables de entorno:

| Variable | Por defecto | Uso |
|---|---|---|
| `PORT` | `8080` | Puerto de escucha (Render lo inyecta) |
| `DB_PATH` | `banca.db` (junto a `server.js`) | Ruta del archivo SQLite local (modo sin Turso; útil para pruebas) |
| `TURSO_DATABASE_URL` | — | URL de la base Turso, `libsql://<base>-<org>.turso.io`. Si se define, la base es Turso (persistente). |
| `TURSO_AUTH_TOKEN` | — | Token de acceso a la base Turso (secreto; se pone en Render, no en el repo). |

Al arrancar con una base vacía se siembra:

- Dueño: usuario `admin`, contraseña `admin` (guardada como hash SHA-256 hex),
  nombre "Banca", rol `dueno`.
- Las loterías del SPEC con sus horas (todas abren 06:00 AM, hora de Santo
  Domingo), incluidas las 15 de Anguila (7:55 AM – 9:55 PM, una cada hora).
- Ajustes: `nombre_banca` = "Mi Banca", `ancho_papel` = "58", `impresora` = "".

## API — `POST /actions`

Cuerpo JSON: `{"action": "...", "args": {...}}`.
Respuesta siempre JSON: `{"ok": true, ...datos}` o `{"ok": false, "error": "..."}`.
Todas las acciones salvo `login` requieren `args.token` (sesión). La banquera
solo ve y opera **su banca**; el dueño ve todas.

### Ejemplos con curl

Primero, guarda el token (aquí se usa `jq`; sin `jq`, copia el token a mano):

```bash
BASE=http://localhost:8080/actions
TOKEN=$(curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d '{"action":"login","args":{"usuario":"admin","contrasena":"admin"}}' | jq -r .token)
```

#### 1. `login`

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d '{"action":"login","args":{"usuario":"admin","contrasena":"admin"}}'
# -> {"ok":true,"token":"...","usuario":{"id":1,"nombre":"Banca","usuario":"admin","rol":"dueno","banca":"Banca"}}
# Contraseña mala -> {"ok":false,"error":"Usuario o contraseña incorrectos."}
```

#### 2. `getLoterias`

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"getLoterias\",\"args\":{\"token\":\"$TOKEN\"}}"
# -> {"ok":true,"loterias":[{"id":1,"nombre":"Loteka Noche","abre":"06:00","cierra":"19:55","abierta":true,"abreTexto":"Abre a las 6:00 AM"}, ...]}
```

#### 3. `createTicket` — vender

```bash
# Quiniela 07, RD$10 (lotería 1 = Loteka Noche; usar una lotería abierta a esa hora)
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"createTicket\",\"args\":{\"token\":\"$TOKEN\",\"loteriaId\":1,\"jugadas\":[{\"tipo\":\"quiniela\",\"numero\":\"07\",\"monto\":10}]}}"
# -> {"ok":true,"ticket":{"id":1,"folio":"000001","codigo":"ABC123","loteria":"Loteka Noche","fecha":"2026-11-24","hora":"...","total":10,"jugadas":[...]}}
# Lotería cerrada -> {"ok":false,"error":"La lotería X está cerrada. Abre a las 6:00 AM y cierra a las 7:55 PM."}
# Tipos por dígitos: quiniela 2, palé 4 ("0230"), tripleta 6 ("012030"),
# Play 3 3 ("123", modo ST/BX), Play 3 Back "-123", Play 4 "-1234".
# Atajo Box: "123." = Play 3 Box. Monto debe ser > 0.
```

#### 4. `listTickets`

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"listTickets\",\"args\":{\"token\":\"$TOKEN\",\"desde\":\"2026-11-24\",\"hasta\":\"2026-11-24\"}}"
```

#### 5. `getUltimoTicket`

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"getUltimoTicket\",\"args\":{\"token\":\"$TOKEN\"}}"
```

#### 6. `voidTicket` / `voidTicketByFolio` — anular (exigen el código del papel)

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"voidTicket\",\"args\":{\"token\":\"$TOKEN\",\"folio\":\"000001\",\"codigo\":\"ABC123\"}}"
# Ticket pagado -> {"ok":false,"error":"Ya está pagado."}
# Código malo -> {"ok":false,"error":"El código no coincide con el ticket."}
```

#### 7. `payTicket` — pagar (exige el código del papel)

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"payTicket\",\"args\":{\"token\":\"$TOKEN\",\"folio\":\"000001\",\"codigo\":\"ABC123\"}}"
# -> {"ok":true,"ticket":{...,"estado":"pagado"},"premio":800}
# Segundo pago -> {"ok":false,"error":"Ya está pagado."}
# Sin premio -> {"ok":false,"error":"Este ticket no tiene premio."}
```

#### 8. `getResultados`

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"getResultados\",\"args\":{\"token\":\"$TOKEN\",\"fecha\":\"2026-11-24\"}}"
```

#### 9. `saveResultado` — solo dueño (upsert por lotería + fecha)

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"saveResultado\",\"args\":{\"token\":\"$TOKEN\",\"loteriaId\":1,\"fecha\":\"2026-11-24\",\"primera\":\"07\",\"segunda\":\"15\",\"tercera\":\"23\"}}"
```

#### 10. `deleteResultado` — solo dueño

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"deleteResultado\",\"args\":{\"token\":\"$TOKEN\",\"id\":1}}"
```

#### 11. `getPremiados`

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"getPremiados\",\"args\":{\"token\":\"$TOKEN\",\"fecha\":\"2026-11-24\"}}"
# -> {"ok":true,"premiados":[{"ticket":{...},"jugadas":[{"tipo":"quiniela","numero":"07","monto":10,"premio":800,"detalle":"Quiniela en 1ra"}],"total_premio":800}]}
```

#### 12. `getEfectivo`

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"getEfectivo\",\"args\":{\"token\":\"$TOKEN\",\"fecha\":\"2026-11-24\"}}"
# -> {"ok":true,"vendido":...,"premios":...,"balance":...,"numTickets":...,"numPagados":...,"totalPagado":...}
# balance = vendido - premios (puede ser negativo, "en pérdida").
# premios = premios a pagar del día (premiados, pagados o no). totalPagado = premio de los tickets ya pagados.
```

#### 13. `getResumen`

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"getResumen\",\"args\":{\"token\":\"$TOKEN\",\"desde\":\"2026-11-24\",\"hasta\":\"2026-11-24\"}}"
# -> {"ok":true,"total_vendido":...,"total_pagado":...,"total_neto":...,"num_tickets":...,
#     "por_loteria":[{"loteria":"...","numTickets":...,"total":...}],
#     "por_banca":[{"banca":"...","total_vendido":...,"total_pagado":...,"total_neto":...}]}
# total_pagado = premios a pagar del rango (premiados, pagados o no); total_neto = vendido - total_pagado.
```

#### 14. `createRecarga`

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"createRecarga\",\"args\":{\"token\":\"$TOKEN\",\"monto\":500,\"nota\":\"recarga\"}}"
```

#### 15. `listRecargas`

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"listRecargas\",\"args\":{\"token\":\"$TOKEN\",\"desde\":\"2026-11-24\",\"hasta\":\"2026-11-24\"}}"
```

#### 16. `getAjustes`

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"getAjustes\",\"args\":{\"token\":\"$TOKEN\"}}"
```

#### 17. `createBanquera` — solo dueño

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"createBanquera\",\"args\":{\"token\":\"$TOKEN\",\"nombreBanca\":\"Banca María\",\"usuario\":\"maria\",\"contrasena\":\"1234\"}}"
```

#### 18. `listBanqueras` — solo dueño

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"listBanqueras\",\"args\":{\"token\":\"$TOKEN\"}}"
```

#### 19. `updateBanquera` — solo dueño

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"updateBanquera\",\"args\":{\"token\":\"$TOKEN\",\"id\":2,\"nombre\":\"Banca María 2\",\"activo\":1}}"
# Campos opcionales: usuario, contrasena, nombre, activo.
```

#### 20. `updateMiCuenta` — solo dueño

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"updateMiCuenta\",\"args\":{\"token\":\"$TOKEN\",\"contrasena\":\"nueva123\"}}"
```

#### 21. `saveAjustes` — solo dueño (acción extra del SPEC)

```bash
curl -s -X POST $BASE -H 'Content-Type: application/json' \
  -d "{\"action\":\"saveAjustes\",\"args\":{\"token\":\"$TOKEN\",\"ajustes\":{\"nombre_banca\":\"Mi Banca\",\"telefono\":\"809-555-0100\"}}}"
```

## Motor de premios (exacto del SPEC)

Resultado: primera, segunda, tercera (2 dígitos).

| Jugada | Premio |
|---|---|
| Quiniela en 1ra / 2da / 3ra | 80× / 8× / 4× el monto |
| Palé 1ra+2da | 1500× |
| Palé 2da+3ra | 100× |
| Tripleta completa | 20000× |
| Tripleta dos patas 1ra+2da / 1ra+3ra | 500× |
| Tripleta dos patas 2da+3ra | 100× |
| Play 3 / Play 3 Back / Play 4 | 0 — "Premio por confirmar" |

## Pendientes (del SPEC, NO resueltos aquí)

- Matemática de premios de Play 3 / Play 3 Back / Play 4 — **POR CONFIRMAR**.
  El servidor devuelve premio 0 con detalle "Premio por confirmar".
- Horas de cierre de QP Noche, LTK, Florida Tarde y Primera Tarde — **POR CONFIRMAR**
  (sembradas en 19:55 / 15:00 según el SPEC, a revisar).
- Palé en 1ra+3ra: hoy paga 0 — **POR CONFIRMAR** si paga y cuánto.
- La URL pública del túnel cambia cada vez que se reinicia; la APK lleva la URL
  configurable.

## Pruebas

Las pruebas usan una base aparte (`banca.test.db`, variable `DB_PATH`); nunca
tocan `banca.db` de producción:

```bash
cd server
DB_PATH=./banca.test.db PORT=18080 node server.js &
# ... correr las pruebas (ver test.sh) ...
kill %1
```

Ver `test.sh` para la suite completa (login, ventas, resultados, premiados,
pago, anulación, efectivo/resumen, banqueras y cambio de contraseña).
