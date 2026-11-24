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
  const okOtp = find(r.data, 'otp_validated') === true; // Perfios success: result.sim_details.otp_validated = true
  return okOtp ? { ok: true } : { ok: false, msg: 'Wrong or expired OTP.' };
}
module.exports = { getOtp, validateOtp };
