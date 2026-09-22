# Topper v14.7.8

Replacement package based directly on v14.7.4. Interview, overlay, model, audio, RAG, payment-order and credit flows are unchanged.

## Payment-gateway website readiness

This build adds only public website/compliance improvements:

- Dedicated About Us page.
- Dedicated Pricing page with the existing ₹599 / 60-minute digital pack.
- Dedicated Shipping & Delivery / Fulfilment policy for the digital service.
- Stronger Contact page with customer-care email, phone, legal business name, business type and registered/principal address.
- Business identity disclosure on the public footer and legal pages.
- Refund policy now states a clear approved-refund initiation target.
- Existing Terms, Privacy, Refund/Cancellation and product/service information remain available before login and after login.
- Added a public read-only business-profile endpoint. It exposes only customer-facing business information, never KYC documents, PAN, bank details or payment credentials.
- Existing PhonePe Standard Checkout v2 implementation was not changed.

## Before submitting the site to PhonePe / Cashfree / Razorpay

Set these Railway environment variables to the exact real details that match the payment-gateway KYC application:

- `BUSINESS_LEGAL_NAME`
- `BUSINESS_TYPE`
- `BUSINESS_SUPPORT_PHONE`
- `BUSINESS_ADDRESS_LINE1`
- `BUSINESS_CITY`
- `BUSINESS_STATE`
- `BUSINESS_POSTAL_CODE`

`BUSINESS_SUPPORT_EMAIL` defaults to `support.topper@gmail.com`, and `BUSINESS_COUNTRY` defaults to `India`. Optional `BUSINESS_GSTIN` and `BUSINESS_UDYAM` are displayed only when provided.

Do not submit the gateway application while the public site still shows “Configure before payment-gateway review”. The legal name/business type/address/phone should match the KYC documents and bank account details used in the gateway application.


## v14.7.6 cost-comparison update
Added manual GPT-4o and GPT-4o Mini live-answer choices. Existing Sol/Terra/Luna/Cerebras routing, RAG, grounding, streaming, STT, screen capture, commerce, licensing and payment behavior remain unchanged. GPT-4o-family calls reuse the same Topper prompt/evidence/output limits while omitting GPT-5.6-only reasoning/verbosity request fields; OpenAI automatic prompt caching remains available where supported.


## v14.7.7 low-cost architecture restoration
The OpenAI live-answer request path has been restored to the v14.7.2 architecture: no application-managed `prompt_cache_key`, no explicit cache TTL/options, and no extra cache plumbing through answer/conformance/streaming calls. The existing prompt, RAG evidence, intent handling, answer token budgets, reasoning effort, streaming, re-answer and multi-question behavior are unchanged. GPT-4o and GPT-4o Mini choices from v14.7.6 remain available, with only the compatibility omission of GPT-5.6-specific reasoning/verbosity request fields. All v14.7.5 portal/payment-readiness work remains intact.


## v14.7.9 Gemini 3.6 Flash fix
Gemini live answers now use Google's Interactions API with Gemini 3.6 Flash, current step.delta streaming/output parsing, low thinking level, and one retry for temporary 429/503 responses. All non-Gemini providers and Topper components remain unchanged.

## v14.7.8 Gemini 2.5 Flash comparison
Added Google Gemini 2.5 Flash as a manual live-answer choice. It uses the same prepared Topper question prompt, retrieved CV/JD evidence, intent rules, output budget, streaming UI and format-conformance path as the other live-answer providers. OpenAI remains unchanged for embeddings, profile/vision processing, and all existing OpenAI model choices. Railway requires `GEMINI_API_KEY`; `GEMINI_MODEL=gemini-2.5-flash` is optional because that is the built-in default.
