const say = (...a) => process.stdout.write(a.join(' ') + '\n');
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const crypto = require('crypto');
const assert = require('assert');
const ROOT = path.resolve(__dirname, '..');

let pass = 0;
const failures = [];
function check(name, fn) {
  try { fn(); pass++; say('  OK   ' + name); }
  catch (err) { failures.push(name + ': ' + err.message); say('  FAIL ' + name + ' -> ' + err.message); }
}

/* ============================ MOCKS ==================================== */
const store = new Map();
const calls = { tokeninfo: 0, gemini: 0, models: 0, fetch: [] };
let tokeninfoResponse = { code: 400, body: '{}' };
let geminiResponse = { code: 200, body: '{}' };
let geminiQueue = [];
let modelsResponse = { code: 200, body: JSON.stringify({ models: [{ name: 'models/gemini-3.8-flash' }, { name: 'models/gemini-3.7-flash' }] }) };
let lockAvailable = true;

function pad(n) { return String(n).padStart(2, '0'); }
function fmtDate(date, tz, format) {
  const d = date instanceof Date ? date : new Date(date);
  if (format === 'yyyy-MM-dd') return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
    pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds());
}

global.PropertiesService = {
  getScriptProperties: () => ({
    getProperty: (k) => (store.has(k) ? store.get(k) : null),
    setProperty: (k, v) => { store.set(k, String(v)); },
    deleteProperty: (k) => { store.delete(k); }
  })
};

global.Session = { getScriptTimeZone: () => 'America/Argentina/Buenos_Aires' };

global.Utilities = {
  formatDate: fmtDate,
  base64Decode: (text) => Array.from(Buffer.from(text, 'base64')),
  newBlob: (bytes) => ({ getDataAsString: () => Buffer.from(bytes).toString('utf8') }),
  computeDigest: (alg, value) => Array.from(crypto.createHash('sha256').update(String(value)).digest()),
  sleep: () => {},
  DigestAlgorithm: { SHA_256: 'SHA_256' }
};

global.ContentService = {
  MimeType: { JSON: 'application/json' },
  createTextOutput: (text) => ({
    text,
    mimeType: null,
    setMimeType(m) { this.mimeType = m; return this; },
    getContent() { return this.text; }
  })
};

global.UrlFetchApp = {
  fetch: (url, options) => {
    calls.fetch.push({ url, options });
    if (String(url).indexOf('tokeninfo') > -1) {
      calls.tokeninfo++;
      return { getResponseCode: () => tokeninfoResponse.code, getContentText: () => tokeninfoResponse.body };
    }
    if (String(url).indexOf('generativelanguage') > -1) {
      if (String(url).indexOf('/models?') > -1) {
        calls.models++;
        const list = modelsResponse;
        return { getResponseCode: () => list.code, getContentText: () => list.body };
      }
      calls.gemini++;
      const next = geminiQueue.length ? geminiQueue.shift() : geminiResponse;
      return { getResponseCode: () => next.code, getContentText: () => next.body };
    }
    throw new Error('URL inesperada en el mock: ' + url);
  }
};

/* ------------------------ Fake Spreadsheet ----------------------------- */
function makeSheet(name) {
  const rows = [];
  const formats = Object.create(null);
  const sheet = {
    name,
    frozen: 0,
    maxColumns: 26,
    widths: {},
    getName: () => sheet.name,
    getMaxColumns: () => sheet.maxColumns,
    insertColumnsAfter: (after, howMany) => { sheet.maxColumns += howMany; },
    getFrozenRows: () => sheet.frozen,
    setFrozenRows: (n) => { sheet.frozen = n; },
    deleteRow: (r) => { rows.splice(r - 1, 1); },
    setColumnWidth: (col, w) => { sheet.widths[col] = w; },
    getCell(r, c) {
      const row = rows[r - 1];
      if (!row) return '';
      const v = row[c - 1];
      return v === undefined || v === null ? '' : v;
    },
    setCell(r, c, v) {
      while (rows.length < r) rows.push([]);
      const row = rows[r - 1];
      while (row.length < c) row.push('');
      row[c - 1] = v;
    },
    rows,
    formats,
    getLastRow() {
      let last = 0;
      rows.forEach((row, i) => {
        if (row && row.some((cell) => String(cell === null || cell === undefined ? '' : cell).trim() !== '')) last = i + 1;
      });
      return last;
    },
    getLastColumn() {
      let max = 0;
      rows.forEach((row) => {
        if (!row) return;
        row.forEach((cell, i) => { if (String(cell === null || cell === undefined ? '' : cell).trim() !== '') max = Math.max(max, i + 1); });
      });
      return max;
    },
    getRange(a, b, c, d) {
      let row = 1, col = 1, nRows = 1, nCols = 1;
      if (typeof a === 'string') {
        const single = /^([A-Z]+)(\d+)$/.exec(a);
        const columnRange = /^([A-Z]+)(\d+):([A-Z]+)$/.exec(a);
        if (single) { col = colToIndex(single[1]); row = Number(single[2]); }
        else if (columnRange) { col = colToIndex(columnRange[1]); row = Number(columnRange[2]); nRows = Math.max(1, 300 - row + 1); }
        else throw new Error('A1 no soportado en el mock: ' + a);
      } else {
        row = Number(a); col = Number(b); nRows = Number(c) || 1; nCols = Number(d) || 1;
      }
      return makeRange(sheet, row, col, nRows, nCols);
    },
    appendRow(values) {
      const r = sheet.getLastRow() + 1;
      values.forEach((v, i) => sheet.setCell(r, i + 1, v));
    },
    getDataRange() {
      return makeRange(sheet, 1, 1, Math.max(1, sheet.getLastRow()), Math.max(1, sheet.getLastColumn()));
    }
  };
  return sheet;
}

function colToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n;
}

