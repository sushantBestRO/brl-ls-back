// BRL LS App · Supervisor Expenses (fooding, conveyance, other) — proof, checks, verify → approve → pay.
// Replaces the paper flow (debit voucher + handwritten sheet + weighbridge slips scanned to HR Andheri).
// Hooked from server.js with one line:  require('./expense')(app, { db, authSup, authAdmin, nowStr, dayStr, reverseGeocode, haversine });
//
// RJ science used (rj-notes):
//  - F.M.S with planned vs actual at each step (BMP-S s.201+ FMS creation): Submit → Verify (branch) → Approve (HR/Accounts) → Pay.
//  - "Even buying a mouse needs to be budgeted, sanctioned & approved" + "batch all expenses" (BMP W1·p.69): every rupee is a line
//    with proof, sanctioned by a named person; branch monthly budget shown against actual (BMP-S s.159).
//  - Daily expenses upload (BMP-S s.155): lines are entered the same day; late entries are flagged.
//  - Stop corruption = weekly payments + FIFO (BMP-S s.190): payment planned on the weekly pay day, oldest claim first;
//    the claimant, the verifier and the approver must be three different people.
//  - Negative MIS (BMP-S s.484+): the board shows only what is late, over budget or red-flagged.
const fs = require('fs'); const path = require('path'); const crypto = require('crypto');
const { PDFDocument, StandardFonts, rgb } = require('pdf-lib');

