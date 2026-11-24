#!/bin/bash
set -e
cd /var/www/brl-ls/node-app
cp server.js server.js.bak5; cp public/app.js public/app.js.bak5
node - <<"EOF_P"
const fs = require('fs');
function patch(file, marker, steps) {
  let s = fs.readFileSync(file, 'utf8');
  if (s.includes(marker)) { console.log(file + ' already patched'); return; }
  for (const [a, b, l] of steps) { if (!s.includes(a)) throw new Error(file + ': anchor missing: ' + l); s = s.replace(a, () => b); }
  fs.writeFileSync(file, s); console.log(file + ' patched');
}
patch('server.js', 'peekCn', [
  ["app.get('/api/me', authSup,",
   "function peekCn(divCode) { const d = db.prepare('SELECT * FROM divisions WHERE code=?').get(divCode || ''); if (d) return (d.cn_prefix || '') + String(d.cn_next).padStart(5, '0'); const n = parseInt(getSetting('CN_NEXT', E.CN_START || '1001'), 10); return (E.CN_PREFIX || '') + String(n).padStart(5, '0'); }\napp.get('/api/next-cn', authSup, (req, res) => res.json({ cn: peekCn(req.sup.division) }));\napp.get('/api/me', authSup,", 'me route'],
  ["L.cnNo = String(L.cnNo || '').trim() || nextCn(req.sup.division);", "L.cnNo = nextCn(req.sup.division); /* always auto-generated; client value ignored */", 'cn assign'],
]);
patch('public/app.js', 'loadCn', [
  ["f('cnNo', 'CN No. (blank = auto number)', '', { ph: 'pre-printed CN no., if any' })",
   "'<div><label>CN No. (auto-generated)</label><input id=\"cnNo\" value=\"Loading…\" readonly style=\"background:#f1f1f1;font-weight:700\"></div>'", 'cn field'],
  ["function renderForm(E) { E = E || {};", "async function loadCn() { try { const r = await api('/next-cn'); if ($('cnNo')) $('cnNo').value = r.cn; } catch (e) { if ($('cnNo')) $('cnNo').value = 'Auto (assigned on save)'; } }\nfunction renderForm(E) { setTimeout(loadCn, 0); E = E || {};", 'renderForm'],
]);
EOF_P
node --check server.js && node --check public/app.js && echo "OK - now run: pm2 restart brl-ls --update-env"