function makeRange(sheet, row, col, nRows, nCols) {
  const range = {
    getValues() {
      const out = [];
      for (let r = 0; r < nRows; r++) {
        const line = [];
        for (let c = 0; c < nCols; c++) line.push(sheet.getCell(row + r, col + c));
        out.push(line);
      }
      return out;
    },
    setValues(values) {
      values.forEach((line, r) => line.forEach((value, c) => {
        sheet.setCell(row + r, col + c, value);
        sheet.formats[(row + r) + ',' + (col + c)] = sheet.formats[(row + r) + ',' + (col + c)] || 'General';
      }));
      return range;
    },
    setNumberFormat(format) {
      for (let r = 0; r < nRows; r++) for (let c = 0; c < nCols; c++) sheet.formats[(row + r) + ',' + (col + c)] = format;
      return range;
    },
    setNumberFormats(matrix) {
      matrix.forEach((line, r) => line.forEach((format, c) => { sheet.formats[(row + r) + ',' + (col + c)] = format; }));
      return range;
    },
    insertCheckboxes() { return range; },
    setFontWeight() { return range; },
    setBackground() { return range; },
    setFontColor() { return range; },
    getNumberFormat() { return sheet.formats[row + ',' + col] || 'General'; }
  };
  return range;
}

const spreadsheets = [];
const mainSheet = makeSheet('Hoja 1');
spreadsheets.push(mainSheet);
const fakeSpreadsheet = {
  id: '1FAKE_SPREADSHEET_ID_abcdefghijklmnopqrstuvwxyz',
  name: 'Gastos personales',
  sheets: spreadsheets,
  getId: () => fakeSpreadsheet.id,
  getName: () => fakeSpreadsheet.name,
  getSpreadsheetTimeZone: () => 'America/Argentina/Buenos_Aires',
  getSheetByName: (n) => spreadsheets.find((s) => s.name === n) || null,
  insertSheet: (n) => { const s = makeSheet(n); spreadsheets.push(s); return s; },
  getSheets: () => spreadsheets
};

global.SpreadsheetApp = {
  openById: () => fakeSpreadsheet,
  getActiveSpreadsheet: () => fakeSpreadsheet,
  flush: () => {}
};

global.LockService = {
  getScriptLock: () => ({ tryLock: () => lockAvailable, releaseLock: () => {} })
};

const cacheStore = new Map();
global.CacheService = {
  getScriptCache: () => ({
    get: (k) => (cacheStore.has(k) ? cacheStore.get(k) : null),
    put: (k, v) => { cacheStore.set(k, v); }
  })
};

const logs = [];
global.console = { log: (m) => logs.push(String(m)), error: (m) => logs.push('ERROR ' + String(m)) };

vm.runInThisContext(fs.readFileSync(path.join(ROOT, 'backend/Code.js'), 'utf8'), { filename: 'Code.js' });

/* ============================ HELPERS ================================== */
const AUTHORIZED = 'yo@gmail.com';
const CLIENT_ID = '123456789012-abcdefghijklmnop.apps.googleusercontent.com';
const API_KEY = 'AIzaSyTESTKEY_0123456789abcdefghijklmno';
const SHEET_ID = '1FAKE_SPREADSHEET_ID_abcdefghijklmnopqrstuvwxyz';
const IMAGE_B64 = Buffer.from('fake-jpeg-content-'.repeat(30)).toString('base64');

function configure() {
  store.clear();
  store.set('AUTHORIZED_EMAIL', AUTHORIZED);
  store.set('GEMINI_API_KEY', API_KEY);
  store.set('GOOGLE_CLIENT_ID', CLIENT_ID);
  store.set('SHEET_ID', SHEET_ID);
}

function b64url(obj) { return Buffer.from(JSON.stringify(obj)).toString('base64url'); }
function makeToken(payload) { return b64url({ alg: 'RS256', typ: 'JWT' }) + '.' + b64url(payload) + '.firma-falsa'; }
function validClaims(overrides) {
  return Object.assign({
    email: AUTHORIZED,
    email_verified: true,
    exp: Math.floor(Date.now() / 1000) + 3600,
    aud: CLIENT_ID,
    iss: 'https://accounts.google.com'
  }, overrides || {});
}
function tokeninfoFor(claims) {
  return {
    code: 200,
    body: JSON.stringify({
      email: claims.email,
      email_verified: 'true',
      aud: claims.aud,
      iss: claims.iss,
      exp: String(claims.exp)
    })
  };
}
function post(body) {
  const contents = typeof body === 'string' ? body : JSON.stringify(body);
  const result = doPost({ postData: { contents } });
  const text = result.getContent();
  return { text, json: JSON.parse(text) };
}
function geminiWith(obj) {
  const text = typeof obj === 'string' ? obj : JSON.stringify(obj);
  return { code: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] }) };
}
function gastosSheet() { return fakeSpreadsheet.getSheetByName('Gastos'); }
function resetCounters() { calls.tokeninfo = 0; calls.gemini = 0; calls.models = 0; calls.fetch = []; cacheStore.clear(); geminiQueue = []; store.delete('GEMINI_MODEL_STATS'); }
function validToken() { return makeToken(validClaims()); }
function saveBody(extra) {
  return Object.assign({
    action: 'save',
    force: true,
    idToken: validToken(),
    fecha: '2026-11-20',
    concepto: 'Coto',
    monto: 1500.5,
    categoria: 'Supermercado',
    persona: 'Mauro'
  }, extra || {});
}

/* ============================ TESTS ==================================== */
say('\n== Helpers y configuración ==');

check('setting_ prioriza Script Properties sobre CONFIG', () => {
  store.clear();
  store.set('AUTHORIZED_EMAIL', 'prop@gmail.com');
  assert.strictEqual(setting_('AUTHORIZED_EMAIL'), 'prop@gmail.com');
  store.delete('AUTHORIZED_EMAIL');
  assert.strictEqual(setting_('AUTHORIZED_EMAIL'), CONFIG.AUTHORIZED_EMAIL);
});

check('setting_ devuelve vacío si no hay nada', () => {
  store.clear();
  assert.strictEqual(setting_('SHEET_ID'), '');
});

