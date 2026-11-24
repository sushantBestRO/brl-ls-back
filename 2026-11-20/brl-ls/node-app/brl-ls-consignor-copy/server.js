require('dotenv').config();
const express = require('express'); const path = require('path'); const fs = require('fs'); const crypto = require('crypto');
const cookieParser = require('cookie-parser'); const helmet = require('helmet'); const morgan = require('morgan'); const axios = require('axios');
const { db, getSetting, setSetting } = require('./db'); const ewb = require('./ewb'); const { buildLrPdfs } = require('./lrpdf'); const { sendOtp } = require('./sms'); const perfios = require('./perfios');

const E = process.env; const PORT = E.PORT || 3000; const SECRET = E.SESSION_SECRET || 'dev-secret';
const SESSION_DAYS = parseInt(E.SESSION_DAYS || '30', 10); const OTP_MIN = 5; const SMS_MODE = (E.SMS_PROVIDER || 'console').toLowerCase();
const REQUIRE_SELFIE = String(E.REQUIRE_SELFIE || 'true').toLowerCase() !== 'false';
const app = express();
app.use(helmet({ contentSecurityPolicy: false, frameguard: false }));
app.use((req, res, next) => { res.setHeader('Content-Security-Policy', "frame-ancestors 'self' https://bestroadways.com https://www.bestroadways.com"); next(); }); app.use(morgan('tiny')); app.use(express.json({ limit: '8mb' })); app.use(cookieParser());
app.use(express.static(path.join(__dirname, 'public')));
app.use('/files', express.static(path.join(__dirname, 'storage')));
['storage/lr', 'storage/photos', 'data'].forEach(d => fs.mkdirSync(path.join(__dirname, d), { recursive: true }));

/* ---------- helpers ---------- */
const IST = { timeZone: 'Asia/Kolkata' };
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function istParts(d = new Date()) { const p = new Intl.DateTimeFormat('en-GB', { ...IST, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false }).formatToParts(d); const g = k => p.find(x => x.type === k).value; return { d: g('day'), m: g('month'), y: g('year'), H: g('hour'), M: g('minute'), S: g('second') }; }
const dayStr = d => { const p = istParts(d); return p.d + '-' + MON[+p.m - 1] + '-' + p.y; };
const nowStr = d => { const p = istParts(d); return dayStr(d) + ' ' + p.H + ':' + p.M + ':' + p.S; };
const sign = s => crypto.createHmac('sha256', SECRET).update(s).digest('base64url').slice(0, 24);
function makeToken(code) { const exp = Date.now() + SESSION_DAYS * 86400000; return sign(code + '|' + exp) + '.' + exp; }
function checkToken(code, tok) { if (!code || !tok) return false; const exp = Number(tok.split('.')[1] || 0); return Date.now() < exp && sign(code + '|' + exp) + '.' + exp === tok; }
function authSup(req, res, next) { const code = req.headers['x-code'] || req.body.code; const tok = req.headers['x-token'] || req.body.token; if (!checkToken(code, tok)) return res.status(401).json({ error: 'Session expired. Please sign in again.' }); req.sup = db.prepare('SELECT * FROM supervisors WHERE code=? AND active=1').get(code); if (!req.sup) return res.status(401).json({ error: 'Supervisor not active.' }); next(); }
function authAdmin(req, res, next) { if (req.cookies.admin && req.cookies.admin === sign('admin')) return next(); res.status(401).json({ error: 'Admin login required' }); }
const divisions = () => db.prepare('SELECT * FROM divisions WHERE active=1 ORDER BY code').all();
const divName = c => { const d = db.prepare('SELECT name FROM divisions WHERE code=?').get(c || ''); return d ? d.name : ''; };
function sessionPayload(s) { return { ok: true, token: makeToken(s.code), code: s.code, name: s.name, mobile: s.mobile, branch: s.branch, division: s.division || '', divisionName: divName(s.division), role: s.role, today: todaySummary(s.code) }; }
function todaySummary(code) {
    const day = dayStr(); const a = db.prepare('SELECT * FROM attendance WHERE code=? AND day=? ORDER BY id').all(code, day);
    const inR = a.find(r => r.type === 'IN'), outR = [...a].reverse().find(r => r.type === 'OUT');
    const lrCount = db.prepare("SELECT COUNT(*) c FROM lrs WHERE code=? AND ts LIKE ?").get(code, day + '%').c;
    const recent = db.prepare('SELECT cn_no cn, ts, vehicle_no vehicle, consignee, delivery_station "to", consignee_pdf cons, driver_pdf drv, consignor_pdf consr, consignor_mobile consr_mobile FROM lrs WHERE code=? ORDER BY id DESC LIMIT 5').all(code);
    return { in: inR ? inR.ts : '', out: outR ? outR.ts : '', inPhoto: inR ? inR.photo : '', outPhoto: outR ? outR.photo : '', lrCount, recent };
}
function haversine(a, b, c, d) { const R = 6371000, toR = x => x * Math.PI / 180; const dLat = toR(c - a), dLon = toR(d - b); const h = Math.sin(dLat / 2) ** 2 + Math.cos(toR(a)) * Math.cos(toR(c)) * Math.sin(dLon / 2) ** 2; return 2 * R * Math.asin(Math.sqrt(h)); }
async function reverseGeocode(lat, lng) { if (String(E.REVERSE_GEOCODE).toLowerCase() === 'false') return ''; try { const r = await axios.get('https://nominatim.openstreetmap.org/reverse', { params: { lat, lon: lng, format: 'json', zoom: 17 }, headers: { 'User-Agent': 'BRL-LS-App/1.0 (fms@bestroadways.com)' }, timeout: 8000 }); return r.data.display_name || ''; } catch (e) { return ''; } }
function nextCn(divCode) {
    const d = db.prepare('SELECT * FROM divisions WHERE code=?').get(divCode || '');
    if (d) { db.prepare('UPDATE divisions SET cn_next=cn_next+1 WHERE code=?').run(d.code); return (d.cn_prefix || '') + String(d.cn_next).padStart(5, '0'); }
    const n = parseInt(getSetting('CN_NEXT', E.CN_START || '1001'), 10); setSetting('CN_NEXT', n + 1); return (E.CN_PREFIX || '') + String(n).padStart(5, '0');
}
const normMobile = m => String(m || '').replace(/\D/g, '').slice(-10);

