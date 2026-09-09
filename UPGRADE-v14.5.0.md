# Topper v14.5.0 — Overlay Q&A History + Last-3 Interview Transcripts

## Scope
This upgrade is intentionally isolated from the interview inference path. It keeps PhonePe Business payments, STT, RAG/vector retrieval, resume/JD extraction, screen capture, usage metering and LLM streaming unchanged.

## What changed
- The overlay keeps Q&A turns for the current session in renderer memory instead of replacing the prior answer.
- Each turn shows a small timestamp and dotted separator.
- A new question automatically aligns to the top of the answer viewport; older Q&A remains available by scrolling upward.
- Transcript data is sent to the backend only when the user stops/ends the session (or closes the overlay), never during live transcription/LLM streaming.
- The backend stores only the newest 3 completed interview sessions per user and removes older sessions in the same database transaction.
- The customer portal displays those 3 sessions, supports View/Hide, and can download an authenticated PDF containing questions, answers and timestamps.

## Deployment
1. Deploy the backend from this package first. The SQLite table/index are created automatically on startup.
2. Build and distribute the Electron v14.5.0 installer for overlay-history support.
3. Existing PhonePe environment variables remain unchanged.
4. No new environment variable or npm dependency is required for transcript history/PDF generation.

## Latency
No database call, PDF generation or new model call was added to the live question/answer path. Persistence happens after Stop/End Session; PDF generation happens only when requested in the portal.
