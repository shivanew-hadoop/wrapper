# Topper commercial rollout — three phases

This build keeps speech, retrieval and LLM streaming unchanged. Authentication, payments and metering run on separate HTTP endpoints; a five-second credit heartbeat never sits in the answer request path. The initial design deliberately uses one backend instance and SQLite WAL on a persistent disk, which is the lowest-cost reliable shape for 50–100 concurrent listening sessions. Do not run multiple backend replicas with this database. Migrate the same tables to managed PostgreSQL before horizontal scaling.

## Phase 1 — local and payment test-mode acceptance

1. Install Node.js 22 LTS and run `npm install` inside `backend`.
2. Copy `backend/.env.example` to `backend/.env`. Generate `JWT_SECRET` with at least 32 random characters. Set a strong, unique `ADMIN_PASSWORD`.
3. Create/activate a PhonePe Business Payment Gateway sandbox account. Put `PHONEPE_CLIENT_ID`, `PHONEPE_CLIENT_SECRET`, and `PHONEPE_CLIENT_VERSION` in `.env`, set `PHONEPE_ENV=sandbox`, and configure dedicated `PHONEPE_WEBHOOK_USERNAME` / `PHONEPE_WEBHOOK_PASSWORD` values in both PhonePe and the backend.
4. Start the backend with `npm start`. Open `http://localhost:8080/portal/`.
5. Register a user, log in, and confirm that the account starts with zero credits.
6. Log in with `ADMIN_EMAIL`, add 5 test minutes, then log back in as the user. Confirm the ledger and remaining credits.
7. Use PhonePe sandbox Standard Checkout to buy the ₹599 plan. The backend must confirm `COMPLETED` with PhonePe's Order Status API before granting credits; the authenticated webhook provides idempotent server-to-server recovery. Confirm exactly 3,600 seconds are credited once, even if the callback is replayed.
8. In the desktop `app-config.json`, keep `http://localhost:8080`. Validate the paid email, prepare Resume/JD, open the overlay and select Start Listening.
9. Confirm the countdown changes every second, the database deducts actual elapsed seconds on five-second heartbeats, Stop settles the final partial interval, and 30/10/5/1-minute warnings appear once.
10. For a short test, set the account to one minute through Admin. Confirm audio and STT hard-stop at zero and subsequent LLM/license requests are rejected.
11. Run two browser accounts and two desktop instances on test machines. Confirm credits and history never cross accounts.

Acceptance gate: registration/login, admin adjustment, payment, webhook replay, Start/Stop settlement, crash recovery, warnings and zero-credit hard stop must all pass before Phase 2.

## Phase 2 — secure online pilot for up to 100 concurrent users

