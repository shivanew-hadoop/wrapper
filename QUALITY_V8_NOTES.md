# v8: CV-grounded experience and transient LLM recovery

Changes restricted to backend/server.js, with new regression tests and this note.

- Cerebras and DeepSeek: for experience/ownership questions, include original resume text as authoritative evidence, not only a generated profile or top-k keyword retrieval.
- Distinguish job-description requirements from completed candidate experience. Explicitly flag queried Boomi/Python/C#/Java/SQL/AWS/Azure/GCP/JFrog terms not established in the CV; even a skill mentioned in the CV is not proof of project delivery.
- When experience is not established, use first-person truthful language: no verified hands-on work in the CV; describe transferable knowledge and how the candidate would approach it. Do not invent durations, clients or past projects.
- Streaming: retry once on HTTP 408/429/500/502/503/504 or transient network errors, only before any visible answer token. Existing first-token timeout retry retained. No retry after partial streamed text, to avoid duplicate content.
- Sol/OpenAI prompt and preparation routing unchanged. No frontend, Deepgram, streaming event schema, model selection or provider adapters changed.

Static tests: QUALITY_V8_REGRESSION_TESTS.js, QUALITY_V7_REGRESSION_TESTS.js, QUALITY_V5_TESTS.js, node --check, ZIP integrity.

Limitations: No live DeepSeek/Cerebras API keys, production error logs or end-to-end Electron/Railway environment available. The exact cause of the single reported LLM error cannot be confirmed from the transcript PDF.
