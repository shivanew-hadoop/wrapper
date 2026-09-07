# Topper v14.4.3 — OpenAI Fast tier

This update enables the OpenAI Fast service tier for interactive answer generation while preserving the existing model, reasoning effort, RAG retrieval, embeddings, prompts, intent routing and output validation.

## Railway variable

Add this variable to the existing backend service:

```text
OPENAI_SERVICE_TIER=fast
```

The code defaults to `fast`, so the variable is recommended for clarity rather than required. Set it to `default` and redeploy if you need to disable Fast mode.

## Replace and deploy

1. Replace `backend/server.js` with the supplied file.
2. Do not replace `.env`, `backend/users.json`, `backend/data`, the Railway volume or any database file.
3. In Railway, open the existing backend service and select `Variables`.
4. Add `OPENAI_SERVICE_TIER=fast`.
5. Commit and push `backend/server.js`, `package.json`, `package-lock.json` and this guide.
6. Wait for the deployment to become `Active`.
7. Open `https://topper.zapperapp.in/health` and confirm:

```json
{"ok":true,"openaiServiceTier":"fast"}
```

8. Ask a normal interview question and inspect Railway deployment logs. A successful request reports `serviceTier=priority` or `serviceTier=fast`, depending on the provider response naming.

## Important behavior

- `service_tier` is added only to interactive Responses API calls: normal answers, streamed answers, screen extraction and rare format correction.
- It is intentionally not added to the embeddings API because Fast mode does not support embeddings.
- No database migration, portal change, payment change, credit change, context reset or Electron reinstall is required for the backend speed change.
- Fast mode has premium API pricing and does not guarantee a fixed response time.