check('isPlaceholder_ detecta placeholders y vacíos', () => {
  assert.strictEqual(isPlaceholder_('PEGAR_API_KEY_DE_GEMINI'), true);
  assert.strictEqual(isPlaceholder_('TU_CLIENT_ID'), true);
  assert.strictEqual(isPlaceholder_(''), true);
  assert.strictEqual(isPlaceholder_(API_KEY), false);
});

check('parseAmount_ entiende formatos argentinos', () => {
  assert.strictEqual(parseAmount_('1.234,56'), 1234.56);
  assert.strictEqual(parseAmount_('$ 1.500'), 1500);
  assert.strictEqual(parseAmount_('1,234.56'), 1234.56);
  assert.strictEqual(parseAmount_('12,50'), 12.5);
  assert.strictEqual(parseAmount_('0.750'), 0.75);
  assert.ok(Number.isNaN(parseAmount_('abc')));
  assert.ok(Number.isNaN(parseAmount_('')));
});

check('isValidIsoDate_ rechaza fechas imposibles', () => {
  assert.strictEqual(isValidIsoDate_('2026-02-29'), false);
  assert.strictEqual(isValidIsoDate_('2024-02-29'), true);
  assert.strictEqual(isValidIsoDate_('2026-13-01'), false);
  assert.strictEqual(isValidIsoDate_('2026-1-1'), false);
});

check('sanitizeCell_ neutraliza fórmulas y caracteres de control', () => {
  assert.strictEqual(sanitizeCell_('=IMPORTXML("http://x","//a")'), "'=IMPORTXML(\"http://x\",\"//a\")");
  assert.strictEqual(sanitizeCell_('+SUM(A1)'), "'+SUM(A1)");
  assert.strictEqual(sanitizeCell_('-1'), "'-1");
  assert.strictEqual(sanitizeCell_('@x'), "'@x");
  assert.strictEqual(sanitizeCell_('Coto'), 'Coto');
  assert.strictEqual(sanitizeCell_('a\u0007b'), 'ab');
});

check('redact_ esconde la API key y los ?key=', () => {
  const text = redact_('url?key=' + API_KEY + ' y ' + API_KEY);
  assert.ok(text.indexOf(API_KEY) === -1);
  assert.ok(text.indexOf('AIza') === -1 || text.indexOf('AIza***') > -1);
});

check('maskEmail_ no expone el email completo', () => {
  const masked = maskEmail_(AUTHORIZED);
  assert.ok(masked.indexOf(AUTHORIZED) === -1);
  assert.ok(masked.endsWith('@gmail.com'));
});

configure();
say('\n== setup() ==');
check('setup crea la hoja Gastos con encabezados y formatos', () => {
  const out = setup();
  const sheet = gastosSheet();
  assert.ok(sheet, 'no se creó la hoja');
  assert.deepStrictEqual(sheet.getRange(1, 1, 1, CONFIG.HEADERS.length).getValues()[0], CONFIG.HEADERS);
  assert.strictEqual(sheet.getRange('A2').getNumberFormat(), '@');
  assert.strictEqual(sheet.getRange('C2').getNumberFormat(), '#,##0.00');
  assert.strictEqual(sheet.getFrozenRows(), 1);
  assert.ok(out.indexOf('creada') > -1 || out.indexOf('ya existía') > -1);
});

check('setup es idempotente', () => {
  const out = setup();
  assert.ok(out.indexOf('ya existía') > -1);
  assert.ok(out.indexOf('Encabezados: OK') > -1);
});

say('\n== Autorización ==');

check('doGet responde mínimo, sin datos de la planilla', () => {
  const res = doGet();
  const body = JSON.parse(res.getContent());
  assert.deepStrictEqual(Object.keys(body).sort(), ['ok', 'service']);
  assert.strictEqual(body.ok, true);
});

check('ping no requiere configuración', () => {
  store.clear();
  const res = post({ action: 'ping' });
  assert.strictEqual(res.json.ok, true);
  assert.strictEqual(res.json.version, VERSION);
  configure();
});

check('acción desconocida -> BAD_REQUEST', () => {
  const res = post({ action: 'borrar-todo' });
  assert.strictEqual(res.json.error, 'BAD_REQUEST');
});

check('body inválido -> BAD_REQUEST', () => {
  assert.strictEqual(post('no es json').json.error, 'BAD_REQUEST');
  assert.strictEqual(post('[]').json.error, 'BAD_REQUEST');
  assert.strictEqual(JSON.parse(doPost({}).getContent()).error, 'BAD_REQUEST');
});

check('sin token -> AUTH y no llama a tokeninfo', () => {
  resetCounters();
  tokeninfoResponse = { code: 200, body: '{}' };
  const res = post({ action: 'save' });
  assert.strictEqual(res.json.error, 'AUTH');
  assert.strictEqual(calls.tokeninfo, 0);
});

check('token malformado -> AUTH sin gastar red', () => {
  resetCounters();
  assert.strictEqual(post({ action: 'save', idToken: 'abc.def' }).json.error, 'AUTH');
  assert.strictEqual(calls.tokeninfo, 0);
});

check('token vencido en el claim -> AUTH sin gastar red', () => {
  resetCounters();
  const expired = makeToken(validClaims({ exp: Math.floor(Date.now() / 1000) - 10 }));
  assert.strictEqual(post({ action: 'save', idToken: expired }).json.error, 'AUTH');
  assert.strictEqual(calls.tokeninfo, 0);
});

check('token de otro email -> AUTH sin gastar red', () => {
  resetCounters();
  const other = makeToken(validClaims({ email: 'otro@gmail.com' }));
  assert.strictEqual(post({ action: 'save', idToken: other }).json.error, 'AUTH');
  assert.strictEqual(calls.tokeninfo, 0);
});

