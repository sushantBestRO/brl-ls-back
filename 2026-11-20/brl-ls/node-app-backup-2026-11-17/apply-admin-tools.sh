#!/bin/bash
# Run on the VPS. Adds: Delete button (Supervisors tab) + Send/Verify test OTP (System tab)
set -e
cd /var/www/brl-ls/node-app
cp server.js server.js.bak3; cp public/admin.html public/admin.html.bak3
node - <<"PATCH_EOF"
const fs = require('fs');
function edit(file, fn) { let s = fs.readFileSync(file, 'utf8'); const must = (a, b, l) => { if (!s.includes(a)) throw new Error(file + ': anchor missing: ' + l); s = s.replace(a, () => b); }; const r = fn(s, must, () => s, v => { s = v; }); fs.writeFileSync(file, s); return r; }

// ---------- server.js ----------
let srv = fs.readFileSync('server.js', 'utf8');
if (srv.includes('/api/admin/supervisor/delete')) { console.log('server.js already patched'); }
else {
  const re = /^app\.post\('\/api\/admin\/sms-test'.*$/m;
  if (!re.test(srv)) throw new Error('server.js: sms-test route not found');
  const NEW = `// --- admin tools: delete supervisor + OTP test with verify ---
const PERF_TEST = require('fs').existsSync(require('path').join(__dirname, 'perfios.js')) ? require('./perfios') : null; const smsTestStore = {};
app.post('/api/admin/supervisor/delete', authAdmin, (req, res) => {
  const code = String(req.body.code || '').toUpperCase().trim();
  const s = db.prepare('SELECT mobile FROM supervisors WHERE upper(code)=?').get(code); if (!s) return res.status(404).json({ error: 'Supervisor not found.' });
  db.prepare('DELETE FROM supervisors WHERE upper(code)=?').run(code);
  if (s.mobile) db.prepare('DELETE FROM otps WHERE mobile LIKE ?').run('%' + normMobile(s.mobile));
  res.json({ ok: true });
});
app.post('/api/admin/sms-test', authAdmin, async (req, res) => {
  try {
    const mobile = normMobile(req.body.mobile); if (!/^\\d{10}$/.test(mobile)) return res.status(400).json({ error: 'Enter a 10-digit mobile number.' });
    if (SMS_MODE === 'perfios') {
      if (!PERF_TEST) return res.status(400).json({ error: 'perfios.js is missing - run apply-perfios.sh first.' });
      const rid = await PERF_TEST.getOtp(mobile); smsTestStore[mobile] = { rid, exp: Date.now() + OTP_MIN * 60000 };
      return res.json({ ok: true, msg: 'OTP requested from Perfios for ' + mobile + '. Enter the OTP you receive by SMS below and click Verify.' });
    }
    const otp = String(crypto.randomInt(100000, 999999)); const via = await sendOtp(mobile, otp); smsTestStore[mobile] = { otp, exp: Date.now() + OTP_MIN * 60000 };
    res.json({ ok: true, msg: via === 'console' ? 'Test mode - no SMS sent. OTP is ' + otp + ' (also in server log). Enter it below and click Verify.' : 'Test OTP sent by SMS to ' + mobile + '. Enter it below and click Verify.' });
  } catch (e) { res.status(502).json({ error: e.message }); }
});
app.post('/api/admin/sms-test-verify', authAdmin, async (req, res) => {
  try {
    const mobile = normMobile(req.body.mobile); const otp = String(req.body.otp || '').trim(); const t = smsTestStore[mobile];
    if (!t || Date.now() > t.exp) return res.status(400).json({ error: 'No active test OTP for this mobile. Click Send test OTP first.' });
    if (!/^\\d{4,8}$/.test(otp)) return res.status(400).json({ error: 'Enter the OTP you received.' });
    if (t.rid) { const v = await PERF_TEST.validateOtp(t.rid, otp); if (!v.ok) return res.status(401).json({ error: v.msg || 'Wrong OTP.' }); }
    else if (otp !== t.otp) return res.status(401).json({ error: 'Wrong OTP.' });
    delete smsTestStore[mobile]; res.json({ ok: true, msg: 'OTP verified - SMS delivery and OTP check are working.' });
  } catch (e) { res.status(502).json({ error: e.message }); }
});`;
  srv = srv.replace(re, () => NEW); fs.writeFileSync('server.js', srv); console.log('server.js patched');
}

// ---------- public/admin.html ----------
edit('public/admin.html', (s, must) => {
  if (s.includes('delSup(')) { console.log('admin.html already patched'); return; }
  must('<th>Active</th></tr>', '<th>Active</th><th></th></tr>', 'sup header');
  must("(s.active ? 'Yes' : 'No') + '</td></tr>'", "(s.active ? 'Yes' : 'No') + '</td><td><button class=\"btn ghost sm\" data-c=\"' + esc(s.code) + '\" onclick=\"delSup(this.dataset.c)\">Delete</button></td></tr>'", 'sup row');
  must('<button class="btn sm dark" onclick="smsTest()">Send test OTP SMS</button></div></div>\' +',
       '<button class="btn sm dark" onclick="smsTest()">Send test OTP SMS</button></div></div>\' +\n    \'<div class="row" style="max-width:520px;align-items:flex-end"><div><label>Enter OTP received</label><input id="sms_otp" inputmode="numeric" maxlength="8"></div><div><button class="btn sm dark" onclick="smsVerify()">Verify OTP</button></div></div>\' +', 'sms verify row');
  must('async function ewbTest()',
       "async function delSup(code) { if (!confirm('Delete supervisor ' + code + '?\\n\\nTheir past attendance and LR records stay in the registers. They will be signed out immediately.')) return; try { await api('/supervisor/delete', { code }); load(); } catch (e) { alert(e.message); } }\nasync function smsVerify() { $('m').innerHTML = '<div class=\"msg info\">Verifying…</div>'; try { const r = await api('/sms-test-verify', { mobile: $('sms_to').value, otp: $('sms_otp').value }); $('m').innerHTML = '<div class=\"msg ok\">' + esc(r.msg) + '</div>'; } catch (e) { $('m').innerHTML = '<div class=\"msg err\">' + esc(e.message) + '</div>'; } }\nasync function ewbTest()", 'js funcs');
  console.log('admin.html patched');
});
PATCH_EOF
node --check server.js && echo "OK - now run: pm2 restart brl-ls --update-env"
