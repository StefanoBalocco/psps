# Poor man's Spreadsheet Password Sharing (PSPS)

Password sharing manager. Store passwords in a Google Sheet, share specific
entries with specific recipients via email-based one-shot PIN auth. No sessions,
no cookies, no database.

## Flow

1. User enters their email address and clicks the arrow button.
2. If the email is authorized (found in the admin sheet or in column 5 of
   accounts), the backend sends a 6-digit PIN via email.
3. The frontend shows a PIN input with underscore placeholders and a 60-second
   resend timer.
4. User enters the PIN. The backend validates it (one-time use, 5-minute TTL,
   3 attempt limit).
5. On success, the backend returns the accounts visible to that email. No
   session token is created — each verify call returns accounts inline.
6. The frontend renders the accounts list with show/copy password controls.
7. After 3 wrong PIN attempts, the PIN is invalidated and the frontend returns
   to the email entry step.

The response is always the same for the email-only step — "If your email is
authorized, you have received a code." — regardless of whether the email is
authorized, rate-limited, or within resend cooldown. This prevents email
enumeration.

## Architecture

- **Backend** TypeScript on Hono + Nodemailer (without framework).
- **Frontend** Static files (HTML, CSS, JS) served by nginx.
- **Spreadsheet** Google Sheets as the sole data store, accessed via public
  CSV/gviz export. The spreadsheet ID and data stay backend-only.

```
nginx serves www/  ──>  browser
nginx proxies /api/ ──>  node backend (127.0.0.1:3000)
```

## API

### `POST /api/login`

Accepts either `{ "email": "..." }` or `{ "email": "...", "pin": "..." }`.

**Email only:** Returns `{ "message": "If your email is authorized, you have received a code." }`.
If authorized, a 6-digit PIN is sent via email. The PIN expires after 5 minutes.
A resend within 60 seconds returns the same response without sending a new email
or replacing the existing PIN. After the cooldown, the same PIN is resent and the
expiration is not extended.

**Email + PIN:** Returns `{ "accounts": [...] }` on success (status 200), or `401`
with `{ "error": "Invalid or expired PIN." }` on failure. Each PIN is one-time-use
and consumed immediately on successful verify. After 3 wrong attempts the PIN is
deleted and the response includes `"reset": true` to signal the frontend to return
to email entry.

## Google Sheet Schema

One Google spreadsheet with two sheets (names configurable):

### `accounts` (default)

| Service name | username | password | link               | shared emails                              |
|--------------|----------|----------|--------------------|--------------------------------------------|
| Example      | user1    | pass1    | https://example.it | alice@example.com; bob@example.com         |

Row 1 is the header. Data starts at row 2.
Service name is ideally unique; row number is the identity.
Column E (shared emails) contains recipient emails separated by spaces, commas,
or semicolons. Duplicates are ignored.

### `admins` (default)

| email                |
|----------------------|
| admin@example.com    |

Users in this sheet see all account rows. Admin emails are merged into every
service's shared list at read time — the frontend never receives or renders an
admin role.

## Configuration

Create `config.json` in the project root directory, or run the daemon and it
creates one for you. Use `--config /path/config.json` for a custom path.

```bash
node backend/dist/index.js
# Creates config.json in CWD and exits. Edit it, then run again.

node backend/dist/index.js --config /etc/psps/config.json
```

### Public spreadsheet access

The spreadsheet must be shared so the backend can read it via the public
CSV/gviz export. Set the spreadsheet visibility to "Anyone with the link can
view" in Google Sheets sharing settings.

The `spreadsheetId` is a backend-only secret and must not be exposed to the
frontend or committed to version control.

### SMTP configuration

PSPS sends login PINs via SMTP (Nodemailer).

```json
{
	"smtp": {
		"host": "smtp.example.com",
		"port": 587,
		"secure": false,
		"user": "smtp-user",
		"pass": "smtp-password",
		"fromAddress": "noreply@example.com",
		"fromName": "PSPS"
	}
}
```

### All configuration keys

| Key                 | Type     | Default             | Description                          |
|---------------------|----------|---------------------|--------------------------------------|
| `log`               | string   | ""                  | Optional log file path (empty or absent = stdout). When non-empty, the backend appends log output to this file, creating it if necessary. The path is relative to the process working directory. Send `SIGHUP` to reopen the file, enabling external log rotation without restarting the daemon. |
| `host`              | string   | 127.0.0.1           | Backend listen address               |
| `port`              | number   | 3000                | Backend listen port                  |
| `corsOrigins`       | string[] | ["*"]               | Allowed CORS origins                 |
| `trustedProxies`    | string[] | []                  | Trusted reverse proxy IPs            |
| `spreadsheetId`     | string   | (required)          | Google Sheets spreadsheet ID (the segment after `/d/` in a Google Sheets URL) |
| `sheets.accounts`   | string   | accounts            | Accounts sheet name                  |
| `sheets.admins`     | string   | admins              | Admin sheet name                     |
| `smtp.host`         | string   | localhost           | SMTP server host                     |
| `smtp.port`         | number   | 587                 | SMTP server port                     |
| `smtp.secure`       | boolean  | false               | Use TLS (true for port 465)          |
| `smtp.user`         | string   | (optional)          | SMTP auth user                       |
| `smtp.pass`         | string   | (optional)          | SMTP auth password                   |
| `smtp.fromAddress`  | string   | noreply@psps.invalid| Sender email                         |
| `smtp.fromName`     | string   | psps                | Sender display name                  |

The `spreadsheetId` field is required and must be non-empty.

### Static behaviour (not configurable)

- PIN lifetime: 5 minutes.
- PIN resend cooldown: 1 minute.
- Max PIN attempts: 3.
- Cache lifetime: 5 minutes (same as PIN lifetime).
- PIN is stored as a number internally, displayed as 6 digits with leading zeros.

## Commands

```bash
# Install dependencies
pnpm install

# Build all
pnpm build

# Build individual targets
pnpm build:backend
pnpm build:frontend
pnpm build:tests

# Run tests
pnpm tests

# Start the backend daemon
pnpm start
# or: node backend/dist/index.js --config config.json
```

## Deploy

```nginx
# nginx.conf.example
server {
	listen 80;
	server_name psps.example.com;

	root /var/www/psps/www;
	index index.html;

	location / {
		try_files $uri $uri/ /index.html;
	}

	location /api/ {
		proxy_pass http://127.0.0.1:3000;
		proxy_set_header Host $host;
		proxy_set_header X-Real-IP $remote_addr;
		proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
		proxy_set_header X-Forwarded-Proto $scheme;
	}
}
```

## Limitations

- **Public CSV access required:** The backend reads sheets through Google
  Sheets' public CSV/gviz export. The spreadsheet must be shared with "Anyone
  with the link can view" permissions.
- **No admin UI:** Admin emails are an internal backend rule. No sharing editing
  UI in this iteration. Edit the sheet directly in Google Sheets.
- **PINs are in-memory:** They expire on process restart.
- **Passwords** are stored in plaintext in the Google Sheet (by design —
  the approved schema intentionally uses plaintext; consider sheet access
  controls and HTTPS for transport security).

## Privacy

The spreadsheet ID and all sheet data stay on the backend. No spreadsheet
information is exposed to the frontend or in API responses.

Log output never contains a full valid email address — valid emails are masked
as `f***@***.tld`. Malformed email input is logged verbatim (raw string) to
aid debugging. PINs, numeric codes, email content, and SMTP credentials are
never written to the log. Error details are limited to a safe error
classification (error code or type).
