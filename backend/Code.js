/**
 * =============================================================================
 * Organizador Financiero — backend (Google Apps Script, runtime V8)
 * =============================================================================
 *
 * API (POST con JSON en el body y Content-Type: text/plain para evitar el
 * preflight OPTIONS que Apps Script no responde):
 *
 *   { "action": "ping" }
 *     -> { ok: true, version }
 *
 *   { "action": "extract", "idToken", "image", "mimeType" }
 *     -> { ok: true, data: { fecha, concepto, monto, categoria, persona }, warnings: [] }
 *
 *   { "action": "save", "idToken", "fecha", "concepto", "monto", "categoria", "persona", "compartido" }
 *     -> { ok: true, row, fecha, monto }
 *     -> { ok: false, error: "DUPLICATE", row }   si repite un gasto reciente (con "force": true se guarda igual)
 *
 *   { "action": "delete", "idToken", "row", "fecha", "concepto", "monto" }
 *     -> { ok: true, deleted: true }              borra solo si la fila coincide (Deshacer)
 *
 * Seguridad
 *  - La Web App se publica como ANYONE_ANONYMOUS (es la única forma de que un
 *    sitio estático pueda llamarla sin cookies) y TODA la autorización ocurre
 *    acá: se valida el idToken de Google contra oauth2.googleapis.com/tokeninfo.
 *  - Los secretos NO viven en este archivo: se leen de Script Properties, que
 *    tienen prioridad sobre el objeto CONFIG. Así el repo queda sin credenciales.
 *  - Los errores que ve el cliente son genéricos; el detalle solo va al log.
 *  - Todo texto que va a una celda se sanea para que no se convierta en fórmula.
 *
 * Utilidades para ejecutar desde el editor de Apps Script
 *  - setup()       crea/repasa la hoja y los formatos.
 *  - selfTest()    verifica configuración y planilla; selfTest(true) prueba Gemini.
 *  - auditSheet()  audita la planilla SIN mostrar importes ni conceptos.
 */

'use strict';

var VERSION = '1.6.0';

/**
 * Valores de referencia.
 * Los secretos reales van en: Configuración del proyecto > Propiedades del
 * script. Si existen ahí, SIEMPRE ganan sobre este objeto (ver setting_).
 */
var CONFIG = {
  AUTHORIZED_EMAIL: 'PEGAR_EMAIL_AUTORIZADO@gmail.com',
  GEMINI_API_KEY: 'PEGAR_API_KEY_DE_GEMINI',
  GOOGLE_CLIENT_ID: 'PEGAR_CLIENT_ID.apps.googleusercontent.com',
  SHEET_ID: '',

  GEMINI_MODEL: 'gemini-3.8-flash',
  GEMINI_MODEL_FALLBACK: 'gemini-3.7-flash',
  // Cadena de modelos: si uno está saturado (503) o retirado (404), sigue con el próximo.
  GEMINI_MODELS: ['gemini-flash-lite-latest', 'gemini-3.8-flash', 'gemini-3.7-flash'],
  GEMINI_MAX_OUTPUT_TOKENS: 8192,
  GEMINI_MAX_ATTEMPTS: 2,
  GEMINI_RETRY_MS: 800,
  SHEET_NAME: 'Gastos',
  // 'Compartido' va al final para no mover los datos existentes de la planilla.
  HEADERS: ['Fecha', 'Concepto', 'Monto', 'Categoría', 'Quién', 'Registrado', 'Compartido'],

  CATEGORIES: ['Supermercado', 'Servicios', 'Transporte', 'Salidas', 'Salud', 'Hogar', 'Otros'],
  PEOPLE: ['Mauro', 'Anto'],

  MAX_BODY_CHARS: 8 * 1024 * 1024,
  MAX_IMAGE_BASE64_CHARS: 6 * 1024 * 1024,
  MIN_IMAGE_BASE64_CHARS: 200,
  MAX_CONCEPTO_CHARS: 120,
  MAX_MONTO: 100000000,
  LOCK_TIMEOUT_MS: 20000,

  TOKENINFO_URL: 'https://oauth2.googleapis.com/tokeninfo',
  GEMINI_ENDPOINT: 'https://generativelanguage.googleapis.com/v1beta/models',
  ALLOWED_IMAGE_TYPES: ['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']
};

/* ============================================================================
 * 1. Configuración, secretos y respuestas
 * ========================================================================== */

/**
 * Resuelve un valor: Script Properties primero, CONFIG como fallback.
 * (Un valor commiteado nunca debe poder pisar el secreto real.)
 */
function setting_(key) {
  var fromProps = '';
  try {
    fromProps = String(PropertiesService.getScriptProperties().getProperty(key) || '').trim();
  } catch (err) {
    fromProps = '';
  }
  if (fromProps) return fromProps;

  var fallback = CONFIG[key];
  return fallback === undefined || fallback === null ? '' : String(fallback).trim();
}

function settingSource_(key) {
  var fromProps = '';
  try {
    fromProps = String(PropertiesService.getScriptProperties().getProperty(key) || '').trim();
  } catch (err) {
    fromProps = '';
  }
  if (fromProps) return 'properties';

  var fallback = CONFIG[key];
  if (fallback === undefined || fallback === null || String(fallback).trim() === '') return 'FALTA';
  if (isPlaceholder_(fallback)) return 'FALTA (placeholder en CONFIG)';
  return 'CONFIG (en el repo)';
}

/** Un placeholder del repo nunca debe usarse como credencial. */
function isPlaceholder_(value) {
  var v = String(value === null || value === undefined ? '' : value).trim();
  if (!v) return true;
  return /^(PEGAR_|TU_|<)/i.test(v);
}

function json_(payload) {
  return ContentService.createTextOutput(JSON.stringify(payload))
    .setMimeType(ContentService.MimeType.JSON);
}

function ok_(data) {
  var payload = { ok: true };
  Object.keys(data || {}).forEach(function (key) { payload[key] = data[key]; });
  return json_(payload);
}

/**
 * Error hacia el cliente: mensaje genérico + detalle solo en el log privado.
 * Nunca devolvemos mensajes de excepción, IDs de planilla ni URLs con la key.
 */
function fail_(code, publicMessage, privateDetail) {
  if (privateDetail) console.error('[' + code + '] ' + redact_(privateDetail));
  return json_({ ok: false, error: code, message: publicMessage });
}

