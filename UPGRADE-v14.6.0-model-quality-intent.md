# Topper v14.6.0 — Sol / Terra / Cerebras comparison + intent-first quality

This build is based on v14.5.9 and intentionally keeps the existing Electron UI, overlay, RAG, Deepgram/STT, licensing, prepare flow, streaming contract, answer formatting, token ceilings, and OpenAI/Cerebras credentials architecture.

Changes only:
- Removed Hybrid from the Prepare Interview model selector.
- Added OpenAI GPT-5.6 Terra (`gpt-5.6-terra`) as a manual comparison option.
- Kept GPT-5.6 Sol Fast and Cerebras GPT-OSS-120B as manual options.
- Resume/JD grounding remains active internally, but visible Resume/JD source tags are removed from the overlay.
- Strengthened current-question intent isolation for every provider: prior turns are used only for genuine contextual follow-ups.
- Added conservative Cerebras quality calibration to reduce broad, irrelevant, or invented details and make answers closer in shape/maturity to Sol.
- Added concept-completeness guidance so finite standard lists are not unnecessarily returned half-complete.

## Optional environment variable

`OPENAI_TERRA_MODEL=gpt-5.6-terra`

This variable is optional because the backend defaults to `gpt-5.6-terra`.
Existing `OPENAI_API_KEY`, `OPENAI_SERVICE_TIER=fast`, `LLM_REASONING_EFFORT=low`, Cerebras, Deepgram, Railway, database and licensing variables remain unchanged.
