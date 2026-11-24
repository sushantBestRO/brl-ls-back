#!/bin/bash
set -e
cd /var/www/brl-ls/node-app
cp server.js server.js.bak4; cp public/admin.html public/admin.html.bak4
node - <<"EOF_P"
const fs = require('fs');
let s = fs.readFileSync('server.js', 'utf8');
if (s.includes('/api/admin/lr/delete')) console.log('server.js already patched');
else {
  const a = "app.get('/api/admin/data', authAdmin,";
  if (!s.includes(a)) throw new Error('server.js anchor missing');
  s = s.replace(a, () => `app.post('/api/admin/lr/delete', authAdmin, (req, res) => {
  const id = parseInt(req.body.id, 10); const r = db.prepare('SELECT * FROM lrs WHERE id=?').get(id); if (!r) return res.status(404).json({ error: 'LR not found.' });
  const dd = path.join(__dirname, 'data', 'deleted-lr'); fs.mkdirSync(dd, { recursive: true });
  try { fs.appendFileSync(path.join(__dirname, 'data', 'deleted-lrs.log'), JSON.stringify({ deleted_at: new Date().toISOString(), row: r }) + '\\n'); } catch (e) { console.error(e); }
  for (const u of [r.consignee_pdf, r.driver_pdf]) { if (!u) continue; const src = path.join(__dirname, 'storage', 'lr', path.basename(String(u))); try { if (fs.existsSync(src)) fs.renameSync(src, path.join(dd, path.basename(src))); } catch (e) { console.error(e); } }
  db.prepare('DELETE FROM lrs WHERE id=?').run(id); console.log('LR deleted:', r.cn_no); res.json({ ok: true });
});
` + a);
  fs.writeFileSync('server.js', s); console.log('server.js patched');
}
let h = fs.readFileSync('public/admin.html', 'utf8');
if (h.includes('delLr(')) console.log('admin.html already patched');
else {
  const must = (x, y, l) => { if (!h.includes(x)) throw new Error('admin.html anchor missing: ' + l); h = h.replace(x, () => y); };
  must('<th>Driver</th><th>PDF</th></tr>', '<th>Driver</th><th>PDF</th><th></th></tr>', 'lr header');
  must("Driver</a></td></tr>').join('')", "Driver</a></td><td><button class=\"btn ghost sm\" data-id=\"' + r.id + '\" data-cn=\"' + esc(r.cn_no) + '\" onclick=\"delLr(this.dataset.id, this.dataset.cn)\">Delete</button></td></tr>').join('')", 'lr row');
  must('async function ewbTest()', "async function delLr(id, cn) { if (!confirm('Delete LR ' + cn + '?\\n\\nThe LR is removed from the register and its PDFs stop opening. A backup copy is kept on the server. The CN number is NOT reused automatically.')) return; try { await api('/lr/delete', { id: Number(id) }); load(); } catch (e) { alert(e.message); } }\nasync function ewbTest()", 'js func');
  fs.writeFileSync('public/admin.html', h); console.log('admin.html patched');
}
EOF_P
node --check server.js && echo "OK - now run: pm2 restart brl-ls --update-env"