/** Borra cualquier rastro de la API key en textos que van al log. */
function redact_(text) {
  var out = String(text === null || text === undefined ? '' : text);
  var key = setting_('GEMINI_API_KEY');
  if (key && key.length > 6) out = out.split(key).join('***');
  out = out.replace(/([?&]key=)[^&\s"']+/gi, '$1***');
  out = out.replace(/AIza[0-9A-Za-z_\-]{10,}/g, 'AIza***');
  return out.length > 2000 ? out.slice(0, 2000) + '…' : out;
}

function maskEmail_(email) {
  var parts = String(email || '').trim().split('@');
  if (parts.length !== 2 || !parts[0]) return '(sin email)';
  var user = parts[0];
  var shown = user.length <= 2
    ? user.charAt(0) + '***'
    : user.charAt(0) + '***' + user.charAt(user.length - 1);
  return shown + '@' + parts[1];
}

function maskSecret_(value) {
  var v = String(value || '');
  if (!v) return '(vacío)';
  if (v.length <= 8) return '***';
  return v.slice(0, 4) + '…' + v.slice(-4) + ' (' + v.length + ' caracteres)';
}

function maskId_(id) {
  var value = String(id || '');
  if (!value) return '(sin id)';
  if (value.length <= 12) return '***';
  return value.slice(0, 4) + '…' + value.slice(-4);
}

/* ============================================================================
 * 2. Fechas, montos y texto
 * ========================================================================== */

function scriptTimeZone_() {
  try {
    return Session.getScriptTimeZone() || 'America/Argentina/Buenos_Aires';
  } catch (err) {
    return 'America/Argentina/Buenos_Aires';
  }
}

function todayIso_() {
  return Utilities.formatDate(new Date(), scriptTimeZone_(), 'yyyy-MM-dd');
}

function timestamp_() {
  return Utilities.formatDate(new Date(), scriptTimeZone_(), 'yyyy-MM-dd HH:mm:ss');
}

/** Valida YYYY-MM-DD con fecha real (rechaza 2026-02-30) y un rango razonable. */
function isValidIsoDate_(value) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  var parts = value.split('-');
  var y = Number(parts[0]);
  var m = Number(parts[1]);
  var d = Number(parts[2]);
  if (!(y >= 1990 && y <= 2100) || !(m >= 1 && m <= 12) || !(d >= 1 && d <= 31)) return false;
  var probe = new Date(Date.UTC(y, m - 1, d));
  return probe.getUTCFullYear() === y && probe.getUTCMonth() === m - 1 && probe.getUTCDate() === d;
}

function round2_(n) {
  return Math.round((Number(n) + Number.EPSILON) * 100) / 100;
}

/**
 * Convierte "1.234,56", "$ 1234,5", "1,234.56" o 1500.5 a número.
 * Devuelve NaN cuando no hay un número razonable.
 */
function parseAmount_(value) {
  if (typeof value === 'number') return isFinite(value) ? round2_(value) : NaN;
  if (typeof value !== 'string') return NaN;

  var raw = value.replace(/[^\d.,\-]/g, '').trim();
  if (!raw) return NaN;
  var negative = raw.charAt(0) === '-';
  raw = raw.replace(/-/g, '');

  var lastComma = raw.lastIndexOf(',');
  var lastDot = raw.lastIndexOf('.');
  var normalized;

  if (lastComma > -1 && lastDot > -1) {
    // El separador decimal es el que aparece último.
    normalized = lastComma > lastDot
      ? raw.replace(/\./g, '').replace(/,/g, '.')
      : raw.replace(/,/g, '');
  } else if (lastComma > -1) {
    var cParts = raw.split(',');
    var cThousands = cParts.length > 1 && cParts[cParts.length - 1].length === 3 && cParts[0] !== '0';
    normalized = cThousands ? raw.replace(/,/g, '') : raw.replace(/,/g, '.');
  } else if (lastDot > -1) {
    var dParts = raw.split('.');
    var dThousands = dParts.length > 1 && dParts[dParts.length - 1].length === 3 && dParts[0] !== '0';
    normalized = dThousands ? raw.replace(/\./g, '') : raw;
  } else {
    normalized = raw;
  }

  var n = Number(normalized);
  if (!isFinite(n)) return NaN;
  return round2_(negative ? -n : n);
}

function collapseSpaces_(value) {
  return String(value === null || value === undefined ? '' : value)
    .replace(/\s+/g, ' ')
    .trim();
}

function stripAccents_(value) {
  var s = String(value === null || value === undefined ? '' : value);
  return s.normalize ? s.normalize('NFD').replace(/[\u0300-\u036f]/g, '') : s;
}

/** Clave de comparación: sin acentos, minúsculas y sin espacios extra. */
function normalizeKey_(value) {
  return stripAccents_(value).toLowerCase().trim();
}

/** Devuelve el valor canónico de la lista o '' si no coincide con ninguno. */
function matchFromList_(value, list) {
  var key = normalizeKey_(value);
  if (!key) return '';
  for (var i = 0; i < list.length; i++) {
    if (normalizeKey_(list[i]) === key) return list[i];
  }
  return '';
}

/**
 * Neutraliza inyección de fórmulas (=, +, -, @) y caracteres de control.
 * Se aplica a TODO texto que va a una celda.
 */
function sanitizeCell_(value) {
  var s = String(value === null || value === undefined ? '' : value);
  s = s.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '');
  if (/^[=+\-@\t\r]/.test(s)) s = "'" + s;
  return s;
}

function cleanConcepto_(value) {
  var s = collapseSpaces_(value);
  if (s.length > CONFIG.MAX_CONCEPTO_CHARS) s = s.slice(0, CONFIG.MAX_CONCEPTO_CHARS).trim();
  return sanitizeCell_(s);
}

/** Formatos por columna de una fila de datos (la 3.ª es el monto). */
function rowFormats_() {
  return CONFIG.HEADERS.map(function (header) {
    if (header === 'Monto') return '#,##0.00';
    if (header === 'Compartido') return 'General';
    return '@';
  });
}

/** true/false tolerante: acepta booleanos, 1/0, 'Sí'/'No', 'x'. */
function parseBoolean_(value) {
  if (value === true || value === 1) return true;
  if (value === false || value === 0 || value === undefined || value === null) return false;
  var text = String(value).trim().toLowerCase();
  return ['true', 'si', 'sí', 's', '1', 'x', 'compartido'].indexOf(text) > -1;
}

/** Índice de columna a letra A1 (0 -> A, 25 -> Z, 26 -> AA). */
function columnLetter_(index) {
  var n = Number(index) + 1;
  var letters = '';
  while (n > 0) {
    var rem = (n - 1) % 26;
    letters = String.fromCharCode(65 + rem) + letters;
    n = Math.floor((n - 1) / 26);
  }
  return letters;
}

/* ============================================================================
 * 3. Entrada HTTP
 * ========================================================================== */

function doGet() {
  // La Web App es pública: no damos pistas de la planilla ni del modelo.
  return json_({ ok: true, service: 'organizador-financiero' });
}

function doPost(e) {
  try {
    if (!e || !e.postData || typeof e.postData.contents !== 'string' || !e.postData.contents) {
      return fail_('BAD_REQUEST', 'Solicitud inválida.');
    }

    var raw = e.postData.contents;
    if (raw.length > CONFIG.MAX_BODY_CHARS) {
      return fail_('LIMIT', 'La imagen es demasiado grande. Probá con otra foto.');
    }

    var body;
    try {
      body = JSON.parse(raw);
    } catch (parseErr) {
      return fail_('BAD_REQUEST', 'Solicitud inválida.');
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      return fail_('BAD_REQUEST', 'Solicitud inválida.');
    }

    var action = typeof body.action === 'string' ? body.action.trim() : '';
    if (action === 'ping') return ok_({ version: VERSION });
    if (action !== 'extract' && action !== 'save' && action !== 'delete') {
      return fail_('BAD_REQUEST', 'Acción desconocida.');
    }

    var gate = checkServerConfig_();
    if (!gate.ok) {
      return fail_('CONFIG', 'El servidor no está configurado todavía.', 'faltan: ' + gate.missing.join(', '));
    }

    var auth = authorize_(body.idToken);
    if (!auth.ok) {
      return fail_('AUTH', 'Sesión inválida o vencida. Volvé a iniciar sesión.', auth.detail);
    }

    if (rateLimited_('global:' + auth.email, 60, 60)) {
      return fail_('LIMIT', 'Demasiadas solicitudes. Esperá un minuto.');
    }

    if (action === 'extract') {
      if (rateLimited_('extract:' + auth.email, 15, 60)) {
        return fail_('LIMIT', 'Demasiadas fotos seguidas. Esperá un minuto.');
      }
      return handleExtract_(body);
    }

    if (rateLimited_('save:' + auth.email, 30, 60)) {
      return fail_('LIMIT', 'Demasiados guardados seguidos. Esperá un minuto.');
    }
    if (action === 'delete') return handleDelete_(body);
    return handleSave_(body);

  } catch (err) {
    return fail_('INTERNAL', 'Ocurrió un error. Intentá de nuevo.', err && err.stack ? err.stack : err);
  }
}

