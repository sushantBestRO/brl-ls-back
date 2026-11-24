// OTP delivery. SMS_PROVIDER = msg91 | webhook | console
//   msg91  : MSG91 Flow API (DLT-approved OTP template with a variable named OTP)
//   webhook: any HTTP SMS gateway – SMS_URL with {mobile} and {otp} placeholders, GET (or POST if SMS_METHOD=POST)
//   console: no SMS; OTP is printed in the server log and shown on /admin → System (for testing)
const axios = require('axios'); const E = process.env;
async function sendOtp(mobile, otp) {
  const p = (E.SMS_PROVIDER || 'console').toLowerCase(); const text = (E.SMS_TEXT || 'Your Best Roadways LS App OTP is {otp}. Valid for 5 minutes.').replace('{otp}', otp);
  if (p === 'msg91') {
    const r = await axios.post('https://control.msg91.com/api/v5/flow', { template_id: E.MSG91_TEMPLATE_ID, short_url: '0', recipients: [{ mobiles: '91' + mobile, OTP: otp, otp: otp }] }, { headers: { authkey: E.MSG91_AUTHKEY, 'Content-Type': 'application/json' }, timeout: 10000 });
    if (r.data && r.data.type === 'error') throw new Error('MSG91: ' + (r.data.message || 'send failed')); return 'sms';
  }
  if (p === 'webhook') {
    const url = String(E.SMS_URL || '').replace('{mobile}', encodeURIComponent(mobile)).replace('{otp}', encodeURIComponent(otp)).replace('{text}', encodeURIComponent(text));
    if (!url) throw new Error('SMS_URL not set'); const r = (E.SMS_METHOD || 'GET').toUpperCase() === 'POST' ? await axios.post(url, {}, { timeout: 10000 }) : await axios.get(url, { timeout: 10000 });
    if (r.status >= 300) throw new Error('SMS gateway HTTP ' + r.status); return 'sms';
  }
  console.log('[OTP console mode] ' + mobile + ' → ' + otp); return 'console';
}
module.exports = { sendOtp };