check('tokeninfo 400 -> AUTH', () => {
  resetCounters();
  tokeninfoResponse = { code: 400, body: '{"error":"invalid_token"}' };
  assert.strictEqual(post(saveBody()).json.error, 'AUTH');
  assert.strictEqual(calls.tokeninfo, 1);
});

check('email_verified=false -> AUTH', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = { code: 200, body: JSON.stringify({ email: claims.email, email_verified: 'false', aud: claims.aud, iss: claims.iss, exp: String(claims.exp) }) };
  assert.strictEqual(post(saveBody()).json.error, 'AUTH');
});

check('emisor inválido -> AUTH', () => {
  resetCounters();
  tokeninfoResponse = { code: 200, body: JSON.stringify({ email: AUTHORIZED, email_verified: 'true', aud: CLIENT_ID, iss: 'https://evil.example.com', exp: String(Math.floor(Date.now() / 1000) + 3600) }) };
  assert.strictEqual(post(saveBody()).json.error, 'AUTH');
});

check('audiencia distinta -> AUTH', () => {
  resetCounters();
  tokeninfoResponse = { code: 200, body: JSON.stringify({ email: AUTHORIZED, email_verified: 'true', aud: 'otro-client', iss: 'https://accounts.google.com', exp: String(Math.floor(Date.now() / 1000) + 3600) }) };
  assert.strictEqual(post(saveBody()).json.error, 'AUTH');
});

check('tokeninfo con otro email -> AUTH', () => {
  resetCounters();
  tokeninfoResponse = { code: 200, body: JSON.stringify({ email: 'atacante@gmail.com', email_verified: 'true', aud: CLIENT_ID, iss: 'https://accounts.google.com', exp: String(Math.floor(Date.now() / 1000) + 3600) }) };
  assert.strictEqual(post(saveBody()).json.error, 'AUTH');
});

check('email en mayúsculas se acepta (case-insensitive)', () => {
  resetCounters();
  store.set('AUTHORIZED_EMAIL', AUTHORIZED.toUpperCase());
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = geminiWith({ fecha: '2026-11-20', concepto: 'Kiosco', monto: 100, categoria: 'Otros', persona: 'Mauro' });
  const res = post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64, mimeType: 'image/jpeg' });
  assert.strictEqual(res.json.ok, true);
  configure();
});

check('tokeninfo caído (red) -> AUTH, sin filtrar el error interno', () => {
  resetCounters();
  const original = global.UrlFetchApp.fetch;
  global.UrlFetchApp.fetch = () => { throw new Error('DNS boom con ' + API_KEY); };
  try {
    const res = post(saveBody());
    assert.strictEqual(res.json.error, 'AUTH');
    assert.ok(res.text.indexOf(API_KEY) === -1);
  } finally {
    global.UrlFetchApp.fetch = original;
  }
});

say('\n== Extracción con Gemini ==');

check('extract devuelve los 5 campos normalizados', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = geminiWith({ fecha: '2026-11-20', concepto: '  "Coto"  ', monto: '1.234,56', categoria: 'supermercado', persona: 'anto' });
  const res = post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64, mimeType: 'image/jpeg' });
  assert.strictEqual(res.json.ok, true, res.text);
  assert.deepStrictEqual(res.json.data, { fecha: '2026-11-20', concepto: 'Coto', monto: 1234.56, categoria: 'Supermercado', persona: 'Anto' });
  assert.deepStrictEqual(res.json.warnings, []);
});

check('el request a Gemini usa modelo, header y schema', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = geminiWith({ fecha: '2026-11-20', concepto: 'Kiosco', monto: 100, categoria: 'Otros', persona: 'Mauro' });
  post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64, mimeType: 'image/png' });

  const call = calls.fetch.filter((c) => c.url.indexOf('generativelanguage') > -1).pop();
  assert.ok(call.url.indexOf(CONFIG.GEMINI_MODELS[0]) > -1, call.url);
  assert.ok(call.url.indexOf('key=') === -1, 'la key no debe ir en la URL');
  assert.strictEqual(call.options.headers['x-goog-api-key'], API_KEY);
  const payload = JSON.parse(call.options.payload);
  assert.strictEqual(payload.contents[0].parts[1].inline_data.mime_type, 'image/png');
  assert.strictEqual(payload.contents[0].parts[1].inline_data.data, IMAGE_B64);
  assert.strictEqual(payload.generationConfig.responseMimeType, 'application/json');
  assert.strictEqual(payload.generationConfig.thinkingConfig, undefined);
  assert.ok(payload.generationConfig.maxOutputTokens >= 2048);
  assert.strictEqual(payload.generationConfig.responseSchema.properties.categoria.enum.length, CONFIG.CATEGORIES.length);
  assert.deepStrictEqual(payload.generationConfig.responseSchema.required, ['fecha', 'concepto', 'monto', 'categoria', 'persona']);
});

check('mimeType no permitido cae a image/jpeg', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = geminiWith({ fecha: '2026-11-20', concepto: 'Kiosco', monto: 100, categoria: 'Otros', persona: 'Mauro' });
  post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64, mimeType: 'text/html' });
  const call = calls.fetch.filter((c) => c.url.indexOf('generativelanguage') > -1).pop();
  assert.strictEqual(JSON.parse(call.options.payload).contents[0].parts[1].inline_data.mime_type, 'image/jpeg');
});

check('Gemini 429 -> QUOTA con mensaje claro', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = { code: 429, body: '{"error":"quota"}' };
  const res = post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64 });
  assert.strictEqual(res.json.error, 'QUOTA');
});

check('Gemini 400 -> CONFIG (no filtra detalles)', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = { code: 400, body: '{"error":{"message":"API key not valid ' + API_KEY + '"}}' };
  const res = post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64 });
  assert.strictEqual(res.json.error, 'CONFIG');
  assert.ok(res.text.indexOf(API_KEY) === -1);
  assert.ok(res.json.message.indexOf('HTTP 400') > -1, res.json.message);
});

