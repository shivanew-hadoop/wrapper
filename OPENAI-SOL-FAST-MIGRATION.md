# OpenAI GPT-5.6 Sol Fast migration

This build keeps the existing Topper architecture and UI behavior, but switches primary text generation from Cerebras GPT-OSS-120B to the OpenAI Responses API using `gpt-5.6-sol`, `OPENAI_SERVICE_TIER=fast`, `LLM_REASONING_EFFORT=low`, and streaming for `/ask/stream`.

Existing Deepgram STT, Resume/JD parsing, RAG embeddings/retrieval, prompt construction, response-mode enforcement, screen capture/vision, licensing, commerce, Electron IPC, SSE renderer events, retry logic and UI answer rendering remain in place.

## Railway variables

Required/changed:

```env
OPENAI_API_KEY=...
OPENAI_MODEL=gpt-5.6-sol
OPENAI_PROFILE_MODEL=gpt-5.6-sol
OPENAI_VISION_MODEL=gpt-5.6-sol
OPENAI_SERVICE_TIER=fast
LLM_REASONING_EFFORT=low
```

Keep all existing Deepgram, commerce/database, CORS, license and other variables exactly as they are. `CEREBRAS_API_KEY`, `CEREBRAS_MODEL`, `CEREBRAS_API_BASE`, and `CEREBRAS_SERVICE_TIER` are no longer used by the backend and can be removed after deployment validation.

## Local `.env`

Use `backend/.env.example` as the reference. Put the real OpenAI key in `backend/.env`; never commit the real key.

## Go Back

The pre-listening overlay now has **Go Back** beside **Start Listening**. It calls the already-existing `stop-and-return-setup` IPC handler, closes the overlay and reopens the existing setup/Prepare Interview window without terminating the app.

## Validation

1. Deploy the backend with the variables above.
2. Open `/health`; verify `llmProvider` is `openai`, `llmModel` is `gpt-5.6-sol`, `openaiServiceTier` is `fast`, and `reasoningEffort` is `low`.
3. Prepare Resume/JD context once.
4. On the Start Listening screen, confirm Go Back returns to setup.
5. Start Listening and ask one typed question; confirm answer tokens appear incrementally.
6. Test system audio and screen capture to confirm the existing paths still work.
