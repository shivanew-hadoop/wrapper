# DeepSeek integration — Topper v14.7.15

## Configure

Set these **backend** environment variables in the deployment service (for example, Railway):

```env
DEEPSEEK_API_KEY=<your DeepSeek API key>
DEEPSEEK_MODEL=deepseek-chat
DEEPSEEK_API_BASE=https://api.deepseek.com
```

Do not put your API key in the Electron client, source code, or setup form. Redeploy/restart the backend after setting the variables.

Keep `OPENAI_API_KEY` configured. This integration switches **live text answers only** to DeepSeek when selected; OpenAI is still used for resume/JD profile generation, vector embeddings, and screen capture/vision. Deepgram transcription and all existing providers remain unchanged. DeepSeek API access is separately billed from any ChatGPT subscription.

## Use

Open **Prepare Interview** → **Live answer model** → **DeepSeek · Chat** → **Prepare Interview**. This selection is sent to the backend and persisted locally for the next setup. Selecting another provider continues to use its existing route.

## Validate

1. `node --check backend/server.js && node --check main.js && node --check setup/setup.js`
2. Backend `/health` should show `deepseekConfigured: true` (never returns the key).
3. Prepare with DeepSeek, ask a text question and verify the streamed response model is `deepseek-chat`.
4. Re-test OpenAI, Cerebras, a follow-up question, document grounding, and screen capture. Screen capture remains OpenAI-backed by design.
5. For response quality, compare identical resume/JD and questions across models. DeepSeek performance/accuracy cannot be guaranteed without live provider tests.

## Rollback

Choose an existing model in the dropdown and re-prepare the interview. No database migration or dependency change is required.