check('el mensaje 401 incluye el motivo de Google sin filtrar la key', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = { code: 401, body: JSON.stringify({ error: { code: 401, message: 'API key not valid. ' + API_KEY, status: 'UNAUTHENTICATED', details: [{ reason: 'ACCESS_TOKEN_TYPE_UNSUPPORTED' }] } }) };
  const res = post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64 });
  assert.strictEqual(res.json.error, 'CONFIG');
  assert.ok(res.json.message.indexOf('HTTP 401') > -1, res.json.message);
  assert.ok(res.json.message.indexOf('ACCESS_TOKEN_TYPE_UNSUPPORTED') > -1, res.json.message);
  assert.ok(res.text.indexOf(API_KEY) === -1, 'no debe filtrar la key');
});

check('Gemini 500 -> UPSTREAM', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = { code: 500, body: 'boom' };
  assert.strictEqual(post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64 }).json.error, 'UPSTREAM');
});

check('Gemini con JSON roto -> UPSTREAM', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = geminiWith('esto no es json');
  assert.strictEqual(post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64 }).json.error, 'UPSTREAM');
});

check('Gemini con bloqueo de seguridad -> UPSTREAM', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = { code: 200, body: JSON.stringify({ promptFeedback: { blockReason: 'SAFETY' } }) };
  assert.strictEqual(post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64 }).json.error, 'UPSTREAM');
});

check('Gemini con texto vacío -> UPSTREAM', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = { code: 200, body: JSON.stringify({ candidates: [{ content: { parts: [] }, finishReason: 'STOP' }] }) };
  assert.strictEqual(post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64 }).json.error, 'UPSTREAM');
});

check('JSON con ```json ... ``` se limpia y parsea', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = geminiWith('```json\n{"fecha":"2026-11-19","concepto":"YPF","monto":5000,"categoria":"Transporte","persona":"Mauro"}\n```');
  const res = post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64 });
  assert.strictEqual(res.json.ok, true);
  assert.strictEqual(res.json.data.concepto, 'YPF');
});

check('normalización: fecha ilegible -> hoy, monto 0 -> warning', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = geminiWith({ fecha: 'ayer', concepto: 'No se pudo leer', monto: 0, categoria: 'Súper', persona: 'Nadie' });
  const res = post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64 });
  assert.strictEqual(res.json.data.fecha, todayIso_());
  assert.strictEqual(res.json.data.concepto, '');
  assert.strictEqual(res.json.data.monto, 0);
  assert.strictEqual(res.json.data.categoria, 'Otros');
  assert.strictEqual(res.json.data.persona, 'Mauro');
  assert.ok(res.json.warnings.length >= 4);
});

check('normalización: monto absurdo se descarta', () => {
  const out = normalizeExtraction_({ fecha: '2026-11-20', concepto: 'X', monto: 999999999999, categoria: 'Otros', persona: 'Mauro' });
  assert.strictEqual(out.data.monto, 0);
});

check('imagen vacía -> BAD_REQUEST', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  assert.strictEqual(post({ action: 'extract', idToken: makeToken(claims), image: '' }).json.error, 'BAD_REQUEST');
});

check('imagen con caracteres inválidos -> BAD_REQUEST', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  assert.strictEqual(post({ action: 'extract', idToken: makeToken(claims), image: 'A'.repeat(300) + '$%&' }).json.error, 'BAD_REQUEST');
});

check('imagen gigante -> LIMIT', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  const huge = 'A'.repeat(CONFIG.MAX_IMAGE_BASE64_CHARS + 8);
  assert.strictEqual(post({ action: 'extract', idToken: makeToken(claims), image: huge }).json.error, 'LIMIT');
});

check('body gigante -> LIMIT antes de parsear', () => {
  const hugeBody = '{"action":"save","pad":"' + 'x'.repeat(CONFIG.MAX_BODY_CHARS + 100) + '"}';
  assert.strictEqual(post(hugeBody).json.error, 'LIMIT');
});

check('payload: thinkingConfig solo en la familia 2.5', () => {
  const p25 = geminiPayload_('gemini-2.5-flash', 'x', 'image/jpeg');
  const p38 = geminiPayload_('gemini-3.8-flash', 'x', 'image/jpeg');
  assert.strictEqual(p25.generationConfig.thinkingConfig.thinkingBudget, 0);
  assert.strictEqual(p38.generationConfig.thinkingConfig, undefined);
  assert.strictEqual(p38.generationConfig.maxOutputTokens, CONFIG.GEMINI_MAX_OUTPUT_TOKENS);
  assert.strictEqual(p38.generationConfig.responseMimeType, 'application/json');
});

check('Gemini 404 -> CONFIG de modelo y prueba el alternativo', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = { code: 404, body: '{"error":"model not found"}' };
  const res = post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64 });
  assert.strictEqual(res.json.error, 'CONFIG');
  assert.ok(res.json.message.indexOf('modelo') > -1, res.json.message);
  assert.strictEqual(calls.gemini, 3);
});

check('Gemini 503 -> UPSTREAM tras probar la cadena de modelos', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = { code: 503, body: '{"error":"overloaded"}' };
  const res = post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64 });
  assert.strictEqual(res.json.error, 'UPSTREAM');
  assert.ok(res.json.message.indexOf('503') > -1, res.json.message);
  assert.strictEqual(calls.gemini, 3);
});

check('si el primario falla, el fallback responde', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiQueue = [
    { code: 503, body: '{"error":"overloaded"}' },
    { code: 503, body: '{"error":"overloaded"}' },
    { code: 200, body: JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ fecha: '2026-11-20', concepto: 'Fallback', monto: 1234, categoria: 'Otros', persona: 'Mauro' }) }] }, finishReason: 'STOP' }] }) }
  ];
  const res = post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64 });
  assert.strictEqual(res.json.ok, true, res.text);
  assert.strictEqual(res.json.data.concepto, 'Fallback');
  assert.strictEqual(calls.gemini, 3);
  const urls = calls.fetch.filter((c) => c.url.indexOf('generativelanguage') > -1).map((c) => c.url);
  assert.ok(urls[2].indexOf(CONFIG.GEMINI_MODELS[2]) > -1, urls[2]);
});