/* ---------- public API ---------- */
app.get('/api/config', (req, res) => res.json({ hrMobile: E.HR_MOBILE || '', requireSelfie: REQUIRE_SELFIE, smsMode: SMS_MODE, allowPin: String(E.ALLOW_PIN_LOGIN).toLowerCase() === 'true', divisions: divisions().map(d => ({ code: d.code, name: d.name })), branches: db.prepare('SELECT name FROM branches ORDER BY name').all().map(b => b.name) }));

// Step 1: mobile → OTP
app.post('/api/otp/send', async (req, res) => {
    const mobile = normMobile(req.body.mobile); if (mobile.length !== 10) return res.status(400).json({ error: 'Enter a 10-digit mobile number.' });
    const s = db.prepare('SELECT * FROM supervisors WHERE active=1 AND mobile LIKE ?').get('%' + mobile);
    if (!s) return res.status(404).json({ error: 'This mobile is not registered as a loading supervisor. Ask HR to add you.' });
    const prev = db.prepare('SELECT sent_at FROM otps WHERE mobile=?').get(mobile);
    if (prev && Date.now() - prev.sent_at < 30000) return res.status(429).json({ error: 'OTP already sent. Wait 30 seconds before resending.' });
    try {
        if (SMS_MODE === 'perfios') {
            const reqId = await perfios.getOtp(mobile);
            db.prepare('INSERT INTO otps(mobile,otp_hash,expires,attempts,sent_at,last_otp) VALUES(?,?,?,0,?,?) ON CONFLICT(mobile) DO UPDATE SET otp_hash=excluded.otp_hash,expires=excluded.expires,attempts=0,sent_at=excluded.sent_at,last_otp=excluded.last_otp').run(mobile, 'pf:' + reqId, Date.now() + OTP_MIN * 60000, Date.now(), '');
            return res.json({ ok: true, name: s.name, masked: 'XXXXXX' + mobile.slice(-4), via: 'sms' });
        }
        const otp = String(crypto.randomInt(100000, 999999)); const via = await sendOtp(mobile, otp);
        db.prepare('INSERT INTO otps(mobile,otp_hash,expires,attempts,sent_at,last_otp) VALUES(?,?,?,0,?,?) ON CONFLICT(mobile) DO UPDATE SET otp_hash=excluded.otp_hash,expires=excluded.expires,attempts=0,sent_at=excluded.sent_at,last_otp=excluded.last_otp').run(mobile, sign('otp|' + mobile + '|' + otp), Date.now() + OTP_MIN * 60000, Date.now(), via === 'console' ? otp : '');
        res.json({ ok: true, name: s.name, masked: 'XXXXXX' + mobile.slice(-4), via, devOtp: via === 'console' ? otp : undefined });
    } catch (e) { res.status(502).json({ error: 'Could not send OTP: ' + e.message }); }
});
// Step 2: verify
app.post('/api/otp/verify', async (req, res) => {
    const mobile = normMobile(req.body.mobile), otp = String(req.body.otp || '').replace(/\D/g, '');
    const row = db.prepare('SELECT * FROM otps WHERE mobile=?').get(mobile); if (!row) return res.status(400).json({ error: 'Request an OTP first.' });
    if (Date.now() > row.expires) return res.status(400).json({ error: 'OTP expired. Request a new one.' });
    if (row.attempts >= 5) return res.status(429).json({ error: 'Too many wrong attempts. Request a new OTP.' });
    if (row.otp_hash.startsWith('pf:')) {
        let v; try { v = await perfios.validateOtp(row.otp_hash.slice(3), otp); } catch (e) { return res.status(502).json({ error: 'Could not verify OTP: ' + e.message }); }
        if (!v.ok) { db.prepare('UPDATE otps SET attempts=attempts+1 WHERE mobile=?').run(mobile); return res.status(401).json({ error: v.msg || 'Wrong OTP.' }); }
    } else if (sign('otp|' + mobile + '|' + otp) !== row.otp_hash) { db.prepare('UPDATE otps SET attempts=attempts+1 WHERE mobile=?').run(mobile); return res.status(401).json({ error: 'Wrong OTP.' }); }
    db.prepare('DELETE FROM otps WHERE mobile=?').run(mobile);
    const s = db.prepare('SELECT * FROM supervisors WHERE active=1 AND mobile LIKE ?').get('%' + mobile); if (!s) return res.status(404).json({ error: 'Supervisor not found.' });
    res.json(sessionPayload(s));
});
// Optional fallback (ALLOW_PIN_LOGIN=true) – code + PIN
app.post('/api/login', (req, res) => {
    if (String(E.ALLOW_PIN_LOGIN).toLowerCase() !== 'true') return res.status(403).json({ error: 'PIN login is disabled. Use mobile + OTP.' });
    const code = String(req.body.code || '').trim().toUpperCase(), pin = String(req.body.pin || '').trim();
    const s = db.prepare('SELECT * FROM supervisors WHERE upper(code)=?').get(code);
    if (!s || !s.active) return res.status(401).json({ error: 'Code not found or inactive. Ask HR.' });
    if (!s.pin || s.pin !== pin) return res.status(401).json({ error: 'Wrong PIN.' });
    res.json(sessionPayload(s));
});
function peekCn(divCode) { const d = db.prepare('SELECT * FROM divisions WHERE code=?').get(divCode || ''); if (d) return (d.cn_prefix || '') + String(d.cn_next).padStart(5, '0'); const n = parseInt(getSetting('CN_NEXT', E.CN_START || '1001'), 10); return (E.CN_PREFIX || '') + String(n).padStart(5, '0'); }
app.get('/api/next-cn', authSup, (req, res) => res.json({ cn: peekCn(req.sup.division) }));
app.get('/api/me', authSup, (req, res) => res.json({ ok: true, today: todaySummary(req.sup.code), division: req.sup.division || '', divisionName: divName(req.sup.division), branch: req.sup.branch, name: req.sup.name }));