/** Requisitos mínimos para atender cualquier acción autenticada. */
function checkServerConfig_() {
  var missing = [];
  var email = setting_('AUTHORIZED_EMAIL');
  if (isPlaceholder_(email) || email.indexOf('@') < 1) missing.push('AUTHORIZED_EMAIL');
  if (!missing.length) {
    try {
      getSpreadsheet_();
    } catch (err) {
      missing.push('SHEET_ID');
    }
  }
  return { ok: missing.length === 0, missing: missing };
}

/**
 * Rate limit básico por bucket usando CacheService.
 * Si el cache falla, no bloqueamos al usuario (fail-open a propósito).
 */
function rateLimited_(bucket, limit, seconds) {
  try {
    var cache = CacheService.getScriptCache();
    var key = 'rl_' + hashKey_(bucket).slice(0, 40);
    var current = Number(cache.get(key) || 0) + 1;
    cache.put(key, String(current), seconds || 60);
    return current > limit;
  } catch (err) {
    return false;
  }
}

function hashKey_(value) {
  var digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value));
  return digest.map(function (b) {
    return ('0' + ((b & 0xff).toString(16))).slice(-2);
  }).join('');
}

/* ============================================================================
 * 4. Autorización: idToken de Google
 * ========================================================================== */

/**
 * Defensa en dos capas:
 *  1) pre-filtro local de los claims (formato, exp, email) sin gastar red;
 *  2) verificación real de la firma vía oauth2.googleapis.com/tokeninfo,
 *     más email_verified, emisor, expiración y audiencia.
 */
function authorize_(idToken) {
  var token = typeof idToken === 'string' ? idToken.trim() : '';
  var authorizedEmail = setting_('AUTHORIZED_EMAIL').toLowerCase();
  var clientId = setting_('GOOGLE_CLIENT_ID');
  var clientIdSet = !!clientId && !isPlaceholder_(clientId);

  if (!token) return { ok: false, detail: 'token ausente' };
  if (token.length > 8192) return { ok: false, detail: 'token demasiado largo' };

  var local = decodeJwtPayload_(token);
  if (!local) return { ok: false, detail: 'token con formato inválido' };
  if (!local.exp || Number(local.exp) * 1000 <= Date.now()) {
    return { ok: false, detail: 'token vencido (claim exp)' };
  }
  if (!local.email || String(local.email).toLowerCase() !== authorizedEmail) {
    return { ok: false, detail: 'email no autorizado (claim sin verificar)' };
  }
  if (clientIdSet && local.aud && local.aud !== clientId) {
    return { ok: false, detail: 'aud distinto al CLIENT_ID configurado' };
  }

  var response;
  try {
    response = UrlFetchApp.fetch(
      CONFIG.TOKENINFO_URL + '?id_token=' + encodeURIComponent(token),
      { method: 'get', muteHttpExceptions: true }
    );
  } catch (err) {
    return { ok: false, detail: 'tokeninfo fetch: ' + (err && err.message) };
  }
  if (response.getResponseCode() !== 200) {
    return { ok: false, detail: 'tokeninfo status ' + response.getResponseCode() };
  }

  var info;
  try {
    info = JSON.parse(response.getContentText());
  } catch (parseErr) {
    return { ok: false, detail: 'tokeninfo json inválido' };
  }
  if (!info || typeof info !== 'object') return { ok: false, detail: 'tokeninfo vacío' };

  var verified = info.email_verified === true || String(info.email_verified) === 'true';
  if (!verified) return { ok: false, detail: 'email no verificado' };
  if (String(info.email || '').toLowerCase() !== authorizedEmail) {
    return { ok: false, detail: 'email del token no coincide con AUTHORIZED_EMAIL' };
  }
  if (!(Number(info.exp) * 1000 > Date.now())) {
    return { ok: false, detail: 'token vencido (tokeninfo)' };
  }
  if (!isValidIssuer_(info.iss)) {
    return { ok: false, detail: 'emisor no permitido: ' + String(info.iss).slice(0, 60) };
  }
  if (clientIdSet && info.aud !== clientId) {
    return { ok: false, detail: 'audiencia inválida' };
  }

  return { ok: true, email: String(info.email).toLowerCase() };
}

function isValidIssuer_(issuer) {
  var value = String(issuer || '');
  return value === 'accounts.google.com' || value === 'https://accounts.google.com';
}

function decodeJwtPayload_(token) {
  var parts = String(token).split('.');
  if (parts.length !== 3) return null;
  try {
    var padded = parts[1].replace(/-/g, '+').replace(/_/g, '/');
    while (padded.length % 4 !== 0) padded += '=';
    var bytes = Utilities.base64Decode(padded);
    if (!bytes || !bytes.length) return null;
    var payload = JSON.parse(Utilities.newBlob(bytes).getDataAsString('UTF-8'));
    return payload && typeof payload === 'object' ? payload : null;
  } catch (err) {
    return null;
  }
}

/* ============================================================================
 * 5. Extracción con Gemini
 * ========================================================================== */

function handleExtract_(body) {
  var image = typeof body.image === 'string' ? body.image.trim() : '';
  if (!image) return fail_('BAD_REQUEST', 'No recibimos la imagen.');

  // Aceptamos tanto base64 pelado como data URL.
  var base64 = image.replace(/^data:[^,]*,/, '').replace(/\s/g, '');
  if (base64.length < CONFIG.MIN_IMAGE_BASE64_CHARS) {
    return fail_('BAD_REQUEST', 'La imagen llegó vacía o incompleta.');
  }
  if (base64.length > CONFIG.MAX_IMAGE_BASE64_CHARS) {
    return fail_('LIMIT', 'La imagen es demasiado grande. Probá con otra foto.');
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(base64)) {
    return fail_('BAD_REQUEST', 'La imagen no está en un formato válido.');
  }

  var mimeType = String(body.mimeType || 'image/jpeg').toLowerCase().trim();
  if (CONFIG.ALLOWED_IMAGE_TYPES.indexOf(mimeType) === -1) mimeType = 'image/jpeg';

  var result = geminiExtract_(base64, mimeType);
  if (!result.ok) {
    return fail_(result.code || 'UPSTREAM', result.message || 'No pudimos leer la imagen.', result.detail);
  }

  var normalized = normalizeExtraction_(result.data);
  return ok_({ data: normalized.data, warnings: normalized.warnings });
}

/**
 * Llama a la API REST de Gemini pidiendo JSON estructurado.
 * La API key viaja en el header x-goog-api-key (no en la URL).
 */
