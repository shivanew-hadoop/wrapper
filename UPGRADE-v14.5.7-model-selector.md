# v14.5.7 — Manual live-answer model selector

Adds one dropdown to Prepare Interview: OpenAI GPT-5.6 Sol Fast (default) or Cerebras GPT-OSS 120B. The selection is stored with the prepared interview session and used for normal live text answers. Existing RAG, Deepgram, SSE/UI streaming, prompts, response formatting, licensing, overlay, portal and navigation are unchanged.

OpenAI remains required for embeddings and screenshot/vision handling even when Cerebras is selected.

Railway variables to keep/add: OPENAI_API_KEY, OPENAI_MODEL=gpt-5.6-sol, OPENAI_SERVICE_TIER=fast, CEREBRAS_API_KEY, CEREBRAS_MODEL=gpt-oss-120b, CEREBRAS_API_BASE=https://api.cerebras.ai/v1, CEREBRAS_SERVICE_TIER=default.
