# PhonePe Business PG readiness — Topper

## What is already present on the bundled website
- Public product description and feature explanation.
- Clear price: ₹599 for a one-time 60-minute interview pack.
- Terms of Service.
- Privacy Policy, including payment-provider handling.
- Refund and Cancellation Policy.
- Contact/support page and support email.
- Account login/registration and payment history.
- HTTPS-capable server deployment path.

## Before requesting live approval
PhonePe approval cannot be guaranteed by code alone. Merchant underwriting/KYC remains PhonePe's decision. Make sure the live website URL submitted to PhonePe is reachable publicly and the legal/KYC information you submit matches the bank account and business entity.

The current bundled website does not contain a legal business entity name, registered/business address, support phone number, GSTIN/CIN/Udyam details, because those details were not supplied in the project. If PhonePe requests these during review, add the real merchant details to the Contact/Terms pages rather than placeholders.

For a digital service there is no physical shipping flow; the site already explains that credits are digital service minutes. Keep the refund/cancellation terms visible and honour them operationally.

## Sandbox variables
```env
PHONEPE_ENV=sandbox
PHONEPE_CLIENT_ID=...
PHONEPE_CLIENT_SECRET=...
PHONEPE_CLIENT_VERSION=1
PHONEPE_WEBHOOK_USERNAME=...
PHONEPE_WEBHOOK_PASSWORD=...
PUBLIC_BASE_URL=https://your-public-topper-domain.example
```

Configure PhonePe's server-to-server callback to:

`https://your-public-topper-domain.example/api/payments/webhook`

Use the same callback username/password in PhonePe and the backend environment.

## Production switch
After live credentials are issued, replace the sandbox client credentials and set:

```env
PHONEPE_ENV=production
```

Do not put PhonePe secrets in Electron, portal JavaScript, GitHub source, or `app-config.json`.
