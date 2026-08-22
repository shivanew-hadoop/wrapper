# Topper v6 - Local, Online Backend and Windows Distribution

## 1. Local verification

Backend:

```powershell
cd D:\Projects\wrapper\backend
Copy-Item .env.example .env
# Put the real Deepgram/OpenAI keys in .env
npm install
npm start
```

Desktop app in a second terminal:

```powershell
cd D:\Projects\wrapper
npm install
npm start
```

Keep `app-config.json` as `http://localhost:8080` only for local testing.

## 2. Put the backend online with Railway

1. Push the project to the GitHub repository.
2. In Railway, create a project and deploy from that GitHub repository.
3. Configure the service root directory as `backend` so Railway runs the backend package rather than Electron.
4. Start command: `npm start`.
5. Add service variables: `DEEPGRAM_API_KEY`, `OPENAI_API_KEY`, `OPENAI_MODEL`, `EMBEDDING_MODEL`, `EMBEDDING_DIMENSIONS`, `RAG_TOP_K`, `DG_MODEL`, `DG_LANGUAGE`, `LLM_FIRST_TOKEN_TIMEOUT_MS`, and optionally `FAST_LEXICAL_THRESHOLD`. Railway supplies `PORT`; the code also reads it automatically.
6. Generate a Railway public domain and verify `https://<domain>/health` returns `{ "ok": true }`.
7. For this current build, keep a single backend instance because prepared interview vectors and conversation memory live in process RAM.

## 3. Point every Windows client to the online backend

Change root `app-config.json` before building:

```json
{
  "backendUrl": "https://YOUR-SERVICE.up.railway.app"
}
```

Never place OpenAI or Deepgram keys in the Electron project. They stay only in Railway variables/backend `.env`.

## 4. License users

Current v6 validates email against `backend/users.json`.

Create a license locally:

```powershell
cd backend
npm run create-license -- customer@example.com "Customer Name" 30
```

Commit/push the updated `backend/users.json`; Railway GitHub auto-deploy then picks it up. This is adequate for a controlled initial rollout.

For a larger public rollout, move licenses from `users.json` to PostgreSQL before scaling to multiple backend replicas. Keep resume/JD vectors in RAM per active interview session for latency, or add Redis/session routing if you scale horizontally.

## 5. Build the Windows app

From project root on Windows:

```powershell
npm install
npm run dist
```

The current configuration builds a portable x64 EXE under `dist\Topper-v6.0.0\`.

## 6. Distribute to users

Upload the generated EXE to a GitHub Release or your own download portal. Users only run the EXE, enter a licensed email, upload CV/JD, prepare context and start listening. They do not need Node.js and do not receive API keys.

## 7. Production hardening before broad public use

- Replace `users.json` with PostgreSQL for dynamic license activation/deactivation.
- Add authentication/admin controls around license creation.
- Configure HTTPS-only backend URL (Railway public domains provide TLS).
- Add request/rate limits per license to protect API cost.
- Add structured server logs and error metrics.
- Keep one active interview context per user/session; avoid storing raw CV/JD longer than required unless the user explicitly opts in.
- Code-sign the Windows executable to reduce Windows SmartScreen friction for distributed binaries.

## v13 model-routing variables
Add these backend variables in Railway/your host:

```env
LLM_ROUTING_ENABLED=true
LLM_FAST_MODEL=gpt-5.6-luna
LLM_DEFAULT_MODEL=gpt-5.6-terra
LLM_COMPLEX_MODEL=gpt-5.6-sol
LLM_PROFILE_MODEL=gpt-5.6-luna
LLM_VISION_EXTRACT_MODEL=gpt-5.6-luna
LLM_FAST_FINAL_ENABLED=false
```

Routing happens locally before the single final LLM request, so it does not add a classifier network hop.