say('\n== Guardado en Sheets ==');

check('save agrega una fila con formatos correctos', () => {
  resetCounters();
  store.set('AUTHORIZED_EMAIL', AUTHORIZED);
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  const before = gastosSheet().getLastRow();
  const res = post(saveBody({ idToken: makeToken(claims), monto: '1.234,56' }));
  assert.strictEqual(res.json.ok, true, res.text);
  assert.strictEqual(res.json.row, before + 1);
  const sheet = gastosSheet();
  assert.strictEqual(sheet.getCell(res.json.row, 1), '2026-11-20');
  assert.strictEqual(sheet.getCell(res.json.row, 2), 'Coto');
  assert.strictEqual(sheet.getCell(res.json.row, 3), 1234.56);
  assert.strictEqual(typeof sheet.getCell(res.json.row, 3), 'number');
  assert.strictEqual(sheet.getCell(res.json.row, 4), 'Supermercado');
  assert.strictEqual(sheet.getCell(res.json.row, 5), 'Mauro');
  assert.ok(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(String(sheet.getCell(res.json.row, 6))));
  assert.strictEqual(sheet.formats[res.json.row + ',1'], '@');
  assert.strictEqual(sheet.formats[res.json.row + ',3'], '#,##0.00');
});

check('avisa duplicado y deja forzar el guardado', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  const first = post(saveBody({ idToken: makeToken(claims) }));
  assert.strictEqual(first.json.ok, true, first.text);
  const second = post(saveBody({ idToken: makeToken(claims), force: false }));
  assert.strictEqual(second.json.error, 'DUPLICATE', second.text);
  assert.ok(second.json.row >= 2);
  const forced = post(saveBody({ idToken: makeToken(claims), force: true }));
  assert.strictEqual(forced.json.ok, true, forced.text);
});

check('deshacer borra la fila si los datos coinciden', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  const saved = post(saveBody({ idToken: makeToken(claims) }));
  const row = saved.json.row;
  const before = gastosSheet().getLastRow();
  const del = post({ action: 'delete', idToken: makeToken(claims), row: row, fecha: '2026-11-20', concepto: 'Coto', monto: 1500.5 });
  assert.strictEqual(del.json.ok, true, del.text);
  assert.strictEqual(gastosSheet().getLastRow(), before - 1);
});

check('no borra si el monto no coincide', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  const saved = post(saveBody({ idToken: makeToken(claims) }));
  const row = saved.json.row;
  const before = gastosSheet().getLastRow();
  const del = post({ action: 'delete', idToken: makeToken(claims), row: row, fecha: '2026-11-20', concepto: 'Coto', monto: 999 });
  assert.strictEqual(del.json.error, 'CONFLICT');
  assert.strictEqual(gastosSheet().getLastRow(), before);
});

check('no borra una fila inexistente', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  const del = post({ action: 'delete', idToken: makeToken(claims), row: 99999, fecha: '2026-11-20', concepto: 'Coto', monto: 1 });
  assert.strictEqual(del.json.error, 'BAD_REQUEST');
});

check('la tilde de Compartido se guarda como booleano en la columna 7', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  const res = post(saveBody({ idToken: makeToken(claims), compartido: true }));
  assert.strictEqual(res.json.ok, true, res.text);
  const sheet = gastosSheet();
  assert.strictEqual(sheet.getRange(1, 7).getValues()[0][0], 'Compartido');
  assert.strictEqual(sheet.getCell(res.json.row, 7), true);
  const res2 = post(saveBody({ idToken: makeToken(claims) }));
  assert.strictEqual(sheet.getCell(res2.json.row, 7), false);
});

check('concepto con fórmula se guarda neutralizado', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  const res = post(saveBody({ idToken: makeToken(claims), concepto: '=IMPORTXML("http://attacker","//x")' }));
  assert.strictEqual(res.json.ok, true);
  const stored = String(gastosSheet().getCell(res.json.row, 2));
  assert.ok(stored.charAt(0) === "'", 'debería empezar con apóstrofo: ' + stored);
  assert.ok(stored.indexOf('=IMPORTXML') > -1);
});

check('concepto con espacios y saltos se normaliza', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  const res = post(saveBody({ idToken: makeToken(claims), concepto: '  Coto   Palermo \n  ' }));
  assert.strictEqual(gastosSheet().getCell(res.json.row, 2), 'Coto Palermo');
});

check('save valida fecha inexistente', () => {
  resetCounters();
  tokeninfoResponse = tokeninfoFor(validClaims());
  assert.strictEqual(post(saveBody({ fecha: '2026-02-30' })).json.error, 'BAD_REQUEST');
});

check('save valida monto <= 0 y texto', () => {
  resetCounters();
  tokeninfoResponse = tokeninfoFor(validClaims());
  assert.strictEqual(post(saveBody({ monto: 0 })).json.error, 'BAD_REQUEST');
  assert.strictEqual(post(saveBody({ monto: '-10' })).json.error, 'BAD_REQUEST');
  assert.strictEqual(post(saveBody({ monto: 'abc' })).json.error, 'BAD_REQUEST');
});

check('save valida categoría y persona contra allowlist', () => {
  resetCounters();
  tokeninfoResponse = tokeninfoFor(validClaims());
  assert.strictEqual(post(saveBody({ categoria: 'Viajes' })).json.error, 'BAD_REQUEST');
  assert.strictEqual(post(saveBody({ categoria: '=SUM(A1)' })).json.error, 'BAD_REQUEST');
  assert.strictEqual(post(saveBody({ persona: 'Desconocido' })).json.error, 'BAD_REQUEST');
});

check('save exige concepto', () => {
  resetCounters();
  tokeninfoResponse = tokeninfoFor(validClaims());
  assert.strictEqual(post(saveBody({ concepto: '   ' })).json.error, 'BAD_REQUEST');
});