// Address for the on-photo stamp (called before the selfie is taken)
app.post('/api/geocode', authSup, async (req, res) => { const { lat, lng } = req.body; if (!lat || !lng) return res.json({ address: '' }); res.json({ address: await reverseGeocode(lat, lng), time: nowStr() }); });

app.post('/api/attendance', authSup, async (req, res) => {
    const { type, lat, lng, accuracy, photo, note, address } = req.body; if (!['IN', 'OUT'].includes(type)) return res.status(400).json({ error: 'type must be IN or OUT' });
    if (REQUIRE_SELFIE && !photo) return res.status(400).json({ error: 'Selfie is required for check-' + type.toLowerCase() });
    if (!lat || !lng) return res.status(400).json({ error: 'GPS location is required. Allow location access and try again.' });
    const addr = address || await reverseGeocode(lat, lng);
    let geoNote = ''; const radius = parseInt(E.GEO_RADIUS_M || '0', 10);
    if (radius > 0) { const b = db.prepare('SELECT lat,lng FROM branches WHERE name=?').get(req.sup.branch); if (b && b.lat && b.lng) { const d = haversine(+lat, +lng, b.lat, b.lng); geoNote = d <= radius ? 'On-site (' + Math.round(d) + ' m)' : 'OFF-SITE (' + Math.round(d) + ' m from branch)'; } }
    let photoUrl = '';
    if (photo) { try { const buf = Buffer.from(String(photo).split(',').pop(), 'base64'); const fn = 'ATT_' + req.sup.code + '_' + type + '_' + Date.now() + '.jpg'; fs.writeFileSync(path.join(__dirname, 'storage', 'photos', fn), buf); photoUrl = '/files/photos/' + fn; } catch (e) { photoUrl = ''; } }
    db.prepare('INSERT INTO attendance(ts,day,code,name,branch,division,type,lat,lng,accuracy,address,photo,note) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)').run(nowStr(), dayStr(), req.sup.code, req.sup.name, req.sup.branch, req.sup.division || '', type, +lat, +lng, accuracy || null, addr, photoUrl, [geoNote, note || ''].filter(Boolean).join(' · '));
    res.json({ ok: true, time: nowStr(), addr, geoNote, photo: photoUrl, today: todaySummary(req.sup.code) });
});

