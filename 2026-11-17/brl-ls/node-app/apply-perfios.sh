#!/bin/bash
# Run inside /var/www/brl-ls/node-app
set -e
cd /var/www/brl-ls/node-app
cp server.js server.js.bak
cat > perfios.js <<'PERFIOS_EOF'
// Perfios Mobile Authentication with OTP (hub.perfios.ai). Perfios generates + SMSes the OTP and validates it by request_id.
const axios = require('axios'); const E = process.env;
const BASE = () => (E.PERFIOS_BASE_URL || 'https://hub.perfios.ai').replace(/\/$/, '');
const hdr = () => ({ 'x-secure-id': E.PERFIOS_SECURE_ID, 'x-secure-cred': E.PERFIOS_SECURE_CRED, 'x-organization-ID': E.PERFIOS_ORG_ID, 'Content-Type': 'application/json' });
const dbg = (...a) => { if (String(E.PERFIOS_DEBUG).toLowerCase() === 'true') console.log('[perfios]', ...a); };
function find(o, key, d = 0) { if (!o || typeof o !== 'object' || d > 4) return undefined; if (o[key] !== undefined) return o[key]; for (const k of Object.keys(o)) { const v = find(o[k], key, d + 1); if (v !== undefined) return v; } }
const text = v => (typeof v === 'string' && v) ? v : '';
async function post(path, body) {
  if (!E.PERFIOS_SECURE_ID || !E.PERFIOS_SECURE_CRED || !E.PERFIOS_ORG_ID) throw new Error('Perfios credentials missing in .env');
  let r; try { r = await axios.post(BASE() + path, body, { headers: hdr(), timeout: 15000, validateStatus: () => true }); } catch (e) { throw new Error('Perfios unreachable: ' + e.message); }
  dbg(path, 'HTTP', r.status, JSON.stringify(r.data).slice(0, 600)); return r;
}
async function getOtp(mobile) {
  const r = await post('/ssp/kyc/api/v2/mobile/otp', { mobile: (E.PERFIOS_MOBILE_PREFIX || '') + mobile, consent: 'y' });
  const rid = find(r.data, 'request_id') || find(r.data, 'requestId');
  if (r.status >= 300 || !rid) throw new Error('Perfios: ' + (text(find(r.data, 'message')) || text(find(r.data, 'error')) || 'HTTP ' + r.status));
  return String(rid);
}
// fails closed: only an explicit success marker counts as a valid OTP
async function validateOtp(requestId, otp) {
  const r = await post('/ssp/kyc/api/v2/mobile/status', { otp: String(otp), request_id: requestId });
  const msg = text(find(r.data, 'message')) || text(find(r.data, 'error')) || 'Wrong OTP.';
  if (r.status >= 300) return { ok: false, msg };
  const sc = find(r.data, 'status_code'), st = find(r.data, 'status');
  const okCode = sc !== undefined && String(sc) === '200';
  const okStatus = st === true || (typeof st === 'string' && ['success', 'valid', 'verified', 'completed', 'otp_verified', 'otp verified'].includes(st.toLowerCase()));
  return okCode || okStatus ? { ok: true } : { ok: false, msg };
}
module.exports = { getOtp, validateOtp };
PERFIOS_EOF
node - <<'PATCH_EOF'

const fs=require('fs'); let s=fs.readFileSync('server.js','utf8');
if (s.includes("require('./perfios')")) { console.log('already patched'); process.exit(0); }
const must=(a,b,l)=>{ if(!s.includes(a)) throw new Error('anchor missing: '+l); s=s.replace(a,()=>b); };
must("const { sendOtp } = require('./sms');","const { sendOtp } = require('./sms'); const perfios = require('./perfios');",'require');
const UP="db.prepare('INSERT INTO otps(mobile,otp_hash,expires,attempts,sent_at,last_otp) VALUES(?,?,?,0,?,?) ON CONFLICT(mobile) DO UPDATE SET otp_hash=excluded.otp_hash,expires=excluded.expires,attempts=0,sent_at=excluded.sent_at,last_otp=excluded.last_otp')";
must("  const otp = String(crypto.randomInt(100000, 999999));\n",
"  if (SMS_MODE === 'perfios') {\n    try { const rid = await perfios.getOtp(mobile);\n      "+UP+".run(mobile, 'perfios:' + rid, Date.now() + OTP_MIN * 60000, Date.now(), '');\n      return res.json({ ok: true, name: s.name, masked: 'XXXXXX' + mobile.slice(-4), via: 'perfios' });\n    } catch (e) { return res.status(502).json({ error: 'Could not send OTP: ' + e.message }); }\n  }\n  const otp = String(crypto.randomInt(100000, 999999));\n",'send');
must("app.post('/api/otp/verify', (req, res) => {","app.post('/api/otp/verify', async (req, res) => {",'verify-async');
must("  if (sign('otp|' + mobile + '|' + otp) !== row.otp_hash) { db.prepare('UPDATE otps SET attempts=attempts+1 WHERE mobile=?').run(mobile); return res.status(401).json({ error: 'Wrong OTP.' }); }",
"  if (SMS_MODE === 'perfios') {\n    if (!/^\\d{4,8}$/.test(otp)) return res.status(400).json({ error: 'Enter the OTP you received.' });\n    db.prepare('UPDATE otps SET attempts=attempts+1 WHERE mobile=?').run(mobile);\n    let v; try { v = await perfios.validateOtp(String(row.otp_hash).replace(/^perfios:/, ''), otp); } catch (e) { return res.status(502).json({ error: e.message }); }\n    if (!v.ok) return res.status(401).json({ error: v.msg || 'Wrong OTP.' });\n  } else if (sign('otp|' + mobile + '|' + otp) !== row.otp_hash) { db.prepare('UPDATE otps SET attempts=attempts+1 WHERE mobile=?').run(mobile); return res.status(401).json({ error: 'Wrong OTP.' }); }",'verify-check');
must("app.post('/api/admin/sms-test', authAdmin, async (req, res) => { try {","app.post('/api/admin/sms-test', authAdmin, async (req, res) => { if (SMS_MODE === 'perfios') return res.json({ ok: true, msg: 'Perfios mode: test by logging in from the app login screen (each test sends a real OTP).' }); try {",'smstest');
fs.writeFileSync('server.js',s); console.log('server.js patched');
PATCH_EOF
node --check server.js && node --check perfios.js && echo 'OK - now edit .env and run: pm2 restart brl-ls'
