#!/bin/bash
set -e
cd /var/www/brl-ls/node-app
cp ewb.js ewb.js.bak7
node - <<"EOF_P"
const fs = require('fs'); let s = fs.readFileSync('ewb.js', 'utf8');
if (s.includes('user_name:')) { console.log('already patched'); process.exit(0); }
const a = "gstin: E.EWB_GSTIN, ip_address: E.EWB_IP }";
if (!s.includes(a)) throw new Error('anchor missing');
s = s.replace(a, () => "gstin: E.EWB_GSTIN, ip_address: E.EWB_IP, user_name: E.EWB_USERNAME }");
fs.writeFileSync('ewb.js', s); console.log('ewb.js patched (user_name header added)');
EOF_P
node --check ewb.js && echo "OK - now run: pm2 restart brl-ls --update-env"
