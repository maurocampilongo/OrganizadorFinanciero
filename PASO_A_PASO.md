# Puesta en marcha paso a paso

Guía para dejar la app funcionando desde cero, sin adivinar. Cada paso tiene
**qué hacer**, **qué tenés que ver** (punto de control) y **qué hacer si falla**.

Tiempo estimado: 30–40 minutos la primera vez. Después, actualizar el código
son 2 comandos.

> 🖐️ **¿No querés usar terminal?** El paso 5 tiene una **alternativa sin `clasp`**
> (copiar y pegar el código en el editor de Apps Script): no necesitás instalar nada.

---

## 0. Mapa mental: quién hace qué

```
┌──────────────┐  1. te identifica   ┌────────────────────┐
│  Google      │ ◄────────────────── │  Tu PWA (Pages)    │
│  Identity    │ ──────────────────► │  index.html        │
└──────────────┘  2. idToken (JWT)   └─────────┬──────────┘
                                               │ 3. POST {action, idToken, ...}
                                               ▼
                                     ┌────────────────────┐
                                     │  Apps Script       │
                                     │  Code.js           │
                                     └───┬────────────┬───┘
                        4. valida el JWT │            │ 6. appendRow
                                         ▼            ▼
                              ┌──────────────┐  ┌──────────────┐
                              │ oauth2...    │  │ Google Sheet │
                              │ tokeninfo    │  │ hoja Gastos  │
                              └──────────────┘  └──────────────┘
                                         │ 5. foto + prompt
                                         ▼
                              ┌──────────────┐
                              │ Gemini 2.5   │
                              │ Flash        │
                              └──────────────┘
```

Hay **cuatro piezas** y cada una resuelve una cosa distinta:

| Pieza | Para qué sirve | Dónde vive |
|-------|----------------|------------|
| Google Sheet | la base de datos (una fila por gasto) | tu Drive |
| Google Cloud (OAuth) | que Google te identifique y emita el `idToken` | console.cloud.google.com |
| Apps Script | el backend: valida el token, llama a Gemini y escribe en la hoja | script.google.com |
| GitHub Pages | sirve el frontend estático | tu repo |

> **¿Por qué el backend es “público”?** Una página estática no puede mandar
> cookies de sesión de Google. Por eso la Web App se publica como *Cualquier
> persona* y la seguridad real es el `idToken` firmado que se valida en cada
> request. Sin un token del email autorizado, el backend no hace nada.

---

## 1. Antes de empezar

- [ ] Cuenta de Google (la que va a cargar los gastos).
- [ ] Node.js 18 o superior (`node --version`).
- [ ] El repo clonado en tu PC y una terminal en la raíz del proyecto.
- [ ] Un lugar seguro para anotar 4 valores (no en el repo, no en el chat).

Instalá `clasp` (la herramienta de Google para subir código desde la terminal):

```bash
npm install -g @google/clasp
clasp --version
```

---

## 2. Mapa de valores: qué copiar y dónde pegarlo

Vas a manejar exactamente **6 valores**. Esta tabla es la referencia para no perderte:

| # | Valor | De dónde sale | Dónde se pega | Si falta o está mal |
|---|-------|---------------|---------------|---------------------|
| 1 | **Email autorizado** | tu cuenta de Google | Script Property `AUTHORIZED_EMAIL` | “El servidor no está configurado todavía” o “Sesión inválida” |
| 2 | **Sheet ID** | URL de la planilla | Script Property `SHEET_ID` | `selfTest` falla / “No pudimos guardar” |
| 3 | **Client ID** | Cloud Console | Script Property `GOOGLE_CLIENT_ID` **y** `APP_CONFIG.CLIENT_ID` | no aparece el botón de Google / “Sesión inválida” |
| 4 | **API key de Gemini** | AI Studio | Script Property `GEMINI_API_KEY` | “Falta configurar la API key de Gemini en el servidor” |
| 5 | **Script ID** | Apps Script | `backend/.clasp.json` (local, no se commitea) | `clasp push` no sabe a qué proyecto subir |
| 6 | **URL `/exec`** | Implementación de la Web App | `APP_CONFIG.BACKEND_URL` | cartel rojo / “No pudimos conectar con el servidor” |

