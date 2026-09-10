# Topper v14.6.9 — latency diagnostics + safe retrieval cache

Built directly on v14.6.8.

- Adds per-question backend `[PERF]` timing for intent, retrieval, embedding/cache, prompt build, provider headers, first provider delta, and total latency.
- Adds `[PERF UI]` timing for first browser paint, correlated by request ID.
- Adds a bounded exact-query retrieval-result cache. It only reuses evidence for the same prepared-session user and normalized standalone retrieval query; it does not reuse prior-turn evidence for unrelated questions.
- Preserves the existing lexical/history/vector retrieval rules and all answer-quality prompts.
- No Redis, SQL, model routing, Deepgram/system-audio, overlay layout, licensing, PDF, or Railway configuration changes.
