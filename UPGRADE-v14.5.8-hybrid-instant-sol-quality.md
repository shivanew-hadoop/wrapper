# Topper v14.5.8 — Hybrid Instant + Sol Quality

Adds an optional third live-answer mode while preserving the existing OpenAI and Cerebras selections.

- OpenAI · GPT-5.6 Sol Fast: unchanged.
- Cerebras · GPT-OSS 120B: unchanged.
- Hybrid · Cerebras Instant + Sol Quality: starts both providers in parallel. Cerebras streams immediately for perceived latency; the completed Sol answer replaces the provisional text as soon as it is ready.
- Final interview history stores the Sol answer when available; Cerebras remains the fallback if Sol fails or exceeds the upgrade timeout.
- RAG, embeddings, Deepgram/STT, prompts, response formatting, UI layout, licensing, screen/vision flow and Railway architecture are unchanged.

Optional variables:
- HYBRID_CEREBRAS_REASONING_EFFORT=medium
- HYBRID_SOL_UPGRADE_TIMEOUT_MS=18000
