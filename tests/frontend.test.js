'use strict';

const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'frontend');
// Puertos derivados del PID: evita chocar con corridas previas o paralelas.
const PORT = 8765 + (process.pid % 200);
const DEBUG_PORT = 9222 + (process.pid % 200);
const PROFILE = '/tmp/of-chrome-' + process.pid;

let pass = 0;
const failures = [];
function check(name, condition, detail) {
  if (condition) { pass++; console.log('  OK   ' + name); }
  else { failures.push(name + (detail ? ': ' + detail : '')); console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png'
};

function startServer() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let pathname = decodeURIComponent(String(req.url || '/').split('?')[0]);
      if (pathname === '/') pathname = '/index.html';
      const file = path.join(ROOT, pathname);
      if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('404');
        return;
      }
      res.writeHead(200, {
        'Content-Type': MIME[path.extname(file)] || 'application/octet-stream',
        'Cache-Control': 'no-store'
      });
      res.end(fs.readFileSync(file));
    });
    server.listen(PORT, '127.0.0.1', () => resolve(server));
  });
}

function fetchJson(url, method) {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method: method || 'GET' }, (res) => {
      let body = '';
      res.on('data', (chunk) => { body += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(body)); } catch (err) { reject(new Error('respuesta no JSON: ' + body.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

async function waitFor(fn, timeout, label) {
  const start = Date.now();
  const limit = timeout || 10000;
  while (Date.now() - start < limit) {
    const value = await fn();
    if (value) return value;
    await delay(120);
  }
  throw new Error('timeout esperando: ' + (label || 'condición'));
}

class CDP {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.events = [];
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(event.data);
      if (message.id && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) entry.reject(new Error(message.error.message));
        else entry.resolve(message.result);
        return;
      }
      this.events.push(message);
    });
  }

  send(method, params) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async eval(expression) {
    const result = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
      userGesture: true
    });
    if (result.exceptionDetails) {
      const description = result.exceptionDetails.exception && result.exceptionDetails.exception.description;
      throw new Error('eval falló: ' + (description || result.exceptionDetails.text));
    }
    return result.result.value;
  }

  async navigate(url) {
    await this.send('Page.navigate', { url });
    await waitFor(() => this.eval('document.readyState === "complete" && !!window.__OF__'), 15000, 'carga de la página');
  }
}

async function connect() {
  let target = null;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await fetchJson('http://127.0.0.1:' + DEBUG_PORT + '/json/list');
      target = list.find((t) => t.type === 'page');
    } catch (err) { /* todavía no levantó */ }
    if (!target) await delay(150);
  }
  if (!target) throw new Error('no se pudo conectar a Chromium');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', () => reject(new Error('error de WebSocket con Chromium')), { once: true });
  });
  return new CDP(socket);
}

const SIGN_IN = `(() => {
  __OF__.config.CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
  __OF__.config.BACKEND_URL = 'https://script.google.com/macros/s/ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789abcdefghij/exec';
  const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
  const exp = Math.floor(Date.now() / 1000) + 3600;
  const payload = btoa(JSON.stringify({ email: 'yo@gmail.com', exp: exp, aud: __OF__.config.CLIENT_ID }));
  __OF__.state.token = header + '.' + payload + '.firma';
  __OF__.state.exp = exp * 1000;
  __OF__.state.email = 'yo@gmail.com';
  __OF__.setSignedIn(true);
  if (!window.__calls) {
    window.__calls = [];
    window.__responses = [];
    window.__lastCall = (action) => window.__calls.slice().reverse().find((c) => {
      try { return JSON.parse(c.options.body || '{}').action === action; } catch (e) { return false; }
    });
    window.__countCalls = (action) => window.__calls.filter((c) => {
      try { return JSON.parse(c.options.body || '{}').action === action; } catch (e) { return false; }
    }).length;
    window.fetch = async (url, options) => {
      window.__calls.push({ url: String(url), options: {
        method: options && options.method,
        headers: options && options.headers,
        body: options && options.body,
        credentials: options && options.credentials,
        cache: options && options.cache,
        redirect: options && options.redirect
      } });
      const sent = JSON.parse((options && options.body) || '{}');
      if (sent.action === 'meta') {
        const metaData = window.__meta || { ok: true, categories: ['Supermercado', 'Servicios', 'Transporte', 'Salidas', 'Salud', 'Hogar', 'Otros'], people: ['Mauro', 'Anto'] };
        return new Response(JSON.stringify(metaData), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      if (sent.action === 'summary') {
        const summaryData = window.__summary || { ok: true, hoy: { count: 0, total: 0 }, mes: { count: 0, total: 0 }, personas: [], compartido: { si: 0, no: 0 }, categorias: [], ultimos: [] };
        return new Response(JSON.stringify(summaryData), { status: 200, headers: { 'Content-Type': 'application/json' } });
      }
      const next = window.__responses.shift() || { ok: true, row: 99 };
      return new Response(JSON.stringify(next), { status: 200, headers: { 'Content-Type': 'application/json' } });
    };
  }
  return true;
})()`;

