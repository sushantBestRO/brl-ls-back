#!/bin/bash
set -e
cd /var/www/brl-ls/node-app
cp data/app.db data/app.db.bak-recode
cat > recode.js <<"EOF_S"
const { db } = require('./db');
const map = [ // mobile, name, new code (employee code)
  ['9594963420', 'RAHUL', '2882'], ['9594963409', 'ANKIT', '2450'], ['9594963374', 'RAVINDER', '2955'],
  ['9594963451', 'HITESH', '3053'], ['9594964628', 'SUMIT', '3175'], ['9594963314', 'GOVINDA SINGH', '2659'],
  ['9594963398', 'AMAN KUMAR', '2999'], ['9594963395', 'SOURAV SINGH', '2699'], ['9405038430', 'PIYUSH THAKUR', '3228'],
];
const run = db.transaction(() => {
  for (const [mobile, name, nc] of map) {
    const s = db.prepare('SELECT code,name FROM supervisors WHERE mobile LIKE ?').get('%' + mobile);
    if (!s) { console.log('NOT FOUND  ' + name + ' ' + mobile); continue; }
    if (s.code === nc) { console.log('already    ' + name + ' = ' + nc); continue; }
    if (db.prepare('SELECT 1 FROM supervisors WHERE code=?').get(nc)) { console.log('SKIPPED    ' + name + ': code ' + nc + ' already used by another supervisor'); continue; }
    db.prepare('UPDATE supervisors SET code=? WHERE code=?').run(nc, s.code);
    const a = db.prepare('UPDATE attendance SET code=? WHERE code=?').run(nc, s.code).changes;
    const l = db.prepare('UPDATE lrs SET code=? WHERE code=?').run(nc, s.code).changes;
    console.log('updated    ' + name + ': ' + s.code + ' -> ' + nc + '  (attendance ' + a + ', LRs ' + l + ')');
  }
});
run();
EOF_S
node recode.js && rm recode.js
