#!/bin/bash
set -e
cd /var/www/brl-ls/node-app
cp ewb.js ewb.js.bak6
node - <<"EOF_P"
const fs = require('fs'); let s = fs.readFileSync('ewb.js', 'utf8');
if (s.includes('__session__')) { console.log('ewb.js already patched'); process.exit(0); }
const must = (a, b, l) => { if (!s.includes(a)) throw new Error('anchor missing: ' + l); s = s.replace(a, () => b); };
must("if (t) { h['auth-token'] = t; h['authtoken'] = t; }", "if (t && t !== '__session__') { h['auth-token'] = t; h['authtoken'] = t; }", 'headers');
must("const t = findKey(r.data, /auth.?token|^token$/i);", "let t = findKey(r.data, /auth.?token|^token$/i);\n  if (!t && r.data && typeof r.data === 'object' && String(r.data.status_cd) === '1') t = '__session__'; // Whitebooks: login ok, no token returned", 'auth');
fs.writeFileSync('ewb.js', s); console.log('ewb.js patched');
EOF_P
node --check ewb.js && echo "OK - now run: pm2 restart brl-ls --update-env"