---

## 3. Paso 1 — Crear la planilla

**Objetivo:** tener la base de datos y su ID.

1. Abrí <https://sheets.new>.
2. Renombrala, por ejemplo, *Gastos personales*.
3. Mirá la barra de direcciones:
   ```
   https://docs.google.com/spreadsheets/d/1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890/edit#gid=0
                                            └──────────── este es el SHEET_ID ────────────┘
   ```
4. Copiá **solo** lo que está entre `/d/` y `/edit`. Anotálo como **valor 2**.

**Punto de control:** el ID tiene ~44 caracteres, empieza con `1` y no tiene
barras ni espacios.

**No hace falta** crear la hoja “Gastos” ni los encabezados: `setup()` los crea
(`Fecha`, `Concepto`, `Monto`, `Categoría`, `Quién`, `Registrado`).

---

## 4. Paso 2 — Proyecto en Google Cloud y pantalla de consentimiento

**Objetivo:** habilitar la identidad de Google para tu app.

1. Entrá a <https://console.cloud.google.com/>.
2. Arriba a la izquierda, **selector de proyecto → Proyecto nuevo**.
   Nombre: `Organizador Financiero` → **Crear** → seleccioná el proyecto.
3. En el menú: **APIs y servicios → Pantalla de consentimiento de OAuth**
   (en la interfaz nueva aparece como **Google Auth Platform**).
4. Completá **Branding / Información de la app**:
   - Nombre de la app: `Gastos`.
   - Email de asistencia: tu email.
   - Email del desarrollador: tu email.
   - Público / User type: **Externo** (salvo que uses Google Workspace, ahí podés elegir *Interno*).
5. En **Audiencia / Usuarios de prueba**: agregá tu propio email.
6. **No agregues scopes**: la app solo usa `openid`, `email` y `profile`, que son básicos.

**Punto de control:** la app queda en estado **Prueba / Testing** con tu email
como usuario de prueba. Es lo esperado para uso personal: no requiere verificación
de Google.

> ⚠️ Si tu app está en *Prueba* y tu email no está en *Usuarios de prueba*,
> el login va a fallar con `access_denied`.

---

## 5. Paso 3 — Crear el Client ID de OAuth

**Objetivo:** obtener el identificador con el que la PWA le pide el token a Google.

1. En el mismo proyecto: **APIs y servicios → Credenciales**.
2. **Crear credenciales → ID de cliente de OAuth**.
3. Tipo de aplicación: **Aplicación web**.
4. Nombre: `Gastos PWA`.
5. **Orígenes de JavaScript autorizados** — agregá dos, uno por línea:
   ```
   https://TU_USUARIO.github.io
   http://localhost:8000
   ```
   Son **orígenes**, no URLs completas: sin barra final y **sin** el nombre del repo.
   `https://maurocampilongo.github.io` es correcto;
   `https://maurocampilongo.github.io/OrganizadorFinanciero/` **no**.
6. **URIs de redirección autorizados**: dejalos vacíos (Google Identity Services
   usa popup, no redirect).
7. **Crear** y copiar el **Client ID** (`123456789012-xxxx.apps.googleusercontent.com`).
   Anotálo como **valor 3**.

**Punto de control:** el ID termina en `.apps.googleusercontent.com` y empieza con
números, un guion y letras. La app lo valida con ese formato exacto.

**Cómo distinguir los IDs (es el error más común):**

