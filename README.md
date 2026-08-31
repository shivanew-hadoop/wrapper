# Topper v3 — Windows System Audio + Resume/JD RAG + Streaming LLM

Topper captures Windows loopback/system audio, sends PCM to the backend for Deepgram transcription, retrieves relevant context from a prepared resume/job-description vector index, and streams a candidate-grounded LLM answer into the floating Electron overlay.

## v14 commercial portal and credit metering

- Customer registration/login, ₹599 PhonePe Business Payment Gateway checkout for 60 minutes, server-side order-status verification and idempotent authenticated webhook recovery.
- Durable second-based credit balance, append-only ledger, payment history and listening-session history in SQLite WAL.
- Credits start deducting only after Start Listening; Stop settles the partial interval. One account cannot listen concurrently on two devices.
- Overlay countdown plus one-time warnings at 30, 10, 5 and 1 minute; audio/STT hard-stop at zero.
- Admin login, user/active/pending counts, user list and positive or negative credit adjustments.
- Customer portal at `/portal/`, Docker deployment assets and the complete three-phase rollout checklist in `COMMERCE_DEPLOYMENT.md`.
- Commerce heartbeats are isolated from `/ask/stream`; the existing answer model, RAG, STT and immediate SSE rendering remain unchanged.

## v13.9.3 latency and answer-quality update

- Removed the forced detailed-answer suffix; normal questions now default to short, speakable answers and expand only when explicitly requested.
- Added adaptive output budgets: 260 tokens normally, with larger budgets retained for introductions, detailed requests, code, debugging, vision and system design.
- Reduced default RAG payload to four chunks and three history turns while preserving follow-up evidence reuse and hybrid retrieval.
- Added a zero-network local guard for corrupted/gibberish and clearly non-interview prompts, returning a concise clarification instead of generating an answer.
- Added compact few-shot calibration for concise factual answers, honest unsupported-experience handling and unclear-input handling.

## Runtime architecture

1. Setup window verifies the license and accepts Resume (PDF/DOCX/TXT), JD (PDF/DOCX/TXT or pasted text), years of experience and optional target role.
2. `/prepare-context` parses both documents once, creates a compact candidate/JD profile, semantic chunks, OpenAI `text-embedding-3-small` vectors and stores them in backend process memory for that email.
3. The overlay captures Windows system audio and Deepgram provides interim/final transcripts.
4. For each finalized utterance, `/ask/stream` embeds only the question, performs local in-memory hybrid vector + keyword retrieval, adds the last five interview Q&A turns, and starts a streaming Responses API request.
5. Tokens are forwarded backend SSE -> Electron main process -> overlay immediately. The overlay displays first-token latency.

## Backend setup

Node.js 20+ is recommended.

```powershell
cd backend
Copy-Item .env.example .env
npm install
npm start
```

Edit `backend/.env` before starting:

```env
PORT=8080
DEEPGRAM_API_KEY=your_deepgram_key
OPENAI_API_KEY=your_openai_api_key
OPENAI_MODEL=gpt-5.4-mini
EMBEDDING_MODEL=text-embedding-3-small
EMBEDDING_DIMENSIONS=512
RAG_TOP_K=4
MAX_HISTORY_TURNS=3
DG_MODEL=nova-3
DG_LANGUAGE=en-US
```

`npm install` is required because v3 adds `pdf-parse` and `mammoth` for PDF/DOCX extraction. A backend package lock is intentionally not included; the install generates one for your environment.

## Electron app setup

For a backend running on the same PC, keep `app-config.json` as:

```json
{
  "backendUrl": "http://localhost:8080"
}
```

Then in a second PowerShell:

```powershell
npm install
npm start
```

The setup screen appears first. After preparation succeeds, the floating overlay opens. Click **Start Listening** and play meeting/call audio through Windows.

## Production backend

Deploy the `backend` directory to Railway (or another Node host), set the same environment variables there, then change only `app-config.json`:

```json
{
  "backendUrl": "https://YOUR-SERVICE.up.railway.app"
}
```

`main.js` now reads `app-config.json`; there is no hard-coded backend URL.

Important: prepared resume/JD vectors are in process memory. If Railway restarts, the user needs to run the setup/preparation screen again. This is deliberate for low latency and to avoid persistent resume storage in v3.

## Build portable Windows EXE

```powershell
npm run dist
```

The build includes `setup/**/*`, overlay, system-audio capture and transcriber files. The backend remains a separate service.

## New endpoints

- `POST /prepare-context` — parse, summarize and embed Resume/JD once.
- `POST /context-status` — check whether this backend process has prepared context for an email.
- `POST /ask` — non-streaming RAG answer, useful for testing.
- `POST /ask/stream` — low-latency SSE RAG answer used by the overlay.
- `WS /stt` — existing Deepgram transcription proxy.

## Latency notes

Local cosine/keyword retrieval normally takes only a few milliseconds or less. End-to-end response cannot be guaranteed in milliseconds because question embedding, network transit, speech endpointing and LLM inference are remote operations. Topper reduces perceived latency by precomputing document embeddings and streaming the first output tokens immediately.

