# Deploy automático del backend (clasp + GitHub Actions)

Objetivo: **no volver a pegar `Code.js`** en el editor de Apps Script. Una vez configurado,
cada push a `main` que toque `backend/` sube el código y publica una versión nueva con la
misma URL `/exec`.

Son **3 secretos** y **1 archivo**. Abajo está de dónde sale cada uno, cómo se ve y cómo
darse cuenta si lo copiaste mal.

---

## Paso 0 — Requisitos

- Ser el **dueño** del proyecto de Apps Script (la misma cuenta de Google de la planilla).
- Tener **habilitada la Apps Script API**:
  1. Entrá a <https://script.google.com/home/usersettings>
  2. Activá **Google Apps Script API** (toggle a ON).
  3. Esperá ~1 minuto.

Sin esto, `clasp push` falla con “User has not enabled the Apps Script API”.

---

## Secreto 1 — `CLASPRC_JSON`

**Qué es:** el archivo que genera `clasp login` con los tokens de tu cuenta. Es lo que le
permite a GitHub actuar en tu nombre sobre Apps Script. **Es una credencial: no se comparte.**

### 1.1 Generarlo (elegí una opción)

#### Opción A — con terminal en tu compu (recomendada)

```bash
npm install -g @google/clasp@3
clasp login
```

- Se abre el navegador → elegí **la cuenta dueña del script** → **Permitir**.
- La terminal dice `Authorization successful`.
- El archivo queda en tu carpeta personal:

| Sistema | Ruta |
|---------|------|
| macOS / Linux | `~/.clasprc.json` |
| Windows | `C:\Users\TU_USUARIO\.clasprc.json` |

**Copiarlo directo al portapapeles:**

```bash
# macOS
pbcopy < ~/.clasprc.json

# Linux (si tenés xclip)
xclip -selection clipboard < ~/.clasprc.json
```

```powershell
# Windows PowerShell
Get-Content "$env:USERPROFILE\.clasprc.json" -Raw | Set-Clipboard
```

Si no, abrilo con un editor de texto y copiá **todo** (`Ctrl+A`, `Ctrl+C`).
En Finder/Explorador el archivo está oculto: en macOS `Cmd+Shift+.` muestra los ocultos;
en Windows, pestaña **Ver → Mostrar → Elementos ocultos**.

#### Opción B — sin terminal propia: Google Cloud Shell

1. Abrí <https://shell.cloud.google.com> con la **misma cuenta**.
2. Esperá que cargue la terminal y corré:
   ```bash
   npm install -g @google/clasp@3
   clasp login --no-localhost
   ```
3. Te imprime una **URL larga**. Abrila, elegí la cuenta y tocá **Permitir**.
4. El navegador va a terminar en algo así como
   `http://localhost:8888/?code=4/0A...&scope=...` y va a mostrar “no se puede acceder”.
   **Eso es normal.**
5. Copiá de la barra de direcciones **solo el valor de `code=`** (desde después de `code=`
   hasta el `&`):
   ```
   http://localhost:8888/?code=4/0AbCdEf...XYZ&scope=...
                              └── esto ──┘
   ```
6. Pegalo en la terminal y Enter.
7. Ahora mostrá el archivo y copialo entero:
   ```bash
   cat ~/.clasprc.json
   ```
   Seleccioná todo el texto que aparece y copialo (o usá el botón de copiar de Cloud Shell).

### 1.2 Cómo se ve

Es **una sola línea** JSON, empieza con `{"tokens"` y adentro tiene `refresh_token`:

```json
{"tokens":{"default":{"access_token":"ya29.a0Af...","refresh_token":"1//0g...","scope":"https://www.googleapis.com/auth/script.projects ...","token_type":"Bearer","expiry_date":1790000000000}}}
```

- Copiá **desde la primera `{` hasta la última `}`**. Nada más: **no copies el prompt**
  (`usuario@cloudshell:~$`) ni líneas de más.
- No lo reformatees, no le agregues comillas, no lo “prettify” con un editor.
- Si tiene más de un usuario (`default`, otro nombre), está bien: mandalo completo.

**Copiarlo limpio en una sola línea (recomendado):**

```bash
python3 -c "import json; print(json.dumps(json.load(open('$HOME/.clasprc.json'))))"
```

Copiá lo que imprime (empieza con `{"tokens"`) y pegá **solo eso** en el secreto.
Si tenés `jq`: `jq -c . ~/.clasprc.json` hace lo mismo.

> El workflow tolera texto extra después del JSON (lo informa como *warning*), pero es mejor
> copiarlo limpio: si el JSON está cortado o mal, el deploy falla.

### 1.3 Guardarlo en GitHub

1. Repo → **Settings** → **Secrets and variables** → **Actions**.
2. **New repository secret**.
3. Name: `CLASPRC_JSON`  (exacto, con guión bajo).
4. Secret: pegá el contenido completo.
5. **Add secret**.

> GitHub no te deja volver a leer el valor después. Si lo cargaste mal, se edita y se pega de nuevo.

---

## Secreto 2 — `APPS_SCRIPT_ID`