function geminiExtract_(base64, mimeType) {
  var result = geminiRequest_(base64, mimeType);
  if (!result.ok) return geminiFailure_(result);

  var text = result.text;
  var data;
  try {
    data = JSON.parse(text);
  } catch (parseErr) {
    return { ok: false, code: 'UPSTREAM', message: 'La IA devolvió una respuesta ilegible.', detail: text.slice(0, 300) };
  }

  if (data && data.promptFeedback && data.promptFeedback.blockReason) {
    return { ok: false, code: 'UPSTREAM', message: 'La IA no pudo procesar esta imagen.', detail: 'blockReason ' + data.promptFeedback.blockReason };
  }

  var candidate = data && data.candidates && data.candidates[0];
  var parts = (candidate && candidate.content && candidate.content.parts) || [];
  var output = parts.map(function (part) {
    return part && typeof part.text === 'string' ? part.text : '';
  }).join('').trim();

  if (!output) {
    return {
      ok: false,
      code: 'UPSTREAM',
      message: 'La IA no devolvió datos. Sacá otra foto o cargá a mano.',
      detail: 'sin texto; finishReason=' + (candidate && candidate.finishReason)
    };
  }

  output = output.replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  var parsed;
  try {
    parsed = JSON.parse(output);
  } catch (jsonErr) {
    return { ok: false, code: 'UPSTREAM', message: 'La IA devolvió un formato inesperado. Reintentá o cargá a mano.', detail: 'json: ' + output.slice(0, 300) };
  }

  return { ok: true, data: parsed, model: result.model };
}

/** Extrae el motivo de Google (ej. ACCESS_TOKEN_TYPE_UNSUPPORTED) sin exponer secretos. */
function geminiReason_(text) {
  try {
    var parsed = JSON.parse(String(text || ''));
    var error = parsed && parsed.error;
    if (!error) return '';
    var reason = '';
    var details = error.details || [];
    for (var i = 0; i < details.length; i++) {
      if (details[i] && details[i].reason) { reason = String(details[i].reason); break; }
    }
    var message = error.message ? String(error.message) : '';
    if (reason && message.indexOf(reason) === -1) message = (message ? message + ' — ' : '') + reason;
    return message.slice(0, 160);
  } catch (err) {
    return '';
  }
}

/** Traduce un fallo de Gemini a un mensaje accionable para la PWA. */
function geminiFailure_(result) {
  var status = result.status || 0;
  var detail = (result.detail || '') + (result.text ? ' ' + result.text.slice(0, 400) : '');

  if (result.code === 'CONFIG') {
    return { ok: false, code: 'CONFIG', message: 'Falta configurar la API key de Gemini en el servidor.', detail: detail };
  }
  if (status === 429) {
    return { ok: false, code: 'QUOTA', message: 'Se alcanzó el límite de la IA. Esperá un minuto y reintentá.', detail: detail };
  }
  if (status === 400 || status === 401 || status === 403) {
    var why = redact_(geminiReason_(result.text));
    return {
      ok: false,
      code: 'CONFIG',
      message: 'La IA rechazó la solicitud (HTTP ' + status + (why ? ': ' + why : '') + '). Revisá la API key en AI Studio.',
      detail: detail
    };
  }
  if (status === 404) {
    return { ok: false, code: 'CONFIG', message: 'El modelo de IA configurado no está disponible. Avisale al administrador.', detail: detail };
  }
  if (!status) {
    return { ok: false, code: 'UPSTREAM', message: 'No pudimos contactar a la IA. Revisá tu conexión.', detail: detail };
  }
  return { ok: false, code: 'UPSTREAM', message: 'La IA no está disponible ahora (HTTP ' + status + '). Reintentá en un rato.', detail: detail };
}