app.post('/api/ewb', authSup, async (req, res) => {
    try { const r = await ewb.getEwb(req.body.ewbNo); db.prepare('INSERT INTO ewb_cache(ewb_no,fetched_at,fetched_by,raw) VALUES(?,?,?,?) ON CONFLICT(ewb_no) DO UPDATE SET fetched_at=excluded.fetched_at,fetched_by=excluded.fetched_by,raw=excluded.raw').run(r.lr.ewbNo, nowStr(), req.sup.code, JSON.stringify(r.raw).slice(0, 200000)); res.json({ ok: true, lr: r.lr }); }
    catch (e) { res.status(400).json({ error: e.message }); }
});

app.post('/api/lr', authSup, async (req, res) => {
    const L = req.body.lr || {}; const need = ['vehicleNo', 'consignorName', 'consigneeName', 'loadingStation', 'deliveryStation', 'driverPhone']; const miss = need.filter(k => !L[k]);
    if (miss.length) return res.status(400).json({ error: 'Missing: ' + miss.join(', ') });
    // consignor name / mobile are OPTIONAL – but if a mobile is typed it must be a valid 10-digit number
    L.consignorContact = String(L.consignorContact || '').trim().slice(0, 60); L.consignorMobile = normMobile(L.consignorMobile);
    if (L.consignorMobile && L.consignorMobile.length !== 10) return res.status(400).json({ error: 'Consignor mobile must be 10 digits (or leave it blank).' });
    L.cnNo = nextCn(req.sup.division); /* always auto-generated; client value ignored */ L.pickupDate = L.pickupDate || dayStr(); L.supervisorName = req.sup.name; L.branch = req.sup.branch; L.division = req.sup.division || ''; L.generatedAt = nowStr();
    if (db.prepare('SELECT 1 FROM lrs WHERE cn_no=?').get(L.cnNo)) return res.status(400).json({ error: 'CN No ' + L.cnNo + ' already exists. Use a different number.' });
    try {
        const { consignee, driver, consignor } = await buildLrPdfs(L); const safe = L.cnNo.replace(/[^A-Za-z0-9]+/g, '-');
        const f1 = 'LR_' + safe + '_Consignee.pdf', f2 = 'LR_' + safe + '_Driver.pdf', f3 = 'LR_' + safe + '_Consignor.pdf';
        fs.writeFileSync(path.join(__dirname, 'storage', 'lr', f1), consignee); fs.writeFileSync(path.join(__dirname, 'storage', 'lr', f2), driver); fs.writeFileSync(path.join(__dirname, 'storage', 'lr', f3), consignor);
        const u1 = '/files/lr/' + f1, u2 = '/files/lr/' + f2, u3 = '/files/lr/' + f3;
        db.prepare(`INSERT INTO lrs(ts,cn_no,pickup_date,trip_id,code,supervisor,branch,division,booking_type,loading_station,delivery_station,vehicle_no,load_type,consignor,consignor_gstin,consignee,consignee_gstin,ewb_no,valid_till,invoice_no,invoice_date,invoice_value,packages,actual_wt,charged_wt,basis,driver_phone,consignee_pdf,driver_pdf,data,consignor_contact,consignor_mobile,consignor_pdf)
      VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(L.generatedAt, L.cnNo, L.pickupDate, L.tripId || '', req.sup.code, req.sup.name, req.sup.branch, L.division, L.bookingType || '', L.loadingStation, L.deliveryStation, L.vehicleNo, L.loadType || '', L.consignorName, L.consignorGstin || '', L.consigneeName, L.consigneeGstin || '', L.ewbNo || '', L.validTill || '', L.invoiceNo || '', L.invoiceDate || '', L.invoiceValue || '', (L.items || []).reduce((a, i) => a + (parseFloat(i.pkgs) || 0), 0), L.actualWt || '', L.chargedWt || '', L.basis || '', L.driverPhone || '', u1, u2, JSON.stringify(L), L.consignorContact, L.consignorMobile, u3);
        const base = (E.BASE_URL || '').replace(/\/$/, '');
        res.json({ ok: true, cnNo: L.cnNo, consigneeUrl: u1, driverUrl: u2, consignorUrl: u3, consigneeAbs: base + u1, driverAbs: base + u2, consignorAbs: base + u3, today: todaySummary(req.sup.code) });
    } catch (e) { console.error(e); res.status(500).json({ error: 'PDF generation failed: ' + e.message }); }
});

/* ---------- admin ---------- */
app.post('/api/admin/login', (req, res) => { if (String(req.body.pin) !== String(E.ADMIN_PIN || '')) return res.status(401).json({ error: 'Wrong PIN' }); res.cookie('admin', sign('admin'), { httpOnly: true, secure: true, sameSite: 'none', maxAge: 12 * 3600000 }); res.json({ ok: true }); });
app.post('/api/admin/lr/delete', authAdmin, (req, res) => {
  const id = parseInt(req.body.id, 10); const r = db.prepare('SELECT * FROM lrs WHERE id=?').get(id); if (!r) return res.status(404).json({ error: 'LR not found.' });
  const dd = path.join(__dirname, 'data', 'deleted-lr'); fs.mkdirSync(dd, { recursive: true });
  try { fs.appendFileSync(path.join(__dirname, 'data', 'deleted-lrs.log'), JSON.stringify({ deleted_at: new Date().toISOString(), row: r }) + '\n'); } catch (e) { console.error(e); }
  for (const u of [r.consignee_pdf, r.driver_pdf, r.consignor_pdf]) { if (!u) continue; const src = path.join(__dirname, 'storage', 'lr', path.basename(String(u))); try { if (fs.existsSync(src)) fs.renameSync(src, path.join(dd, path.basename(src))); } catch (e) { console.error(e); } }
  db.prepare('DELETE FROM lrs WHERE id=?').run(id); console.log('LR deleted:', r.cn_no); res.json({ ok: true });
});
app.get('/api/admin/data', authAdmin, (req, res) => res.json({
    supervisors: db.prepare('SELECT code,name,mobile,pin,branch,division,role,active FROM supervisors ORDER BY division,branch,name').all(),
    branches: db.prepare('SELECT * FROM branches ORDER BY name').all(),
    divisions: db.prepare('SELECT * FROM divisions ORDER BY code').all(),
    attendance: db.prepare('SELECT * FROM attendance ORDER BY id DESC LIMIT 500').all(),
    lrs: db.prepare('SELECT id,ts,cn_no,pickup_date,code,supervisor,branch,division,loading_station,delivery_station,vehicle_no,consignor,consignee,ewb_no,invoice_no,packages,actual_wt,driver_phone,consignee_pdf,driver_pdf,consignor_contact,consignor_mobile,consignor_pdf FROM lrs ORDER BY id DESC LIMIT 500').all(),
    smsMode: SMS_MODE, requireSelfie: REQUIRE_SELFIE,
    recentOtps: SMS_MODE === 'console' ? db.prepare('SELECT mobile,last_otp,sent_at,expires FROM otps ORDER BY sent_at DESC LIMIT 10').all().map(o => ({ mobile: o.mobile, otp: o.last_otp, expired: Date.now() > o.expires })) : []
}));
app.post('/api/admin/supervisor', authAdmin, (req, res) => {
    const s = req.body; if (!s.code || !s.name || !s.branch || !s.mobile || !s.division) return res.status(400).json({ error: 'code, name, mobile, branch and division are required' }); const mob = normMobile(s.mobile); if (mob.length !== 10) return res.status(400).json({ error: 'Mobile must be 10 digits' });
    const dup = db.prepare('SELECT code FROM supervisors WHERE mobile=? AND code<>?').get(mob, String(s.code).toUpperCase().trim()); if (dup) return res.status(400).json({ error: 'Mobile already used by ' + dup.code });
    db.prepare('INSERT INTO supervisors(code,name,mobile,pin,branch,division,role,active) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,mobile=excluded.mobile,pin=excluded.pin,branch=excluded.branch,division=excluded.division,role=excluded.role,active=excluded.active').run(String(s.code).toUpperCase().trim(), s.name, mob, s.pin ? String(s.pin) : null, s.branch, s.division, s.role || 'Supervisor', s.active === false || s.active === 0 ? 0 : 1); res.json({ ok: true });
});
app.post('/api/admin/branch', authAdmin, (req, res) => { const b = req.body; if (!b.name) return res.status(400).json({ error: 'name required' }); db.prepare('INSERT INTO branches(name,address,phone,email,lat,lng,billing_default) VALUES(?,?,?,?,?,?,?) ON CONFLICT(name) DO UPDATE SET address=excluded.address,phone=excluded.phone,email=excluded.email,lat=excluded.lat,lng=excluded.lng,billing_default=excluded.billing_default').run(b.name.toUpperCase().trim(), b.address || '', b.phone || '', b.email || '', b.lat || null, b.lng || null, b.billing_default || b.name); res.json({ ok: true }); });
app.post('/api/admin/division', authAdmin, (req, res) => { const d = req.body; if (!d.code || !d.name) return res.status(400).json({ error: 'code and name required' }); db.prepare('INSERT INTO divisions(code,name,cn_prefix,cn_next,active) VALUES(?,?,?,?,?) ON CONFLICT(code) DO UPDATE SET name=excluded.name,cn_prefix=excluded.cn_prefix,cn_next=excluded.cn_next,active=excluded.active').run(String(d.code).toUpperCase().trim(), d.name, d.cn_prefix || '', parseInt(d.cn_next || '1001', 10), d.active === false || d.active === 0 ? 0 : 1); res.json({ ok: true }); });
app.post('/api/admin/ewb-test', authAdmin, async (req, res) => { try { const t = await ewb.auth(true); res.json({ ok: true, msg: 'Authenticated. Token ' + String(t).slice(0, 10) + '…' }); } catch (e) { res.status(400).json({ error: e.message }); } });
// --- admin tools: delete supervisor + OTP test with verify ---
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
        const mobile = normMobile(req.body.mobile); if (!/^\d{10}$/.test(mobile)) return res.status(400).json({ error: 'Enter a 10-digit mobile number.' });
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
        if (!/^\d{4,8}$/.test(otp)) return res.status(400).json({ error: 'Enter the OTP you received.' });
        if (t.rid) { const v = await PERF_TEST.validateOtp(t.rid, otp); if (!v.ok) return res.status(401).json({ error: v.msg || 'Wrong OTP.' }); }
        else if (otp !== t.otp) return res.status(401).json({ error: 'Wrong OTP.' });
        delete smsTestStore[mobile]; res.json({ ok: true, msg: 'OTP verified - SMS delivery and OTP check are working.' });
    } catch (e) { res.status(502).json({ error: e.message }); }
});
app.get('/api/admin/export/:table.csv', authAdmin, (req, res) => { const t = { attendance: 'attendance', lrs: 'lrs', supervisors: 'supervisors' }[req.params.table]; if (!t) return res.status(404).end(); const rows = db.prepare('SELECT * FROM ' + t + ' ORDER BY rowid').all(); const cols = rows.length ? Object.keys(rows[0]).filter(c => c !== 'data' && c !== 'pin') : []; const esc = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename=' + t + '.csv'); res.send([cols.join(','), ...rows.map(r => cols.map(c => esc(r[c])).join(','))].join('\n')); });

app.get('/admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'admin.html')));
app.get('/health', (req, res) => res.json({ ok: true, time: nowStr() }));
app.listen(PORT, () => console.log('BRL LS App on http://localhost:' + PORT + '  (OTP mode: ' + SMS_MODE + ', selfie: ' + (REQUIRE_SELFIE ? 'required' : 'optional') + ')'));