**Qué es:** el ID del **proyecto** de Apps Script (no el de la implementación).

1. Entrá a <https://script.google.com> y abrí tu proyecto (`Organizador Financiero`).
2. En la barra izquierda, engranaje ⚙️ **Configuración del proyecto** (*Project Settings*).
3. Bajá hasta **IDs** → **ID de la secuencia de comandos** (*Script ID*).
4. Tocá el ícono de copiar.

Se ve así: **`1AbCdEfGhIjKlMnOpQrStUvWxYz1234567890`** (empieza con `1`, ~44 caracteres).

- ✅ Es el que está en *Configuración del proyecto*.
- ❌ No es el `AKfycb...` de la URL `/exec` (ese es el secreto 3).
- ❌ No es el número de proyecto de Google Cloud.

---

## Secreto 3 — `APPS_SCRIPT_DEPLOYMENT_ID`

**Qué es:** el ID de la **implementación de la Web App** que la PWA ya está usando.

**Forma más fácil:** mirá la URL que tenés en `APP_CONFIG.BACKEND_URL`:

```
https://script.google.com/macros/s/AKfycbzuIfo-AaEds.../exec
                                └── este es ──┘
```

O desde el editor:

1. **Implementar** → **Administrar implementaciones**.
2. En la fila de la implementación activa, copiá **ID de la implementación** (o la URL de la
   aplicación web y extraé la parte del medio).

Se ve así: **`AKfycb...`** (empieza con `AKfycb`, ~70 caracteres).

- ✅ Es la implementación cuya URL termina en **`/exec`** (la que usa la PWA).
- ❌ No es la URL `/dev` (esa es de prueba).
- ❌ No es el Script ID del secreto 2.

---

## Paso 4 — Crear el workflow en GitHub

El token automático de este repo no puede crear archivos en `.github/workflows/`, así que
esto es lo único que se hace desde la web:

1. En el repo: **Add file** → **Create new file**.
2. En el nombre escribí exactamente:
   ```
   .github/workflows/deploy-backend.yml
   ```
3. Abrí en otra pestaña la plantilla:
   <https://github.com/maurocampilongo/OrganizadorFinanciero/blob/main/tests/github-workflow-deploy.yml>
   → botón **Raw** → `Ctrl+A` / `Ctrl+C`.
4. Pegá el contenido en el editor de GitHub.
5. **Commit changes** (directo a `main`).

---

## Paso 5 — Probarlo

1. GitHub → pestaña **Actions** → **Deploy backend** → **Run workflow** → **Run workflow**.
2. Esperá ~20–30 s y abrí el run.
3. Tiene que terminar en verde, con los pasos **Subir el código** y **Publicar versión nueva** OK.
4. Verificá la versión del backend:
   ```bash
   curl -sS -L "https://script.google.com/macros/s/TU_ID/exec" \
     -H 'Content-Type: text/plain' --data '{"action":"ping"}'
   ```
   Tiene que devolver la versión nueva (`{"ok":true,"version":"1.9.0"}` o la que corresponda).

Listo: de acá en adelante, cualquier cambio en `backend/` que se pushee a `main` se deploya solo.

---

## Si algo falla

| Error en el log del Action | Causa | Solución |
|---|---|---|
| `Could not find credentials` / `Could not read credentials` | `CLASPRC_JSON` vacío, cortado o con comillas extra | Volver a copiar el archivo completo |
| `Unexpected non-whitespace character after JSON` | el secreto tiene **texto extra** después del JSON (típico: el prompt de la shell) | volver a copiarlo con el comando de arriba, o actualizar el workflow (ya lo tolera) |
| `invalid_grant` / `Token has been expired or revoked` | la sesión se revocó o venció | `clasp login` de nuevo y actualizar el secreto |
| `The caller does not have permission` (403) | el login se hizo con otra cuenta | repetir el login con la cuenta dueña |
| `User has not enabled the Apps Script API` | falta el toggle | activarlo en <https://script.google.com/home/usersettings> |
| `Script ... not found` (404) | `APPS_SCRIPT_ID` mal copiado | revisar el ID en Configuración del proyecto |
| `Deployment not found` | `APPS_SCRIPT_DEPLOYMENT_ID` mal copiado o de otro script | copiarlo de la URL `/exec` correcta |
| El Action pasa pero la app no cambia | el commit no tocó `backend/` o la implementación no se actualizó | correr **Run workflow** y revisar el último paso |

---

## Seguridad

- `CLASPRC_JSON` es una credencial de larga duración (refresh token). Vive **solo** en GitHub Secrets.
- Si alguna vez la querés cortar: <https://myaccount.google.com/permissions> → quitá el acceso de
  **Google Apps Script** / `clasp` → borrá el secreto en GitHub → volvé a hacer `clasp login`.
- No la pegues en issues, chats, capturas ni archivos del repo.

## Alternativa sin secretos

Si preferís no cargar credenciales en GitHub, cuando tengas una terminal con `clasp login` hecho:

```bash
cd backend && clasp push -f && clasp deploy --deploymentId AKfycb...
```
