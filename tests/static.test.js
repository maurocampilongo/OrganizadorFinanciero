const fs = require('fs');
const vm = require('vm');
const path = require('path');

let pass = 0, fail = 0;
function check(name, condition, detail) {
  if (condition) { pass++; console.log('  OK   ' + name); }
  else { fail++; console.log('  FAIL ' + name + (detail ? ' -> ' + detail : '')); }
}

const root = path.resolve(__dirname, '..');
const htmlPath = path.join(root, 'frontend/index.html');
const html = fs.readFileSync(htmlPath, 'utf8');

console.log('== HTML / JS inline ==');
const scriptMatches = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
const inline = scriptMatches.filter((m) => !/\bsrc\s*=/.test(m[1]));
check('hay exactamente 1 bloque JS inline', inline.length === 1, 'encontrados: ' + inline.length);
try {
  new vm.Script(inline[0][2], { filename: 'inline.js' });
  check('sintaxis del JS inline', true);
} catch (err) {
  check('sintaxis del JS inline', false, err.message);
}
check('la app define APP_CONFIG', /const APP_CONFIG = \{/.test(html));
check('usa fetch con Content-Type text/plain', /text\/plain;charset=utf-8/.test(html));
check('no hay handlers inline (onclick=...)', !/\son(click|change|submit|input|load)=/i.test(html));
check('no usa innerHTML con datos', !/\.innerHTML\s*=/.test(inline[0][2]));
check('input de foto con capture=environment', /accept="image\/\*"\s+capture="environment"/.test(html));
check('monto con inputmode=decimal y step 0.01', /inputmode="decimal"[^>]*step="0.01"|step="0.01"[^>]*inputmode="decimal"/.test(html));
check('compresion a 1024 px y calidad 0.75', /MAX_IMAGE_WIDTH: 1024/.test(html) && /JPEG_QUALITY: 0.75/.test(html));

// Balance de etiquetas (ignorando comentarios, script y style)
const cleaned = html
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
  .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
  .replace(/<!DOCTYPE[^>]*>/gi, '');
const voids = new Set(['meta','link','input','img','br','hr','source','area','base','col','embed','param','track','wbr']);
const stack = [];
let balanced = true, problem = '';
for (const m of cleaned.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9-]*)([^>]*?)(\/?)>/g)) {
  const closing = m[1] === '/';
  const name = m[2].toLowerCase();
  if (voids.has(name) || m[4] === '/') continue;
  if (!closing) stack.push(name);
  else {
    const open = stack.pop();
    if (open !== name) { balanced = false; problem = 'cierra <' + name + '> pero abría <' + open + '>'; break; }
  }
}
check('HTML balanceado', balanced && stack.length === 0, problem || ('quedan: ' + stack.join(',')));