| ID | Se ve así | De dónde se saca | ¿Va en `APP_CONFIG`? |
|----|-----------|------------------|----------------------|
| **Client ID** ✅ | `123456789012-abc123.apps.googleusercontent.com` | Cloud Console → Credenciales → OAuth 2.0 Client IDs | **sí** |
| ID de implementación ❌ | `AKfycb...` | está dentro de la URL `/exec` | no (ya está en la URL) |
| ID del script ❌ | `1AbCdEf...` | Apps Script → Configuración del proyecto | no |
| Client secret ❌ | `GOCSPX-...` | Cloud Console → tu cliente OAuth | nunca |

> **No uses el “client secret”.** No lo necesitamos en ningún lado. Si lo generaste,
> ignoralo (no es un secreto para esta arquitectura, pero tampoco hace falta).

---

## 6. Paso 4 — API key de Gemini

**Objetivo:** que el backend pueda leer las fotos.

1. Entrá a <https://aistudio.google.com/apikey> con la misma cuenta.
2. **Create API key**.
3. Elegí el proyecto que creaste (o “Create API key in new project”).
4. Abrí el detalle de la key y usá **Copy key** (la lista muestra una versión recortada
   que **no funciona**). Anotála como **valor 4**.

**Punto de control:** desde mayo 2026 las claves nuevas son **`AQ.`** de 53 caracteres;
las `AIza…` (~39) anteriores siguen funcionando. `selfTest()` acepta ambos formatos.

> Si tu proyecto rechaza la `AQ.` con `ACCESS_TOKEN_TYPE_UNSUPPORTED` (bug conocido del
> endpoint REST), creá una clave **estándar** en Cloud Console → Credenciales → Crear
> credenciales → Clave de API y **restringila a *Generative Language API*** (las claves
> estándar sin restricción se rechazan desde mayo 2026). Pegala en `GEMINI_API_KEY`.

> El modelo configurado es `gemini-2.5-flash` (capa gratuita) con `gemini-2.0-flash`
> como respaldo automático. Podés cambiarlos en `CONFIG.GEMINI_MODEL` y
> `CONFIG.GEMINI_MODEL_FALLBACK` y volver a desplegar.

---

## 7. Paso 5 — Proyecto de Apps Script y `clasp push`

**Objetivo:** subir `backend/Code.js` y `backend/appsscript.json` a Google.

1. Entrá a <https://script.google.com/home> → **Nuevo proyecto**.
2. Cambiale el nombre (arriba a la izquierda): `Organizador Financiero`.
3. **Configuración del proyecto** (ícono de engranaje, menú izquierdo) →
   copiá el **ID de la secuencia de comandos**. Anotálo como **valor 5**.
4. En tu terminal, desde la raíz del repo:
   ```bash
   cd backend
   cp .clasp.json.example .clasp.json
   ```
5. Abrí `backend/.clasp.json` y reemplazá el placeholder:
   ```json
   {
     "scriptId": "1AbCdEf...EL_ID_DEL_PASO_5",
     "rootDir": ".",
     "filePushOrder": ["Code.js", "appsscript.json"]
   }
   ```
6. Autenticá `clasp` (una sola vez por máquina):
   ```bash
   clasp login
   ```
   Se abre el navegador → elegí tu cuenta → **Permitir**. Guarda las credenciales
   en tu carpeta personal (`~/.clasprc.json`), **fuera** del repo.
7. Subí el código:
   ```bash
   clasp push -f
   ```
8. Volvé al editor de Apps Script: tenés que ver `Code.js` y `appsscript.json`.
   (`clasp open` abre el proyecto directo desde la terminal.)

**Punto de control:** `clasp push` termina con `Pushed 2 files.` y en el editor
aparecen los dos archivos. Si no ves `appsscript.json`, activá
*Configuración del proyecto → Mostrar archivo de manifiesto*.

> `.clasp.json` y `.clasprc.json` son **credenciales locales**: ya están en
> `.gitignore`. No los subas, no los pegues en ningún lado.

---

### Alternativa sin terminal (copiar y pegar)

