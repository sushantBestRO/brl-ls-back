// Seeds branches and one test supervisor per division. Safe to re-run.
require('dotenv').config(); const { db } = require('../db');
db.prepare('INSERT OR IGNORE INTO branches(name,address,phone,email,lat,lng,billing_default) VALUES(?,?,?,?,?,?,?)').run('DRONAGIRI', 'Best House, Plot No.30A & 30B, Sector 2, Opp. Apm Terminals, Dronagiri, Uran Navi Mumbai - 400707', '022-50077523/525 | +919594963404', 'vinod.saharan@bestroadways.com', 18.8536, 72.9469, 'DRONAGIRI');
db.prepare('INSERT OR IGNORE INTO branches(name,billing_default) VALUES(?,?)').run('KALAMBOLI', 'KALAMBOLI');
db.prepare('INSERT OR IGNORE INTO supervisors(code,name,mobile,pin,branch,division,role,active) VALUES(?,?,?,?,?,?,?,1)').run('LS001', 'Test Supervisor (Container)', '9594963332', '1234', 'DRONAGIRI', 'JNPTC', 'Admin');
db.prepare('INSERT OR IGNORE INTO supervisors(code,name,mobile,pin,branch,division,role,active) VALUES(?,?,?,?,?,?,?,1)').run('LS002', 'Test Supervisor (Booking)', '9999999999', '1234', 'DRONAGIRI', 'JNPT-E', 'Supervisor');
console.log('Seeded: divisions JNPTC / JNPT-E, branches DRONAGIRI, KALAMBOLI, supervisors LS001 (9594963332, JNPTC) and LS002 (9999999999, JNPT-E). Edit via /admin.');
