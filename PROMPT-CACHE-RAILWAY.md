# Topper prompt-cache latency patch (v14.7.15 base)

## Scope
Only `backend/server.js` and `backend/.env.example` are modified; this guide is added. All existing Electron, STT, retrieval, embedding, prompt content, model, streaming, token budgets, payment, and overlay logic remain unchanged.

The OpenAI Responses API already supports automatic prompt-prefix caching. This patch optionally supplies a deterministic `prompt_cache_key` for the same stable candidate/profile prefix and existing instructions. It is a routing hint, **not** a cache of answers. Current questions, previous turns, retrieved evidence and responses are never reused as answers. It adds no extra provider request and does not reduce prompt content. It cannot guarantee a latency improvement.

## Railway deployment
1. Back up your current Railway deployment/environment. Push/deploy the `backend` folder from this ZIP as you normally do. Do not replace your existing API keys or other environment variables.
2. In Railway **Variables**, set `OPENAI_PROMPT_CACHE_KEY_ENABLED=false` and `OPENAI_PROMPT_CACHE_METRICS=true` initially; redeploy. These settings are optional (same defaults if absent).
3. Run 10-20 questions with the same prepared interview. Inspect Railway logs for `[CACHE_PERF]`: `cacheHitPct`, `firstProviderDeltaAfterRequestMs`, `providerHeadersMs`, `retrievalMs`, `totalMs`. `cachedTokens` may be zero for short prompts, cache misses, or cache expiry.
4. To A/B test the optional routing hint, set `OPENAI_PROMPT_CACHE_KEY_ENABLED=true` and redeploy. Compare the same model, same profile and similar questions against the baseline. If results worsen or the API rejects the hint, set it back to `false` and redeploy; no other rollback is required.
5. Keep existing `OPENAI_SERVICE_TIER`, `LLM_REASONING_EFFORT`, `RAG_TOP_K`, `MAX_HISTORY_TURNS`, embedding and Deepgram settings unchanged. Do not add Redis, LangChain, a second LLM, or a vector database for this patch.

## Interpretation
- Prompt caching only applies to eligible matching prefixes and does not speed up the model's generated/reasoning output. A cache hit is not guaranteed; stable instructions and profile context were already at the front of the request in this codebase.
- `firstProviderDeltaAfterRequestMs` is model-to-first-text time; `firstTokenMs` includes backend preparation.
- A new prompt-cache key does not force caching; the provider decides. The best next optimization depends on measured bottlenecks.
- This ZIP is based on the **uploaded v14.7.15** archive, not any earlier v14.9.2 archive.
