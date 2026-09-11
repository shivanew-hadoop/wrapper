# Topper v14.7.3

Replacement package based directly on v14.7.2. No new Railway environment variables are required.

## Change in this build

- Added GPT-5.6 Responses API prompt-cache bucketing for OpenAI Sol, Terra and Luna answer requests.
- The cache key is isolated to the prepared interview session and model, so a newly prepared CV/JD session gets a fresh namespace.
- Uses the supported 30-minute GPT-5.6 prompt-cache TTL. Repeated questions in the same interview can reuse matching stable prompt prefixes at OpenAI cached-input pricing.
- The same cache configuration is also passed to rare format-repair requests and the dormant hybrid Sol path.
- This is a billing/cache optimization only: prompt wording, retrieved evidence, question intent, reasoning effort, answer token ceilings, response formatting and model selection are unchanged.

## Intentionally unchanged

Everything else from v14.7.2 remains unchanged: re-answer history behavior, multi-question handling, role/experience inference, portal UI, RAG evidence selection, resume/JD grounding, adaptive examples, Deepgram/system audio, screen capture, SQL/commerce/licensing, PDF behavior, overlay size/position, and Railway configuration.
