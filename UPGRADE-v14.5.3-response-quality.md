# v14.5.3 — Interview response quality tuning

This is a prompt/budget-only update on top of the Cerebras GPT-OSS-120B build.

- Preserves Cerebras provider, streaming, RAG, CV/JD grounding, Deepgram, vision fallback, commerce/licensing and Electron behavior.
- Makes normal answers shorter and more speakable.
- Uses compact hyphen bullets for feature, difference, steps, troubleshooting and multi-point questions.
- Keeps narrow questions to 1–3 sentences.
- Keeps coding answers to the smallest complete runnable solution with short logic.
- Prevents speculative production root-cause claims when evidence is not available.
- No new environment variables are required.
- Backend-only deployment does not require rebuilding Electron.
