# Gastos — Organizador Financiero

[![Tests](https://github.com/maurocampilongo/OrganizadorFinanciero/actions/workflows/test.yml/badge.svg)](https://github.com/maurocampilongo/OrganizadorFinanciero/actions/workflows/test.yml)

PWA minimalista y mobile-first para cargar gastos personales desde el celular.
La foto del ticket se procesa con **Gemini 3.8 Flash** (con respaldo automático) y el gasto se guarda en un
**Google Sheet** propio, sin AppSheet ni planillas de terceros.

- Frontend: HTML + CSS + JavaScript puro (sin frameworks ni build).
- Backend: Google Apps Script (`doPost`) + Google Sheets + API REST de Gemini.
- Auth: Google Identity Services; el backend valida el `idToken` en cada request.
- Instalable en Android como app independiente (manifest + service worker).

> 📘 **¿Primera vez?** Seguí **[PASO_A_PASO.md](PASO_A_PASO.md)**: 11 pasos con
> puntos de control, valores exactos y qué hacer ante cada error. Este README es
> la referencia técnica y el resumen.

**PWA publicada:** https://maurocampilongo.github.io/OrganizadorFinanciero/

```
┌─────────────────────────┐        POST (JSON, text/plain)      ┌──────────────────────────┐
│  Celular / PWA          │ ──────────────────────────────────► │  Apps Script Web App     │
│  · login Google (GIS)   │                                     │  · valida idToken        │
│  · foto → canvas 1024px │ ◄──────── { ok, data } ───────────  │  · Gemini 2.5 Flash      │
│  · formulario 5 campos  │                                     │  · appendRow en Sheets   │
└─────────────────────────┘                                     └──────────────────────────┘
```

## Estructura del repositorio

```
.
├── frontend/
│   ├── index.html          # UI + lógica (APP_CONFIG arriba de todo)
│   ├── manifest.json       # PWA standalone, paths relativos
│   ├── sw.js               # Service Worker (shell offline)
│   └── icons/              # 192/512 para "any" y "maskable"
├── PASO_A_PASO.md          # guía de puesta en marcha con puntos de control
├── backend/
│   ├── Code.js             # doPost: auth → Gemini → Sheets (+ setup/selfTest/auditSheet)
│   ├── appsscript.json     # TZ America/Argentina/Buenos_Aires + webapp
│   └── .clasp.json.example # plantilla (el real va gitignoreado)
├── .gitignore
└── README.md
```

## Requisitos

- Cuenta de Google (la misma que va a usar la app).
- Node.js 18+ y `clasp`: `npm install -g @google/clasp`.
- Una API key gratuita de Gemini (Google AI Studio).
- Opcional para probar local: `python3 -m http.server` o `npx serve`.

## Puesta en marcha (resumen)

| # | Qué | Dónde |
|---|-----|-------|
| 1 | Crear la planilla y copiar su ID | Google Sheets |
| 2 | Crear el Client ID OAuth (Web) | Google Cloud Console |
| 3 | Crear la API key de Gemini | AI Studio |
| 4 | Subir el backend con `clasp` | Terminal |
| 5 | Cargar secretos y correr `setup()` / `selfTest()` | Editor de Apps Script |
| 6 | Implementar la Web App y copiar la URL `/exec` | Editor de Apps Script |
| 7 | Completar `APP_CONFIG` en `frontend/index.html` | Editor |
| 8 | Publicar `frontend/` en GitHub Pages | GitHub |
| 9 | Instalar la PWA desde Chrome en Android | Celular |

> El detalle de cada paso —qué hacer, **qué tenés que ver** y qué hacer si falla—
> está en **[PASO_A_PASO.md](PASO_A_PASO.md)**.

---

## Paso 1 — Planilla

1. Creá una planilla nueva en <https://sheets.new> (ej.: *Gastos personales*).
2. Copiá el ID de la URL: `https://docs.google.com/spreadsheets/d/`**`ESTE_ES_EL_ID`**`/edit`.

No hace falta crear la hoja ni los encabezados a mano: `setup()` crea la hoja `Gastos`
con las 7 columnas (`Fecha`, `Concepto`, `Monto`, `Categoría`, `Quién`, `Registrado`, `Compartido`)
y los formatos correctos.

## Paso 2 — Client ID de OAuth (Google Cloud Console)

1. Entrá a <https://console.cloud.google.com/> y elegí (o creá) un proyecto.
2. **APIs y servicios → Pantalla de consentimiento de OAuth**:
   - Tipo de usuario: *Externo* (o *Interno* si usás Google Workspace).
   - Completá nombre de la app, email de soporte y email del desarrollador.
   - Si queda en estado *Prueba*, agregá tu email en **Usuarios de prueba**.
   - No hace falta declarar scopes: la app solo usa `openid`, `email` y `profile`.
3. **APIs y servicios → Credenciales → Crear credenciales → ID de cliente de OAuth**.
   - Tipo: **Aplicación web**.
   - **Orígenes de JavaScript autorizados**:
     ```
     https://TU_USUARIO.github.io
     http://localhost:8000
     ```
     (sin barra final y sin el nombre del repo: el origen es solo esquema + host).
   - **URIs de redirección autorizados**: no se necesitan (GIS usa popup).
4. Copiá el **Client ID** (`123456789012-xxxx.apps.googleusercontent.com`).
   Es público por diseño: va en `index.html` y no es un secreto. **No** uses el
   *client secret* para nada.

## Paso 3 — API key de Gemini

1. Entrá a <https://aistudio.google.com/apikey> con la misma cuenta.
2. **Create API key** → elegí el proyecto → **Copy key** (la lista muestra la key
   recortada: abrí el detalle y usá *Copy key* para copiar la completa).
3. Desde mayo 2026 AI Studio emite claves con formato **`AQ.`** (53 caracteres); las
   `AIza…` anteriores siguen funcionando. El modelo usado es `gemini-3.8-flash`.

> Si tu proyecto rechaza la clave `AQ.` con `ACCESS_TOKEN_TYPE_UNSUPPORTED` (bug
> conocido del endpoint REST), creá una clave **estándar** en Cloud Console →
> Credenciales → Crear credenciales → Clave de API, y **restringila a *Generative
> Language API*** (desde mayo 2026 las claves estándar sin restricción se rechazan).

## Paso 4 — Subir el backend con `clasp`

```bash
npm install -g @google/clasp
```

**Opción A (recomendada, no pisa archivos):**

1. En <https://script.google.com> creá **Nuevo proyecto** y renombralo *Organizador Financiero*.
2. **Configuración del proyecto → ID de la secuencia de comandos**: copialo.
3. En la terminal:
   ```bash
   cd backend
   cp .clasp.json.example .clasp.json
   # editá .clasp.json y reemplazá PEGAR_SCRIPT_ID_DE_APPS_SCRIPT por el ID
   clasp login          # abre el navegador; guarda ~/.clasprc.json (fuera del repo)
   clasp push -f
   ```
4. En el editor de Apps Script vas a ver `Code.js` y `appsscript.json`.
   (Si no ves el manifiesto: *Configuración del proyecto → Mostrar archivo de manifiesto*.)

**Opción B:** crear el proyecto desde una carpeta vacía y copiar el `.clasp.json`:

```bash
mkdir /tmp/of-backend && cd /tmp/of-backend
clasp create --type webapp --title "Organizador Financiero"
# copiar el .clasp.json generado a backend/ (con "rootDir": ".")
```

> ⚠️ No corras `clasp create` dentro de `backend/`: puede sobrescribir `Code.js`.

## Paso 5 — Secretos y verificación

Los secretos **no** van en el código. Se cargan una vez en
**Configuración del proyecto → Propiedades de la secuencia de comandos**:

| Propiedad | Valor |
|-----------|-------|
| `AUTHORIZED_EMAIL` | el único email que puede cargar gastos |
| `GEMINI_API_KEY` | la key de AI Studio |
| `GOOGLE_CLIENT_ID` | el Client ID del paso 2 |
| `SHEET_ID` | el ID del paso 1 |

Después, en el editor de Apps Script:

1. Elegí la función **`setup`** → **Ejecutar** → autorizá los permisos
   (Sheets y llamadas externas).
2. Elegí **`selfTest`** → **Ejecutar** → en el registro tiene que decir
   `PROBLEMAS (0)` y mostrarte de dónde sale cada secreto (`properties`).
3. Opcional: elegí **`probarGemini`** y Ejecutar (prueba los dos modelos, consume 1–2 requests).
   También existe `selfTest(true)`, pero desde el menú de funciones no se le pueden pasar
   parámetros: por eso está el atajo `probarGemini`.
4. Opcional: si ya tenías datos de AppSheet, corré **`auditSheet`** y pegá la salida:
   no muestra importes ni conceptos, solo conteos y números de fila.

Las constantes `PEGAR_...` de `Code.js` son solo documentación: si falta una
propiedad, el backend responde *“El servidor no está configurado todavía”*
y `selfTest()` te dice exactamente cuál falta. Las Propiedades del script
**siempre** tienen prioridad sobre `CONFIG`.

## Paso 6 — Implementar la Web App

1. **Implementar → Nueva implementación → Aplicación web**.
2. Descripción: `v1`.
3. **Ejecutar como**: *Yo (tu email)*.
4. **Quién tiene acceso**: **Cualquier persona** (`ANYONE_ANONYMOUS`).
   Es necesario porque la PWA se sirve desde GitHub Pages y no puede enviar
   cookies de sesión de Google; la seguridad la da el `idToken` validado en
   cada request (ver [Seguridad](#seguridad-y-modelo-de-confianza)).
5. Copiá la URL que termina en **`/exec`**.
6. Probalo desde la terminal:
   ```bash
   curl -sS -X POST "https://script.google.com/macros/s/XXXX/exec" \
     -H 'Content-Type: text/plain' \
     --data '{"action":"ping"}'
   # -> {"ok":true,"version":"1.4.0"}
   ```

> Cada cambio de código necesita una **nueva versión**. `clasp deploy` sin más crea
> una implementación **nueva con URL nueva**, así que para conservar la `/exec` actual:
>
> ```bash
> clasp deployments                                   # lista los IDs
> clasp deploy --deploymentId <ID> --description "v2"
> ```
>
> O desde la UI: *Implementar → Administrar implementaciones → ✏️ Editar →
> Versión: Nueva versión → Implementar*. La URL `/exec` se mantiene.

---

## Paso 7 — Configurar el frontend

En `frontend/index.html`, arriba de todo, completá `APP_CONFIG`:

```js
const APP_CONFIG = {
  CLIENT_ID: '123456789012-xxxx.apps.googleusercontent.com',   // paso 2
  BACKEND_URL: 'https://script.google.com/macros/s/XXXX/exec',   // paso 6
  CATEGORIAS: ['Supermercado', 'Servicios', 'Transporte', 'Salidas', 'Salud', 'Hogar', 'Otros'],
  PERSONAS: ['Mauro', 'Anto'],
  ...
};
```

- `BACKEND_URL` **tiene que terminar en `/exec`**: el frontend rechaza cualquier otra URL
  (solo acepta `https://script.google.com/macros/s/.../exec`).
- Mientras queden los `PEGAR_...` vas a ver un cartel rojo y el login no se inicializa.

Prueba local:

```bash
cd frontend
python3 -m http.server 8000
# abrir http://localhost:8000  (ese origen ya quedó autorizado en el paso 2)
```

## Paso 8 — Publicar en GitHub Pages

La carpeta que se publica es `frontend/` (no la raíz). La forma más simple, sin build,
es empujarla a la rama `gh-pages` con `subtree`:

```bash
git add .
git commit -m "PWA de gastos con backend en Apps Script y Gemini"
git subtree push --prefix frontend origin gh-pages
```

En GitHub: **Settings → Pages → Build and deployment**
→ Source: *Deploy from a branch* → Branch: **`gh-pages`** / `/(root)` → **Save**.

En 1–2 minutos queda en:

```
https://TU_USUARIO.github.io/OrganizadorFinanciero/
```

> El `manifest.json` y el `sw.js` usan rutas relativas (`./`), así que funcionan
> igual en la raíz del dominio o en un subdirectorio como este.

## Paso 9 — Instalar en Android

1. Abrí la URL de Pages en **Chrome**.
2. Menú **⋮ → Instalar aplicación** (o *Agregar a pantalla principal*).
3. Si el navegador dispara el evento de instalación, también aparece el botón
   **“Instalar en el celular”** al pie de la app.

Requisitos que ya están cumplidos: HTTPS, `manifest.json` con `display: "standalone"`,
iconos de 192/512 (incluidos los *maskable*) y un service worker con scope en la raíz.

En iPhone: Safari → Compartir → *Agregar a pantalla de inicio*.

## Uso diario

1. Abrí la app e ingresá con Google (la sesión dura ~1 hora y se renueva volviendo a entrar).
2. **Leer un ticket** (tarjeta de arriba): sacá, subí, arrastrá o pegá la foto con `Ctrl+V`.
   La imagen se comprime a 1024 px / JPEG 0.75 y Gemini completa los 5 campos solo.
   Si la lectura falla, **🔄 Leer de nuevo** reintenta sin volver a elegir la foto.
   También podés **compartir una captura** desde otra app (Mercado Pago, homebanking, mail):
   **Compartir → Gastos**. La app se abre con esa imagen y la lee sola. Requiere la PWA
   instalada en Android (en iOS el menú Compartir de Safari no soporta `share_target`).
3. Revisá el aviso amarillo **“Revisá y corregí los datos extraídos antes de guardar”**.
   Los campos autocompletados quedan con borde verde hasta que los toques, y la etiqueta
   del formulario dice **“Leído del ticket”**.
4. **Guardar gasto** → aparece `Guardado ✔ (fila N)`. Durante 10 segundos podés tocar
   **Deshacer** para borrar esa fila si te equivocaste.
5. Si repetís un gasto idéntico (fecha, concepto, monto, categoría, persona y tilde) entre
   los últimos, la app avisa **“Parece que ya cargaste este gasto”** y te deja
   **Guardar igual** o **Cancelar**.

Arriba de todo tenés el **resumen del mes** (compacto). Tocá **Detalle** para ver el
total por persona, los compartidos, el top de categorías y los **últimos gastos**, con
un **✏️ para editarlo** o un **🗑 para borrarlo**. Se actualiza solo al guardar, editar o borrar.

Para **editar** un gasto: **Detalle** en el resumen → **✏️** → el formulario entra en modo
edición (chip *Editando*, botón *Guardar cambios*) y podés **Cancelar** sin tocar nada.

Si preferís cargar a mano, usá la tarjeta **Detalle del gasto** (la etiqueta dice
**“Carga manual”**): los mismos campos (más el interruptor), sin foto.

Con la PWA instalada, **mantené presionado el ícono** y aparecen los atajos
**Foto del ticket** y **Cargar a mano** (Android). La app vibra al guardar y al leer.

Detalles del formulario:

- **Fecha**: arranca en la fecha local de hoy (sin corrimiento UTC). `◀` / `▶` mueven
  un día; tocar el campo abre el calendario nativo.
- **Concepto**: texto libre, máximo 120 caracteres.
- **Monto**: teclado decimal, `step="0.01"`; acepta `1.234,56` o `1234.56`
  (la coma se convierte a punto automáticamente, porque `type="number"` la descartaría).
- **Categoría**: lista cerrada; el backend rechaza valores fuera de la lista.
- **Quién hizo el gasto**: `Mauro` o `Anto` (son los dos únicos valores válidos).
- **Gasto compartido**: interruptor que se guarda como casilla (checkbox) en la columna
  `Compartido`, para después separar en la planilla propia o en la de compartidos.
- Después de guardar se conservan **fecha, categoría, persona y el interruptor** (útil
  para cargar varios tickets del mismo día) y se limpian concepto, monto y la foto.

## Personalización

| Qué | Dónde | Nota |
|-----|-------|------|
| Categorías | `CONFIG.CATEGORIES` (backend) | la app las trae con `meta` al iniciar sesión; `APP_CONFIG.CATEGORIAS` es solo el fallback inicial |
| Personas | `CONFIG.PEOPLE` (backend) | `Mauro` y `Anto`; se traen con `meta`, igual que las categorías |
| Nombre de la hoja | `CONFIG.SHEET_NAME` | por defecto `Gastos` |
| Columnas | `CONFIG.HEADERS` | si las cambiás en una hoja existente, `setup()` reescribe la fila 1 |
| Modelos de IA | `CONFIG.GEMINI_MODELS` | cadena `gemini-flash-lite-latest` → `gemini-3.8-flash` → `gemini-3.7-flash`; el backend **aprende** cuál responde mejor y lo pone primero (ranking en la Propiedad `GEMINI_MODEL_STATS`) |
| Compresión de foto | `APP_CONFIG.MAX_IMAGE_WIDTH` y `JPEG_QUALITY` | 1024 px y 0.75 |
| Límites del backend | `CONFIG.MAX_MONTO`, `MAX_BODY_CHARS`, `MAX_IMAGE_BASE64_CHARS` | si los subís, revisá el tamaño de la imagen comprimida |

Después de tocar el backend: `clasp push -f && clasp deploy --description "cambio"`.

---

## Seguridad y modelo de confianza

La Web App es pública **a propósito**: una página estática en GitHub Pages no puede
enviar cookies de sesión de Google. Por eso la autorización no depende de la URL
secreta sino de un `idToken` firmado por Google que se valida en cada request.

### Capas implementadas

| Capa | Implementación |
|------|----------------|
| Acceso | `extract` y `save` exigen `idToken`; sin él no se toca Gemini ni la planilla |
| Validación del token | pre-filtro local (formato, `exp`, email) → `oauth2.googleapis.com/tokeninfo` (firma), `email_verified`, emisor `accounts.google.com`, `aud` si hay `GOOGLE_CLIENT_ID`, `exp` vigente |
| Autorización | un único email en `AUTHORIZED_EMAIL`, comparado sin distinguir mayúsculas |
| Secretos | Script Properties (prioridad) sobre `CONFIG`; la API key viaja en el header `x-goog-api-key`, nunca en la URL |
| Entrada | allowlists de categoría/persona, fecha real validada, monto numérico con tope, concepto ≤ 120, body ≤ 8 MB, imagen ≤ 6 MB base64 |
| Inyección de fórmulas | `sanitizeCell_()` antepone `'` a `= + - @` y quita caracteres de control |
| Salida | errores genéricos al cliente; el detalle va al log con `redact_()` (borra la key) |
| Sesión en el navegador | `sessionStorage`, expiración verificada, cierre automático 1 minuto antes y borrado ante `AUTH` |
| Navegador | CSP, sin `innerHTML`, `referrer=no-referrer`, `noindex`, backend restringido a `script.google.com/.../exec`, `credentials: 'omit'` |
| Abuso | rate limit por email con `CacheService`: 60/min global, 15/min extracciones, 30/min guardados |
| Diagnóstico | `selfTest()` no imprime secretos; `auditSheet()` no imprime importes ni conceptos |

### Riesgos residuales (conocidos y aceptados)

1. **El endpoint es público.** Cualquiera puede hacer `POST`, pero sin un `idToken`
   válido del email autorizado no se ejecuta nada. El rate limit es *best effort*
   con `CacheService` y no reemplaza un WAF.
2. **GitHub Pages no permite headers HTTP.** La CSP va por `<meta>` (sin
   `frame-ancestors`) y necesita `'unsafe-inline'` porque el JS está embebido;
   tampoco hay HSTS. Si querés headers reales, serví `frontend/` desde
   Cloudflare Pages, Netlify o Vercel y mové la CSP al header.
3. **La llave real es tu cuenta de Google.** Quien controle ese email puede cargar
   gastos: activá verificación en dos pasos.
4. **La planilla es tan privada como su uso compartido.** No la publiques ni la
   compartas con “cualquiera con el enlace”; el script corre con tus permisos.
5. **Privacidad de la IA.** En el plan gratuito de Gemini, Google puede usar los
   datos enviados para mejorar sus productos. No subas comprobantes con información
   que no quieras compartir.
6. **La API key vive en Apps Script**, no en el repo. Si alguna vez pegaste una key
   en un archivo o en un chat, revocala en AI Studio y generá otra.

### Checklist antes de publicar

- [ ] `APP_CONFIG.CLIENT_ID` y `BACKEND_URL` completos (sin `PEGAR_`).
- [ ] Script Properties cargadas y `selfTest()` con `PROBLEMAS (0)`.
- [ ] `curl` al `/exec` devuelve `{"ok":true,"version":"1.4.0"}`.
- [ ] Implementación: *Ejecutar como* vos y *Acceso* **Cualquier persona**.
- [ ] Origen `https://TU_USUARIO.github.io` autorizado en Cloud Console.
- [ ] `git status` no muestra `.clasp.json` ni `.clasprc.json`.
- [ ] Probaste en el celular: login → foto → revisar → guardar → fila en la planilla.
- [ ] Si migraste datos de AppSheet: `auditSheet()` sin filas para revisar.

## Problemas frecuentes

| Síntoma | Causa probable | Solución |
|---------|----------------|----------|
| Cartel rojo “Falta configurar APP_CONFIG…” | quedaron los placeholders | completá `CLIENT_ID` y `BACKEND_URL` (paso 7) |
| No aparece el botón de Google | origen no autorizado, Client ID inválido o red bloqueada | agregá `https://TU_USUARIO.github.io` (sin path) en *Orígenes de JavaScript* |
| “Sesión inválida o vencida” al guardar | token de 1 h vencido **o** email distinto al autorizado | volvé a entrar; revisá `AUTHORIZED_EMAIL` |
| “El servidor no está configurado todavía” | faltan Propiedades del script | corré `selfTest()` y cargá las que marca |
| “La IA rechazó la solicitud” | API key inválida, API deshabilitada o proyecto sin acceso | `probarGemini` y revisá la key en AI Studio |
| “Se alcanzó el límite de la IA” | cuota gratuita agotada momentáneamente | esperá un minuto y reintentá |
| “La IA no está disponible ahora (HTTP 5xx)” | sobrecarga/caída transitoria de Gemini | reintentá en unos minutos; el backend prueba la cadena de modelos y usa el primero disponible |
| “El modelo de IA configurado no está disponible” | Google retiró ese modelo (ej. 2.5/2.0) | `probarGemini` y poné un modelo de la lista en `CONFIG.GEMINI_MODEL` |
| “No pudimos conectar con el servidor” | URL mal copiada, sin internet o implementación privada | usá la URL `/exec` y *Acceso: Cualquier persona* |
| Error de CORS / preflight | se cambió el `Content-Type` a `application/json` | dejá `text/plain;charset=utf-8` (ya está así) |
| La app no ofrece instalarse | falta HTTPS/manifest/SW o ya está instalada | abrí la URL de Pages en Chrome, no un archivo local |
| Las fechas se corren un día | zona horaria del script o de la planilla | ambas deben ser `America/Argentina/Buenos_Aires` |
| “No pudimos guardar el gasto” + log “Sin planilla” | `SHEET_ID` incorrecto o sin permisos | revisá el ID y que la cuenta del script tenga acceso |
| Los cambios no se ven | falta nueva versión o caché del SW | deployá una versión nueva (`--deploymentId`) y recargá dos veces |

## Costos

- **Google Sheets / Apps Script**: plan gratuito (cuotas de consumidor).
- **Gemini 2.5 Flash**: capa gratuita de AI Studio; si la superás, se cobra por uso.
- **GitHub Pages**: gratuito para repositorios públicos (para privados necesitás plan pago).

## Tests y CI

Las tres suites viven en `tests/` y no tienen dependencias npm:

```bash
npm test              # corre las 3 (~228 checks)
npm run test:static   # HTML/JS/CSP/manifest, sin navegador
npm run test:backend  # simulación de Apps Script (auth, Gemini, Sheets, límites)
npm run test:frontend # Chromium headless: UI, fechas, fotos, PWA, share target
```

| Suite | Cobertura | Checks |
|-------|-----------|--------|
| `static` | HTML/JS inline, CSP, IDs, manifest, iconos, sin credenciales | 40 |
| `backend` | auth JWT, extracción, cadena de modelos, guardado, edición, duplicados, deshacer, resumen, auditoría | 80 |
| `frontend` | render, fechas, compresión, extracción, guardado, edición, sesión, PWA, offline, share target, resumen, meta | 108 |

Requiere Node 22+ y un Chromium del sistema (`CHROME_BIN` para indicar otro).
El workflow está en [`tests/github-workflow.yml`](tests/github-workflow.yml) y se copia
**una sola vez** a `.github/workflows/test.yml` (GitHub → *Add file → Create new file*):
el token automático del repo no puede crear archivos en esa carpeta. Desde entonces corre
`npm test` en cada push a `main` y en cada PR.

## Deploy automático del backend (opcional)

Por defecto, cada cambio en `backend/` hay que pegarlo en el editor de Apps Script.
Se puede automatizar con GitHub Actions + `clasp` (configuración única):

1. Habilitá la **Apps Script API** en <https://script.google.com/home/usersettings>
   con la cuenta dueña del script.
2. Generá las credenciales de `clasp` una sola vez:
   ```bash
   npm install -g @google/clasp@3
   clasp login
   ```
   Sin terminal propia podés usar <https://shell.cloud.google.com> (todo desde el navegador).
3. En GitHub → **Settings → Secrets and variables → Actions**, agregá:

   | Secreto | Valor |
   |---------|-------|
   | `CLASPRC_JSON` | todo el contenido de `~/.clasprc.json` |
   | `APPS_SCRIPT_ID` | ID del proyecto (Apps Script → Configuración del proyecto) |
   | `APPS_SCRIPT_DEPLOYMENT_ID` | el `AKfycb…` de la URL `/exec` |

4. Copiá [`tests/github-workflow-deploy.yml`](tests/github-workflow-deploy.yml) a
   `.github/workflows/deploy-backend.yml` (GitHub → *Add file → Create new file*).
5. Listo: cada push a `main` que toque `backend/` sube el código y publica una versión
   nueva **con la misma URL** (`clasp push` + `clasp deploy --deploymentId`).

> ⚠️ `CLASPRC_JSON` es una credencial: va **solo** en GitHub Secrets, nunca al repo ni al chat.
> La sesión se puede revocar en <https://myaccount.google.com/permissions> y el secreto borrar.
> Si `clasp login` se hizo con otra cuenta (no la dueña del script), el push falla.

## Git

Este repo quedó con los archivos **sin commitear** y **sin push** (regla del workspace).
Para publicarlo:

```bash
git add .
git commit -m "PWA de gastos con Apps Script + Gemini"
git subtree push --prefix frontend origin gh-pages
```

Recordá que `backend/.clasp.json` y `.clasprc.json` están en `.gitignore`:
son credenciales locales, no deben viajar al repositorio.
