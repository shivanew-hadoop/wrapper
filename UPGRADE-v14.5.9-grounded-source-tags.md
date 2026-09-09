# v14.5.9 — Grounded Resume/JD Source Tags

This update keeps the existing model selector, RAG, streaming, Deepgram, overlay, Prepare Interview flow and Railway architecture intact.

## What changed
- Retrieved Resume/JD chunks now carry explicit internal evidence identifiers.
- Candidate-specific claims must be supported by retrieved evidence; unsupported first-person claims are not allowed.
- Evidence-backed sentences/bullets receive compact source tags such as `Resume · Experience` or `JD · Requirements`.
- General technical explanations remain untagged.
- Source markers become UI pills only when the response completes, so first-token streaming latency is unchanged.

No new environment variables are required.
