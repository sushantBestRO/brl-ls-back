#!/bin/bash
set -e
cd /var/www/brl-ls/node-app
cat > add-supervisors.js <<"EOF_S"
const { db } = require('./db');
const rows = [
  // code, name, mobile, division, branch
  ['LS0007', 'HITESH',        '9594963451', 'JNPTC',  'DRONAGIRI'],
  ['LS0008', 'SUMIT',         '9594964628', 'JNPTC',  'DRONAGIRI'],
  ['LS0009', 'GOVINDA SINGH', '9594963314', 'JNPT-E', 'BHIWANDI'],
  ['LS0010', 'AMAN KUMAR',    '9594963398', 'JNPT-E', 'BHIWANDI'],
  ['LS0011', 'SOURAV SINGH',  '9594963395', 'JNPT-E', 'BHIWANDI'],
  ['LS0012', 'PIYUSH THAKUR', '9405038430', 'JNPT-E', 'BHIWANDI'],
];
db.prepare('INSERT OR IGNORE INTO branches(name,billing_default) VALUES(?,?)').run('BHIWANDI', 'BHIWANDI');
const up = db.prepare("INSERT INTO supervisors(code,name,mobile,pin,branch,division,role,active) VALUES(?,?,?,?,?,?,'Supervisor',1) ON CONFLICT(code) DO UPDATE SET name=excluded.name,mobile=excluded.mobile,branch=excluded.branch,division=excluded.division,active=1");
for (const [code, name, mobile, division, branch] of rows) {
  const clash = db.prepare('SELECT code,name FROM supervisors WHERE mobile LIKE ? AND code<>?').get('%' + mobile, code);
  if (clash) { console.log('SKIPPED ' + code + ' ' + name + ' - mobile already used by ' + clash.code + ' ' + clash.name); continue; }
  up.run(code, name, mobile, '', branch, division, ); console.log('saved   ' + code + ' ' + name + ' ' + mobile + ' ' + division + ' ' + branch);
}
EOF_S
node add-supervisors.js && rm add-supervisors.js
