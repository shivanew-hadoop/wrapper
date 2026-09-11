# Topper v14.7.2

Replacement package based on v14.7.1. No new Railway environment variables are required.

## Changes

- Re-answer now creates a new chronological answer turn. Earlier answers remain visible and unchanged; every re-answer streams below them like a new question while still asking for a materially different accurate approach.
- Role detection priority is explicit CV role -> explicit JD role -> conservative skill/profile inference. The resolved role is stored in the prepared session and used in answer grounding.
- Experience detection prefers an explicit total. When absent, it calculates a conservative span from the earliest non-education employment/project date to the latest/current project date, and stores the resolved value in the prepared session.
- Multi-question prompts no longer discard the earlier complete question. Related questions are answered as one connected response; distinct questions are answered in order, with the first concise and the next answered directly. Mixed prompts that include coding still require usable code for the coding part.
- The public/account portal was redesigned with persistent navigation after login, a compact account area, visible logout/account/history/support links, clearer product sections, and payment/privacy/refund/contact links suitable for a professional digital-service storefront. Existing account, PhonePe, credits, launch, transcript, admin and download IDs/actions are preserved.
- Terms, privacy, refund/cancellation and contact pages were refreshed for the digital-credit service and remain linked from the portal.

## Intentionally unchanged

Model routing and model IDs, reasoning settings, answer token ceilings outside the new multi-question response mode, RAG evidence selection, resume/JD grounding boundaries, adaptive examples, Deepgram/system-audio capture and recovery, screen-capture accumulation, SQL schema, commerce/payment API behavior, licensing, PDF transcript behavior, overlay size/position, and Railway configuration are otherwise unchanged.
