# Topper v14.4.3 — Interview response tuning

This patch changes only normal spoken-answer shaping. It keeps the existing OpenAI Fast tier, model, reasoning effort, RAG retrieval, embeddings, STT, streaming, licensing, commerce, coding/diagram routing, retries and UI behavior intact.

## What changed

- Normal spoken mode is now `SPOKEN_INTERVIEW_EXPLAINED` instead of keyword-compressed `SPOKEN_CONCISE`.
- Normal technical/experience/troubleshooting answers start with one direct sentence and add 2–4 concise implementation sentences.
- Very narrow yes/no and single-fact follow-ups remain short.
- Normal spoken token ceiling changed from 260 to 420; expanded answers from 500 to 600.
- Default Responses API text verbosity for spoken answers changed from `low` to `medium`.
- Added structural calibration examples so answers explain practical flow instead of returning comma-separated technology keywords.

## Latency behavior

No extra LLM request, classifier request, embedding request, validation pass, or post-generation rewrite was added for spoken answers. Existing SSE token streaming and first-token retry behavior are unchanged.

## Deployment

Replace the existing project with this patched build, or deploy only `backend/server.js` if the desktop client and backend are deployed separately. Existing environment variables remain compatible. If `LLM_VERBOSITY` is explicitly set to `low` in Railway, remove it or change it to `medium` to receive the intended response style.