(async () => {
  fs.rmSync(PROFILE, { recursive: true, force: true });
  const server = await startServer();
  const chromium = spawn(process.env.CHROME_BIN || 'chromium', [
    '--headless=new',
    '--no-sandbox',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--hide-scrollbars',
    '--no-first-run',
    '--disable-background-networking',
    '--remote-debugging-port=' + DEBUG_PORT,
    '--user-data-dir=' + PROFILE,
    '--window-size=390,844',
    'about:blank'
  ], { stdio: 'ignore' });

  let cdp = null;
  try {
    cdp = await connect();
    await cdp.send('Page.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Log.enable');

    const APP_URL = 'http://127.0.0.1:' + PORT + '/index.html?debug=1';
    await cdp.navigate(APP_URL);

    console.log('== Render inicial ==');
    const initial = await cdp.eval(`(() => ({
      categorias: Array.from(document.querySelectorAll('#categoria option')).map(o => o.value),
      personas: Array.from(document.querySelectorAll('#persona option')).map(o => o.value),
      fecha: document.getElementById('fecha').value,
      hoy: __OF__.helpers.toLocalIso(new Date()),
      loginVisible: !document.getElementById('login-card').hidden,
      appHidden: document.getElementById('app-card').hidden,
      configWarning: document.getElementById('config-warning').hidden ? '' : document.getElementById('config-warning').textContent,
      hasManifest: !!document.querySelector('link[rel=manifest]'),
      csp: (document.querySelector('meta[http-equiv="Content-Security-Policy"]') || {}).content || '',
      title: document.title
    }))()`);
    check('7 categorías renderizadas', JSON.stringify(initial.categorias) === JSON.stringify(['Supermercado', 'Servicios', 'Transporte', 'Salidas', 'Salud', 'Hogar', 'Otros']), JSON.stringify(initial.categorias));
    check('2 personas renderizadas', JSON.stringify(initial.personas) === JSON.stringify(['Mauro', 'Anto']), JSON.stringify(initial.personas));
    check('fecha por defecto = hoy local', initial.fecha === initial.hoy, initial.fecha + ' vs ' + initial.hoy);
    check('login visible y app oculta al inicio', initial.loginVisible === true && initial.appHidden === true);
    check('sin aviso de configuración (APP_CONFIG completo)', initial.configWarning === '', initial.configWarning);
    check('manifest enlazado', initial.hasManifest === true);
    check('CSP default-src none', initial.csp.indexOf("default-src 'none'") > -1);
    check('título correcto', initial.title.indexOf('Gastos') > -1);

    console.log('\n== Botones de fecha ==');
    const dates = await cdp.eval(`(() => {
      const input = document.getElementById('fecha');
      const prev = document.getElementById('btn-prev-day');
      const next = document.getElementById('btn-next-day');
      const out = {};
      input.value = '2026-01-01'; prev.click(); out.enero = input.value;
      input.value = '2026-12-31'; next.click(); out.diciembre = input.value;
      input.value = '2024-02-28'; next.click(); out.bisiesto = input.value;
      input.value = '2023-02-28'; next.click(); out.noBisiesto = input.value;
      input.value = '2026-03-01'; prev.click(); out.marzo = input.value;
      return out;
    })()`);
    check('1/1 -1 = 31/12 del año anterior', dates.enero === '2025-12-31', dates.enero);
    check('31/12 +1 = 1/1 del año siguiente', dates.diciembre === '2027-01-01', dates.diciembre);
    check('28/2/2024 +1 = 29/2', dates.bisiesto === '2024-02-29', dates.bisiesto);
    check('28/2/2023 +1 = 1/3', dates.noBisiesto === '2023-03-01', dates.noBisiesto);
    check('1/3 -1 = 28/2', dates.marzo === '2026-02-28', dates.marzo);

    console.log('\n== Login simulado ==');
    await cdp.eval(SIGN_IN);
    const signed = await cdp.eval(`({
      loginHidden: document.getElementById('login-card').hidden,
      appVisible: !document.getElementById('app-card').hidden,
      email: document.getElementById('user-email').textContent,
      userbox: !document.getElementById('userbox').hidden
    })`);
    check('app visible tras iniciar sesión', signed.appVisible === true && signed.loginHidden === true);
    check('email en la barra superior', signed.email === 'yo@gmail.com', signed.email);

    console.log('\n== Validaciones del formulario ==');
    const validation = await cdp.eval(`({
      emptyConcepto: __OF__.validate({ fecha: '2026-11-20', concepto: '', monto: 10, categoria: 'Otros', persona: 'Mauro' }),
      montoCero: __OF__.validate({ fecha: '2026-11-20', concepto: 'X', monto: 0, categoria: 'Otros', persona: 'Mauro' }),
      fechaMala: __OF__.validate({ fecha: '20/11/2026', concepto: 'X', monto: 10, categoria: 'Otros', persona: 'Mauro' }),
      categoriaMala: __OF__.validate({ fecha: '2026-11-20', concepto: 'X', monto: 10, categoria: 'Viajes', persona: 'Mauro' }),
      personaMala: __OF__.validate({ fecha: '2026-11-20', concepto: 'X', monto: 10, categoria: 'Otros', persona: 'Otro' }),
      ok: __OF__.validate({ fecha: '2026-11-20', concepto: 'X', monto: 10, categoria: 'Otros', persona: 'Mauro' })
    })`);
    check('rechaza concepto vacío', validation.emptyConcepto.indexOf('concepto') > -1);
    check('rechaza monto 0', validation.montoCero.indexOf('monto') > -1);
    check('rechaza fecha con formato incorrecto', validation.fechaMala.indexOf('fecha') > -1);
    check('rechaza categoría fuera de lista', validation.categoriaMala.indexOf('categoría') > -1);
    check('rechaza persona fuera de lista', validation.personaMala.indexOf('gasto') > -1);
    check('acepta un gasto válido', validation.ok === '');

    console.log('\n== Guardado ==');
    const save = await cdp.eval(`(async () => {
      document.getElementById('fecha').value = '2026-11-20';
      document.getElementById('concepto').value = 'Coto';
      document.getElementById('monto').value = '1234.56';
      document.getElementById('categoria').value = 'Supermercado';
      document.getElementById('persona').value = 'Mauro';
      window.__responses.push({ ok: true, row: 42 });
      document.getElementById('expense-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      const started = Date.now();
      while (Date.now() - started < 5000 && document.getElementById('form-status').textContent.indexOf('Guardado') === -1) {
        await new Promise(r => setTimeout(r, 50));
      }
      const call = window.__lastCall('save');
      return {
        status: document.getElementById('form-status').textContent,
        statusClass: document.getElementById('form-status').className,
        concepto: document.getElementById('concepto').value,
        monto: document.getElementById('monto').value,
        fecha: document.getElementById('fecha').value,
        body: JSON.parse(call.options.body),
        contentType: call.options.headers['Content-Type'],
        credentials: call.options.credentials,
        url: call.url
      };
    })()`);
    check('mensaje de guardado con número de fila', save.status.indexOf('Guardado') > -1 && save.status.indexOf('42') > -1, save.status);
    check('estado en verde', save.statusClass.indexOf('ok') > -1, save.statusClass);
    check('limpia concepto y monto pero conserva la fecha', save.concepto === '' && save.monto === '' && save.fecha === '2026-11-20', JSON.stringify({ c: save.concepto, m: save.monto, f: save.fecha }));
    check('envía action=save con los 5 campos', save.body.action === 'save' && save.body.fecha === '2026-11-20' && save.body.concepto === 'Coto' && save.body.monto === 1234.56 && save.body.categoria === 'Supermercado' && save.body.persona === 'Mauro', JSON.stringify(save.body));
    check('monto viaja como número', typeof save.body.monto === 'number', typeof save.body.monto);
    check('incluye idToken', typeof save.body.idToken === 'string' && save.body.idToken.split('.').length === 3);
    check('Content-Type text/plain (sin preflight)', save.contentType === 'text/plain;charset=utf-8', save.contentType);
    check('fetch sin credenciales', save.credentials === 'omit', save.credentials);
    check('URL del backend /exec', save.url.indexOf('https://script.google.com/macros/s/') === 0 && save.url.endsWith('/exec'), save.url);

    console.log('\n== Error del servidor ==');
    const serverError = await cdp.eval(`(async () => {
      document.getElementById('concepto').value = 'Kiosco';
      document.getElementById('monto').value = '500';
      window.__responses.push({ ok: false, error: 'SERVER', message: 'Se cayó el servidor.' });
      document.getElementById('expense-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      const started = Date.now();
      while (Date.now() - started < 5000 && document.getElementById('form-status').textContent.indexOf('Se cayó') === -1) {
        await new Promise(r => setTimeout(r, 50));
      }
      return {
        status: document.getElementById('form-status').textContent,
        statusClass: document.getElementById('form-status').className,
        concepto: document.getElementById('concepto').value
      };
    })()`);
    check('muestra el mensaje del backend', serverError.status === 'Se cayó el servidor.', serverError.status);
    check('estado en rojo', serverError.statusClass.indexOf('error') > -1, serverError.statusClass);
    check('no borra lo que escribió el usuario', serverError.concepto === 'Kiosco');

    console.log('\n== Foto + extracción con IA ==');
    const extract = await cdp.eval(`(async () => {
      window.__responses.push({
        ok: true,
        data: { fecha: '2026-11-18', concepto: 'Shell', monto: 3500.25, categoria: 'Transporte', persona: 'Anto' },
        warnings: ['Revisá el monto.']
      });

      document.getElementById('fecha').value = '2026-11-20';
      document.getElementById('concepto').value = '';
      document.getElementById('monto').value = '';

      const canvas = document.createElement('canvas');
      canvas.width = 2000;
      canvas.height = 1000;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, 2000, 1000);
      ctx.fillStyle = '#111111';
      ctx.font = '90px sans-serif';
      ctx.fillText('TICKET 3500.25', 80, 300);
      ctx.font = '40px sans-serif';
      ctx.fillText('SHELL - 18/11/2026', 80, 420);

      const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.92));
      const file = new File([blob], 'ticket.jpg', { type: 'image/jpeg' });
      const transfer = new DataTransfer();
      transfer.items.add(file);
      const input = document.getElementById('foto');
      input.files = transfer.files;
      input.dispatchEvent(new Event('change', { bubbles: true }));

      const started = Date.now();
      while (Date.now() - started < 8000 && document.getElementById('concepto').value !== 'Shell') {
        await new Promise((resolve) => setTimeout(resolve, 60));
      }

      const call = window.__lastCall('extract');
      const body = JSON.parse(call.options.body);
      const bytes = Uint8Array.from(atob(body.image), (c) => c.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));

      return {
        concepto: document.getElementById('concepto').value,
        monto: document.getElementById('monto').value,
        fecha: document.getElementById('fecha').value,
        categoria: document.getElementById('categoria').value,
        persona: document.getElementById('persona').value,
        bannerHidden: document.getElementById('review-banner').hidden,
        banner: document.getElementById('review-banner').textContent,
        autofilled: document.querySelectorAll('.autofilled').length,
        thumbVisible: !document.getElementById('thumb-wrap').hidden,
        thumbSrc: document.getElementById('thumb').src.slice(0, 16),
        status: document.getElementById('foto-status').textContent,
        action: body.action,
        mime: body.mimeType,
        imageBytes: bytes.length,
        originalBytes: file.size,
        width: bitmap.width,
        height: bitmap.height
      };
    })()`);
    check('autocompleta los 5 campos', extract.concepto === 'Shell' && extract.monto === '3500.25' && extract.fecha === '2026-11-18' && extract.categoria === 'Transporte' && extract.persona === 'Anto', JSON.stringify(extract));
    check('muestra el aviso de revisión', extract.bannerHidden === false && extract.banner.indexOf('Revisá y corregí') > -1, extract.banner);
    check('incluye los warnings del backend', extract.banner.indexOf('Revisá el monto.') > -1, extract.banner);
    check('marca los 5 campos como autocompletados', extract.autofilled === 5, String(extract.autofilled));
    check('miniatura visible', extract.thumbVisible === true && extract.thumbSrc.indexOf('data:image/jpeg') === 0, extract.thumbSrc);
    check('estado de la foto confirma la extracción', extract.status.indexOf('Datos extraídos') > -1, extract.status);
    check('envía action=extract con JPEG', extract.action === 'extract' && extract.mime === 'image/jpeg');
    check('comprime 2000px a 1024px', extract.width === 1024 && extract.height === 512, extract.width + 'x' + extract.height);
    check('la imagen enviada pesa menos que la original', extract.imageBytes < extract.originalBytes, extract.imageBytes + ' vs ' + extract.originalBytes);

    console.log('\n== Guardar después de extraer ==');
    const afterExtract = await cdp.eval(`(async () => {
      window.__responses.push({ ok: true, row: 43 });
      document.getElementById('expense-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      const started = Date.now();
      while (Date.now() - started < 5000 && document.getElementById('form-status').textContent.indexOf('Guardado') === -1) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        status: document.getElementById('form-status').textContent,
        bannerHidden: document.getElementById('review-banner').hidden,
        autofilled: document.querySelectorAll('.autofilled').length,
        thumbHidden: document.getElementById('thumb-wrap').hidden,
        fotoStatus: document.getElementById('foto-status').textContent,
        mode: document.getElementById('form-mode').textContent,
        body: JSON.parse(window.__lastCall('save').options.body)
      };
    })()`);
    check('guarda lo extraído', afterExtract.status.indexOf('43') > -1 && afterExtract.body.concepto === 'Shell' && afterExtract.body.monto === 3500.25, afterExtract.status);
    check('oculta el aviso y limpia marcas', afterExtract.bannerHidden === true && afterExtract.autofilled === 0);
    check('limpia la miniatura', afterExtract.thumbHidden === true);
    check('restaura el texto de ayuda', afterExtract.fotoStatus.indexOf('Tocá') > -1, afterExtract.fotoStatus);
    check('vuelve a la etiqueta "Carga manual"', afterExtract.mode === 'Carga manual', afterExtract.mode);

    console.log('\n== Leer / arrastrar / quitar foto ==');
    console.log('Gasto compartido');
    const shared = await cdp.eval(`(async () => {
      const input = document.getElementById('compartido');
      const exists = !!input;
      input.checked = true;
      window.__responses.push({ ok: true, row: 44 });
      document.getElementById('concepto').value = 'Cena';
      document.getElementById('monto').value = '9000';
      document.getElementById('expense-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      const started = Date.now();
      while (Date.now() - started < 5000 && document.getElementById('form-status').textContent.indexOf('Guardado') === -1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const body = JSON.parse(window.__lastCall('save').options.body);
      return { exists: exists, body: body, checkedAfter: document.getElementById('compartido').checked, status: document.getElementById('form-status').textContent };
    })()`);
    check('el interruptor de compartido existe', shared.exists === true);
    check('el guardado envía compartido=true', shared.body.compartido === true, JSON.stringify(shared.body));
    check('el interruptor se conserva después de guardar', shared.checkedAfter === true, shared.status);

    console.log('Duplicado, vibracion y deshacer');
    const dup = await cdp.eval(`(async () => {
      window.__vibrations = [];
      try { navigator.vibrate = (p) => { window.__vibrations.push(p); return true; }; } catch (e) {}
      document.getElementById('concepto').value = 'Coto';
      document.getElementById('monto').value = '1500.50';
      window.__responses.push({ ok: false, error: 'DUPLICATE', message: 'Parece que ya cargaste este gasto (fila 41).', row: 41 });
      document.getElementById('expense-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      const started = Date.now();
      while (Date.now() - started < 4000 && document.getElementById('duplicate-banner').hidden) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const banner = { hidden: document.getElementById('duplicate-banner').hidden, text: document.getElementById('duplicate-text').textContent };
      window.__responses.push({ ok: true, row: 46 });
      document.getElementById('btn-force-save').click();
      const s2 = Date.now();
      while (Date.now() - s2 < 4000 && document.getElementById('form-status').textContent.indexOf('Guardado') === -1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const body = JSON.parse(window.__lastCall('save').options.body);
      return {
        banner: banner,
        status: document.getElementById('form-status').textContent,
        body: body,
        undoVisible: !document.getElementById('undo-box').hidden,
        vibrations: window.__vibrations.length
      };
    })()`);
    check('avisa cuando el gasto parece duplicado', dup.banner.hidden === false && dup.banner.text.indexOf('fila 41') > -1, JSON.stringify(dup.banner));
    check('"Guardar igual" reenvía con force=true', dup.body.force === true && dup.status.indexOf('46') > -1, JSON.stringify(dup.body));
    check('aparece el botón Deshacer', dup.undoVisible === true);
    check('vibra al guardar', dup.vibrations > 0, String(dup.vibrations));

    const undo = await cdp.eval(`(async () => {
      window.__responses.push({ ok: true, deleted: true, row: 46 });
      document.getElementById('btn-undo').click();
      const started = Date.now();
      while (Date.now() - started < 4000 && document.getElementById('form-status').textContent.indexOf('eliminado') === -1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const body = JSON.parse(window.__lastCall('delete').options.body);
      return { status: document.getElementById('form-status').textContent, body: body, undoHidden: document.getElementById('undo-box').hidden };
    })()`);
    check('Deshacer borra la fila guardada', undo.body.action === 'delete' && undo.body.row === 46 && typeof undo.body.fecha === 'string' && undo.status.indexOf('eliminado') > -1, JSON.stringify(undo));
    check('la caja de Deshacer se oculta', undo.undoHidden === true);

    console.log('Compartir imagen (share target)');
    const share = await cdp.eval(`(async () => {
      for (let i = 0; i < 60 && !navigator.serviceWorker.controller; i++) {
        await new Promise((r) => setTimeout(r, 100));
      }
      const canvas = document.createElement('canvas');
      canvas.width = 800; canvas.height = 1000;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 800, 1000);
      ctx.fillStyle = '#000'; ctx.font = '40px sans-serif'; ctx.fillText('PAGO 777', 40, 120);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      const form = new FormData();
      form.append('foto', new File([blob], 'pago.jpg', { type: 'image/jpeg' }));
      const status = await new Promise((resolve) => {
        const xhr = new XMLHttpRequest();
        xhr.open('POST', './share-target');
        xhr.onload = () => resolve(xhr.status);
        xhr.onerror = () => resolve(0);
        xhr.send(form);
      });
      const key = new URL('__shared-image', new URL('./', location.href)).href;
      const cache = await caches.open('gastos-share-v1');
      const stored = await cache.match(key);
      return { controlled: !!navigator.serviceWorker.controller, status: status, stored: !!stored, size: stored ? (await stored.blob()).size : 0 };
    })()`);
    check('el SW intercepta el share_target y guarda la imagen', share.controlled === true && share.stored === true && share.size > 1000, JSON.stringify(share));

    const shareFlow = await cdp.eval(`(async () => {
      history.replaceState(null, '', '?debug=1&shared=1');
      window.__responses.push({ ok: true, data: { fecha: '2026-11-22', concepto: 'Compartida', monto: 777, categoria: 'Otros', persona: 'Mauro' }, warnings: [] });
      await __OF__.applyPendingShare();
      const started = Date.now();
      while (Date.now() - started < 8000 && document.getElementById('concepto').value !== 'Compartida') {
        await new Promise((r) => setTimeout(r, 60));
      }
      const key = new URL('__shared-image', new URL('./', location.href)).href;
      const cache = await caches.open('gastos-share-v1');
      const leftover = await cache.match(key);
      return { concepto: document.getElementById('concepto').value, monto: document.getElementById('monto').value, leftover: !!leftover, search: location.search };
    })()`);
    check('la imagen compartida se lee y completa el formulario', shareFlow.concepto === 'Compartida' && shareFlow.monto === '777.00', JSON.stringify(shareFlow));
    check('se limpia el cache y el ?shared=1', shareFlow.leftover === false && shareFlow.search.indexOf('shared') === -1, JSON.stringify(shareFlow));

    console.log('Resumen del mes');
    const summary = await cdp.eval(`(async () => {
      window.__summary = {
        ok: true,
        hoy: { count: 2, total: 1500 },
        mes: { count: 3, total: 3500 },
        personas: [{ nombre: 'Mauro', total: 3000 }, { nombre: 'Anto', total: 500 }],
        compartido: { si: 2500, no: 1000 },
        categorias: [{ nombre: 'Servicios', total: 2000 }, { nombre: 'Supermercado', total: 1000 }],
        ultimos: [
          { row: 5, fecha: '2026-11-21', concepto: 'Luz', monto: 2000, categoria: 'Servicios', persona: 'Mauro', compartido: true },
          { row: 4, fecha: '2026-11-20', concepto: 'Coto', monto: 1000, categoria: 'Supermercado', persona: 'Mauro', compartido: false }
        ]
      };
      await __OF__.loadSummary();
      return {
        total: document.getElementById('summary-total').textContent,
        meta: document.getElementById('summary-meta').textContent,
        chips: document.getElementById('summary-chips').textContent,
        cats: document.getElementById('summary-cats').textContent,
        items: document.querySelectorAll('#recent-list li').length,
        first: document.querySelector('#recent-list li .r-concept').textContent
      };
    })()`);
    check('muestra el total del mes y de hoy', summary.total.indexOf('3.500') > -1 && summary.meta.indexOf('3 gastos') > -1 && summary.meta.indexOf('1.500') > -1, JSON.stringify(summary));
    check('muestra personas y compartido', summary.chips.indexOf('Mauro') > -1 && summary.chips.indexOf('Anto') > -1 && summary.chips.indexOf('Compartido') > -1, summary.chips);
    check('muestra el top de categorías', summary.cats.indexOf('Servicios') > -1, summary.cats);
    check('lista los últimos gastos', summary.items === 2 && summary.first === 'Luz', JSON.stringify(summary));

    const toggle = await cdp.eval(`(() => {
      const btn = document.getElementById('btn-summary-toggle');
      const body = document.getElementById('summary-body');
      btn.click();
      const opened = !body.hidden && btn.textContent === 'Ocultar' && btn.getAttribute('aria-expanded') === 'true';
      btn.click();
      const closed = body.hidden && btn.textContent === 'Detalle';
      return { opened: opened, closed: closed };
    })()`);
    check('el botón Detalle abre y cierra', toggle.opened === true && toggle.closed === true, JSON.stringify(toggle));

    const delRecent = await cdp.eval(`(async () => {
      window.confirm = () => true;
      window.__responses.push({ ok: true, deleted: true, row: 5 });
      const before = window.__calls.length;
      document.querySelector('#recent-list li .r-del').click();
      const started = Date.now();
      while (Date.now() - started < 5000 && window.__calls.length <= before) {
        await new Promise((r) => setTimeout(r, 50));
      }
      await new Promise((r) => setTimeout(r, 400));
      const calls = window.__calls.slice(before).map((c) => JSON.parse(c.options.body));
      const del = calls.find((c) => c.action === 'delete');
      return { deleteBody: del || null, status: document.getElementById('form-status').textContent };
    })()`);
    check('borrar desde la lista usa action=delete con la fila', delRecent.deleteBody && delRecent.deleteBody.row === 5 && delRecent.status.indexOf('eliminado') > -1, JSON.stringify(delRecent));

    const editFlow = await cdp.eval(`(async () => {
      const first = document.querySelector('#recent-list li');
      first.querySelector('.r-edit').click();
      const filled = {
        fecha: document.getElementById('fecha').value,
        concepto: document.getElementById('concepto').value,
        monto: document.getElementById('monto').value,
        chip: document.getElementById('form-mode').textContent,
        editing: document.getElementById('form-mode').classList.contains('is-editing'),
        cancelVisible: !document.getElementById('btn-cancel-edit').hidden,
        saveLabel: document.getElementById('btn-save').textContent
      };
      document.getElementById('monto').value = '2222.50';
      window.__responses.push({ ok: true, row: 5, updated: true });
      document.getElementById('expense-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      const started = Date.now();
      while (Date.now() - started < 5000 && document.getElementById('form-status').textContent.indexOf('actualizado') === -1) {
        await new Promise((r) => setTimeout(r, 50));
      }
      const body = JSON.parse(window.__lastCall('update').options.body);
      return {
        filled: filled,
        body: body,
        status: document.getElementById('form-status').textContent,
        chipAfter: document.getElementById('form-mode').textContent,
        cancelHidden: document.getElementById('btn-cancel-edit').hidden,
        saveLabelAfter: document.getElementById('btn-save').textContent
      };
    })()`);
    check('el ✏️ carga el gasto en el formulario', editFlow.filled.fecha === '2026-11-21' && editFlow.filled.concepto === 'Luz' && editFlow.filled.monto === '2000.00', JSON.stringify(editFlow.filled));
    check('el formulario entra en modo edición', editFlow.filled.chip === 'Editando' && editFlow.filled.editing === true && editFlow.filled.cancelVisible === true && editFlow.filled.saveLabel === 'Guardar cambios', JSON.stringify(editFlow.filled));
    check('guardar envía action=update con fila y original', editFlow.body.action === 'update' && editFlow.body.row === 5 && editFlow.body.original.concepto === 'Luz' && editFlow.body.original.monto === 2000 && editFlow.body.monto === 2222.5, JSON.stringify(editFlow.body));
    check('al guardar vuelve a carga manual', editFlow.status.indexOf('actualizado') > -1 && editFlow.chipAfter === 'Carga manual' && editFlow.cancelHidden === true && editFlow.saveLabelAfter === 'Guardar gasto', JSON.stringify(editFlow));

    const cancelEdit = await cdp.eval(`(() => {
      document.querySelector('#recent-list li .r-edit').click();
      const before = document.getElementById('btn-cancel-edit').hidden;
      document.getElementById('btn-cancel-edit').click();
      return {
        before: before,
        after: document.getElementById('btn-cancel-edit').hidden,
        concepto: document.getElementById('concepto').value,
        monto: document.getElementById('monto').value,
        chip: document.getElementById('form-mode').textContent
      };
    })()`);
    check('Cancelar sale del modo edición y limpia', cancelEdit.before === false && cancelEdit.after === true && cancelEdit.concepto === '' && cancelEdit.monto === '' && cancelEdit.chip === 'Carga manual', JSON.stringify(cancelEdit));

    const meta = await cdp.eval(`(async () => {
      window.__meta = { ok: true, categories: ['Supermercado', 'Mascotas', 'Otros'], people: ['Mauro', 'Anto', 'Sofi'] };
      await __OF__.loadMeta();
      const cats = Array.from(document.querySelectorAll('#categoria option')).map((o) => o.value);
      const people = Array.from(document.querySelectorAll('#persona option')).map((o) => o.value);
      const valid = __OF__.validate({ fecha: '2026-11-22', concepto: 'X', monto: 10, categoria: 'Mascotas', persona: 'Sofi' });
      const invalid = __OF__.validate({ fecha: '2026-11-22', concepto: 'X', monto: 10, categoria: 'Supermercado', persona: 'Nadie' });
      return { cats: cats, people: people, valid: valid, invalid: invalid };
    })()`);
    check('las categorías y personas vienen del backend', meta.cats.indexOf('Mascotas') > -1 && meta.people.indexOf('Sofi') > -1, JSON.stringify(meta));
    check('la validación usa las listas nuevas', meta.valid === '' && meta.invalid.indexOf('gasto') > -1, JSON.stringify(meta));

    const photoUi = await cdp.eval(`(async () => {
      const out = {};
      if (!document.getElementById('thumb-wrap').hidden) {
        document.getElementById('btn-quitar-foto').click();
      }
      out.before = {
        leerHidden: document.getElementById('btn-leer').hidden,
        thumbHidden: document.getElementById('thumb-wrap').hidden,
        leerText: document.getElementById('btn-leer').textContent
      };

      const canvas = document.createElement('canvas');
      canvas.width = 900; canvas.height = 600;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 900, 600);
      ctx.fillStyle = '#000'; ctx.font = '40px sans-serif'; ctx.fillText('FARMACIA 1234', 40, 120);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      const file = new File([blob], 'drop.jpg', { type: 'image/jpeg' });

      window.__responses.push({ ok: true, data: { fecha: '2026-11-21', concepto: 'Farmacia', monto: 2500, categoria: 'Salud', persona: 'Mauro' }, warnings: [] });
      await __OF__.handleFile(file);
      out.afterRead = {
        concepto: document.getElementById('concepto').value,
        leerHidden: document.getElementById('btn-leer').hidden,
        leerText: document.getElementById('btn-leer').textContent,
        thumbHidden: document.getElementById('thumb-wrap').hidden,
        hasImage: !!__OF__.state.image,
        calls: window.__countCalls('extract')
      };

      window.__responses.push({ ok: true, data: { fecha: '2026-11-21', concepto: 'Farmacia', monto: 2600, categoria: 'Salud', persona: 'Mauro' }, warnings: [] });
      document.getElementById('btn-leer').click();
      const started = Date.now();
      while (Date.now() - started < 5000 && document.getElementById('monto').value !== '2600.00') {
        await new Promise((r) => setTimeout(r, 50));
      }
      out.afterReread = {
        monto: document.getElementById('monto').value,
        calls: window.__countCalls('extract'),
        body: JSON.parse(window.__lastCall('extract').options.body)
      };

      document.getElementById('btn-quitar-foto').click();
      out.afterRemove = {
        thumbHidden: document.getElementById('thumb-wrap').hidden,
        leerHidden: document.getElementById('btn-leer').hidden,
        hasImage: !!__OF__.state.image,
        concepto: document.getElementById('concepto').value,
        monto: document.getElementById('monto').value
      };
      return out;
    })()`);
    check('sin foto: "Leer ticket" y vista previa ocultos', photoUi.before.leerHidden === true && photoUi.before.thumbHidden === true, JSON.stringify(photoUi.before));
    check('al cargar una foto se lee sola y completa', photoUi.afterRead.concepto === 'Farmacia' && photoUi.afterRead.hasImage === true, JSON.stringify(photoUi.afterRead));
    check('aparece "Leer de nuevo" con la vista previa', photoUi.afterRead.leerHidden === false && photoUi.afterRead.leerText.indexOf('Leer de nuevo') > -1 && photoUi.afterRead.thumbHidden === false, JSON.stringify(photoUi.afterRead));
    check('el botón relee la misma imagen', photoUi.afterReread.monto === '2600.00' && photoUi.afterReread.calls === photoUi.afterRead.calls + 1 && photoUi.afterReread.body.action === 'extract' && photoUi.afterReread.body.image.length > 1000, JSON.stringify({ calls: photoUi.afterReread.calls, monto: photoUi.afterReread.monto }));
    check('"Quitar foto" limpia la imagen pero no los campos', photoUi.afterRemove.thumbHidden === true && photoUi.afterRemove.leerHidden === true && photoUi.afterRemove.hasImage === false && photoUi.afterRemove.concepto === 'Farmacia' && photoUi.afterRemove.monto === '2600.00', JSON.stringify(photoUi.afterRemove));

    const dropped = await cdp.eval(`(async () => {
      const canvas = document.createElement('canvas');
      canvas.width = 800; canvas.height = 600;
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, 800, 600);
      ctx.fillStyle = '#000'; ctx.font = '36px sans-serif'; ctx.fillText('SUPER 999', 30, 100);
      const blob = await new Promise((r) => canvas.toBlob(r, 'image/jpeg', 0.9));
      const file = new File([blob], 'drop2.jpg', { type: 'image/jpeg' });
      const dt = new DataTransfer();
      dt.items.add(file);
      const zone = document.getElementById('dropzone');
      zone.dispatchEvent(new DragEvent('dragenter', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const highlighted = zone.classList.contains('dragover');
      window.__responses.push({ ok: true, data: { fecha: '2026-11-21', concepto: 'Super', monto: 990, categoria: 'Supermercado', persona: 'Anto' }, warnings: [] });
      zone.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      const started = Date.now();
      while (Date.now() - started < 8000 && document.getElementById('concepto').value !== 'Super') {
        await new Promise((r) => setTimeout(r, 60));
      }
      return {
        highlighted: highlighted,
        highlightedAfter: zone.classList.contains('dragover'),
        concepto: document.getElementById('concepto').value,
        monto: document.getElementById('monto').value,
        categoria: document.getElementById('categoria').value,
        persona: document.getElementById('persona').value
      };
    })()`);
    check('dragenter resalta la zona de drop', dropped.highlighted === true, String(dropped.highlighted));
    check('soltar una foto la procesa y completa', dropped.concepto === 'Super' && dropped.monto === '990.00' && dropped.categoria === 'Supermercado' && dropped.persona === 'Anto', JSON.stringify(dropped));
    check('el resaltado se limpia al soltar', dropped.highlightedAfter === false, String(dropped.highlightedAfter));

    const layoutCards = await cdp.eval(`(() => {
      const app = document.getElementById('app-card');
      const ticket = document.getElementById('ticket-card');
      const form = document.getElementById('form-card');
      return {
        siblings: ticket.parentElement === app && form.parentElement === app,
        divider: !!app.querySelector('.or-divider'),
        titles: !!ticket.querySelector('.section-title') && !!form.querySelector('.section-title'),
        chip: document.getElementById('form-mode').textContent,
        chipRead: document.getElementById('form-mode').classList.contains('is-read')
      };
    })()`);
    check('ticket y formulario son tarjetas separadas', layoutCards.siblings === true && layoutCards.divider === true && layoutCards.titles === true, JSON.stringify(layoutCards));
    check('etiqueta "Leídos del ticket" con tilde verde', layoutCards.chip === 'Leído del ticket' && layoutCards.chipRead === true, JSON.stringify(layoutCards));

    console.log('\n== Token vencido / AUTH ==');
    const authFail = await cdp.eval(`(async () => {
      document.getElementById('concepto').value = 'Nafta';
      document.getElementById('monto').value = '800';
      window.__responses.push({ ok: false, error: 'AUTH', message: 'Sesión inválida o vencida. Volvé a iniciar sesión.' });
      document.getElementById('expense-form').dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
      const started = Date.now();
      while (Date.now() - started < 5000 && document.getElementById('login-card').hidden) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        loginVisible: !document.getElementById('login-card').hidden,
        appHidden: document.getElementById('app-card').hidden,
        loginStatus: document.getElementById('login-status').textContent,
        token: __OF__.state.token,
        stored: localStorage.getItem('of.sesion.v1')
      };
    })()`);
    check('AUTH cierra la sesión y vuelve al login', authFail.loginVisible === true && authFail.appHidden === true, JSON.stringify(authFail));
    check('explica que la sesión venció', authFail.loginStatus.indexOf('venció') > -1, authFail.loginStatus);
    check('borra token y localStorage', authFail.token === null && authFail.stored === null);

    console.log('\n== Persistencia de sesión ==');
    const savedSession = await cdp.eval(`(() => {
      const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const exp = Math.floor(Date.now() / 1000) + 1800;
      const payload = btoa(JSON.stringify({ email: 'yo@gmail.com', exp: exp }));
      __OF__.saveSession(header + '.' + payload + '.f', { email: 'yo@gmail.com', exp: exp });
      return {
        inLocal: !!localStorage.getItem('of.sesion.v1'),
        inSession: !!sessionStorage.getItem('of.sesion.v1'),
        token: !!__OF__.state.token
      };
    })()`);
    check('el login guarda la sesión en localStorage', savedSession.inLocal === true && savedSession.inSession === false && savedSession.token === true, JSON.stringify(savedSession));
    await cdp.eval(SIGN_IN);
    await cdp.eval(`(() => {
      const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const payload = btoa(JSON.stringify({ email: 'yo@gmail.com', exp: exp }));
      localStorage.setItem('of.sesion.v1', JSON.stringify({ token: header + '.' + payload + '.f', exp: exp * 1000, email: 'yo@gmail.com' }));
      return true;
    })()`);
    await cdp.navigate(APP_URL);
    const restored = await cdp.eval(`({
      appVisible: !document.getElementById('app-card').hidden,
      loginHidden: document.getElementById('login-card').hidden,
      email: document.getElementById('user-email').textContent
    })`);
    check('restaura la sesión al recargar', restored.appVisible === true && restored.loginHidden === true);
    check('restaura el email', restored.email === 'yo@gmail.com', restored.email);

    // Migración desde la versión anterior (sessionStorage)
    await cdp.eval(`(() => {
      const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const exp = Math.floor(Date.now() / 1000) + 3600;
      const payload = btoa(JSON.stringify({ email: 'yo@gmail.com', exp: exp }));
      localStorage.removeItem('of.sesion.v1');
      sessionStorage.setItem('of.sesion.v1', JSON.stringify({ token: header + '.' + payload + '.f', exp: exp * 1000, email: 'yo@gmail.com' }));
      return true;
    })()`);
    await cdp.navigate(APP_URL);
    const migrated = await cdp.eval(`({
      appVisible: !document.getElementById('app-card').hidden,
      inLocal: !!localStorage.getItem('of.sesion.v1'),
      inSession: !!sessionStorage.getItem('of.sesion.v1')
    })`);
    check('migra la sesión vieja a localStorage', migrated.appVisible === true && migrated.inLocal === true && migrated.inSession === false, JSON.stringify(migrated));

    const expired = await cdp.eval(`(() => {
      const header = btoa(JSON.stringify({ alg: 'none', typ: 'JWT' }));
      const exp = Math.floor(Date.now() / 1000) - 3600;
      const payload = btoa(JSON.stringify({ email: 'yo@gmail.com', exp: exp }));
      __OF__.setSignedIn(false);
      __OF__.state.token = null;
      localStorage.setItem('of.sesion.v1', JSON.stringify({ token: header + '.' + payload + '.f', exp: exp * 1000, email: 'yo@gmail.com' }));
      __OF__.restoreSession();
      return {
        loginVisible: !document.getElementById('login-card').hidden,
        appHidden: document.getElementById('app-card').hidden,
        token: __OF__.state.token,
        stored: localStorage.getItem('of.sesion.v1')
      };
    })()`);
    check('ignora y borra una sesión vencida', expired.loginVisible === true && expired.appHidden === true && expired.token === null && expired.stored === null, JSON.stringify(expired));

    console.log('\n== PWA / Service Worker ==');
    await cdp.send('Network.enable');
    const sw = await waitFor(() => cdp.eval(`navigator.serviceWorker.getRegistrations().then((regs) => {
      if (!regs.length) return null;
      const reg = regs[0];
      if (!reg.active) return null;
      return { count: regs.length, scope: reg.scope, state: reg.active.state, controlled: !!navigator.serviceWorker.controller };
    })`), 15000, 'service worker activo').catch(() => null);
    check('service worker registrado y activo', !!sw && sw.state === 'activated', JSON.stringify(sw));
    check('scope en la raíz del sitio', !!sw && sw.scope.endsWith('/'), sw && sw.scope);

    const offline = await cdp.eval(`fetch('index.html').then((r) => r.text()).then((t) => t.indexOf('Gastos') > -1).catch(() => false)`);
    check('precachea el shell (online)', offline === true);

    await cdp.send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    const offlineServed = await cdp.eval(`fetch('index.html', { cache: 'no-store' }).then((r) => r.text()).then((t) => t.indexOf('Gastos') > -1).catch(() => false)`);
    await cdp.send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
    check('sirve la app sin conexión desde el SW', offlineServed === true);

    console.log('\n== Superficie de depuración ==');
    await cdp.send('Page.navigate', { url: 'http://127.0.0.1:' + PORT + '/index.html' });
    await waitFor(() => cdp.eval('document.readyState === "complete"'), 15000, 'recarga sin debug');
    const noHook = await cdp.eval('typeof window.__OF__');
    check('sin ?debug no expone helpers internos', noHook === 'undefined', noHook);

    console.log('\n== Layout mobile-first ==');
    await cdp.navigate(APP_URL);
    await cdp.eval(SIGN_IN);
    const layout = await cdp.eval(`(() => {
      const mainButtons = Array.from(document.querySelectorAll('.btn, .step')).filter((b) => b.offsetParent !== null);
      const heights = mainButtons.map((b) => b.getBoundingClientRect().height);
      const fields = ['fecha', 'concepto', 'monto', 'categoria', 'persona'].map((id) => document.getElementById(id));
      return {
        width: window.innerWidth,
        scrollWidth: document.documentElement.scrollWidth,
        minButton: Math.min.apply(null, heights),
        fieldsInside: fields.every((f) => f.getBoundingClientRect().right <= window.innerWidth + 1),
        inputFontSize: getComputedStyle(document.getElementById('concepto')).fontSize,
        bodyFontSize: getComputedStyle(document.body).fontSize
      };
    })()`);
    check('sin scroll horizontal a 390px', layout.scrollWidth <= layout.width + 1, layout.scrollWidth + ' vs ' + layout.width);
    check('botones con altura táctil >= 48px', layout.minButton >= 48, String(layout.minButton));
    check('todos los campos entran en el ancho', layout.fieldsInside === true);
    check('inputs a 16px (evita zoom en iOS)', layout.inputFontSize === '16px', layout.inputFontSize);

    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 320, height: 700, deviceScaleFactor: 2, mobile: true });
    const narrow = await cdp.eval(`({ width: window.innerWidth, scrollWidth: document.documentElement.scrollWidth })`);
    await cdp.send('Emulation.clearDeviceMetricsOverride');
    check('sin scroll horizontal a 320px', narrow.scrollWidth <= narrow.width + 1, narrow.scrollWidth + ' vs ' + narrow.width);

    console.log('\n== CSP y errores de JS ==');
    const exceptions = cdp.events.filter((e) => e.method === 'Runtime.exceptionThrown');
    const consoleErrors = cdp.events.filter((e) => e.method === 'Runtime.consoleAPICalled' && e.params.type === 'error');
    const logErrors = cdp.events.filter((e) => e.method === 'Log.entryAdded' && e.params.entry.level === 'error');
    const cspMessages = consoleErrors.concat(logErrors).filter((e) => JSON.stringify(e.params).indexOf('Content Security Policy') > -1);
    check('sin excepciones de JS', exceptions.length === 0, exceptions.map((e) => JSON.stringify(e.params.exceptionDetails && e.params.exceptionDetails.text)).join(' | '));
    check('sin violaciones de CSP', cspMessages.length === 0, cspMessages.map((e) => JSON.stringify(e.params)).join(' | '));
    const networkErrors = logErrors.filter((e) => JSON.stringify(e.params).indexOf('ERR_') > -1 || JSON.stringify(e.params).indexOf('Failed to load') > -1);
    console.log('  (info) errores de red esperados sin internet: ' + networkErrors.length);

    console.log('\n== Archivos servidos ==');
    const paths = ['/', '/index.html', '/manifest.json', '/sw.js', '/icons/icon-192.png', '/icons/icon-512.png', '/icons/maskable-192.png', '/icons/maskable-512.png'];
    for (const item of paths) {
      const response = await new Promise((resolve) => {
        http.get('http://127.0.0.1:' + PORT + item, (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, type: res.headers['content-type'], body: Buffer.concat(chunks) }));
        }).on('error', () => resolve({ status: 0 }));
      });
      const isPng = item.endsWith('.png');
      const pngOk = !isPng || (response.body && response.body[0] === 0x89 && response.body[1] === 0x50);
      check('200 ' + item + ' (' + (response.type || 'sin mime') + ')', response.status === 200 && pngOk, String(response.status));
    }

    console.log('');
    console.log('RESULTADO FRONTEND: ' + pass + ' OK / ' + failures.length + ' FAIL');
    if (failures.length) {
      console.log('FALLAS:');
      failures.forEach((f) => console.log(' - ' + f));
    }
  } catch (err) {
    failures.push('excepción del harness: ' + err.message);
    console.log('\nERROR DEL HARNESS: ' + err.stack);
  } finally {
    try { chromium.kill('SIGKILL'); } catch (err) { /* ignorado */ }
    try { server.close(); } catch (err) { /* ignorado */ }
    process.exit(failures.length ? 1 : 0);
  }
})();