check('un AUTH fallido no escribe en la hoja', () => {
  resetCounters();
  const before = gastosSheet().getLastRow();
  tokeninfoResponse = { code: 400, body: '{}' };
  assert.strictEqual(post(saveBody()).json.error, 'AUTH');
  assert.strictEqual(gastosSheet().getLastRow(), before);
});

check('lock ocupado -> BUSY sin escribir', () => {
  resetCounters();
  tokeninfoResponse = tokeninfoFor(validClaims());
  const before = gastosSheet().getLastRow();
  lockAvailable = false;
  try {
    assert.strictEqual(post(saveBody()).json.error, 'BUSY');
    assert.strictEqual(gastosSheet().getLastRow(), before);
  } finally {
    lockAvailable = true;
  }
});

check('faltan Propiedades -> CONFIG (mensaje genérico)', () => {
  store.clear();
  const res = post(saveBody());
  assert.strictEqual(res.json.error, 'CONFIG');
  assert.ok(res.text.indexOf('AUTHORIZED_EMAIL') === -1);
  configure();
});

check('summary agrega hoy, mes, personas, compartidos y categorías', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  const sheet = gastosSheet();
  sheet.rows.length = 0;
  CONFIG.HEADERS.forEach((h, i) => sheet.setCell(1, i + 1, h));

  const hoy = todayIso_();
  const mes = hoy.slice(0, 7);
  const otroDia = (hoy === mes + '-01') ? mes + '-02' : mes + '-01';
  const previo = (Number(mes.slice(0, 4)) - 1) + '-12-31';
  const filas = [
    [hoy, 'Coto', 1000, 'Supermercado', 'Mauro', 'x', false],
    [hoy, 'Shell', 500, 'Transporte', 'Anto', 'x', true],
    [otroDia, 'Luz', 2000, 'Servicios', 'Mauro', 'x', true],
    [previo, 'Viejo', 9999, 'Otros', 'Mauro', 'x', false]
  ];
  filas.forEach((fila, r) => fila.forEach((valor, c) => sheet.setCell(r + 2, c + 1, valor)));

  const res = post({ action: 'summary', idToken: makeToken(claims) });
  assert.strictEqual(res.json.ok, true, res.text);
  assert.strictEqual(res.json.hoy.count, 2);
  assert.strictEqual(res.json.hoy.total, 1500);
  assert.strictEqual(res.json.mes.count, 3);
  assert.strictEqual(res.json.mes.total, 3500);
  assert.deepStrictEqual(res.json.personas, [{ nombre: 'Mauro', total: 3000 }, { nombre: 'Anto', total: 500 }]);
  assert.deepStrictEqual(res.json.compartido, { si: 2500, no: 1000 });
  assert.strictEqual(res.json.categorias[0].nombre, 'Servicios');
  assert.strictEqual(res.json.ultimos.length, 4);
  assert.strictEqual(res.json.ultimos[0].concepto, 'Viejo');
  assert.strictEqual(res.json.ultimos[0].row, 5);
});

check('summary exige token válido', () => {
  resetCounters();
  tokeninfoResponse = { code: 400, body: '{}' };
  const res = post({ action: 'summary', idToken: makeToken(validClaims()) });
  assert.strictEqual(res.json.error, 'AUTH');
});

check('summary con hoja vacía devuelve ceros', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  const sheet = gastosSheet();
  sheet.rows.length = 0;
  CONFIG.HEADERS.forEach((h, i) => sheet.setCell(1, i + 1, h));
  const res = post({ action: 'summary', idToken: makeToken(claims) });
  assert.strictEqual(res.json.ok, true);
  assert.deepStrictEqual(res.json.mes, { count: 0, total: 0 });
  assert.deepStrictEqual(res.json.ultimos, []);
  assert.strictEqual(res.json.personas.length, CONFIG.PEOPLE.length);
});

check('meta devuelve categorías, personas y versión', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  const res = post({ action: 'meta', idToken: makeToken(claims) });
  assert.strictEqual(res.json.ok, true, res.text);
  assert.deepStrictEqual(res.json.categories, CONFIG.CATEGORIES);
  assert.deepStrictEqual(res.json.people, CONFIG.PEOPLE);
  assert.strictEqual(res.json.version, VERSION);
});

check('meta exige token válido', () => {
  resetCounters();
  tokeninfoResponse = { code: 400, body: '{}' };
  const res = post({ action: 'meta', idToken: makeToken(validClaims()) });
  assert.strictEqual(res.json.error, 'AUTH');
});

say('\n== Auditoría y diagnóstico ==');

check('auditSheet detecta problemas sin exponer importes ni conceptos', () => {
  const sheet = gastosSheet();
  sheet.rows.length = 0;
  Object.keys(sheet.formats).forEach((k) => delete sheet.formats[k]);

  CONFIG.HEADERS.forEach((h, i) => sheet.setCell(1, i + 1, h));

  sheet.setCell(2, 1, '2026-11-01'); sheet.setCell(2, 2, 'Coto'); sheet.setCell(2, 3, 1500);
  sheet.setCell(2, 4, 'Supermercado'); sheet.setCell(2, 5, 'Mauro');

  sheet.setCell(3, 1, '2026-13-01'); sheet.setCell(3, 2, 'Luz'); sheet.setCell(3, 3, 'abc');
  sheet.setCell(3, 4, 'Viajes'); sheet.setCell(3, 5, 'Otra');

  sheet.rows[3] = [];

  sheet.setCell(5, 1, '2026-11-01'); sheet.setCell(5, 2, 'Coto'); sheet.setCell(5, 3, 1500);
  sheet.setCell(5, 4, 'Supermercado'); sheet.setCell(5, 5, 'Mauro');

  sheet.formats['2,1'] = '@';
  sheet.formats['2,3'] = '#,##0.00';

  const out = auditSheet();
  assert.ok(out.indexOf('Filas vacías: 1') > -1, out);
  assert.ok(out.indexOf('fechas inválidas: 1') > -1);
  assert.ok(out.indexOf('montos inválidos: 1') > -1);
  assert.ok(out.indexOf('Categorías fuera de lista: 1') > -1);
  assert.ok(out.indexOf('personas fuera de lista: 1') > -1);
  assert.ok(out.indexOf('duplicados exactos: 1') > -1);
  assert.ok(out.indexOf('Revisar filas: 3') > -1);
  assert.ok(out.indexOf('Total de filas de datos: 3') > -1, out);
  assert.ok(out.indexOf('Formato A2: @') > -1);
  assert.ok(out.indexOf('Formato C2') === -1 || out.indexOf('#,##0.00') > -1);
  assert.ok(out.indexOf('Coto') === -1, 'no debe mostrar conceptos');
  assert.ok(out.indexOf('1500') === -1, 'no debe mostrar importes');
});