module.exports = function mountExpense(app, ctx) {
  const { db, authSup, authAdmin, nowStr, dayStr, reverseGeocode, haversine } = ctx;
  const STORE = path.join(__dirname, 'storage', 'exp'); fs.mkdirSync(STORE, { recursive: true });

  /* ---------------- tables ---------------- */
  db.exec(`
  CREATE TABLE IF NOT EXISTS exp_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT, created_ts TEXT, code TEXT NOT NULL, name TEXT, branch TEXT, division TEXT,
    type TEXT NOT NULL, exp_date TEXT NOT NULL, amount REAL NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'OPEN',
    lr_id INTEGER, lr_cn TEXT, vehicle_no TEXT, party TEXT, from_place TEXT, to_place TEXT,
    mode TEXT, km REAL, fair REAL, live INTEGER DEFAULT 0,
    start_ts TEXT, start_lat REAL, start_lng REAL, start_addr TEXT, end_ts TEXT, end_lat REAL, end_lng REAL, end_addr TEXT,
    category TEXT, slip_no TEXT, note TEXT,
    photo TEXT, photo_hash TEXT, photo_ts TEXT, photo_lat REAL, photo_lng REAL, photo_addr TEXT,
    flags TEXT DEFAULT '[]', claim_id INTEGER, check_status TEXT DEFAULT 'PENDING', check_reason TEXT, checked_by TEXT, checked_ts TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_expl_code ON exp_lines(code, status);
  CREATE INDEX IF NOT EXISTS idx_expl_claim ON exp_lines(claim_id);
  CREATE TABLE IF NOT EXISTS exp_claims (
    id INTEGER PRIMARY KEY AUTOINCREMENT, claim_no TEXT UNIQUE, code TEXT NOT NULL, name TEXT, mobile TEXT, branch TEXT, division TEXT,
    from_date TEXT, to_date TEXT, line_count INTEGER, amount REAL, approved_amount REAL, red_flags INTEGER DEFAULT 0,
    status TEXT NOT NULL, submitted_ts TEXT, submitted_iso TEXT,
    verify_plan TEXT, verified_ts TEXT, verified_by TEXT, verified_code TEXT,
    approve_plan TEXT, approved_ts TEXT, approved_by TEXT, approved_code TEXT,
    pay_plan TEXT, paid_ts TEXT, paid_by TEXT, paid_code TEXT, pay_mode TEXT, pay_ref TEXT,
    returned_ts TEXT, returned_by TEXT, return_reason TEXT, pdf TEXT
  );
  CREATE TABLE IF NOT EXISTS exp_approvers (code TEXT NOT NULL, role TEXT NOT NULL, branches TEXT DEFAULT '*', active INTEGER DEFAULT 1, PRIMARY KEY (code, role));
  CREATE TABLE IF NOT EXISTS exp_branch (branch TEXT PRIMARY KEY, short TEXT, fooding_rate REAL, monthly_budget REAL);
  CREATE TABLE IF NOT EXISTS exp_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, claim_id INTEGER, line_id INTEGER, by_code TEXT, by_name TEXT, action TEXT, note TEXT);
  `);

  /* ---------------- rules (admin-editable, stored in settings) ---------------- */
  const DEF = {
    fooding: { rate: 100, label: 'Fooding exp. (per vehicle loaded)' },
    conveyance: { minFare: 20, perKm: 12, roadFactor: 1.3, dailyCap: 200, ticketAbove: 100, modes: ['Auto (shared)', 'Auto', 'Bus', 'Train', 'Own bike', 'Walk'] },
    other: { categories: ['Weighbridge charges', 'Labour / hamali', 'Lashing / choking material', 'Xerox / printing', 'Mobile recharge', 'Other'], billRequired: true, needNoteAbove: 500 },
    entryWindowDays: 3, hardLimitDays: 35, maxLrAgeDays: 20, branchRadiusKm: 25, photoAfterLrHours: 48,
    verifyDays: 1, approveDays: 2, payWeekday: 6, payDayName: 'Saturday', segregation: true,
  };
  const getRules = () => { try { const r = db.prepare("SELECT value FROM settings WHERE key='EXP_RULES'").get(); return deepMerge(DEF, r ? JSON.parse(r.value) : {}); } catch (e) { return DEF; } };
  function deepMerge(a, b) { const o = Array.isArray(a) ? a.slice() : { ...a }; for (const k of Object.keys(b || {})) { o[k] = (a && typeof a[k] === 'object' && !Array.isArray(a[k]) && b[k] && typeof b[k] === 'object' && !Array.isArray(b[k])) ? deepMerge(a[k], b[k]) : b[k]; } return o; }
  const branchCfg = br => db.prepare('SELECT * FROM exp_branch WHERE upper(branch)=upper(?)').get(br || '') || {};
  const foodingRate = br => { const b = branchCfg(br); return b.fooding_rate != null && b.fooding_rate !== '' ? Number(b.fooding_rate) : Number(getRules().fooding.rate); };
  const branchShort = br => (branchCfg(br).short || String(br || 'BR').replace(/[^A-Za-z]/g, '').slice(0, 3)).toUpperCase();

  /* ---------------- helpers ---------------- */
  const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const isoToday = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Kolkata' }).format(new Date());
  const isoToDay = iso => { const [y, m, d] = String(iso).split('-'); return d + '-' + MON[+m - 1] + '-' + y; }; // 2026-10-30 → 30-Oct-2026 (attendance.day format)
  const dayToIso = s => { const m = String(s || '').match(/(\d{1,2})-([A-Za-z]{3})-(\d{4})/); if (!m) return ''; const mi = MON.findIndex(x => x.toLowerCase() === m[2].toLowerCase()); return mi < 0 ? '' : m[3] + '-' + String(mi + 1).padStart(2, '0') + '-' + m[1].padStart(2, '0'); };
  const addDays = (iso, n) => { const d = new Date(iso + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
  const daysBetween = (a, b) => Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000);
  const nextWeekday = (iso, wd) => { let d = iso; for (let i = 0; i < 7; i++) { if (new Date(d + 'T00:00:00Z').getUTCDay() === wd) return d; d = addDays(d, 1); } return iso; };
  const money = n => Math.round((Number(n) || 0) * 100) / 100;
  const normV = v => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const parseFlags = s => { try { return JSON.parse(s || '[]'); } catch (e) { return []; } };
  const log = (claimId, lineId, who, action, note) => db.prepare('INSERT INTO exp_log(ts,claim_id,line_id,by_code,by_name,action,note) VALUES(?,?,?,?,?,?,?)').run(nowStr(), claimId || null, lineId || null, who ? who.code : '', who ? who.name : '', action, note || '');
  const bad = (res, msg, code) => res.status(code || 400).json({ error: msg });

  function savePhoto(dataUrl, prefix) {
    if (!dataUrl) return null;
    const buf = Buffer.from(String(dataUrl).split(',').pop(), 'base64');
    if (buf.length < 2000) throw new Error('Photo is empty. Take it again.');
    if (buf.length > 4 * 1024 * 1024) throw new Error('Photo too large.');
    const hash = crypto.createHash('sha256').update(buf).digest('hex');
    const dup = db.prepare("SELECT id FROM exp_lines WHERE photo_hash=? AND status<>'DELETED'").get(hash);
    if (dup) throw new Error('This exact photo is already used on expense line #' + dup.id + '. Take a fresh photo of the proof.');
    const fn = prefix + '_' + crypto.randomBytes(9).toString('base64url') + '.jpg';
    fs.writeFileSync(path.join(STORE, fn), buf);
    return { url: '/files/exp/' + fn, hash };
  }

  // Roles: VERIFY (branch head / P.C), APPROVE (HR / Accounts head), PAY (cashier / accounts)
  const rolesOf = code => db.prepare('SELECT role, branches FROM exp_approvers WHERE upper(code)=upper(?) AND active=1').all(code || '');
  const canAct = (code, role, branch) => rolesOf(code).some(r => r.role === role && (String(r.branches || '*').trim() === '*' || String(r.branches).toUpperCase().split(/\s*,\s*/).includes(String(branch || '').toUpperCase())));

  /* ---------------- automatic checks on a line (the "authentication") ---------------- */
  function computeFlags(L, sup) {
    const R = getRules(); const F = []; const today = isoToday();
    const lag = daysBetween(L.exp_date, dayToIso(String(L.created_ts || nowStr()).slice(0, 11)) || today);
    if (lag > R.entryWindowDays) F.push({ k: 'LATE', lvl: 'amber', t: 'Entered ' + lag + ' days after the expense date (rule: within ' + R.entryWindowDays + ' days).' });
    const att = db.prepare("SELECT COUNT(*) c FROM attendance WHERE code=? AND day=? AND type='IN'").get(L.code, isoToDay(L.exp_date)).c;
    if (!att) F.push({ k: 'NO_ATT', lvl: 'red', t: 'No check-in in the app on ' + isoToDay(L.exp_date) + '.' });
    const b = db.prepare('SELECT lat,lng FROM branches WHERE upper(name)=upper(?)').get(L.branch || '');
    const farFrom = (lat, lng, what) => { if (b && b.lat && b.lng && lat && lng) { const km = haversine(+lat, +lng, b.lat, b.lng) / 1000; if (km > R.branchRadiusKm) F.push({ k: 'FAR', lvl: 'amber', t: what + ' ' + Math.round(km) + ' km from ' + L.branch + ' branch.' }); } };
    if (L.type === 'FOODING') {
      if (!L.lr_id) F.push({ k: 'LR_MANUAL', lvl: 'amber', t: 'LR ' + (L.lr_cn || '?') + ' was not made in the app — check it in ERP.' });
      const dupSlip = L.slip_no ? db.prepare("SELECT id FROM exp_lines WHERE id<>? AND type='FOODING' AND status<>'DELETED' AND slip_no<>'' AND upper(slip_no)=upper(?)").get(L.id || 0, L.slip_no) : null;
      if (dupSlip) F.push({ k: 'DUP_SLIP', lvl: 'red', t: 'Weighbridge slip no. ' + L.slip_no + ' is also on line #' + dupSlip.id + '.' });
      if (L.lr_id) { const lr = db.prepare('SELECT ts FROM lrs WHERE id=?').get(L.lr_id); if (lr && L.photo_ts) { const h = (Date.parse(L.photo_ts) - Date.parse(dayToIso(lr.ts) + 'T' + String(lr.ts).slice(12, 20) + '+05:30')) / 3600000; if (h > R.photoAfterLrHours) F.push({ k: 'PHOTO_LATE', lvl: 'amber', t: 'Proof photo taken ' + Math.round(h) + ' h after the LR.' }); } }
      farFrom(L.photo_lat, L.photo_lng, 'Proof photo taken');
      const sameDay = db.prepare("SELECT COUNT(*) c FROM exp_lines WHERE code=? AND type='FOODING' AND exp_date=? AND status<>'DELETED'").get(L.code, L.exp_date).c;
      const lrsDay = db.prepare('SELECT COUNT(*) c FROM lrs WHERE code=? AND ts LIKE ?').get(L.code, isoToDay(L.exp_date) + '%').c;
      if (lrsDay && sameDay > lrsDay) F.push({ k: 'MORE_THAN_LR', lvl: 'amber', t: sameDay + ' fooding lines on this day but only ' + lrsDay + ' LRs in the app.' });
    }
    if (L.type === 'CONVEYANCE') {
      const C = R.conveyance;
      if (!L.live) F.push({ k: 'NOT_LIVE', lvl: 'amber', t: 'Typed afterwards — not tracked live with GPS.' });
      if (L.live && L.fair != null && L.amount > L.fair) F.push({ k: 'ABOVE_FAIR', lvl: 'amber', t: 'Rs ' + L.amount + ' is above the fair fare Rs ' + L.fair + ' for ~' + L.km + ' km.' });
      if (L.amount > C.ticketAbove && !L.photo) F.push({ k: 'NO_TICKET', lvl: 'red', t: 'Above Rs ' + C.ticketAbove + ' needs a ticket / receipt photo.' });
      const dayTot = db.prepare("SELECT COALESCE(SUM(amount),0) s FROM exp_lines WHERE code=? AND type='CONVEYANCE' AND exp_date=? AND status NOT IN ('DELETED','RUNNING')").get(L.code, L.exp_date).s;
      if (C.dailyCap && dayTot > C.dailyCap) F.push({ k: 'DAY_CAP', lvl: 'red', t: 'Conveyance on ' + isoToDay(L.exp_date) + ' totals Rs ' + dayTot + ' (daily cap Rs ' + C.dailyCap + ').' });
      if (L.live) { farFrom(L.start_lat, L.start_lng, 'Trip started'); }
    }
    if (L.type === 'OTHER') {
      if (R.other.billRequired && !L.photo) F.push({ k: 'NO_BILL', lvl: 'red', t: 'No bill photo.' });
      if (L.amount > R.other.needNoteAbove && !(L.note || '').trim()) F.push({ k: 'NO_NOTE', lvl: 'amber', t: 'Above Rs ' + R.other.needNoteAbove + ' — reason not written.' });
      farFrom(L.photo_lat, L.photo_lng, 'Bill photo taken');
    }
    return F;
  }
  function refreshFlags(id) { const L = db.prepare('SELECT * FROM exp_lines WHERE id=?').get(id); if (!L) return []; const F = computeFlags(L); db.prepare('UPDATE exp_lines SET flags=? WHERE id=?').run(JSON.stringify(F), id); return F; }

  /* ---------------- supervisor: what I can claim ---------------- */
  function myState(sup) {
    const R = getRules(); const since = addDays(isoToday(), -R.maxLrAgeDays);
    const lrs = db.prepare('SELECT id, ts, cn_no, vehicle_no, consignor, consignee, loading_station, delivery_station FROM lrs WHERE code=? ORDER BY id DESC LIMIT 200').all(sup.code)
      .filter(l => (dayToIso(l.ts) || '') >= since)
      .filter(l => !db.prepare("SELECT 1 FROM exp_lines WHERE lr_id=? AND type='FOODING' AND status<>'DELETED'").get(l.id))
      .map(l => ({ id: l.id, date: dayToIso(l.ts), cn: l.cn_no, vehicle: l.vehicle_no, party: l.consignor, to: l.delivery_station, from: l.loading_station }));
    const lines = db.prepare("SELECT * FROM exp_lines WHERE code=? AND status IN ('OPEN','RUNNING') ORDER BY exp_date, id").all(sup.code).map(pubLine);
    const claims = db.prepare('SELECT * FROM exp_claims WHERE code=? ORDER BY id DESC LIMIT 12').all(sup.code).map(pubClaim);
    const roles = rolesOf(sup.code).map(r => r.role);
    const queue = roles.length ? queueFor(sup).length : 0;
    return { rules: { ...R, foodingRate: foodingRate(sup.branch) }, lrs, lines, claims, roles, queue, today: isoToday(), name: sup.name, branch: sup.branch, code: sup.code };
  }
  const pubLine = L => ({ ...L, flags: parseFlags(L.flags) });
  const pubClaim = C => C;

  app.get('/api/exp/me', authSup, (req, res) => res.json(myState(req.sup)));

  // Add a fooding / conveyance (typed) / other line
  app.post('/api/exp/line', authSup, (req, res) => {
    const sup = req.sup; const R = getRules(); const b = req.body || {}; const type = String(b.type || '').toUpperCase();
    if (!['FOODING', 'CONVEYANCE', 'OTHER'].includes(type)) return bad(res, 'Pick the expense type.');
    const today = isoToday(); let exp_date = String(b.exp_date || today).slice(0, 10);
    const L = { code: sup.code, name: sup.name, branch: sup.branch, division: sup.division || '', type, created_ts: nowStr(), status: 'OPEN', live: 0,
      photo_ts: b.photoMeta && b.photoMeta.ts ? String(b.photoMeta.ts) : null, photo_lat: b.photoMeta ? +b.photoMeta.lat || null : null, photo_lng: b.photoMeta ? +b.photoMeta.lng || null : null, photo_addr: b.photoMeta ? String(b.photoMeta.addr || '').slice(0, 300) : '',
      note: String(b.note || '').slice(0, 300), slip_no: String(b.slip_no || '').trim().slice(0, 40) };
    if (type === 'FOODING') {
      if (b.lr_id) {
        const lr = db.prepare('SELECT * FROM lrs WHERE id=?').get(+b.lr_id);
        if (!lr || lr.code !== sup.code) return bad(res, 'That LR is not yours.');
        if (db.prepare("SELECT id FROM exp_lines WHERE lr_id=? AND type='FOODING' AND status<>'DELETED'").get(lr.id)) return bad(res, 'Fooding for LR ' + lr.cn_no + ' is already claimed.');
        Object.assign(L, { lr_id: lr.id, lr_cn: lr.cn_no, vehicle_no: normV(lr.vehicle_no), party: lr.consignor, from_place: lr.loading_station, to_place: lr.delivery_station }); exp_date = dayToIso(lr.ts) || exp_date;
      } else {
        Object.assign(L, { lr_cn: String(b.lr_cn || '').trim(), vehicle_no: normV(b.vehicle_no), party: String(b.party || '').trim(), from_place: String(b.from_place || sup.branch).trim(), to_place: String(b.to_place || '').trim() });
        if (!L.lr_cn || !L.vehicle_no || !L.party || !L.to_place) return bad(res, 'For an LR not made in the app, type LR no., vehicle no., party and destination.');
        const d = db.prepare("SELECT id FROM exp_lines WHERE type='FOODING' AND status<>'DELETED' AND (upper(lr_cn)=upper(?) OR (vehicle_no=? AND exp_date=?))").get(L.lr_cn, L.vehicle_no, exp_date);
        if (d) return bad(res, 'Fooding for this LR / vehicle on this date is already on line #' + d.id + '.');
      }
      L.amount = foodingRate(sup.branch);
      if (!b.photo) return bad(res, 'Take a photo of the weighbridge slip (or the loaded vehicle with its number plate).');
    } else if (type === 'CONVEYANCE') {
      Object.assign(L, { from_place: String(b.from_place || '').trim(), to_place: String(b.to_place || '').trim(), mode: String(b.mode || '').trim(), amount: money(b.amount) });
      if (!L.from_place || !L.to_place || !L.mode || !(L.amount > 0)) return bad(res, 'From, to, mode and amount are needed.');
    } else {
      Object.assign(L, { category: String(b.category || '').trim(), amount: money(b.amount), party: String(b.party || '').trim(), vehicle_no: normV(b.vehicle_no) });
      if (!L.category || !(L.amount > 0)) return bad(res, 'Category and amount are needed.');
      if (R.other.billRequired && !b.photo) return bad(res, 'Take a photo of the bill / receipt.');
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(exp_date) || exp_date > today) return bad(res, 'Expense date cannot be in the future.');
    if (daysBetween(exp_date, today) > R.hardLimitDays) return bad(res, 'Older than ' + R.hardLimitDays + ' days — cannot be claimed in the app. Speak to HR.');
    L.exp_date = exp_date;
    try { const p = savePhoto(b.photo, type.slice(0, 3)); if (p) { L.photo = p.url; L.photo_hash = p.hash; } } catch (e) { return bad(res, e.message); }
    const cols = Object.keys(L); const id = db.prepare('INSERT INTO exp_lines(' + cols.join(',') + ') VALUES(' + cols.map(() => '?').join(',') + ')').run(...cols.map(k => L[k])).lastInsertRowid;
    const F = refreshFlags(id); log(null, id, sup, 'ADD ' + type, 'Rs ' + L.amount);
    res.json({ ok: true, id, flags: F, state: myState(sup) });
  });

  // Live conveyance: start (GPS) … reached (GPS + fare)
  app.post('/api/exp/trip/start', authSup, async (req, res) => {
    const sup = req.sup; const b = req.body || {};
    if (db.prepare("SELECT id FROM exp_lines WHERE code=? AND status='RUNNING'").get(sup.code)) return bad(res, 'A trip is already running. Tap Reached on it first.');
    if (!b.lat || !b.lng) return bad(res, 'GPS needed to start a trip.');
    if (!String(b.from_place || '').trim() || !String(b.mode || '').trim()) return bad(res, 'Type where you start from and the mode.');
    const addr = await reverseGeocode(b.lat, b.lng);
    const id = db.prepare("INSERT INTO exp_lines(created_ts,code,name,branch,division,type,exp_date,amount,status,live,from_place,mode,start_ts,start_lat,start_lng,start_addr,note) VALUES(?,?,?,?,?,'CONVEYANCE',?,0,'RUNNING',1,?,?,?,?,?,?,?)")
      .run(nowStr(), sup.code, sup.name, sup.branch, sup.division || '', isoToday(), String(b.from_place).trim(), String(b.mode).trim(), new Date().toISOString(), +b.lat, +b.lng, addr, String(b.note || '').slice(0, 300)).lastInsertRowid;
    log(null, id, sup, 'TRIP START', b.from_place); res.json({ ok: true, id, state: myState(sup) });
  });
  app.post('/api/exp/trip/end', authSup, async (req, res) => {
    const sup = req.sup; const b = req.body || {}; const R = getRules(); const C = R.conveyance;
    const L = db.prepare("SELECT * FROM exp_lines WHERE id=? AND code=? AND status='RUNNING'").get(+b.id, sup.code); if (!L) return bad(res, 'No running trip.');
    if (!b.lat || !b.lng) return bad(res, 'GPS needed to end the trip.');
    const amount = money(b.amount); if (!(amount > 0)) return bad(res, 'Type the fare paid.');
    if (!String(b.to_place || '').trim()) return bad(res, 'Type where you reached.');
    const km = Math.round(haversine(L.start_lat, L.start_lng, +b.lat, +b.lng) / 1000 * C.roadFactor * 10) / 10;
    const fair = Math.max(C.minFare, Math.ceil(km * C.perKm / 5) * 5);
    let p = null; try { p = savePhoto(b.photo, 'CON'); } catch (e) { return bad(res, e.message); }
    const addr = await reverseGeocode(b.lat, b.lng);
    db.prepare("UPDATE exp_lines SET status='OPEN', to_place=?, amount=?, km=?, fair=?, end_ts=?, end_lat=?, end_lng=?, end_addr=?, photo=?, photo_hash=?, photo_ts=?, photo_lat=?, photo_lng=?, mode=COALESCE(NULLIF(?,''),mode), note=TRIM(COALESCE(note,'')||' '||?) WHERE id=?")
      .run(String(b.to_place).trim(), amount, km, fair, new Date().toISOString(), +b.lat, +b.lng, addr, p ? p.url : null, p ? p.hash : null, p ? new Date().toISOString() : null, p ? +b.lat : null, p ? +b.lng : null, String(b.mode || ''), String(b.note || '').slice(0, 200), L.id);
    const F = refreshFlags(L.id); log(null, L.id, sup, 'TRIP END', 'Rs ' + amount + ' · ' + km + ' km'); res.json({ ok: true, km, fair, flags: F, state: myState(sup) });
  });
  app.post('/api/exp/trip/cancel', authSup, (req, res) => { const r = db.prepare("UPDATE exp_lines SET status='DELETED' WHERE id=? AND code=? AND status='RUNNING'").run(+req.body.id, req.sup.code); log(null, +req.body.id, req.sup, 'TRIP CANCEL', ''); res.json({ ok: !!r.changes, state: myState(req.sup) }); });

  app.post('/api/exp/line/delete', authSup, (req, res) => {
    const r = db.prepare("UPDATE exp_lines SET status='DELETED' WHERE id=? AND code=? AND status='OPEN'").run(+req.body.id, req.sup.code);
    if (!r.changes) return bad(res, 'Only your own unclaimed lines can be removed.'); log(null, +req.body.id, req.sup, 'DELETE LINE', ''); res.json({ ok: true, state: myState(req.sup) });
  });

  // Submit all open lines as one claim (the debit voucher)
  app.post('/api/exp/claim', authSup, async (req, res) => {
    const sup = req.sup; const R = getRules();
    const lines = db.prepare("SELECT * FROM exp_lines WHERE code=? AND status='OPEN' ORDER BY exp_date, id").all(sup.code);
    if (!lines.length) return bad(res, 'Nothing to claim. Add expenses first.');
    lines.forEach(l => refreshFlags(l.id));
    const fresh = db.prepare("SELECT * FROM exp_lines WHERE code=? AND status='OPEN' ORDER BY exp_date, id").all(sup.code);
    const total = money(fresh.reduce((a, l) => a + l.amount, 0)); const reds = fresh.reduce((a, l) => a + parseFlags(l.flags).filter(f => f.lvl === 'red').length, 0);
    const today = isoToday(); const yymm = today.slice(2, 4) + today.slice(5, 7); const pre = 'EXP/' + branchShort(sup.branch) + '/' + yymm + '/';
    const n = db.prepare('SELECT COUNT(*) c FROM exp_claims WHERE claim_no LIKE ?').get(pre + '%').c + 1;
    const claimNo = pre + String(n).padStart(3, '0');
    const tx = db.transaction(() => {
      const id = db.prepare("INSERT INTO exp_claims(claim_no,code,name,mobile,branch,division,from_date,to_date,line_count,amount,approved_amount,red_flags,status,submitted_ts,submitted_iso,verify_plan) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,'SUBMITTED',?,?,?)")
        .run(claimNo, sup.code, sup.name, sup.mobile || '', sup.branch, sup.division || '', fresh[0].exp_date, fresh[fresh.length - 1].exp_date, fresh.length, total, total, reds, nowStr(), today, addDays(today, R.verifyDays)).lastInsertRowid;
      db.prepare("UPDATE exp_lines SET status='CLAIMED', claim_id=?, check_status='PENDING', check_reason=NULL, checked_by=NULL, checked_ts=NULL WHERE code=? AND status='OPEN'").run(id, sup.code);
      return id;
    });
    const id = tx(); log(id, null, sup, 'SUBMIT', claimNo + ' · Rs ' + total);
    await buildPdf(id).catch(e => console.error('exp pdf', e));
    res.json({ ok: true, claimNo, id, state: myState(sup) });
  });

  /* ---------------- approvers ---------------- */
  function queueFor(sup) {
    const out = []; const all = db.prepare("SELECT * FROM exp_claims WHERE status IN ('SUBMITTED','VERIFIED','APPROVED') ORDER BY id").all();
    for (const c of all) {
      const step = { SUBMITTED: 'VERIFY', VERIFIED: 'APPROVE', APPROVED: 'PAY' }[c.status];
      if (c.code === sup.code) continue;
      if (!canAct(sup.code, step, c.branch)) continue;
      if (step === 'APPROVE' && getRules().segregation && c.verified_code === sup.code) continue;
      out.push({ ...c, step });
    }
    return out;
  }
  app.get('/api/exp/queue', authSup, (req, res) => res.json({ claims: queueFor(req.sup), roles: rolesOf(req.sup.code) }));

  function canSee(req, c) { if (isAdmin(req)) return true; const s = trySup(req); if (!s) return false; if (s.code === c.code) return true; return ['VERIFY', 'APPROVE', 'PAY'].some(r => canAct(s.code, r, c.branch)); }
  function trySup(req) { let ok = false; authSup({ headers: req.headers, body: {} }, { status: () => ({ json: () => {} }) }, () => { ok = true; }); if (!ok) return null; return db.prepare('SELECT * FROM supervisors WHERE code=?').get(req.headers['x-code']); }
  function isAdmin(req) { let ok = false; authAdmin(req, { status: () => ({ json: () => {} }) }, () => { ok = true; }); return ok; }
  function claimDetail(id) {
    const c = db.prepare('SELECT * FROM exp_claims WHERE id=?').get(id); if (!c) return null;
    const lines = db.prepare('SELECT * FROM exp_lines WHERE claim_id=? ORDER BY exp_date, id').all(id).map(pubLine);
    const logRows = db.prepare('SELECT ts, by_name, action, note FROM exp_log WHERE claim_id=? ORDER BY id').all(id);
    const month = String(c.submitted_iso || '').slice(0, 7);
    const mtd = db.prepare("SELECT COALESCE(SUM(approved_amount),0) s FROM exp_claims WHERE code=? AND substr(submitted_iso,1,7)=? AND status<>'RETURNED'").get(c.code, month).s;
    return { claim: c, lines, log: logRows, personMonth: mtd };
  }
  app.get('/api/exp/claim/:id', (req, res) => { const d = claimDetail(+req.params.id); if (!d) return bad(res, 'Not found', 404); if (!canSee(req, d.claim)) return bad(res, 'Not allowed', 403); res.json(d); });

  // Tick / reject a line (verifier at SUBMITTED, approver at VERIFIED)
  app.post('/api/exp/line/check', authSup, (req, res) => {
    const sup = req.sup; const L = db.prepare('SELECT * FROM exp_lines WHERE id=?').get(+req.body.id); if (!L || !L.claim_id) return bad(res, 'Line not found.');
    const c = db.prepare('SELECT * FROM exp_claims WHERE id=?').get(L.claim_id); const step = { SUBMITTED: 'VERIFY', VERIFIED: 'APPROVE' }[c.status];
    if (!step || !canAct(sup.code, step, c.branch) || c.code === sup.code) return bad(res, 'You cannot check lines on this claim now.', 403);
    const ok = !!req.body.ok; const reason = String(req.body.reason || '').trim(); if (!ok && !reason) return bad(res, 'Write why this line is rejected.');
    db.prepare('UPDATE exp_lines SET check_status=?, check_reason=?, checked_by=?, checked_ts=? WHERE id=?').run(ok ? 'OK' : 'REJECTED', ok ? null : reason, sup.name, nowStr(), L.id);
    const appr = money(db.prepare("SELECT COALESCE(SUM(amount),0) s FROM exp_lines WHERE claim_id=? AND check_status<>'REJECTED'").get(c.id).s);
    db.prepare('UPDATE exp_claims SET approved_amount=? WHERE id=?').run(appr, c.id); log(c.id, L.id, sup, ok ? 'LINE OK' : 'LINE REJECTED', reason);
    res.json({ ok: true, approved_amount: appr });
  });

  app.post('/api/exp/claim/act', authSup, async (req, res) => {
    const sup = req.sup; const R = getRules(); const b = req.body || {}; const c = db.prepare('SELECT * FROM exp_claims WHERE id=?').get(+b.id); if (!c) return bad(res, 'Claim not found.');
    const action = String(b.action || '').toUpperCase(); const today = isoToday();
    if (c.code === sup.code) return bad(res, 'You cannot act on your own claim.', 403);
    const need = { VERIFY: ['SUBMITTED', 'VERIFY'], APPROVE: ['VERIFIED', 'APPROVE'], PAY: ['APPROVED', 'PAY'], RETURN: [c.status, c.status === 'SUBMITTED' ? 'VERIFY' : 'APPROVE'] }[action];
    if (!need) return bad(res, 'Unknown action.');
    if (c.status !== need[0] || !['SUBMITTED', 'VERIFIED', 'APPROVED'].includes(c.status)) return bad(res, 'Claim is ' + c.status + ' — cannot ' + action.toLowerCase() + '.');
    if (action === 'RETURN' && c.status === 'APPROVED') return bad(res, 'Approved claims cannot be returned.');
    if (!canAct(sup.code, need[1], c.branch)) return bad(res, 'You are not set up to ' + need[1].toLowerCase() + ' ' + c.branch + ' claims.', 403);
    if (action === 'APPROVE' && R.segregation && c.verified_code === sup.code) return bad(res, 'The person who verified cannot also approve.', 403);
    const lines = db.prepare('SELECT * FROM exp_lines WHERE claim_id=?').all(c.id);
    if (action === 'VERIFY') {
      const undecided = lines.filter(l => l.check_status === 'PENDING' && parseFlags(l.flags).some(f => f.lvl === 'red'));
      if (undecided.length) return bad(res, undecided.length + ' red-flag line(s) need your OK or Reject first (#' + undecided.map(l => l.id).join(', #') + ').');
      db.prepare("UPDATE exp_lines SET check_status='OK', checked_by=?, checked_ts=? WHERE claim_id=? AND check_status='PENDING'").run(sup.name, nowStr(), c.id);
      db.prepare("UPDATE exp_claims SET status='VERIFIED', verified_ts=?, verified_by=?, verified_code=?, approve_plan=? WHERE id=?").run(nowStr(), sup.name, sup.code, addDays(today, R.approveDays), c.id);
    } else if (action === 'APPROVE') {
      db.prepare("UPDATE exp_claims SET status='APPROVED', approved_ts=?, approved_by=?, approved_code=?, pay_plan=? WHERE id=?").run(nowStr(), sup.name, sup.code, nextWeekday(addDays(today, 0), R.payWeekday), c.id);
    } else if (action === 'PAY') {
      const mode = String(b.pay_mode || '').trim(), ref = String(b.pay_ref || '').trim();
      if (!mode) return bad(res, 'Pick how it was paid.'); if (mode !== 'Cash' && !ref) return bad(res, 'Type the UTR / transaction reference.');
      if (mode === 'Cash' && !ref) return bad(res, 'Type the cash voucher no.');
      db.prepare("UPDATE exp_claims SET status='PAID', paid_ts=?, paid_by=?, paid_code=?, pay_mode=?, pay_ref=? WHERE id=?").run(nowStr(), sup.name, sup.code, mode, ref, c.id);
      db.prepare("UPDATE exp_lines SET status=CASE WHEN check_status='REJECTED' THEN 'REJECTED' ELSE 'PAID' END WHERE claim_id=?").run(c.id);
    } else if (action === 'RETURN') {
      const why = String(b.reason || '').trim(); if (!why) return bad(res, 'Write why the claim is returned.');
      db.prepare("UPDATE exp_claims SET status='RETURNED', returned_ts=?, returned_by=?, return_reason=? WHERE id=?").run(nowStr(), sup.name, why, c.id);
      db.prepare("UPDATE exp_lines SET status='OPEN', claim_id=NULL, check_status='PENDING', check_reason=NULL WHERE claim_id=? AND check_status<>'REJECTED'").run(c.id);
      db.prepare("UPDATE exp_lines SET status='REJECTED' WHERE claim_id=? AND check_status='REJECTED'").run(c.id);
    }
    log(c.id, null, sup, action, [b.pay_mode, b.pay_ref, b.reason].filter(Boolean).join(' · '));
    await buildPdf(c.id).catch(e => console.error('exp pdf', e));
    res.json({ ok: true, claim: db.prepare('SELECT * FROM exp_claims WHERE id=?').get(c.id) });
  });

  /* ---------------- debit voucher PDF (replaces the paper voucher + scanned annexure) ---------------- */
  function words(n) {
    n = Math.round(Number(n) || 0); if (!n) return 'Zero';
    const a = ['', 'One', 'Two', 'Three', 'Four', 'Five', 'Six', 'Seven', 'Eight', 'Nine', 'Ten', 'Eleven', 'Twelve', 'Thirteen', 'Fourteen', 'Fifteen', 'Sixteen', 'Seventeen', 'Eighteen', 'Nineteen'];
    const t = ['', '', 'Twenty', 'Thirty', 'Forty', 'Fifty', 'Sixty', 'Seventy', 'Eighty', 'Ninety'];
    const two = x => x < 20 ? a[x] : t[Math.floor(x / 10)] + (x % 10 ? ' ' + a[x % 10] : '');
    const three = x => (x >= 100 ? a[Math.floor(x / 100)] + ' Hundred' + (x % 100 ? ' ' : '') : '') + (x % 100 ? two(x % 100) : '');
    const parts = []; const cr = Math.floor(n / 1e7); n %= 1e7; const lk = Math.floor(n / 1e5); n %= 1e5; const th = Math.floor(n / 1000); n %= 1000;
    if (cr) parts.push(three(cr) + ' Crore'); if (lk) parts.push(two(lk) + ' Lakh'); if (th) parts.push(two(th) + ' Thousand'); if (n) parts.push(three(n));
    return parts.join(' ');
  }
  const TYPE_LABEL = { FOODING: 'Fooding exp.', CONVEYANCE: 'Conveyance exp.', OTHER: 'Other exp.' };
  async function buildPdf(id) {
    const d = claimDetail(id); if (!d) return; const { claim: c, lines } = d;
    const pdf = await PDFDocument.create(); const F = await pdf.embedFont(StandardFonts.Helvetica); const B = await pdf.embedFont(StandardFonts.HelveticaBold);
    const RED = rgb(0.784, 0.063, 0.18), INK = rgb(0.1, 0.1, 0.1), GREY = rgb(0.45, 0.45, 0.45), LIGHT = rgb(0.9, 0.9, 0.9);
    const W = 595, H = 842; let page, y;
    const clean = s => String(s == null ? '' : s).replace(/·/g, '|').replace(/→/g, '>').replace(/₹/g, 'Rs ').replace(/[^\x20-\x7E]/g, ' ');
    const txt = (s, x, yy, size, font, color, maxW) => { s = clean(s); const f = font || F; if (maxW) { while (s.length > 1 && f.widthOfTextAtSize(s, size) > maxW) s = s.slice(0, -1); } page.drawText(s, { x, y: yy, size, font: f, color: color || INK }); };
    const newPage = () => { page = pdf.addPage([W, H]); y = H - 40; };
    // Page 1 — voucher
    newPage();
    page.drawRectangle({ x: 30, y: 40, width: W - 60, height: H - 80, borderColor: INK, borderWidth: 1 });
    txt('DEBIT VOUCHER', W / 2 - B.widthOfTextAtSize('DEBIT VOUCHER', 11) / 2, H - 62, 11, B);
    txt('BEST ROADWAYS LIMITED', 48, H - 92, 20, B, RED); txt('Mobilizing Your Growth  ·  Supervisor expense claim (LS App)', 48, H - 108, 9, F, GREY);
    const kv = [['Branch', c.branch], ['Claim no.', c.claim_no], ['Submitted', c.submitted_ts], ['Status', c.status + (c.status === 'PAID' ? ' · ' + c.pay_mode + ' ' + c.pay_ref : '')]];
    kv.forEach(([k, v], i) => { txt(k, 360, H - 80 - i * 15, 8.5, B, GREY); txt(v, 420, H - 80 - i * 15, 8.5, F, INK, 140); });
    y = H - 160;
    const types = ['FOODING', 'CONVEYANCE', 'OTHER'].filter(t => lines.some(l => l.type === t));
    txt('Debited To', 48, y, 9, B, GREY); txt(types.map(t => TYPE_LABEL[t]).join(' / '), 130, y, 11, B); y -= 18;
    txt('Paid To', 48, y, 9, B, GREY); txt(c.name + '  (' + c.code + ')' + (c.mobile ? '  ·  ' + c.mobile : ''), 130, y, 11, B); y -= 26;
    page.drawRectangle({ x: 48, y: y - 4, width: W - 96, height: 18, color: LIGHT }); txt('PARTICULARS', 56, y + 1, 9, B); txt('Rs', W - 130, y + 1, 9, B); y -= 22;
    const per = (t, s) => lines.filter(l => l.type === t && (s ? l.check_status !== 'REJECTED' : true));
    for (const t of types) {
      const all = per(t), ok = per(t, true); const sum = ok.reduce((a, l) => a + l.amount, 0);
      const extra = t === 'FOODING' ? ' (' + ok.length + ' vehicles loaded)' : t === 'CONVEYANCE' ? ' (' + ok.length + ' trips)' : ' (' + ok.length + ' bills)';
      txt('Being the amount paid for ' + TYPE_LABEL[t].toLowerCase() + extra, 56, y, 10); txt(money(sum).toFixed(2), W - 130, y, 10, B); y -= 14;
      txt(isoToDay(c.from_date) + ' to ' + isoToDay(c.to_date) + '  ·  all details & proofs attached', 70, y, 8.5, F, GREY); y -= 20;
      if (all.length !== ok.length) { txt(all.length - ok.length + ' line(s) rejected — not paid (see annexure)', 70, y + 6, 8, F, RED); y -= 10; }
    }
    page.drawLine({ start: { x: 48, y }, end: { x: W - 48, y }, thickness: 0.8, color: INK }); y -= 16;
    txt('Total', W - 200, y, 11, B); txt(money(c.approved_amount).toFixed(2), W - 130, y, 12, B); if (c.amount !== c.approved_amount) txt('(claimed ' + money(c.amount).toFixed(2) + ')', W - 130, y - 12, 8, F, GREY); y -= 30;
    txt('Rupees in words:  ' + words(c.approved_amount) + ' only', 48, y, 10, B); y -= 40;
    // sign-off (digital — each by OTP-signed login, name + time)
    const signs = [['Prepared by (OTP login)', c.name, c.submitted_ts], ['Verified by (branch)', c.verified_by, c.verified_ts], ['Approved by', c.approved_by, c.approved_ts], ['Paid by', c.paid_by, c.paid_ts || '', c.paid_ts ? c.pay_mode + ' ' + (c.pay_ref || '') : '']];
    const bw = (W - 96) / 4; signs.forEach(([k, n, ts, ex], i) => { const x = 48 + i * bw; page.drawRectangle({ x: x + 2, y: y - 50, width: bw - 4, height: 58, borderColor: LIGHT, borderWidth: 1 }); txt(k, x + 6, y - 2, 7.5, B, GREY); txt(n || '—', x + 6, y - 20, 9.5, B, n ? INK : GREY, bw - 14); txt(ts || 'pending', x + 6, y - 34, 7, F, GREY, bw - 14); if (ex) txt(ex, x + 6, y - 44, 7, B, INK, bw - 14); });
    y -= 80;
    if (c.status === 'RETURNED') { txt('RETURNED by ' + c.returned_by + ' on ' + c.returned_ts + ': ' + c.return_reason, 48, y, 9, B, RED, W - 96); y -= 16; }
    const reds = lines.reduce((a, l) => a + l.flags.filter(f => f.lvl === 'red').length, 0), ambers = lines.reduce((a, l) => a + l.flags.filter(f => f.lvl === 'amber').length, 0);
    txt('System checks: ' + reds + ' red, ' + ambers + ' amber flag(s). Fooding lines are matched to LRs made in the LS App; proof photos are taken in-app with GPS + time stamp.', 48, y, 7.5, F, GREY, W - 96);
    // Annexure table
    newPage(); txt('ANNEXURE — ' + c.claim_no + ' · ' + c.name + ' · ' + c.branch, 30, y, 11, B, RED); y -= 22;
    const cols = [['#', 30, 22], ['Date', 52, 50], ['Type', 102, 52], ['Details', 154, 250], ['Rs', 406, 40], ['Check', 448, 50], ['Flags', 500, 70]];
    const head = () => { page.drawRectangle({ x: 28, y: y - 4, width: W - 56, height: 16, color: LIGHT }); cols.forEach(([h, x]) => txt(h, x, y, 8, B)); y -= 16; };
    head(); let i = 0;
    for (const l of lines) {
      if (y < 60) { newPage(); head(); }
      i++; const det = l.type === 'FOODING' ? [l.vehicle_no, 'LR ' + (l.lr_cn || ''), l.party, (l.from_place || '') + ' > ' + (l.to_place || ''), l.slip_no ? 'Slip ' + l.slip_no : ''].filter(Boolean).join(' · ')
        : l.type === 'CONVEYANCE' ? [(l.from_place || '') + ' > ' + (l.to_place || ''), l.mode, l.km ? l.km + ' km (fair ' + l.fair + ')' : '', l.live ? 'GPS tracked' : 'typed'].filter(Boolean).join(' · ')
        : [l.category, l.party, l.note].filter(Boolean).join(' · ');
      txt(String(i), 30, y, 8); txt(isoToDay(l.exp_date).slice(0, 6), 52, y, 8); txt(TYPE_LABEL[l.type].replace(' exp.', ''), 102, y, 8); txt(det, 154, y, 7.5, F, INK, 248);
      txt(money(l.amount).toFixed(0), 406, y, 8, B, l.check_status === 'REJECTED' ? RED : INK); txt(l.check_status === 'REJECTED' ? 'Rejected' : l.check_status === 'OK' ? 'OK' : 'Pending', 448, y, 8, F, l.check_status === 'REJECTED' ? RED : INK);
      const fl = l.flags.map(f => f.k).join(' '); txt(fl, 500, y, 6.5, F, l.flags.some(f => f.lvl === 'red') ? RED : GREY, 70); y -= 12;
      if (l.check_status === 'REJECTED' && l.check_reason) { txt('Rejected: ' + l.check_reason, 154, y, 7, F, RED, 340); y -= 11; }
    }
    y -= 6; txt('Total claimed Rs ' + money(c.amount).toFixed(2) + '   ·   Payable Rs ' + money(c.approved_amount).toFixed(2), 30, y, 9.5, B);
    // Proof photos, 4 per page
    const withPhoto = lines.filter(l => l.photo);
    for (let k = 0; k < withPhoto.length; k++) {
      if (k % 4 === 0) { newPage(); txt('PROOFS — ' + c.claim_no, 30, y, 11, B, RED); }
      const l = withPhoto[k]; const slot = k % 4; const bx = 30 + (slot % 2) * 272, by = H - 70 - (Math.floor(slot / 2) + 1) * 370;
      try { const img = await pdf.embedJpg(fs.readFileSync(path.join(STORE, path.basename(l.photo)))); const s = Math.min(262 / img.width, 330 / img.height); page.drawImage(img, { x: bx, y: by + 30, width: img.width * s, height: img.height * s }); } catch (e) { txt('(photo missing)', bx, by + 180, 9, F, GREY); }
      txt('Line ' + (lines.indexOf(l) + 1) + ' · ' + isoToDay(l.exp_date) + ' · ' + TYPE_LABEL[l.type] + ' · Rs ' + l.amount + (l.check_status === 'REJECTED' ? ' · REJECTED' : ''), bx, by + 16, 8, B, l.check_status === 'REJECTED' ? RED : INK, 262);
      txt(l.vehicle_no || l.category || ((l.from_place || '') + ' > ' + (l.to_place || '')), bx, by + 5, 7.5, F, GREY, 262);
    }
    const fn = 'CLAIM_' + c.claim_no.replace(/[^A-Za-z0-9]+/g, '-') + '_' + (c.pdf ? path.basename(c.pdf).split('_').pop().replace('.pdf', '') : crypto.randomBytes(8).toString('hex')) + '.pdf';
    fs.writeFileSync(path.join(STORE, fn), await pdf.save()); db.prepare('UPDATE exp_claims SET pdf=? WHERE id=?').run('/files/exp/' + fn, id);
  }

  /* ---------------- admin (/expense-admin) ---------------- */
  function mis() {
    const today = isoToday(); const month = today.slice(0, 7); const R = getRules();
    const open = db.prepare("SELECT * FROM exp_claims WHERE status IN ('SUBMITTED','VERIFIED','APPROVED') ORDER BY id").all();
    const late = open.map(c => { const plan = c.status === 'SUBMITTED' ? c.verify_plan : c.status === 'VERIFIED' ? c.approve_plan : c.pay_plan; return { id: c.id, claim_no: c.claim_no, name: c.name, branch: c.branch, amount: c.approved_amount, waitingFor: { SUBMITTED: 'Verify', VERIFIED: 'Approve', APPROVED: 'Pay' }[c.status], plan, daysLate: plan ? daysBetween(plan, today) : 0 }; }).filter(x => x.daysLate > 0).sort((a, b) => b.daysLate - a.daysLate);
    const branches = db.prepare("SELECT branch, SUM(CASE WHEN status<>'RETURNED' THEN approved_amount ELSE 0 END) amt, SUM(CASE WHEN status='PAID' THEN approved_amount ELSE 0 END) paid, COUNT(*) n FROM exp_claims WHERE substr(submitted_iso,1,7)=? GROUP BY branch").all(month)
      .map(b => { const bud = branchCfg(b.branch).monthly_budget; return { ...b, budget: bud || null, over: bud ? b.amt > bud : false }; });
    const notClaimed = db.prepare("SELECT code, name, branch, COUNT(*) n, SUM(amount) amt, MIN(exp_date) oldest FROM exp_lines WHERE status='OPEN' GROUP BY code HAVING oldest <= ?").all(addDays(today, -10));
    const flags = {}; db.prepare("SELECT flags FROM exp_lines WHERE substr(exp_date,1,7)=? AND status<>'DELETED'").all(month).forEach(r => parseFlags(r.flags).forEach(f => { flags[f.k] = (flags[f.k] || 0) + 1; }));
    return { month, late, branches, notClaimed, flags, payDay: R.payDayName };
  }
  app.get('/api/exp/admin/data', authAdmin, (req, res) => res.json({
    rules: getRules(), branchCfg: db.prepare('SELECT * FROM exp_branch ORDER BY branch').all(), branches: db.prepare('SELECT name FROM branches ORDER BY name').all().map(b => b.name),
    approvers: db.prepare('SELECT a.*, s.name, s.mobile, s.branch home FROM exp_approvers a LEFT JOIN supervisors s ON upper(s.code)=upper(a.code) ORDER BY a.role, s.name').all(),
    people: db.prepare('SELECT code, name, branch, mobile FROM supervisors WHERE active=1 ORDER BY name').all(),
    claims: db.prepare('SELECT * FROM exp_claims ORDER BY id DESC LIMIT 500').all(), mis: mis(), feedKey: !!process.env.EXP_FEED_KEY,
  }));
  app.post('/api/exp/admin/rules', authAdmin, (req, res) => { const cur = getRules(); const next = deepMerge(cur, req.body || {}); db.prepare("INSERT INTO settings(key,value) VALUES('EXP_RULES',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(JSON.stringify(next)); res.json({ ok: true, rules: next }); });
  app.post('/api/exp/admin/branch', authAdmin, (req, res) => { const b = req.body || {}; if (!b.branch) return bad(res, 'branch required'); db.prepare('INSERT INTO exp_branch(branch,short,fooding_rate,monthly_budget) VALUES(?,?,?,?) ON CONFLICT(branch) DO UPDATE SET short=excluded.short,fooding_rate=excluded.fooding_rate,monthly_budget=excluded.monthly_budget').run(String(b.branch).toUpperCase().trim(), String(b.short || '').toUpperCase().trim() || null, b.fooding_rate === '' || b.fooding_rate == null ? null : +b.fooding_rate, b.monthly_budget === '' || b.monthly_budget == null ? null : +b.monthly_budget); res.json({ ok: true }); });
  app.post('/api/exp/admin/approver', authAdmin, (req, res) => { const b = req.body || {}; const role = String(b.role || '').toUpperCase(); if (!b.code || !['VERIFY', 'APPROVE', 'PAY'].includes(role)) return bad(res, 'Pick a person and a role.'); if (!db.prepare('SELECT 1 FROM supervisors WHERE upper(code)=upper(?)').get(b.code)) return bad(res, 'Add this person in /admin → Supervisors first (that is their OTP login).'); db.prepare('INSERT INTO exp_approvers(code,role,branches,active) VALUES(?,?,?,1) ON CONFLICT(code,role) DO UPDATE SET branches=excluded.branches,active=1').run(String(b.code).toUpperCase(), role, String(b.branches || '*').toUpperCase().trim() || '*'); res.json({ ok: true }); });
  app.post('/api/exp/admin/approver/delete', authAdmin, (req, res) => { db.prepare('DELETE FROM exp_approvers WHERE upper(code)=upper(?) AND role=?').run(req.body.code, req.body.role); res.json({ ok: true }); });
  app.post('/api/exp/admin/pdf', authAdmin, async (req, res) => { try { await buildPdf(+req.body.id); res.json({ ok: true, claim: db.prepare('SELECT * FROM exp_claims WHERE id=?').get(+req.body.id) }); } catch (e) { bad(res, e.message); } });

  const csv = (rows, cols) => { const e = v => '"' + String(v == null ? '' : v).replace(/"/g, '""') + '"'; return [cols.join(','), ...rows.map(r => cols.map(c => e(r[c])).join(','))].join('\n'); };
  const LINE_COLS = ['id', 'exp_date', 'code', 'name', 'branch', 'type', 'amount', 'status', 'check_status', 'check_reason', 'claim_no', 'lr_cn', 'vehicle_no', 'party', 'from_place', 'to_place', 'mode', 'km', 'fair', 'live', 'category', 'slip_no', 'note', 'flag_codes', 'photo', 'created_ts'];
  const CLAIM_COLS = ['id', 'claim_no', 'code', 'name', 'branch', 'from_date', 'to_date', 'line_count', 'amount', 'approved_amount', 'red_flags', 'status', 'submitted_ts', 'verify_plan', 'verified_ts', 'verified_by', 'approve_plan', 'approved_ts', 'approved_by', 'pay_plan', 'paid_ts', 'paid_by', 'pay_mode', 'pay_ref', 'return_reason', 'pdf'];
  const lineRows = (from, to) => db.prepare("SELECT l.*, c.claim_no FROM exp_lines l LEFT JOIN exp_claims c ON c.id=l.claim_id WHERE l.status<>'DELETED' AND l.exp_date BETWEEN ? AND ? ORDER BY l.exp_date, l.id").all(from || '2000-01-01', to || '2999-12-31').map(r => ({ ...r, flag_codes: parseFlags(r.flags).map(f => f.k).join(' ') }));
  const claimRows = (from, to) => db.prepare('SELECT * FROM exp_claims WHERE submitted_iso BETWEEN ? AND ? ORDER BY id').all(from || '2000-01-01', to || '2999-12-31');
  app.get('/api/exp/admin/export/:t.csv', authAdmin, (req, res) => { const t = req.params.t; if (!['lines', 'claims'].includes(t)) return res.status(404).end(); res.setHeader('Content-Type', 'text/csv'); res.setHeader('Content-Disposition', 'attachment; filename=expense-' + t + '.csv'); res.send(t === 'lines' ? csv(lineRows(req.query.from, req.query.to), LINE_COLS) : csv(claimRows(req.query.from, req.query.to), CLAIM_COLS)); });
  // Read-only feed for Google Sheets / F.M.S robots / ERP: /api/exp/feed?key=EXP_FEED_KEY&from=2026-11-01&to=2026-11-30
  app.get('/api/exp/feed', (req, res) => { const k = process.env.EXP_FEED_KEY; if (!k || req.query.key !== k) return bad(res, 'Feed key missing or wrong.', 401); res.json({ ok: true, generated: nowStr(), claims: claimRows(req.query.from, req.query.to), lines: lineRows(req.query.from, req.query.to).map(r => { const o = { ...r }; delete o.flags; delete o.photo_hash; return o; }) }); });

  app.get('/expense', (req, res) => res.sendFile(path.join(__dirname, 'public', 'expense.html')));
  app.get('/expense-admin', (req, res) => res.sendFile(path.join(__dirname, 'public', 'expense-admin.html')));
  console.log('Expense module ready (/expense, /expense-admin)');
};