Si no querés instalar `clasp` (por ejemplo, porque trabajás desde el navegador), podés
hacer lo mismo en 4 minutos:

1. Abrí tu proyecto en <https://script.google.com>.
2. Abrí el archivo `backend/Code.js` del repo en GitHub y copiá **todo** el contenido
   (botón *Copy* o `Ctrl+A` / `Ctrl+C`).
   Enlace directo: `https://github.com/TU_USUARIO/TU_REPO/blob/main/backend/Code.js`
3. En el editor de Apps Script hacé clic dentro de `Código.gs` (o `Code.gs`),
   seleccioná todo (`Ctrl+A`) y pegá (`Ctrl+V`). Guardá (`Ctrl+S`).
4. **Configuración del proyecto → Zona horaria** → `(GMT-03:00) Buenos Aires`.
   Si no pegás `appsscript.json`, esta zona horaria **es obligatoria**: define qué es “hoy”.
5. Cargá las 4 Script Properties (paso 6) y corré `setup()` y `selfTest()` (paso 7).
6. Implementá como Aplicación web (paso 8). El `appsscript.json` **no es necesario**:
   los permisos se detectan solos al autorizar y el acceso se elige en la implementación.

> ¿Y `appsscript.json`? Solo hace falta si querés que el proyecto tenga exactamente los
> metadatos del repo (TZ, scopes y `access` declarados). Se pega desde
> *Configuración del proyecto → Mostrar archivo de manifiesto*, pero es opcional.

---

## 8. Paso 6 — Cargar los secretos (Script Properties)

**Objetivo:** que el backend tenga el email autorizado, la key y la planilla sin
que nada de eso esté en el código.

En el editor de Apps Script: **Configuración del proyecto → Propiedades de la
secuencia de comandos → Agregar propiedad**. Cargá exactamente estos 4 nombres
(sin espacios, respetando mayúsculas):

| Propiedad | Valor |
|-----------|-------|
| `AUTHORIZED_EMAIL` | tu email de Google (el mismo de *Usuarios de prueba*) |
| `GEMINI_API_KEY` | la key del paso 4 |
| `GOOGLE_CLIENT_ID` | el Client ID del paso 3 |
| `SHEET_ID` | el ID del paso 1 |

Después de cada una: **Guardar propiedades del script**.

**Punto de control:** quedan 4 filas visibles en la lista. Si te equivocás en un
nombre, `selfTest()` va a decir que falta (por ejemplo, `AUTHORIZED_EMAIL no está
configurado`).

> Las constantes `PEGAR_...` de `Code.js` son solo documentación. Las Propiedades
> del script **siempre** tienen prioridad; por eso el repo puede ser público.

---

## 9. Paso 7 — `setup()`, `selfTest()` y (opcional) `auditSheet()`

**Objetivo:** crear la hoja y verificar que todo esté bien antes de publicar.

1. En el editor, arriba, hay un selector de funciones. Elegí **`setup`** → **Ejecutar**.
2. La primera vez aparece **“Se necesita autorización”** → **Revisar permisos** →
   elegí tu cuenta → si aparece “Google no verificó esta aplicación”, tocá
   **Avanzado → Ir a Organizador Financiero (no seguro)** → **Permitir**.
   Ese cartel es normal: es *tu* proyecto, sin verificación pública.
3. Mirá el **Registro de ejecución**. Tiene que decir algo así:
   ```
   == setup ==
   Planilla: Gastos personales (1AbC…7890)
   Hoja "Gastos": creada
   Encabezados: escritos ahora
   Formatos: A = texto, C = #,##0.00, fila 1 congelada
   ```
