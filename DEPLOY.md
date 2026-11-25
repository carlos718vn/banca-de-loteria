# Despliegue en Render (gratis) — Banca de Lotería

El servidor ya está listo para Render: lee el puerto de `PORT`, escucha en
`0.0.0.0`, y la base de datos es Turso (libSQL, persistente). Este documento
lista los pasos exactos que faltan. **No se crea ninguna cuenta aquí**: los
pasos que piden cuenta los hace el usuario.

## Cuentas que hacen falta (todas gratis, sin tarjeta)

| Cuenta | Para qué | Estado |
|---|---|---|
| Render | Alojar el servidor (Web Service gratis) | **Ya creada** por el usuario |
| GitHub | Guardar el código para que Render lo tome | **Pendiente: crearla** (gratis, sin tarjeta) |
| Turso | La base de datos persistente (libSQL) | **Pendiente: crearla** (gratis, sin tarjeta; se entra con GitHub) |

## Paso 1 — Subir el código a GitHub (usuario)

1. Crear cuenta gratis en https://github.com/signup (solo correo y contraseña).
2. Crear un repositorio nuevo (público o privado, da igual) llamado
   `banca-de-loteria`.
3. Subir el contenido de `~/workspace/banca-de-loteria-public/` al repo:
   - La forma fácil: en la página del repo, "Add file" → "Upload files" y
     subir las carpetas `server/`, `client/`, y los archivos `render.yaml`,
     `SPEC.md`, `DEPLOY.md`.
   - O con git (si lo tiene instalado): `git clone` del repo vacío, copiar
     los archivos, `git add .`, `git commit -m "Banca de Lotería"`,
     `git push`.
   - No subir `node_modules/` ni `banca.db` (ya están ignorados por
     `.gitignore`).

## Paso 2 — Crear la base de datos en Turso (usuario)

1. Entrar a https://turso.tech y crear la cuenta gratis (con GitHub).
2. Crear una base de datos llamada `banca-de-loteria` (región cercana,
   por ejemplo `iad` — Virginia, EE. UU. — o la que ofrezca por defecto).
3. Conseguir los dos valores (en el panel de Turso, en la base creada):
   - **URL**: se ve como `libsql://banca-de-loteria-<usuario>.turso.io`
   - **Token**: en la base, "Create token" (o `turso db tokens create`).
     Es un secreto: no se pega en el chat, se pone directo en Render.
4. Guardar esos dos valores para el Paso 3.

Límites del plan gratis de Turso (verificados nov 2026): 100 bases, 5 GB de
almacenamiento, 500 millones de filas leídas y 10 millones escritas por mes,
sin tarjeta y sin vencimiento. La app usa una fracción mínima de eso.
Aviso: una base sin uso por 10 días se archiva (se restaura desde el panel,
no se borra). Como la banca vende todos los días, no debería pasar.

## Paso 3 — Crear el servicio en Render (usuario)

1. Entrar a https://dashboard.render.com (cuenta ya creada).
2. **New +** → **Web Service** → conectar el repositorio de GitHub
   `banca-de-loteria` (Render pide autorizar el acceso a GitHub la primera
   vez).
3. Configuración del servicio:
   - **Name**: `banca-de-loteria`
   - **Root Directory**: `server`
   - **Runtime**: Node
   - **Build Command**: `npm install`
   - **Start Command**: `npm start`
   - **Plan**: Free
   - (Ojo: el archivo `render.yaml` de este repo ya trae estos valores; si
     Render ofrece crear por Blueprint, también vale y pide lo mismo.)
4. **Environment Variables** (botón "Add Environment Variable"):
   - `TURSO_DATABASE_URL` = la URL de Turso del Paso 2
   - `TURSO_AUTH_TOKEN` = el token de Turso del Paso 2 (marcarlo secreto)
   - Render pone `PORT` solo.
5. **Create Web Service**. El primer despliegue tarda unos minutos.
   La URL pública será algo como
   `https://banca-de-loteria.onrender.com`.

Notas del plan gratis de Render: el servicio **duerme tras 15 minutos sin
tráfico** y tarda ~1 minuto en despertar con la primera visita. Mientras la
banca lo usa, se mantiene despierto (la app se actualiza sola cada 15 s).
No se usa la base Postgres gratis de Render porque **expira a los 30 días
y se borra con todos los datos**; por eso la base es Turso.

## Paso 4 — Verificar que está en vivo

1. Abrir la URL pública en el navegador: debe cargar la pantalla de inicio
   de sesión de la banca.
2. Entrar con `admin` / `admin` (la siembra inicial; cambiar la contraseña
   en "Mi cuenta" del panel del dueño).
3. Probar una venta y un reporte. Si algo falla, revisar los logs del
   servicio en el panel de Render.

## Paso 5 — Migrar los datos vivos del artefacto (Muse, no el usuario)

Los tickets, banqueras y resultados que ya existen en la app del artefacto
NO se copian solos: el servidor nuevo arranca vacío (solo admin y las 35
loterías). Para traerlos:

```bash
cd server
TURSO_DATABASE_URL=libsql://... TURSO_AUTH_TOKEN=... \
  node migrate.mjs /ruta/a/app.db
```

- El origen es el archivo `app.db` del artefacto original.
- La migración mapea loterías por nombre y usuarios por nombre de usuario;
  las sesiones no se migran (cada quien vuelve a entrar).
- Debe correrse **antes de vender** en el servidor nuevo, sobre la base
  Turso recién creada. El script reporta cuántos copió y cuáles saltó.
- Verificar después: entrar como dueño y revisar Tickets y Ventas.

## Paso 6 — APK con la URL de Render (Muse)

Reconstruir la APK apuntando a la URL pública de Render (la del Paso 3) y
verificar de punta a punta (login, venta, resultado, premiados, reportes)
antes de entregarla. La APK anterior apuntaba al túnel de Cloudflare, que
no se puede correr desde esta máquina.

## Resumen de lo que falta (checklist)

- [ ] Cuenta de GitHub creada + código subido (Paso 1)
- [ ] Cuenta de Turso creada + base + URL y token (Paso 2)
- [ ] Web Service creado en Render con las 2 variables (Paso 3)
- [ ] URL pública verificada (Paso 4)
- [ ] Migración de datos vivos del artefacto (Paso 5)
- [ ] APK reconstruida con la URL de Render y verificada (Paso 6)
