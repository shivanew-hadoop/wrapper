# Cerebras GPT-OSS 120B migration

This build changes the primary **text answer path** from OpenAI Responses API to Cerebras `gpt-oss-120b` Chat Completions, including streaming, profile generation, normal `/ask`, `/ask/stream`, and rare code/diagram format correction.

## What is intentionally unchanged

- Electron UI/overlay and SSE contract
- Deepgram STT
- licensing, PhonePe/commerce and portal
- resume/JD parsing and in-memory RAG
- OpenAI embeddings (`text-embedding-3-small` by default)
- OpenAI screenshot/vision extraction and direct image answer fallback
- response-mode rules, prompt construction, interview history, retries and latency telemetry

OpenAI remains configured because Cerebras `gpt-oss-120b` is text-only. Removing `OPENAI_API_KEY` would break embeddings and screenshot functionality.

## Local `.env`

Copy `backend/.env.example` to `backend/.env` and set at minimum:

```env
DEEPGRAM_API_KEY=...
CEREBRAS_API_KEY=...
CEREBRAS_MODEL=gpt-oss-120b
CEREBRAS_SERVICE_TIER=default
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-terra
OPENAI_SERVICE_TIER=fast
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=512
LLM_REASONING_EFFORT=low
LLM_FIRST_TOKEN_TIMEOUT_MS=5000
```

For live interview latency, `LLM_REASONING_EFFORT=low` is the recommended starting point. Change to `medium` only if you prefer more reasoning quality over time-to-first-answer.

## Railway — recommended upgrade

You **do not need a new Railway project**. Update the existing backend service so the public URL stays unchanged and desktop clients require no URL change.

1. Back up/export the current Railway variables.
2. Add `CEREBRAS_API_KEY`.
3. Add `CEREBRAS_MODEL=gpt-oss-120b`.
4. Add `CEREBRAS_SERVICE_TIER=default`.
5. Keep the existing `OPENAI_API_KEY`, `OPENAI_MODEL`, `OPENAI_SERVICE_TIER`, embedding, Deepgram, database/commerce, JWT, PhonePe and other production variables.
6. Deploy this updated project/repository to the same Railway service.
7. Check `/health`. It should report `llmProvider: "cerebras"`, `llmModel: "gpt-oss-120b"`, `cerebrasConfigured: true`, and `openaiConfigured: true`.
8. Run one setup/context preparation and one typed answer before production use. Then test system-audio streaming and screen capture.

### Safer zero-risk rollout option

If the existing Railway service is already serving users, clone the Railway service (or create a temporary staging service in the same project), deploy this build there, test it, then switch the production service after validation. A completely separate Railway **project** is not required for latency; Railway project separation itself does not make Cerebras inference faster.

## Latency notes

The main answer generation now streams from Cerebras. Actual end-to-end latency still includes client → Railway network, question embedding when semantic retrieval is needed, prompt construction, Cerebras queue/TTFT, and output length. No hosted LLM integration can guarantee a fixed millisecond response time. The existing lexical fast path and streaming behavior are preserved.