4. Elegí **`selfTest`** → **Ejecutar**. Esperado:
   ```
   == Organizador Financiero — selfTest 1.1.0 ==
   Zona horaria del script: America/Argentina/Buenos_Aires | Hoy: 2026-11-22

   AUTHORIZED_EMAIL: properties -> m***o@gmail.com
   GEMINI_API_KEY: properties -> AIza…lmno (39 caracteres)
   GOOGLE_CLIENT_ID: properties -> 1234…com (72 caracteres)
   SHEET_ID: properties -> 1AbC…7890 (44 caracteres)

   Planilla: Gastos personales (1AbC…7890)
   Zona horaria de la planilla: America/Argentina/Buenos_Aires
   Hoja "Gastos": 1 filas | encabezados OK

   Gemini: OMITIDO (usá selfTest(true) para probarlo; consume 1 request)

   PROBLEMAS (0)
   ADVERTENCIAS (0)

   RESULTADO: listo para usar.
   ```
5. Opcional: **`selfTest(true)`** hace una llamada real a Gemini para confirmar
   que la key y el modelo responden (consume 1 request gratuito).
6. Opcional, si ya cargabas gastos con AppSheet: elegí **`auditSheet`** → **Ejecutar**.
   Es de solo lectura y no muestra importes ni conceptos: solo conteos y filas a
   revisar (fechas inválidas, montos en texto, categorías fuera de lista, fórmulas,
   duplicados). Sirve para detectar qué datos viejos hay que normalizar.

**Punto de control:** `PROBLEMAS (0)` y `RESULTADO: listo para usar.`
Si hay problemas, el detalle te dice qué propiedad falta o qué no puede abrir.

---

## 10. Paso 8 — Publicar la Web App y probarla con `curl`

**Objetivo:** tener la URL `/exec` que va a consumir la PWA.

1. En el editor: **Implementar → Nueva implementación**.
2. Engranaje ⚙️ **Seleccionar tipo → Aplicación web**.
3. Completá:
   - **Descripción**: `v1`
   - **Ejecutar como**: *Yo (tu email)*
   - **Quién tiene acceso**: **Cualquier persona**
     (no “Cualquier persona con cuenta de Google”: esa opción exige cookies de
     sesión de Google y rompe el fetch desde GitHub Pages).
4. **Implementar** → copiá la **URL de la aplicación web**. Termina en `/exec`.
   Anotála como **valor 6**.
5. Probala desde la terminal (reemplazá `XXXX`):
   ```bash
   curl -i -X POST "https://script.google.com/macros/s/XXXX/exec" \
     -H 'Content-Type: text/plain' \
     --data '{"action":"ping"}'
   ```

**Punto de control:**

```
HTTP/2 200
content-type: application/json; charset=utf-8

{"ok":true,"version":"1.1.0"}
```

| Si en vez de eso ves… | Significa |
|-----------------------|-----------|
| HTML con la pantalla de login de Google | “Quién tiene acceso” no está en *Cualquier persona* |
| **302 hacia `accounts.google.com/ServiceLogin`** | idem: el acceso sigue restringido (mirá el diagnóstico rápido) |
| `{"ok":false,"error":"CONFIG"...}` | faltan Propiedades o la planilla no abre: corré `selfTest()` |
| Error 404 | la URL está mal copiada o la implementación se borró |

**Diagnóstico rápido de la URL** (sin seguir redirecciones, te dice qué pasa):

```bash
curl -sS -o /dev/null -w '%{http_code} %{redirect_url}\n' \
  "https://script.google.com/macros/s/XXXX/exec"
```

| Resultado | Significa | Solución |
|-----------|-----------|----------|
| `302 ...accounts.google.com/ServiceLogin...` | el deploy existe pero **pide login** | *Administrar implementaciones → ✏️ → Quién tiene acceso: **Cualquier persona*** → Implementar |
| `404` | el ID de implementación no existe / está mal copiado | copiá la URL desde el diálogo de la implementación |
| `302 ...script.googleusercontent.com...` | correcto: está redirigiendo la ejecución | probá el `curl -L` completo |

