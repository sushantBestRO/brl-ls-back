#!/bin/bash
set -e
cd /var/www/brl-ls/node-app
node - <<"EOF_FIX"
const fs=require('fs');
let p=fs.readFileSync('perfios.js','utf8');
if(!p.includes('otp_validated')){
  const a="  return okCode || okStatus ? { ok: true } : { ok: false, msg };";
  if(!p.includes(a)) throw new Error('perfios.js anchor missing');
  p=p.replace(a,()=>"  const okOtp = find(r.data, 'otp_validated') === true; // Perfios success: result.sim_details.otp_validated = true\n  return okOtp ? { ok: true } : { ok: false, msg: 'Wrong or expired OTP.' };");
  fs.writeFileSync('perfios.js',p); console.log('perfios.js fixed');
} else console.log('perfios.js already fixed');
let a=fs.readFileSync('public/app.js','utf8');
if(a.includes('otp.length !== 6')){
  a=a.replace('otp.length !== 6',()=>'otp.length < 4').replace('<label>6-digit OTP</label>',()=>'<label>OTP</label>').replace(/Valid 5 minutes\./,()=>'Valid for 100 seconds (Perfios) / 5 minutes.');
  fs.writeFileSync('public/app.js',a); console.log('app.js fixed');
} else console.log('app.js already fixed');
EOF_FIX
echo "OK - now run: pm2 restart brl-ls --update-env"
