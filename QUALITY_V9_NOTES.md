# v9 — D365 follow-up, flow formatting, STT false starts

Changes only to backend/server.js prompt construction for DeepSeek/Cerebras. No changes to Sol, Deepgram, UI, streaming, provider dropdown, resume/JD preparation or retry adapters.

- Referential follow-ups like "what exactly is that, and what's your role" must resolve the immediately preceding interviewer technical subject, not define "that" or quote pronouns.
- Explicit Dataverse/Service Bus integration-flow questions start with a single-line arrow chain, then 2–4 brief implementation lines. Only claim delivered project experience when resume evidence supports it.
- An abandoned STT fragment such as "what are the type of like" is discarded when the actual request asks about model-driven form onLoad/onSave/onChange; do not introduce SQL/FetchXML LIKE.
- Use the CV silently for factual grounding. Spoken answers must not say "from my CV" or "documented in my CV". Unsupported experience must still be disclosed honestly.

Checks: node --check, v5/v7/v8/v9 regression suites, zip integrity. No live DeepSeek or Cerebras API test or Electron/Railway end-to-end verification.