/** Payload para un modelo concreto. thinkingConfig solo existe en la familia 2.5. */
function geminiPayload_(model, base64, mimeType) {
  var generationConfig = {
    temperature: 0.1,
    topP: 0.8,
    maxOutputTokens: CONFIG.GEMINI_MAX_OUTPUT_TOKENS,
    responseMimeType: 'application/json',
    responseSchema: geminiSchema_()
  };
  if (/^gemini-2\.5/.test(model)) generationConfig.thinkingConfig = { thinkingBudget: 0 };

  return {
    contents: [{
      role: 'user',
      parts: [
        { text: buildPrompt_() },
        { inline_data: { mime_type: mimeType, data: base64 } }
      ]
    }],
    generationConfig: generationConfig,
    safetySettings: [
      { category: 'HARM_CATEGORY_HARASSMENT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_HATE_SPEECH', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_SEXUALLY_EXPLICIT', threshold: 'BLOCK_ONLY_HIGH' },
      { category: 'HARM_CATEGORY_DANGEROUS_CONTENT', threshold: 'BLOCK_ONLY_HIGH' }
    ]
  };
}

/**
 * Llama a Gemini con reintento ante 5xx y caída a un modelo alternativo.
 * Devuelve { ok, status, text, model, detail }.
 */
/** Cadena de modelos a probar, sin duplicados ni vacíos. */
var GEMINI_STATS_KEY = 'GEMINI_MODEL_STATS';

/** Estadísticas persistentes por modelo (éxitos, fallos y latencia). */
function geminiStats_() {
  try {
    var raw = PropertiesService.getScriptProperties().getProperty(GEMINI_STATS_KEY);
    var parsed = raw ? JSON.parse(raw) : null;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch (err) {
    return {};
  }
}

/** Guarda el resultado de una llamada para ordenar la próxima vez. */
function geminiRecord_(model, ok, elapsedMs) {
  if (!model) return;
  try {
    var stats = geminiStats_();
    var entry = stats[model] || {};
    entry.attempts = (entry.attempts || 0) + 1;
    if (ok) {
      entry.ok = (entry.ok || 0) + 1;
      entry.lastOk = Date.now();
      entry.lastMs = Math.max(1, Math.round(Number(elapsedMs) || 0));
      entry.failStreak = 0;
    } else {
      entry.fail = (entry.fail || 0) + 1;
      entry.failStreak = (entry.failStreak || 0) + 1;
      entry.lastFail = Date.now();
    }
    stats[model] = entry;
    PropertiesService.getScriptProperties().setProperty(GEMINI_STATS_KEY, JSON.stringify(stats));
  } catch (err) {
    // Nunca romper la extracción por no poder guardar estadísticas.
  }
}

/**
 * Orden de la cadena:
 *  1) modelos con un éxito reciente, del más rápido al más lento;
 *  2) los nunca probados, en el orden configurado;
 *  3) los que fallaron hace poco, al final.
 */
function geminiModelChain_() {
  var configured = [];
  (CONFIG.GEMINI_MODELS || []).forEach(function (model) {
    if (model && configured.indexOf(model) === -1) configured.push(model);
  });
  [CONFIG.GEMINI_MODEL, CONFIG.GEMINI_MODEL_FALLBACK].forEach(function (model) {
    if (model && configured.indexOf(model) === -1) configured.push(model);
  });

  var stats = geminiStats_();
  var now = Date.now();
  var FRESH_OK = 6 * 3600 * 1000;
  var RECENT_FAIL = 10 * 60 * 1000;

  function score(model) {
    var entry = stats[model] || {};
    var freshOk = entry.lastOk && (now - entry.lastOk) < FRESH_OK;
    var recentFail = entry.lastFail && (now - entry.lastFail) < RECENT_FAIL;
    return {
      rank: freshOk ? 0 : (recentFail ? 2 : 1),
      ms: freshOk ? (entry.lastMs || 1e9) : 1e9,
      index: configured.indexOf(model)
    };
  }

  return configured.slice().sort(function (a, b) {
    var sa = score(a);
    var sb = score(b);
    if (sa.rank !== sb.rank) return sa.rank - sb.rank;
    if (sa.ms !== sb.ms) return sa.ms - sb.ms;
    return sa.index - sb.index;
  });
}

/**
 * Llama a Gemini con reintento ante 5xx y caída a un modelo alternativo.
 * Devuelve { ok, status, text, model, detail }.
 */
function geminiRequest_(base64, mimeType) {
  var apiKey = setting_('GEMINI_API_KEY');
  if (isPlaceholder_(apiKey)) {
    return { ok: false, code: 'CONFIG', status: 0, model: CONFIG.GEMINI_MODEL, detail: 'GEMINI_API_KEY ausente', text: '' };
  }

  var models = geminiModelChain_();

  var last = { ok: false, status: 0, model: models[0], detail: 'sin intentos', text: '' };

  for (var i = 0; i < models.length; i++) {
    var model = models[i];
    var url = CONFIG.GEMINI_ENDPOINT + '/' + encodeURIComponent(model) + ':generateContent';
    var payload = geminiPayload_(model, base64, mimeType);

    for (var attempt = 1; attempt <= CONFIG.GEMINI_MAX_ATTEMPTS; attempt++) {
      var startedAt = Date.now();
      var response;
      try {
        response = UrlFetchApp.fetch(url, {
          method: 'post',
          contentType: 'application/json',
          headers: { 'x-goog-api-key': apiKey },
          payload: JSON.stringify(payload),
          muteHttpExceptions: true
        });
      } catch (err) {
        geminiRecord_(model, false, Date.now() - startedAt);
        last = { ok: false, status: 0, model: model, detail: 'fetch: ' + (err && err.message), text: '' };
        break;
      }

      var status = response.getResponseCode();
      var text = response.getContentText() || '';
      var elapsed = Date.now() - startedAt;

      if (status === 200) {
        geminiRecord_(model, true, elapsed);
        return { ok: true, status: status, text: text, model: model, elapsed: elapsed };
      }

      geminiRecord_(model, false, elapsed);
      last = { ok: false, status: status, model: model, text: text, detail: 'gemini ' + status };
      // 401/403 (key) y 429 (cuota) no mejoran cambiando de modelo.
      if (status === 401 || status === 403 || status === 429) return last;
      // 400 (payload incompatible), 404 (retirado) o 502/503 (saturación): siguiente modelo.
      if (status === 400 || status === 404 || status === 502 || status === 503) break;
      // 500/504: un reintento del mismo modelo antes de pasar al siguiente.
      if (attempt < CONFIG.GEMINI_MAX_ATTEMPTS) Utilities.sleep(CONFIG.GEMINI_RETRY_MS * attempt);
    }
  }

  return last;
}

function geminiSchema_() {
  return {
    type: 'OBJECT',
    properties: {
      fecha: { type: 'STRING', description: 'Fecha del comprobante en formato YYYY-MM-DD' },
      concepto: { type: 'STRING', description: 'Comercio o motivo del gasto' },
      monto: { type: 'NUMBER', description: 'Total pagado, sin símbolo de moneda ni separador de miles' },
      categoria: { type: 'STRING', enum: CONFIG.CATEGORIES.slice(), description: 'Categoría del gasto' },
      persona: { type: 'STRING', enum: CONFIG.PEOPLE.slice(), description: 'Quién hizo el gasto' }
    },
    required: ['fecha', 'concepto', 'monto', 'categoria', 'persona'],
    propertyOrdering: ['fecha', 'concepto', 'monto', 'categoria', 'persona']
  };
}

function buildPrompt_() {
  return [
    'Sos un asistente experto en leer tickets, facturas y comprobantes de pago de Argentina.',
    'Extraé los datos del gasto de la imagen y devolvé SOLO el JSON solicitado.',
    '',
    'Reglas:',
    '- fecha: fecha del comprobante en formato YYYY-MM-DD. Si no se lee, usá ' + todayIso_() + '.',
    '- concepto: nombre del comercio o motivo del gasto (máx. 60 caracteres). Sin direcciones, CUIT ni números de ticket.',
    '- monto: total pagado como número, sin símbolo de moneda, sin separador de miles y con punto decimal.',
    '- categoria: exactamente una de: ' + CONFIG.CATEGORIES.join(', ') + '.',
    '- persona: exactamente una de: ' + CONFIG.PEOPLE.join(', ') + '. Si no se puede determinar, usá "' + CONFIG.PEOPLE[0] + '".',
    '- Si la imagen no es un comprobante o es ilegible, usá concepto "No se pudo leer" y monto 0.'
  ].join('\n');
}

/** Normaliza lo que devuelve el modelo: nunca confiamos en su formato. */
function normalizeExtraction_(raw) {
  var warnings = [];
  var source = raw && typeof raw === 'object' ? raw : {};

  var fecha = typeof source.fecha === 'string' ? source.fecha.trim() : '';
  if (!isValidIsoDate_(fecha)) {
    fecha = todayIso_();
    warnings.push('No pudimos leer la fecha: usamos hoy.');
  }

  var concepto = collapseSpaces_(source.concepto)
    .replace(/^["'`]+/, '')
    .replace(/["'`]+$/, '')
    .slice(0, CONFIG.MAX_CONCEPTO_CHARS)
    .trim();
  if (!concepto || normalizeKey_(concepto) === 'no se pudo leer') {
    concepto = '';
    warnings.push('No pudimos leer el concepto: escribilo a mano.');
  }

  var monto = parseAmount_(source.monto);
  if (!isFinite(monto) || monto <= 0) {
    monto = 0;
    warnings.push('No pudimos leer el monto: ingresalo a mano.');
  } else if (monto > CONFIG.MAX_MONTO) {
    monto = 0;
    warnings.push('El monto leído es demasiado alto: revisalo.');
  }

  var categoria = matchFromList_(source.categoria, CONFIG.CATEGORIES);
  if (!categoria) {
    categoria = 'Otros';
    if (collapseSpaces_(source.categoria)) warnings.push('Categoría desconocida: quedó en "Otros".');
  }

  var persona = matchFromList_(source.persona, CONFIG.PEOPLE);
  if (!persona) {
    persona = CONFIG.PEOPLE[0];
    if (collapseSpaces_(source.persona)) warnings.push('No reconocimos quién hizo el gasto: revisalo.');
  }

  return {
    data: {
      fecha: fecha,
      concepto: concepto,
      monto: monto,
      categoria: categoria,
      persona: persona
    },
    warnings: warnings
  };
}

/* ============================================================================
 * 6. Guardado en Google Sheets
 * ========================================================================== */

function handleSave_(body) {
  var fecha = typeof body.fecha === 'string' ? body.fecha.trim() : '';
  if (!isValidIsoDate_(fecha)) return fail_('BAD_REQUEST', 'La fecha no es válida.');

  var concepto = cleanConcepto_(body.concepto);
  if (!concepto) return fail_('BAD_REQUEST', 'El concepto no puede estar vacío.');

  var monto = parseAmount_(body.monto);
  if (!isFinite(monto) || monto <= 0) return fail_('BAD_REQUEST', 'El monto debe ser mayor a cero.');
  if (monto > CONFIG.MAX_MONTO) return fail_('BAD_REQUEST', 'El monto es demasiado alto.');

  var categoria = matchFromList_(body.categoria, CONFIG.CATEGORIES);
  if (!categoria) return fail_('BAD_REQUEST', 'Elegí una categoría válida.');

  var persona = matchFromList_(body.persona, CONFIG.PEOPLE);
  if (!persona) return fail_('BAD_REQUEST', 'Elegí quién hizo el gasto.');

  var compartido = parseBoolean_(body.compartido);

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return fail_('BUSY', 'El servidor está ocupado. Reintentá en unos segundos.');
  }

  try {
    var sheet = getSheet_();

    if (!parseBoolean_(body.force)) {
      var duplicateRow = findDuplicateRow_(sheet, {
        fecha: fecha,
        concepto: concepto,
        monto: monto,
        categoria: categoria,
        persona: persona,
        compartido: compartido
      });
      if (duplicateRow) {
        return json_({
          ok: false,
          error: 'DUPLICATE',
          message: 'Parece que ya cargaste este gasto (fila ' + duplicateRow + '). Si querés, guardalo igual.',
          row: duplicateRow
        });
      }
    }

    var row = sheet.getLastRow() + 1;
    var range = sheet.getRange(row, 1, 1, CONFIG.HEADERS.length);

    // Formato ANTES de escribir: la fecha y el registro quedan como texto y
    // Sheets no los reinterpreta como fecha/hora.
    range.setNumberFormats([rowFormats_()]);
    var registro = timestamp_();
    var rowValues = CONFIG.HEADERS.map(function (header) {
      switch (header) {
        case 'Fecha': return sanitizeCell_(fecha);
        case 'Concepto': return concepto;
        case 'Monto': return monto;
        case 'Categoría': return sanitizeCell_(categoria);
        case 'Quién': return sanitizeCell_(persona);
        case 'Registrado': return sanitizeCell_(registro);
        case 'Compartido': return compartido;
        default: return '';
      }
    });
    range.setValues([rowValues]);
    SpreadsheetApp.flush();

    return ok_({ row: row, fecha: fecha, monto: monto });
  } catch (err) {
    return fail_('INTERNAL', 'No pudimos guardar el gasto. Reintentá.', 'save: ' + (err && err.stack ? err.stack : err));
  } finally {
    lock.releaseLock();
  }
}

/** Devuelve la fila de un gasto idéntico entre las últimas 5 (0 si no hay). */
function findDuplicateRow_(sheet, candidate) {
  var lastRow = sheet.getLastRow();
  if (lastRow < 2) return 0;

  var from = Math.max(2, lastRow - 4);
  var width = CONFIG.HEADERS.length;
  var values = sheet.getRange(from, 1, lastRow - from + 1, width).getValues();
  var concepto = String(candidate.concepto || '').toLowerCase();

  for (var i = values.length - 1; i >= 0; i--) {
    var row = values[i] || [];
    var sameFecha = String(row[0]) === candidate.fecha;
    var sameConcepto = String(row[1] || '').trim().toLowerCase() === concepto;
    var sameMonto = Math.abs(Number(row[2]) - Number(candidate.monto)) < 0.005;
    var sameCategoria = String(row[3]) === candidate.categoria;
    var samePersona = String(row[4]) === candidate.persona;
    var sameCompartido = parseBoolean_(row[6]) === candidate.compartido;

    if (sameFecha && sameConcepto && sameMonto && sameCategoria && samePersona && sameCompartido) {
      return from + i;
    }
  }
  return 0;
}

/** Borra una fila solo si los datos coinciden (para el "Deshacer"). */
function handleDelete_(body) {
  var row = Number(body.row);
  if (!(row >= 2 && row <= 1000000)) return fail_('BAD_REQUEST', 'La fila no es válida.');

  var fecha = typeof body.fecha === 'string' ? body.fecha.trim() : '';
  var concepto = collapseSpaces_(body.concepto);
  var monto = parseAmount_(body.monto);
  if (!isValidIsoDate_(fecha) || !concepto || !isFinite(monto)) {
    return fail_('BAD_REQUEST', 'Faltan los datos para verificar la fila.');
  }

  var lock = LockService.getScriptLock();
  if (!lock.tryLock(CONFIG.LOCK_TIMEOUT_MS)) {
    return fail_('BUSY', 'El servidor está ocupado. Reintentá en unos segundos.');
  }

  try {
    var sheet = getSheet_();
    if (row > sheet.getLastRow()) return fail_('BAD_REQUEST', 'Esa fila ya no existe.');

    var values = sheet.getRange(row, 1, 1, CONFIG.HEADERS.length).getValues()[0];
    var sameFecha = String(values[0]) === fecha;
    var sameConcepto = collapseSpaces_(values[1]).toLowerCase() === concepto.toLowerCase();
    var sameMonto = Math.abs(Number(values[2]) - monto) < 0.005;

    if (!sameFecha || !sameConcepto || !sameMonto) {
      return fail_('CONFLICT', 'La fila cambió; no la borramos.', 'row ' + row + ' no coincide');
    }

    sheet.deleteRow(row);
    SpreadsheetApp.flush();
    return ok_({ deleted: true, row: row });
  } catch (err) {
    return fail_('INTERNAL', 'No pudimos borrar el gasto.', 'delete: ' + (err && err.stack ? err.stack : err));
  } finally {
    lock.releaseLock();
  }
}

function getSpreadsheet_() {
  var id = setting_('SHEET_ID');
  if (id && !isPlaceholder_(id)) return SpreadsheetApp.openById(id);

  var active = SpreadsheetApp.getActiveSpreadsheet();
  if (active) return active;

  throw new Error('Sin planilla: configurá SHEET_ID en las Propiedades del script.');
}

function getSheet_() {
  var spreadsheet = getSpreadsheet_();
  var sheet = spreadsheet.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) sheet = spreadsheet.insertSheet(CONFIG.SHEET_NAME);
  ensureHeaders_(sheet);
  return sheet;
}

/** Escribe los encabezados si faltan o no coinciden. Devuelve true si ya estaban. */
function ensureHeaders_(sheet) {
  var headers = CONFIG.HEADERS;
  var maxColumns = sheet.getMaxColumns();
  if (maxColumns < headers.length) {
    sheet.insertColumnsAfter(maxColumns, headers.length - maxColumns);
  }

  var current = sheet.getRange(1, 1, 1, headers.length).getValues()[0].map(function (cell) {
    return String(cell === null || cell === undefined ? '' : cell).trim();
  });
  var matches = headers.every(function (header, index) {
    return current[index] === header;
  });

  if (!matches) {
    var headerRange = sheet.getRange(1, 1, 1, headers.length);
    headerRange.setValues([headers]);
    headerRange.setFontWeight('bold');
    headerRange.setBackground('#0f1720');
    headerRange.setFontColor('#f5b301');
    headerRange.setNumberFormat('@');
  }

  if (sheet.getFrozenRows() < 1) sheet.setFrozenRows(1);
  return matches;
}

/* ============================================================================
 * 7. Utilidades para ejecutar desde el editor
 * ========================================================================== */

function setup() {
  var lines = ['== setup =='];
  var spreadsheet;
  try {
    spreadsheet = getSpreadsheet_();
  } catch (err) {
    lines.push('FALLA: no se pudo abrir la planilla — ' + redact_(err.message || err));
    console.error(lines.join('\n'));
    return lines.join('\n');
  }

  var sheet = spreadsheet.getSheetByName(CONFIG.SHEET_NAME);
  var created = false;
  if (!sheet) {
    sheet = spreadsheet.insertSheet(CONFIG.SHEET_NAME);
    created = true;
  }
  var headersOk = ensureHeaders_(sheet);

  CONFIG.HEADERS.forEach(function (header, index) {
    var letter = columnLetter_(index);
    var range = sheet.getRange(letter + '2:' + letter);
    if (header === 'Compartido') {
      range.insertCheckboxes();
    } else {
      range.setNumberFormat(header === 'Monto' ? '#,##0.00' : '@');
    }
  });

  var widths = [110, 240, 120, 130, 130, 160, 110];
  CONFIG.HEADERS.forEach(function (header, index) {
    if (widths[index]) sheet.setColumnWidth(index + 1, widths[index]);
  });

  lines.push('Planilla: ' + (spreadsheet.getName() || '(sin nombre)') + ' (' + maskId_(spreadsheet.getId()) + ')');
  lines.push('Hoja "' + CONFIG.SHEET_NAME + '": ' + (created ? 'creada' : 'ya existía'));
  lines.push('Encabezados: ' + (headersOk ? 'OK' : 'escritos ahora'));
  lines.push('Formatos: A = texto, C = #,##0.00, fila 1 congelada');
  console.log(lines.join('\n'));
  return lines.join('\n');
}

/**
 * Diagnóstico de configuración.
 *   selfTest()      -> no llama a Gemini (no consume cuota)
 *   selfTest(true)  -> hace 1 request real a Gemini
 */
function selfTest(runGemini) {
  var lines = [];
  var problems = [];
  var warnings = [];
  function line(text) { lines.push(text); }

  line('== Organizador Financiero — selfTest ' + VERSION + ' ==');
  line('Zona horaria del script: ' + scriptTimeZone_() + ' | Hoy: ' + todayIso_());
  line('');

  ['AUTHORIZED_EMAIL', 'GEMINI_API_KEY', 'GOOGLE_CLIENT_ID', 'SHEET_ID'].forEach(function (key) {
    var value = setting_(key);
    var source = settingSource_(key);
    var shown = '(vacío)';
    if (value) shown = key === 'AUTHORIZED_EMAIL' ? maskEmail_(value) : maskSecret_(value);
    line(key + ': ' + source + ' -> ' + shown);
    if (source.indexOf('FALTA') === 0) {
      if (key === 'GOOGLE_CLIENT_ID' || key === 'SHEET_ID') warnings.push(key + ' no está configurado.');
      else problems.push(key + ' no está configurado.');
    }
  });

  var email = setting_('AUTHORIZED_EMAIL');
  if (email && !isPlaceholder_(email) && email.indexOf('@') < 1) {
    problems.push('AUTHORIZED_EMAIL no parece un email válido.');
  }
  var apiKey = setting_('GEMINI_API_KEY');
  if (apiKey && !isPlaceholder_(apiKey) &&
      !/^(AIza[0-9A-Za-z_\-]{20,}|AQ\.[0-9A-Za-z_.\-]{20,})$/.test(apiKey)) {
    warnings.push('GEMINI_API_KEY no tiene un formato conocido (AIza… o AQ.…).');
  }
  var clientId = setting_('GOOGLE_CLIENT_ID');
  if (clientId && !isPlaceholder_(clientId) && !/\.apps\.googleusercontent\.com$/.test(clientId)) {
    warnings.push('GOOGLE_CLIENT_ID no termina en .apps.googleusercontent.com.');
  }

  try {
    var ss = getSpreadsheet_();
    line('');
    line('Planilla: ' + (ss.getName() || '(sin nombre)') + ' (' + maskId_(ss.getId()) + ')');
    line('Zona horaria de la planilla: ' + ss.getSpreadsheetTimeZone());
    if (ss.getSpreadsheetTimeZone() !== scriptTimeZone_()) {
      warnings.push('La planilla y el script tienen zonas horarias distintas.');
    }

    var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
    if (!sheet) {
      line('Hoja "' + CONFIG.SHEET_NAME + '": NO EXISTE (se crea al guardar o al correr setup)');
      warnings.push('La hoja "' + CONFIG.SHEET_NAME + '" todavía no existe.');
    } else {
      var headers = sheet.getRange(1, 1, 1, CONFIG.HEADERS.length).getValues()[0].map(function (cell) {
        return String(cell === null || cell === undefined ? '' : cell).trim();
      });
      var headersOk = CONFIG.HEADERS.every(function (header, index) { return headers[index] === header; });
      line('Hoja "' + CONFIG.SHEET_NAME + '": ' + sheet.getLastRow() + ' filas | encabezados ' + (headersOk ? 'OK' : 'DESALINEADOS'));
      if (!headersOk) {
        line('  esperado: ' + CONFIG.HEADERS.join(' | '));
        line('  actual:   ' + headers.join(' | '));
        warnings.push('Los encabezados no coinciden: corré setup() para reescribirlos.');
      }
    }
  } catch (err) {
    problems.push('No se pudo abrir la planilla: ' + redact_(err.message || err));
  }

  line('');
  if (runGemini) {
    var probe = geminiPing_();
    line('Gemini: ' + (probe.ok ? 'OK (' + CONFIG.GEMINI_MODEL + ')' : 'FALLA — ' + probe.detail));
    if (!probe.ok) problems.push('Gemini no respondió: ' + probe.detail);
  } else {
    line('Gemini: OMITIDO (corré probarGemini() para probarlo; consume 1 request)');
  }

  line('');
  line('PROBLEMAS (' + problems.length + ')');
  problems.forEach(function (item) { line('  - ' + item); });
  line('ADVERTENCIAS (' + warnings.length + ')');
  warnings.forEach(function (item) { line('  - ' + item); });
  line('');
  line(problems.length === 0 ? 'RESULTADO: listo para usar.' : 'RESULTADO: faltan cosas para poder usarla.');

  console.log(lines.join('\n'));
  return lines.join('\n');
}

/**
 * Diagnóstico de la IA desde el menú de funciones (no recibe parámetros).
 * Prueba el modelo principal y el de respaldo y muestra el error exacto.
 */
function probarGemini() {
  var lines = [];
  var apiKey = setting_('GEMINI_API_KEY');
  lines.push('== prueba de Gemini (key: ' + maskSecret_(apiKey) + ') ==');

  if (isPlaceholder_(apiKey)) {
    lines.push('Falta GEMINI_API_KEY en las Propiedades del script.');
    console.log(lines.join('\n'));
    return lines.join('\n');
  }

  var chain = geminiModelChain_();
  var list = geminiListModels_(apiKey);
  if (!list.ok) {
    lines.push('ListModels: FALLA — ' + list.detail);
  } else {
    lines.push('ListModels: OK (' + list.models.length + ' modelos)');
    chain.forEach(function (model) {
      lines.push('  ' + model + ': ' + (list.models.indexOf(model) > -1 ? 'disponible' : 'NO disponible'));
    });
    lines.push('  familia disponible: ' + list.models.slice(0, 10).join(', '));
  }

  chain.forEach(function (model) {
    var started = Date.now();
    var result = geminiPing_(model);
    var elapsed = Date.now() - started;
    lines.push(model + ': ' + (result.ok ? 'OK' : 'FALLA — ' + result.detail) + ' (' + elapsed + ' ms)');
  });

  lines.push('');
  lines.push('orden que va a usar la app: ' + geminiModelChain_().join(' → '));
  lines.push('');
  lines.push('Si un modelo dice "NO disponible": copiá uno de la lista en CONFIG.GEMINI_MODEL.');
  lines.push('Si aparece HTTP 401/403: revisá la key (o usá una AIza restringida a Generative Language API).');
  lines.push('Si aparece HTTP 429/5xx: cuota o sobrecarga; reintentá.');

  console.log(lines.join('\n'));
  return lines.join('\n');
}

/** Modelos disponibles para la key (GET /v1beta/models). */
function geminiListModels_(apiKey) {
  try {
    var response = UrlFetchApp.fetch(CONFIG.GEMINI_ENDPOINT + '?pageSize=1000', {
      method: 'get',
      headers: { 'x-goog-api-key': apiKey },
      muteHttpExceptions: true
    });
    if (response.getResponseCode() !== 200) {
      return { ok: false, detail: 'HTTP ' + response.getResponseCode() + ' ' + redact_(response.getContentText()).slice(0, 200) };
    }
    var data = JSON.parse(response.getContentText());
    var models = (data.models || []).map(function (model) {
      return String(model.name || '').replace(/^models\//, '');
    }).filter(function (name) {
      return name.indexOf('gemini') === 0;
    });
    return { ok: true, models: models };
  } catch (err) {
    return { ok: false, detail: redact_(err.message || err) };
  }
}

/** Prueba real de generación con un modelo concreto. */
function geminiPing_(model) {
  model = model || CONFIG.GEMINI_MODEL;
  var apiKey = setting_('GEMINI_API_KEY');
  if (isPlaceholder_(apiKey)) return { ok: false, detail: 'falta la API key' };

  var url = CONFIG.GEMINI_ENDPOINT + '/' + encodeURIComponent(model) + ':generateContent';
  var payload = {
    contents: [{ role: 'user', parts: [{ text: 'Respondé solo con la palabra OK.' }] }],
    generationConfig: { temperature: 0, maxOutputTokens: CONFIG.GEMINI_MAX_OUTPUT_TOKENS }
  };

  var startedAt = Date.now();
  try {
    var response = UrlFetchApp.fetch(url, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-goog-api-key': apiKey },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });
    var elapsed = Date.now() - startedAt;

    if (response.getResponseCode() !== 200) {
      geminiRecord_(model, false, elapsed);
      return { ok: false, detail: 'HTTP ' + response.getResponseCode() + ' ' + redact_(response.getContentText()).slice(0, 200) };
    }
    var data = JSON.parse(response.getContentText());
    var candidate = data && data.candidates && data.candidates[0];
    var parts = (candidate && candidate.content && candidate.content.parts) || [];
    var text = parts.map(function (part) { return part && part.text ? part.text : ''; }).join('').trim();
    geminiRecord_(model, !!text, elapsed);
    return { ok: !!text, detail: text ? '' : 'respuesta vacía; finishReason=' + (candidate && candidate.finishReason) };
  } catch (err) {
    geminiRecord_(model, false, Date.now() - startedAt);
    return { ok: false, detail: redact_(err.message || err) };
  }
}

/**
 * Auditoría de solo lectura de la planilla.
 * NO imprime importes ni conceptos: solo conteos y números de fila,
 * para poder pegar la salida en un chat sin filtrar datos personales.
 */
function auditSheet() {
  var lines = [];
  function line(text) { lines.push(text); }
  function finish() { console.log(lines.join('\n')); return lines.join('\n'); }

  line('== auditoría de la planilla (sin importes ni conceptos) ==');

  var ss;
  try {
    ss = getSpreadsheet_();
  } catch (err) {
    line('FALLA: no se pudo abrir la planilla — ' + redact_(err.message || err));
    return finish();
  }

  line('Planilla: ' + (ss.getName() || '(sin nombre)') + ' (' + maskId_(ss.getId()) + ')');
  line('Zona horaria: ' + ss.getSpreadsheetTimeZone() + ' | hoja esperada: "' + CONFIG.SHEET_NAME + '"');
  line('Hojas: ' + ss.getSheets().map(function (s) { return s.getName(); }).join(', '));

  var sheet = ss.getSheetByName(CONFIG.SHEET_NAME);
  if (!sheet) {
    line('FALLA: la hoja "' + CONFIG.SHEET_NAME + '" no existe.');
    return finish();
  }

  var lastRow = sheet.getLastRow();
  var lastColumn = Math.max(sheet.getLastColumn(), CONFIG.HEADERS.length);
  line('Filas: ' + lastRow + ' | columnas: ' + lastColumn);

  var headers = sheet.getRange(1, 1, 1, lastColumn).getValues()[0].map(function (cell) {
    return String(cell === null || cell === undefined ? '' : cell).trim();
  });
  var headersOk = CONFIG.HEADERS.every(function (header, index) { return headers[index] === header; });
  if (headersOk) {
    line('Encabezados OK');
  } else {
    line('Encabezados DESALINEADOS -> ' + headers.join(' | '));
    line('Esperados -> ' + CONFIG.HEADERS.join(' | '));
  }
  line('Fila congelada: ' + sheet.getFrozenRows());
  line('Formato A2: ' + sheet.getRange('A2').getNumberFormat() + ' | formato C2: ' + sheet.getRange('C2').getNumberFormat());

  if (lastRow < 2) {
    line('Sin datos todavía.');
    return finish();
  }

  var MAX_ROWS = 5000;
  var startRow = lastRow > MAX_ROWS ? lastRow - MAX_ROWS + 1 : 2;
  if (startRow > 2) line('Nota: se auditan las últimas ' + MAX_ROWS + ' filas.');

  var values = sheet.getRange(startRow, 1, lastRow - startRow + 1, lastColumn).getValues();

  var blank = 0;
  var badDate = 0;
  var badAmount = 0;
  var badCategory = 0;
  var badPerson = 0;
  var formulas = 0;
  var duplicates = 0;
  var review = [];
  var seen = {};

  values.forEach(function (row, index) {
    var rowNumber = startRow + index;
    var isBlank = row.every(function (cell) {
      return String(cell === null || cell === undefined ? '' : cell).trim() === '';
    });
    if (isBlank) {
      blank++;
      return;
    }

    var issues = [];

    var fecha = row[0];
    var fechaText = fecha instanceof Date
      ? Utilities.formatDate(fecha, scriptTimeZone_(), 'yyyy-MM-dd')
      : String(fecha === null || fecha === undefined ? '' : fecha).trim();
    if (!isValidIsoDate_(fechaText)) {
      badDate++;
      issues.push('fecha');
    }

    var monto = row[2];
    if (typeof monto !== 'number' || !isFinite(monto) || monto <= 0) {
      badAmount++;
      issues.push('monto');
    }

    var categoria = String(row[3] === null || row[3] === undefined ? '' : row[3]).trim();
    if (categoria && !matchFromList_(categoria, CONFIG.CATEGORIES)) {
      badCategory++;
      issues.push('categoría');
    }

    var persona = String(row[4] === null || row[4] === undefined ? '' : row[4]).trim();
    if (persona && !matchFromList_(persona, CONFIG.PEOPLE)) {
      badPerson++;
      issues.push('quién');
    }

    row.forEach(function (cell) {
      if (typeof cell === 'string' && /^[=+\-@]/.test(cell)) {
        formulas++;
        issues.push('fórmula');
      }
    });

    var key = [
      fechaText,
      String(row[1] === null || row[1] === undefined ? '' : row[1]).trim(),
      String(monto),
      categoria,
      persona,
      String(row[6] === null || row[6] === undefined ? '' : row[6])
    ].join('|');
    if (seen[key]) {
      duplicates++;
      issues.push('duplicado');
    } else {
      seen[key] = true;
    }

    if (issues.length && review.length < 30) {
      review.push(rowNumber + ' (' + issues.join(', ') + ')');
    }
  });

  var dataRows = lastRow - startRow + 1 - blank;
  line('Filas vacías: ' + blank + ' | fechas inválidas: ' + badDate + ' | montos inválidos: ' + badAmount);
  line('Categorías fuera de lista: ' + badCategory + ' | personas fuera de lista: ' + badPerson);
  line('Celdas tipo fórmula (posible injection): ' + formulas + ' | duplicados exactos: ' + duplicates);
  line('Revisar filas: ' + (review.length ? review.join('; ') : 'ninguna'));
  line('Total de filas de datos: ' + dataRows);

  return finish();
}
