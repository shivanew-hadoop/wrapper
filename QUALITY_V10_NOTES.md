# v10 — interview precision hotfix (DeepSeek/Cerebras)

Basis: 15-question uploaded Fiserv BA/API implementation transcript, 23 Nov 2026.

## Changes
- Correct past-project challenge intent rather than interpreting as future domain gap.
- For SQL query demonstration follow-ups, request an actual minimal SELECT statement with inline comments instead of prose about writing SQL. Preserve one-table scope.
- Resolve noisy 'CD/CT' validation questions to internal vs external ownership; forbid unsupported CI/CD and external onboarding claims.
- Preserve the boundary between API contract review and actual code generation; do not invent server stub/SDK generation.
- Strengthen mapping precision, field ownership, verification and non-repetition instructions for chat-completions providers.
- Changes only in backend/server.js chat-provider prompt preparation; no extra network calls or change to model selection, STT, UI, retrieval, streaming or OpenAI-family behavior.

## Checks
- `node --check backend/server.js`
- v4, v5, v7, v8, v9 and v10 regression tests PASS.
- Tests v4-v8 had pre-existing relative-path assumptions inconsistent with archive layout; corrected only the test file paths. v9 test extraction updated to include the new helper.
- No provider API keys or live service test: cannot certify real model wording, end-to-end application functionality, or production latency.