> **Cómo arreglar el acceso:** *Implementar → Administrar implementaciones* → en la
> fila de la implementación activa, **✏️ (editar)** → **Quién tiene acceso:
> Cualquier persona** y **Ejecutar como: Yo** → **Implementar** (crea la versión
> nueva) → copiá de nuevo la **URL de la aplicación web**. La URL no cambia.

> **Cuidado con `clasp deploy`:** crea una implementación **nueva**, con **URL nueva**.
> Para conservar la URL actual usá:
> ```bash
> clasp deployments                                   # lista IDs
> clasp deploy --deploymentId <ID> --description "v2"
> ```
> O hacelo desde la UI: *Implementar → Administrar implementaciones → ✏️ Editar →
> Versión: Nueva versión → Implementar*. La URL `/exec` se mantiene.

> No uses la URL `/dev` en la PWA: esa solo funciona con tu sesión de Google
> iniciada en el navegador y pide login interactivo.

---

## 11. Paso 9 — Configurar el frontend y probarlo en la compu

**Objetivo:** que la página sepa con qué Client ID y con qué backend hablar.

1. Abrí `frontend/index.html` y buscá el bloque `APP_CONFIG` (línea ~273):
   ```js
   const APP_CONFIG = {
     CLIENT_ID: 'PEGAR_CLIENT_ID.apps.googleusercontent.com',
     BACKEND_URL: 'PEGAR_URL_EXEC_DE_APPS_SCRIPT',
     CATEGORIAS: ['Supermercado', 'Servicios', 'Transporte', 'Salidas', 'Salud', 'Hogar', 'Otros'],
     PERSONAS: ['Mauro', 'Compartido'],
     ...
   };
   ```
2. Reemplazá **solo** los dos strings, dejando las comillas y la coma:
   ```js
   CLIENT_ID: '123456789012-xxxx.apps.googleusercontent.com',
   BACKEND_URL: 'https://script.google.com/macros/s/XXXX/exec',
   ```
3. Guardá y serví la carpeta por HTTP (no abras el archivo con doble clic:
   Google Identity Services y el service worker necesitan `http://`):
   ```bash
   cd frontend
   python3 -m http.server 8000
   ```
4. Abrí <http://localhost:8000>.

**Punto de control:**

- No aparece ningún cartel rojo.
- Aparece el botón **“Iniciar sesión con Google”**.
- Al entrar, ves tu email arriba a la derecha y el formulario con los 5 campos
  (7 categorías y 2 personas).
- Probá un gasto manual: `Guardado ✔ (fila N)` y la fila aparece en la planilla.

> Si el botón no aparece: revisá que `http://localhost:8000` esté en *Orígenes de
> JavaScript autorizados* y que no haya un bloqueador de popups activo.

---

## 12. Paso 10 — Publicar en GitHub Pages

**Objetivo:** tener una URL HTTPS instalable en el celular.

```bash
git add frontend/index.html
git commit -m "Configurar Client ID y URL del backend"
git subtree push --prefix frontend origin gh-pages
```

Después, en GitHub:

1. **Settings → Pages**.
2. *Build and deployment* → Source: **Deploy from a branch**.
3. Branch: **`gh-pages`** / carpeta **`/(root)`** → **Save**.
4. Esperá 1–2 minutos y abrí:
   ```
   https://TU_USUARIO.github.io/OrganizadorFinanciero/
   ```

**Punto de control:** la página carga igual que en local y el login funciona
(el origen `https://TU_USUARIO.github.io` ya quedó autorizado en el paso 3).

> Si el repo aún no tiene la rama `main` en GitHub, primero `git push -u origin main`.
> `git subtree` crea `gh-pages` sola la primera vez.

---

## 13. Paso 11 — Instalar en Android y primera carga real

1. Abrí la URL de Pages **en Chrome del celular** (no en el navegador interno de
   otra app).
2. Menú **⋮ → Instalar aplicación** (o *Agregar a pantalla principal*).
   También puede aparecer el botón **“Instalar en el celular”** al pie.
