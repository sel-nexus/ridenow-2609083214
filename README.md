# RideNow — identity slice

RideNow is a Hyderabad mobility **simulation**. This slice implements simulated phone, Google, Apple and guest entry and profile editing; ride, map and payment functionality is not included yet. No SMS is sent, any four or six digits are accepted, and no Google or Apple service is contacted. **These entry methods do not verify identity and must not protect real personal data or be used as production authentication.** Each entry creates a new isolated demo profile, even when the same phone or provider is used again. Retain the existing session to return to that profile; sign-out revokes it and there is no account recovery.

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

The backend suite creates a random `ridenow_test_*` database on `TEST_MONGODB_URI` (default `mongodb://127.0.0.1:27017`) and drops only that database afterward. The server must permit database creation and deletion.

```sh
cd backend
PYTHONPATH=. python -m pytest -q tests/test_identity.py
cd ../frontend
npm test
```

The Playwright spec uses running frontend, backend and Mongo services; `E2E_BASE_URL` defaults to `http://127.0.0.1:3000`. Install Chromium with `node node_modules/@playwright/test/cli.js install chromium`, then run `node node_modules/@playwright/test/cli.js test` from `frontend`. The suite creates demo profiles; run it against a dedicated test database. The identity slice does not run E2E automatically.

## API contract

`POST /api/v1/identity/phone/start` accepts `{"phone":"+919876543210"}` and returns a single-use challenge. `POST /phone/verify` takes `challenge` and `otp`. `POST /enter` accepts `method` = `google`, `apple`, or `guest`. Entry returns `token` and `profile`. `GET` and `PUT /profile`, and `POST /logout`, require `Authorization: Bearer <token>`. Updates only affect the token's own profile; invalid input returns 422 and absent, expired or revoked sessions return 401. Tokens must be treated as credentials.
