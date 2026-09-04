# Topper v14.4.3 — PhonePe Business Payment Gateway

This update starts from the first **Response-Tuned** build and changes only the commerce payment-provider path.

## Changed
- Replaced Razorpay checkout/order/signature code with PhonePe Business Payment Gateway Standard Checkout v2.
- Added PhonePe OAuth client-credential authentication for sandbox and production.
- Added server-side PhonePe order-status verification before credits are granted.
- Added SHA-256 authenticated PhonePe server-to-server callback handling with replay/idempotency protection.
- Kept the existing ₹599 / 60-minute plan, SQLite order table, credit ledger, account history and portal layout.
- Updated payment/privacy/refund/contact copy from Razorpay to PhonePe.
- PhonePe checkout is opened through the official hosted checkout JavaScript when available, with redirect fallback.

## Unchanged
Electron overlay, system audio, Deepgram/STT, resume/JD extraction, RAG/vector retrieval, OpenAI streaming, response tuning, usage metering, licensing, account authentication, admin credits and desktop launch behavior are unchanged.

## Required backend configuration
```env
PHONEPE_ENV=sandbox
PHONEPE_CLIENT_ID=...
PHONEPE_CLIENT_SECRET=...
PHONEPE_CLIENT_VERSION=1
PHONEPE_WEBHOOK_USERNAME=...
PHONEPE_WEBHOOK_PASSWORD=...
PUBLIC_BASE_URL=https://your-public-topper-domain.example
```

After PhonePe live approval, replace the sandbox credentials with live credentials and set `PHONEPE_ENV=production`.
