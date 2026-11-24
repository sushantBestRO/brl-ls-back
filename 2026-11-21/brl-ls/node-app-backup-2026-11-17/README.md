# BRL Loading Supervisor App

Node.js + HTML web app for Best Roadways loading supervisors:

0. **Two divisions, one app** — **JNPTC** (Container Division) and **JNPT-E** (Booking Division). Each supervisor belongs to one division (set by HR in `/admin`); attendance and LRs are tagged with it, and each division has its own LR number series (`JNPTC/01001…`, `JNPTE/01001…`). More divisions can be added in `/admin → System`.
1. **Login by mobile + OTP** — supervisor enters the registered mobile, gets a 6-digit OTP by SMS, stays signed in on that phone for 30 days. No passwords to forget.
2. **Field attendance** — check-in / check-out requires GPS **and a selfie**; the selfie is stamped on the photo itself with name, code, division, branch, date-time (IST), latitude/longitude ± accuracy and the reverse-geocoded address, so the record cannot be altered later. Optional geo-fence per branch flags OFF-SITE punches.
3. **E-way bill → LR** — supervisor enters the 12-digit e-way bill number, the app fetches it from Whitebooks, pre-fills consignor / consignee / places / invoice / vehicle / items, supervisor adds the rest (weights, container, seal, driver phone, etc.) and the app generates **Consignee copy** and **Driver copy** PDFs on the real BRL LR template, with a one-tap WhatsApp share to the driver.
4. **Admin page** (`/admin`) — LR register, attendance log, supervisors, branches, CSV export, API connection test.

No build step, no external database. Stack: Express · SQLite (better-sqlite3) · pdf-lib · vanilla JS.

## Run it (5 minutes)

```bash
npm install
cp .env.example .env        # edit: SESSION_SECRET, ADMIN_PIN, BASE_URL, EWB_* when going to production
npm run seed                # branches DRONAGIRI/KALAMBOLI + test supervisors LS001 (9594963332, JNPTC), LS002 (9999999999, JNPT-E)
npm start                   # http://localhost:3000   admin: http://localhost:3000/admin
```

Docker: `docker build -t brl-ls . && docker run -d -p 3000:3000 --env-file .env -v $PWD/data:/app/data -v $PWD/storage:/app/storage brl-ls`

Put it behind HTTPS (Caddy / nginx + Let's Encrypt). **HTTPS is required** for phone GPS and camera to work in the browser.

## OTP / SMS setup

`.env` → `SMS_PROVIDER`:
- `console` (default for testing) — no SMS is sent; the OTP is printed in the server log and shown on the login screen and on `/admin → System`. **Switch this off before going live.**
- `msg91` — MSG91 Flow API. Set `MSG91_AUTHKEY` and `MSG91_TEMPLATE_ID` (a DLT-approved OTP template containing `##OTP##`). ~₹0.15–0.20 per OTP.
- `webhook` — any other HTTP SMS gateway: put its send URL in `SMS_URL` with `{mobile}`, `{otp}` or `{text}` placeholders.

Test from `/admin → System → Send test OTP SMS`. `ALLOW_PIN_LOGIN=true` enables an emergency code + PIN login if the SMS gateway is down.

## Going live with Whitebooks

The `.env.example` has the **sandbox** credentials. For production:
- `EWB_BASE_URL` → the production base Whitebooks gives you
- `EWB_GSTIN` → BRL's real GSTIN (`88AAACB4214A1ZJ` is a sandbox placeholder)
- `EWB_IP` → this server's **static public IP**, and register the same IP with Whitebooks (they whitelist by IP). This is why the app should run on a VPS / cloud VM with a fixed IP, not on a laptop.
- Test from `/admin → System → Test e-way bill API connection`.

If Whitebooks' "get e-way bill" path differs from `/ewayapi/getewaybill`, change `EWB_GET_PATH` in `.env`. The response parser tolerates both `{data:{…}}` wrappers and raw NIC JSON (`ewbNo`, `fromTrdName`, `toTrdName`, `itemList`, `VehiclListDetails`, …).

## Layout of the LR PDF

`templates/BRL_Blank_LR.pdf` is the 10-page blank LR. Pages 3–4 (consignee copy + T&C) and 5–6 (driver copy + T&C) are used. Field positions are in `lrpdf.js` → `FIELDS` as `[key, x, yFromTop, fontSize, maxWidth, options]` in PDF points (page is 679.5 × 1224 pt). If the printed LR design changes, replace the template and adjust those numbers; nothing else changes.

Fields that come from the e-way bill are shown pink in the form; everything else is typed by the supervisor. CN number is auto (`CN_PREFIX` + serial) unless the supervisor types a pre-printed one.

## Files & data

- `data/app.db` — SQLite database (attendance, LRs, supervisors, branches, e-way bill cache). Back up by copying the file.
- `storage/lr/` — generated PDFs, served at `/files/lr/…` (links are public-by-URL; they are what gets WhatsApp'd to drivers).
- `storage/photos/` — attendance selfies if `REQUIRE_SELFIE=true`.

## Managing supervisors

`/admin` → Supervisors → add code (use the HR employee code), name, **mobile (this is the login)**, **division (JNPTC / JNPT-E)**, branch. Mobile must be unique. Set Active = No to disable — the person can no longer get an OTP. A phone stays signed in for `SESSION_DAYS` (30) after OTP.

## API (for integration with FMS / Sheets later)

All JSON. Supervisor calls need headers `x-code` and `x-token` from `/api/login`.
`POST /api/login` · `GET /api/me` · `POST /api/attendance` · `POST /api/ewb {ewbNo}` · `POST /api/lr {lr:{…}}` · admin: `GET /api/admin/data`, `GET /api/admin/export/{lrs|attendance|supervisors}.csv`.