console.log('== IDs referenciados por $() ==');
const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
const used = new Set([...inline[0][2].matchAll(/\$\('([^']+)'\)/g)].map((m) => m[1]));
const missing = [...used].filter((id) => !ids.has(id));
check('todos los IDs existen (' + used.size + ')', missing.length === 0, missing.join(','));

console.log('== JSON / archivos ==');
for (const file of ['frontend/manifest.json', 'backend/appsscript.json']) {
  try { JSON.parse(fs.readFileSync(path.join(root, file), 'utf8')); check(file + ' es JSON valido', true); }
  catch (err) { check(file + ' es JSON valido', false, err.message); }
}
const manifest = JSON.parse(fs.readFileSync(path.join(root, 'frontend/manifest.json'), 'utf8'));
const appsscript = JSON.parse(fs.readFileSync(path.join(root, 'backend/appsscript.json'), 'utf8'));
check('manifest display=standalone', manifest.display === 'standalone');
check('manifest start_url y scope relativos', manifest.start_url === './' && manifest.scope === './');
check('manifest con 4 iconos (any + maskable)', manifest.icons.length === 4 && manifest.icons.filter((i) => i.purpose === 'any').length === 2 && manifest.icons.filter((i) => i.purpose === 'maskable').length === 2);
for (const icon of manifest.icons) check('existe ' + icon.src, fs.existsSync(path.join(root, 'frontend', icon.src)));
check('manifest con share_target de imágenes', !!(manifest.share_target && manifest.share_target.method === 'POST' && manifest.share_target.enctype === 'multipart/form-data' && manifest.share_target.params.files.length === 1), JSON.stringify(manifest.share_target || null));
check('manifest con 2 atajos', Array.isArray(manifest.shortcuts) && manifest.shortcuts.length === 2 && manifest.shortcuts.every((s) => s.url && s.icons.length), JSON.stringify(manifest.shortcuts || []));
check('appsscript TZ Buenos Aires', appsscript.timeZone === 'America/Argentina/Buenos_Aires');
check('appsscript ANYONE_ANONYMOUS', appsscript.webapp.access === 'ANYONE_ANONYMOUS');
check('appsscript runtime V8', appsscript.runtimeVersion === 'V8');
check('appsscript scopes sheets + external_request', appsscript.oauthScopes.includes('https://www.googleapis.com/auth/spreadsheets') && appsscript.oauthScopes.includes('https://www.googleapis.com/auth/script.external_request'));
check('sw.js referencia archivos existentes', ['index.html','manifest.json','icons/icon-192.png','icons/icon-512.png','icons/maskable-192.png','icons/maskable-512.png'].every((f) => fs.existsSync(path.join(root, 'frontend', f))));
check('sw.js no cachea script.google.com', /url.origin !== self.location.origin/.test(fs.readFileSync(path.join(root, 'frontend/sw.js'), 'utf8')));

console.log('== Seguridad estatica ==');
check('CSP presente', /Content-Security-Policy/.test(html));
check('CSP permite GIS script', /script-src[^;]*https:\/\/accounts\.google\.com\/gsi\/client/.test(html));
check('CSP bloquea por defecto', /default-src 'none'/.test(html));
check('CSP base-uri none', /base-uri 'none'/.test(html));
check('CSP no permite otros scripts externos', (html.match(/script-src([^;]*)/) || [,''])[1].replace("'self'",'').replace("'unsafe-inline'",'').match(/https:\/\//g).length === 1);
check('noindex/follow', /name="robots" content="noindex, nofollow"/.test(html));
check('referrer no-referrer', /name="referrer" content="no-referrer"/.test(html));
check('isTrustedBackendUrl exige /exec de script.google.com', /\^https:\\\/\\\/script\\\.google\\\.com\\\/macros\\\/s\\\//.test(inline[0][2]));

const files = [];
(function walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === '.cline-home' || entry.name === 'tests') continue;
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full);
    else files.push(full);
  }
})(root);
const secretPatterns = [/AIza[0-9A-Za-z_\-]{30,}/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/, /client_secret\s*[:=]\s*['"][^'"]{8,}/i, /ya29\.[0-9A-Za-z_\-]{20,}/];
const leaked = [];
for (const file of files) {
  if (/\.(png)$/.test(file)) continue;
  const content = fs.readFileSync(file, 'utf8');
  for (const pattern of secretPatterns) if (pattern.test(content)) leaked.push(path.relative(root, file) + ' (' + pattern + ')');
}
check('sin credenciales reales en el repo', leaked.length === 0, leaked.join(', '));
check('Code.js sin API key hardcodeada', !/AIza[0-9A-Za-z_\-]{30,}/.test(fs.readFileSync(path.join(root, 'backend/Code.js'), 'utf8')));
check('gitignore cubre .clasprc.json', /\.clasprc\.json/.test(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')));
check('gitignore cubre backend/.clasp.json', /backend\/\.clasp\.json/.test(fs.readFileSync(path.join(root, '.gitignore'), 'utf8')));

console.log('');
console.log('RESULTADO: ' + pass + ' OK / ' + fail + ' FAIL');
process.exit(fail ? 1 : 0);
