# RideNow — Hyderabad mobility simulation

RideNow is a **simulation**, not a real ride, delivery or payment service. It includes simulated phone, Google, Apple and guest entry; profile editing; Hyderabad place search and a map; ride and parcel quotes and bookings; simulated tracking and safety actions; reservations, history, receipts, feedback, saved places, appearance settings and mock wallet credits.

Map tiles use external providers; routes and vehicle movement are simulated straight lines, not live navigation or driver locations. No driver or courier is dispatched, no call or message is sent, and SOS does not contact emergency services. Delivered parcels show an illustration as simulated proof, not a verified delivery photograph. Payment choices are simulated: no real payment is processed or money charged. Optional card and custom UPI fields accept only the displayed dummy test values; do not enter real credentials. Test details stay on the page and are not sent or saved. Wallet funds are mock credits. Reservations do not dispatch drivers, and hourly reservations use the route estimate rather than an hourly tariff.

No SMS is sent, any four or six digits are accepted, and no Google or Apple service is contacted. **These entry methods do not verify identity and must not protect real personal data or be used as production authentication.** Each entry creates a new isolated demo profile, even when the same phone or provider is used again. Retain the existing session to return to that profile; sign-out revokes it and there is no account recovery.

Bearer tokens are random and only their SHA-256 hashes are stored in MongoDB. They expire after 30 days and are persisted in browser localStorage as requested, which is vulnerable to browser script access/XSS; use HTTPS, proper authentication, an HttpOnly cookie strategy and production security controls for any real deployment. Challenges expire after five minutes and are single-use. Profile photos are stored as small data URLs. Avoid real personal information in this demo.

## Run locally

Requirements: Python 3.12, Node 20+, and a running MongoDB instance. Copy `backend/.env.example` to `backend/.env` and `frontend/.env.example` to `frontend/.env.local`; edit for your environment. The sample Mongo URI is for a local unauthenticated server only. Configure an authenticated TLS MongoDB deployment for hosted environments, restrict network access, and never commit real credentials.

```sh
cd backend
python3 -m venv .venv
. .venv/bin/activate
pip install -r requirements.txt
uvicorn app.main:app --reload
```

In another terminal:

```sh
cd frontend
npm install
npm run dev
```

Open http://localhost:3000. Next proxies `/api/*` to `BACKEND_URL` server-side; Next resolves this rewrite at build time, so set `BACKEND_URL` before building and rebuild when changing it (Docker build accepts `--build-arg BACKEND_URL=...`). The backend listens on port 8000 by default. `CORS_ORIGINS` is a comma-separated list for direct browser access. `MONGODB_URI` selects the Mongo server, `MONGODB_DB` the application database. Health: `GET /api/health`; API docs: `/docs` on the backend. Alternatively `docker compose up --build` starts Mongo, API and frontend; the compose database is intended only for local development. Configure Mongo authentication, TLS and persistent backups before exposing it.

## Tests

Backend API and integration tests use uniquely named temporary databases on `TEST_MONGODB_URI` (default `mongodb://127.0.0.1:27017`) and drop their own databases afterward. Use an isolated MongoDB server that permits database creation and deletion. From the project root, with backend requirements and frontend dependencies installed:

```sh
cd backend
PYTHONPATH=. python -m pytest -q tests
cd ../frontend
npm test
node node_modules/typescript/bin/tsc --noEmit --incremental false
```

The backend command includes identity, location, booking, tracking, activity and cross-feature integration tests. `npm test` runs frontend component tests; the last command type-checks the frontend.

### Browser E2E (real services)

Start a real MongoDB first, and install backend requirements into a Python environment whose `python` is on PATH. Install frontend dependencies and Chromium (`cd frontend && npm install && node node_modules/@playwright/test/cli.js install chromium`). With that Python environment active, run `node node_modules/@playwright/test/cli.js test` from `frontend`. Playwright starts FastAPI at `127.0.0.1:18000`, waits for `/api/health` (the app startup pings Mongo), then starts Next at `127.0.0.1:13000` and waits for it. Those ports must be free. Next proxies to the started backend. The default Mongo URI is `mongodb://127.0.0.1:27017`; set `E2E_MONGODB_URI` and `E2E_MONGODB_DB` if needed. The default database `ridenow_e2e` is persistent and is **not** automatically deleted: use an isolated disposable database, not production data. Tests create demo profiles and bookings. Each entry creates its own profile.

Alternatively, set `E2E_BASE_URL` to a separately running frontend; this disables both Playwright-managed servers. In that mode start and wait for Mongo, FastAPI and Next yourself, set `BACKEND_URL` before starting/building Next, and point the backend at a dedicated database. Do not mix a custom base URL with an assumption that Playwright starts a backend. Screenshots and failure traces are stored in Playwright's test-results directory. Map tiles require external network access; no application APIs are stubbed. The delayed-response loading case forwards the real request and holds its real response temporarily.

## API contract

`POST /api/v1/identity/phone/start` accepts `{"phone":"+919876543210"}` and returns a single-use challenge. `POST /phone/verify` takes `challenge` and `otp`. `POST /enter` accepts `method` = `google`, `apple`, or `guest`. Entry returns `token` and `profile`. `GET` and `PUT /profile`, and `POST /logout`, require `Authorization: Bearer <token>`. Updates only affect the token's own profile; invalid input returns 422 and absent, expired or revoked sessions return 401. Tokens must be treated as credentials.