3. Abrí el ícono instalado: tiene que verse a pantalla completa, sin barra de
   direcciones (eso confirma `display: standalone`).
4. Iniciá sesión y cargá un gasto real **con foto**:
   - La pantalla tiene dos tarjetas: **Leer un ticket** (arriba) y **Detalle del gasto**
     (abajo); la etiqueta de la segunda dice *Carga manual* o *Leído del ticket*.
   - La foto se comprime (vas a ver algo como `Foto lista (2.4 MB → 180 KB)`).
   - Aparece el aviso amarillo de revisión y los campos en verde.
   - Corregí lo que haga falta y guardá.
   - También podés **arrastrar** la imagen al recuadro o **pegarla con `Ctrl+V`**; y con
     **🔄 Leer de nuevo** reintentás la lectura sin elegir la foto otra vez.
5. Verificá la fila en la planilla.

**Punto de control:** la fila nueva tiene la fecha como **texto** (alineada a la
izquierda), el monto con dos decimales y la columna `Registrado` con fecha y hora.

---

## 14. Verificación final (5 minutos)

- [ ] `curl` al `/exec` devuelve `{"ok":true,"version":"1.1.0"}`.
- [ ] `selfTest()` devuelve `PROBLEMAS (0)` y `RESULTADO: listo para usar.`
- [ ] `selfTest(true)` responde `Gemini: OK (gemini-2.5-flash)`.
- [ ] Login desde la URL de Pages con tu cuenta.
- [ ] Gasto manual: aparece en la hoja, con fecha texto y monto numérico.
- [ ] Gasto por foto: banner de revisión + 5 campos autocompletados.
- [ ] Monto con coma (`1234,56`) se guarda como `1234.56`.
- [ ] Cerrar y reabrir la PWA: sigue logueado (hasta ~1 h) y abre sin conexión.
- [ ] (Opcional) `curl` con `{"action":"save"}` sin token → `{"ok":false,"error":"AUTH"}`.

---

## 15. Mantenimiento

| Quiero… | Qué hacer |
|---------|-----------|
| Cambiar categorías o personas | editar `CONFIG.CATEGORIES` / `CONFIG.PEOPLE` en `Code.js` **y** `APP_CONFIG.CATEGORIAS` / `PERSONAS` en `index.html` (deben coincidir) → `clasp push -f` + nueva versión → commit y `git subtree push` |
| Cambiar el email autorizado | solo la Propiedad `AUTHORIZED_EMAIL`. **No hace falta redesplegar** |
| Rotar la API key | crear una nueva en AI Studio → actualizar `GEMINI_API_KEY` → borrar la vieja en AI Studio |
| Cambiar de planilla | nuevo `SHEET_ID` en Propiedades → correr `setup()` |
| Cambiar el modelo de IA | `CONFIG.GEMINI_MODEL` → `clasp push -f` + nueva versión |
| Actualizar el código | `cd backend && clasp push -f` → *Administrar implementaciones → ✏️ → Nueva versión* |
| Renombrar la hoja | `CONFIG.SHEET_NAME`; si ya existe con otro nombre, `setup()` crea la nueva vacía |

**Regla de oro:** cada cambio en `backend/` necesita **nueva versión** de la
implementación. `clasp push` solo sube el código; la URL `/exec` sigue sirviendo
la versión publicada anterior hasta que deployes.

---

## 16. Errores típicos (mensaje exacto → qué hacer)

