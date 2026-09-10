# Topper v14.6.8 — Adaptive Grounded Examples

This update is intentionally limited to answer-example selection.

- Adds a per-question EXAMPLE POLICY to the existing prompt.
- Examples are included when explicitly requested or when one concrete application materially improves an experience/concept answer.
- Process/mechanism answers that are already concrete do not receive redundant examples.
- Narrow correction/clarification answers stay direct unless an example is needed to remove ambiguity.
- Candidate/project-specific examples remain strictly grounded in retrieved resume evidence; unsupported personal examples are forbidden.
- Normally at most one concise example is used, integrated naturally rather than forced into every answer.

No audio, Deepgram, overlay, SQL/RAG retrieval, model routing, Luna/Sol/Terra/Cerebras, setup, PDF, licensing, or Railway behavior was changed.
