require('dotenv').config();
const E = process.env, p = E.EWB_PASSWORD || '';
console.log('email   :', E.EWB_EMAIL);
console.log('username:', E.EWB_USERNAME);
console.log('password: length', p.length, '| first/last:', p[0] + '...' + p.slice(-1));
console.log('gstin   :', E.EWB_GSTIN, '| ip:', E.EWB_IP);
console.log('client_id set:', !!E.EWB_CLIENT_ID, '| client_secret set:', !!E.EWB_CLIENT_SECRET);