| Mensaje que ves | Causa | Solución |
|-----------------|-------|----------|
| `Falta configurar APP_CONFIG...` (cartel rojo) | placeholders en `index.html` | completá `CLIENT_ID` y `BACKEND_URL` |
| `El servidor no está configurado todavía.` | falta `AUTHORIZED_EMAIL` o la planilla no abre | `selfTest()` y cargá lo que marque |
| `Sesión inválida o vencida. Volvé a iniciar sesión.` | token vencido (1 h), email distinto o `aud` distinto | volvé a entrar; revisá que el Client ID sea el mismo en front y back |
| `Falta configurar la API key de Gemini en el servidor.` | falta `GEMINI_API_KEY` | cargala en Propiedades |
| `La IA rechazó la solicitud. Avisale al administrador.` | key inválida, API deshabilitada o key restringida | `selfTest(true)` y mirá el log de ejecución |
| `Se alcanzó el límite de la IA. Esperá un minuto y reintentá.` | cuota 429 | esperá o revisá el plan en AI Studio |
| `La IA no está disponible ahora (HTTP 5xx). Reintentá en un rato.` | sobrecarga transitoria de Gemini | reintentá; el backend reintenta y usa el modelo de respaldo |
| `La IA no devolvió datos. Sacá otra foto o cargá a mano.` | foto ilegible / no es un ticket | mejor luz, encuadre o carga manual |
| `Demasiadas fotos seguidas. Esperá un minuto.` | rate limit (15/min) | esperá 60 s |
| `No pudimos conectar con el servidor. Revisá tu conexión.` | URL mal, implementación privada/borrada o sin internet | probá el `curl` del paso 8 |
| `Respuesta inesperada del servidor. Reintentá.` | llegó HTML (login de Google) en vez de JSON | *Quién tiene acceso* = **Cualquier persona** |
| `curl` al `/exec` da **302 a accounts.google.com** | el deploy existe pero pide login | *Administrar implementaciones → ✏️ → Cualquier persona + Ejecutar como: Yo → Implementar* |
| `curl` al `/exec` da **404** | ID de implementación inexistente o mal copiado | copiá la URL desde el diálogo de la implementación (no el ID a mano) |
| `No pudimos guardar el gasto. Reintentá.` | error al escribir en la hoja | revisá el log de ejecución y los permisos de la planilla |
| No aparece el botón de Google | origen no autorizado / Client ID mal | agregá el origen exacto, sin path |
| `Error 403: access_denied` al autorizar | tu email no está en *Usuarios de prueba* | agregalo en la pantalla de consentimiento |
| Cartel “Google no verificó esta aplicación” | app propia en modo Prueba | **Avanzado → Ir a… (no seguro) → Permitir** |
| La app no ofrece instalarse | no es HTTPS, o ya está instalada, o falta el SW | usá la URL de Pages en Chrome |
| Después de deployar no veo cambios | versión vieja o caché del SW | nueva versión + cerrar y abrir la PWA |

---

## 17. Seguridad: lo que NO hay que hacer

- ❌ Pegar la API key, el Client ID o el Sheet ID en un chat, un issue o un commit.
- ❌ Commitear `backend/.clasp.json` o `~/.clasprc.json` (ya están en `.gitignore`).
- ❌ Compartir la planilla como “cualquiera con el enlace”.
- ❌ Usar el *client secret* o la URL `/dev` en la PWA.
- ❌ Poner `GOOGLE_CLIENT_ID` distinto en el frontend y en el backend.
- ✅ Activá verificación en dos pasos en tu cuenta de Google: es la llave real.
- ✅ Si una key se filtró, revocala en AI Studio y generá otra (no alcanza con borrar el archivo).

---

## 18. Resumen en 10 líneas

```bash
# 1) planilla nueva  -> SHEET_ID
# 2) Cloud: consentimiento + Client ID (origins: Pages y localhost:8000)
# 3) AI Studio -> API key
# 4) script.google.com -> nuevo proyecto -> Script ID
cd backend && cp .clasp.json.example .clasp.json   # pegar Script ID
clasp login && clasp push -f
# 5) 4 Script Properties -> setup() -> selfTest()
# 6) Implementar -> Aplicación web -> Cualquier persona -> URL /exec
# 7) APP_CONFIG (index.html) -> local -> Pages -> instalar en Android
```