check('auditSheet con hoja faltante no rompe', () => {
  const sheet = gastosSheet();
  const originalName = sheet.name;
  sheet.name = 'Otra hoja';
  try {
    const out = auditSheet();
    assert.ok(out.indexOf('no existe') > -1, out);
  } finally {
    sheet.name = originalName;
  }
});

check('selfTest reporta origen de cada secreto sin exponerlo', () => {
  const out = selfTest();
  assert.ok(out.indexOf('AUTHORIZED_EMAIL: properties') > -1, out);
  assert.ok(out.indexOf('GEMINI_API_KEY: properties') > -1);
  assert.ok(out.indexOf('PROBLEMAS (0)') > -1, out);
  assert.ok(out.indexOf('Gemini: OMITIDO') > -1);
  assert.ok(out.indexOf(AUTHORIZED) === -1);
  assert.ok(out.indexOf(API_KEY) === -1);
});

check('selfTest detecta configuración faltante', () => {
  store.clear();
  const out = selfTest();
  assert.ok(out.indexOf('FALTA') > -1, out);
  assert.ok(/PROBLEMAS \([1-9]/.test(out), out);
  configure();
});

check('probarGemini lista modelos y prueba los dos', () => {
  resetCounters();
  geminiResponse = geminiWith('OK');
  const out = probarGemini();
  assert.ok(out.indexOf('ListModels: OK (2 modelos)') > -1, out);
  assert.ok(out.indexOf('gemini-3.8-flash: disponible') > -1, out);
  assert.ok(out.indexOf('gemini-3.8-flash: OK') > -1, out);
  assert.ok(out.indexOf('gemini-3.7-flash: OK') > -1, out);
  assert.strictEqual(calls.models, 1);
  assert.strictEqual(calls.gemini, 3);
  const payloads = calls.fetch.filter((c) => c.url.indexOf('generativelanguage') > -1 && c.options.method === 'post').map((c) => JSON.parse(c.options.payload));
  assert.strictEqual(payloads[0].generationConfig.thinkingConfig, undefined);
});

check('el ranking prioriza el modelo exitoso más rápido', () => {
  resetCounters();
  store.set('GEMINI_MODEL_STATS', JSON.stringify({
    'gemini-3.7-flash': { ok: 3, lastOk: Date.now(), lastMs: 500 },
    'gemini-3.8-flash': { ok: 3, lastOk: Date.now(), lastMs: 9000 }
  }));
  const chain = geminiModelChain_();
  assert.strictEqual(chain[0], 'gemini-3.7-flash');
  assert.strictEqual(chain[1], 'gemini-3.8-flash');
  assert.strictEqual(chain[2], 'gemini-flash-lite-latest');
});

check('un modelo que falló hace poco va al final', () => {
  resetCounters();
  store.set('GEMINI_MODEL_STATS', JSON.stringify({
    'gemini-flash-lite-latest': { failStreak: 2, lastFail: Date.now() }
  }));
  const chain = geminiModelChain_();
  assert.strictEqual(chain[chain.length - 1], 'gemini-flash-lite-latest');
});

check('un éxito viejo no altera el orden configurado', () => {
  resetCounters();
  store.set('GEMINI_MODEL_STATS', JSON.stringify({
    'gemini-3.8-flash': { ok: 1, lastOk: Date.now() - 8 * 3600 * 1000, lastMs: 100 }
  }));
  const chain = geminiModelChain_();
  assert.strictEqual(chain[0], 'gemini-flash-lite-latest');
});

check('una extracción exitosa guarda la latencia', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = geminiWith({ fecha: '2026-11-20', concepto: 'X', monto: 10, categoria: 'Otros', persona: 'Mauro' });
  post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64 });
  const stats = JSON.parse(store.get('GEMINI_MODEL_STATS'));
  const entry = stats[CONFIG.GEMINI_MODELS[0]];
  assert.ok(entry && entry.ok >= 1 && entry.lastMs >= 1, JSON.stringify(stats));
});

check('selfTest(true) no explota sin API key válida', () => {
  resetCounters();
  geminiResponse = geminiWith('OK');
  const out = selfTest(true);
  assert.ok(out.indexOf('Gemini:') > -1);
});

say('\n== Límites de uso ==');

check('límite de 15 extracciones por minuto', () => {
  resetCounters();
  const claims = validClaims();
  tokeninfoResponse = tokeninfoFor(claims);
  geminiResponse = geminiWith({ fecha: '2026-11-20', concepto: 'Kiosco', monto: 100, categoria: 'Otros', persona: 'Mauro' });
  const results = [];
  for (let i = 0; i < 16; i++) {
    results.push(post({ action: 'extract', idToken: makeToken(claims), image: IMAGE_B64 }).json);
  }
  assert.strictEqual(results.filter((r) => r.ok === true).length, 15);
  assert.strictEqual(results[15].error, 'LIMIT');
});

say('');
if (failures.length) {
  say('FALLAS:');
  failures.forEach((f) => say(' - ' + f));
}
say('RESULTADO BACKEND: ' + pass + ' OK / ' + failures.length + ' FAIL');
process.exit(failures.length ? 1 : 0);
