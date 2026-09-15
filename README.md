# Topper v14.7.4

Replacement package based directly on v14.7.3. No new Railway environment variables are required.

## Change in this build

- Stabilized overlay answer rendering for long responses: the streamed text is no longer rebuilt again on normal completion.
- Locked each answer turn to the same configured font size and line height from first token through completion.
- Manual scrolling is preserved; completion does not reposition or resize the answer the user is already reading.
- Explicit backend format-repair events still work exactly as before when a code/diagram response genuinely requires repair.
- No model, prompt, grounding, token-cost, latency, RAG, audio, capture, payment, SQL, licensing or portal behavior was changed.

## Intentionally unchanged

Everything else from v14.7.3 remains unchanged, including GPT-5.6 prompt caching, re-answer history behavior, multi-question handling, role/experience inference, portal UI, RAG evidence selection, CV/JD grounding, adaptive examples, Deepgram/system audio, screen capture, PDF behavior, overlay size/position and Railway configuration.