## v4 interview-answer behavior
- Resume/JD preparation now extracts canonical technical vocabulary used to resolve speech-to-text phonetic mistakes without asking the interviewer for confirmation.
- Retrieval expands likely misheard technical terms against the prepared resume/JD vocabulary before embedding/search.
- Answers are first-person, production-oriented, plain text, and begin with a short direct answer before deeper implementation detail.
- Coding answers request meaningful inline comments on each logical statement/line.
- Auto Send waits for 1.8 seconds of transcript stability to avoid sending on a short mid-question pause.
- Auto Send can be toggled in the live overlay. Manual Send transmits only finalized transcript accumulated since the previous send.
- Re-run Prepare Interview after upgrading so the new canonical vocabulary is generated from the resume and JD.

## v5 reliability/latency changes
- Auto-send waits for a stable question and, if speech resumes while the auto answer is still streaming, cancels/replaces that partial request with the combined question.
- Manual Send still consumes only unsent transcript since the previous manual send.
- Short contextual follow-ups (for example: "give one example", "how did you do that?", "what about it?") reuse the immediately previous turn and its retrieved evidence without another embedding round trip.
- Missing resume evidence is not represented as production experience; the answer states that first, then gives concise high-level/POC guidance.
- LLM tokens stream immediately. Rare provider first-token stalls are aborted after `LLM_FIRST_TOKEN_TIMEOUT_MS` (default 6500 ms) and retried once.
- Overlay uses Electron's stronger top-most window level and reasserts top-most state when needed.
- Auto Send and Send controls are inside the LLM answer pane with higher-contrast styling.

## v6 final UI, continuity and latency changes
- CV/JD upload accepts any selected file and extracts common resume/JD formats including PDF, legacy DOC, DOCX, RTF, TXT, Markdown, CSV, JSON, HTML, XML and YAML. Unknown text-like files use a safe text fallback; binary formats that cannot yield reliable text are rejected.
- Legacy `.doc` parsing uses `word-extractor`; run `npm install` inside `backend` after upgrading.
- License validation stays on the setup screen. The overlay no longer exposes a separate license tab, and the listening screen cannot open if the license is invalid/expired.
- Stop now shuts down STT/audio/LLM streaming and returns to the first Resume/JD setup screen.
- Live UI is answer-first: LLM response uses the main area; the transcript is a compact two-line strip under it.
- When Auto Send is OFF, a manual prompt text box appears. Send uses typed text when present, otherwise only unsent speech. If neither exists, the UI shows `Nothing to send.`
- Short modifier follow-ups such as `using Java`, `same in Python`, `show code`, `give one example`, `what about failures`, `this/that/it` are resolved against the immediately previous interviewer question. A standalone short topic question such as `What is Kubernetes?` remains a new question.
- Auto-send continuations are merged while an answer is still streaming; after completion, clearly continuing fragments such as `and...`, `using...`, `with...`, `but...` inside the merge window regenerate from the combined question.
- STT WebSocket is pre-connected when Start Listening is clicked instead of waiting for the first audio chunk.
- Retrieval now has three modes: `history-reuse` for follow-ups, `lexical-fast` for strong exact CV/JD matches, and `vector-hybrid` when semantic embedding is actually needed. This removes the query-embedding network hop for many common skill questions.
- Default first-token provider timeout is 5000 ms with one retry; override using `LLM_FIRST_TOKEN_TIMEOUT_MS` if needed.


## v11 Capture Window
Use **Capture Window** from the live overlay to temporarily hide Topper, capture the application underneath, and stream a vision answer back into the existing LLM answer pane. This is optimized for coding questions, partially written code, compiler/runtime errors, and technical questions visible on screen. The screenshot is resized by Electron before upload and sent directly to the configured OpenAI vision-capable model; no separate OCR round trip is used.

## v13 dynamic model routing + continuous unsent transcript
- Final answer routing is local (no extra classifier API call): Terra for normal interview answers and Sol for complex coding/debugging/system-design/security-flow work.
- Resume/JD profile generation and screenshot-to-text extraction use Luna by default to reduce auxiliary cost without lowering normal answer quality.
- Set `LLM_FAST_FINAL_ENABLED=false` to force all final interview answers to Terra/Sol while still keeping Luna for auxiliary work.
- The live transcript now renders all Deepgram final/interim chunks for the current unsent question as one continuous bright line at the top. A new line starts only after the prior question is actually sent; sent questions are dimmed and pushed underneath newest-first.

## v13.5 overlay/interview-response refinements
- Streaming answers remain pinned to the top while text is being printed; scrolling is user-controlled.
- Default overlay transcript/answer font is 16px (existing user-selected font preference is preserved).
- Scenario-based questions begin with 1-2 practical clarification questions, then continue with the detailed solution using prepared and recent interview context.
- Default spoken-answer target is about 45-60 seconds unless the question requires more.
- Auto-send quiet window reduced from 900ms to 450ms to reduce avoidable client-side latency while preserving continuation handling.
- Manual Send and Ctrl+Enter continue to use the complete unsent Live Questions snapshot, including the visible interim tail.