1. Provision one small Linux VM/container host close to the majority of users. Start with 2–4 vCPU and 4–8 GB RAM. Attach a persistent SSD volume mounted at `/data`.
2. Point `api.yourdomain.com` to the server. Put a managed HTTPS reverse proxy/load balancer in front. Redirect HTTP to HTTPS and allow WebSocket upgrades for `/stt`.
3. Build from `backend/Dockerfile`. Mount the persistent volume at `/data`; inject `.env` values through the host secret manager, never into the image.
4. Set `NODE_ENV=production`, `LEGACY_LICENSE_FALLBACK=false`, a permanent `JWT_SECRET`, live OpenAI/Deepgram keys, PhonePe sandbox credentials initially, and the real admin email. Restrict inbound backend traffic to ports 443/80; do not expose the database volume.
5. Configure PhonePe's server-to-server callback URL as `https://api.yourdomain.com/api/payments/webhook` and configure the same callback username/password as `PHONEPE_WEBHOOK_USERNAME` / `PHONEPE_WEBHOOK_PASSWORD`. Keep the endpoint public over HTTPS. The backend verifies the callback SHA-256 authorization and then independently checks the PhonePe order status before crediting.
6. Set monitoring for `/health`, process restarts, disk usage, webhook non-2xx responses, active session count and provider errors. Send application logs to a retained log service, excluding secrets and full resumes.
7. Back up `/data/topper-commerce.db` and its WAL consistently every day; test restoration to a separate staging server. Keep at least seven daily versions.
8. Change desktop `app-config.json` to `https://api.yourdomain.com`, build the signed Windows portable/installer, and distribute it from the portal. The portal Launch button uses `topper://launch`; Windows registration occurs when the packaged app starts.
9. Load-test staging with 100 WebSocket STT connections, 100 five-second heartbeats, and representative concurrent LLM streams. Measure p50/p95 first-token latency separately from control-plane requests. The payment/heartbeat endpoints must not change LLM p95.
10. Pilot with 5 users, then 20, 50 and 100. At each gate verify CPU, memory, upstream rate limits, Deepgram concurrency, OpenAI limits, disk latency, first-token p95, billing accuracy and forced-stop behavior.
11. Complete PhonePe Business PG KYC/activation, publish Terms, Privacy, Refund/Cancellation and support/contact pages, confirm tax/GST obligations with an Indian accountant, then set live PhonePe credentials and `PHONEPE_ENV=production`. Run one real ₹599 purchase plus reconciliation/refund testing before public launch.

Acceptance gate: HTTPS/WebSocket stability, backup restore, 100-user load test, provider quota, live payment reconciliation and legal pages are complete.

## Phase 3 — commercial hardening and scale beyond one instance

1. Move users, orders, ledger, webhook events and usage sessions from SQLite to managed PostgreSQL. Keep integer seconds and the append-only ledger; never derive paid balance only from browser timers.
2. Use row-level transactions (`SELECT ... FOR UPDATE`) for settlement and credit grants. Add a unique payment ID/event ID so retries can never double-credit.
3. Put session/cache state in Redis only if multiple backend replicas are introduced. Use sticky WebSockets or a shared STT session coordinator.
4. Add verified-email/password-reset delivery, refresh-token rotation, login throttling, CAPTCHA after repeated failures, admin MFA, audit exports and role-scoped admin permissions.
5. Add a scheduled reconciler that compares PhonePe `COMPLETED` orders with paid local orders and alerts on mismatches. Add dispute/refund handling that writes compensating ledger entries instead of deleting history.
6. Autoscale stateless backend replicas only after PostgreSQL/Redis migration. Keep LLM streaming direct from each replica and benchmark p95 after every scaling change.
7. Add SLOs: availability, first-token p95, STT reconnect rate, payment-credit delay, heartbeat error rate and billing drift. Alert before user-visible failure.

## Production invariants

- The server is the source of truth for credits; UI countdown is display-only.
- Credits are stored and settled as integer seconds, so reconnects and partial minutes remain fair.
- Payment credits are idempotent and require a valid checkout or webhook signature.
- A listening session starts only after the server reserves/validates a positive balance.
- LLM/RAG/STT endpoints are unchanged; credit heartbeats are asynchronous and isolated from answer latency.
- SQLite deployment is single-instance only. A second replica without PostgreSQL is unsupported.


## PhonePe environment variables

Use these values only on the backend. Never expose the client secret or callback password in portal/Electron code.

```env
PHONEPE_ENV=sandbox
PHONEPE_CLIENT_ID=...
PHONEPE_CLIENT_SECRET=...
PHONEPE_CLIENT_VERSION=1
PHONEPE_WEBHOOK_USERNAME=...
PHONEPE_WEBHOOK_PASSWORD=...
PUBLIC_BASE_URL=https://your-public-topper-domain.example
PLAN_PRICE_PAISE=59900
PLAN_CREDITS_MINUTES=60
```

For live payments, use the production credentials issued by PhonePe and set `PHONEPE_ENV=production`. `PUBLIC_BASE_URL` should be the HTTPS origin serving the Topper portal so PhonePe can return the customer to the correct site.
