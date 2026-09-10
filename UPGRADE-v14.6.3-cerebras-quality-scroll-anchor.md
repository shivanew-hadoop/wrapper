# v14.6.3 — Cerebras quality instruction + answer viewport anchor

Focused changes on top of v14.6.2:

- Added internal-analysis discipline to the shared answer prompt: analyze carefully, but return final answer only; never expose chain-of-thought or `<thinking>` tags.
- Reinforced current-question scope, relevance, finite-concept completeness, and resume-grounded first-person claims.
- Fixed answer-pane positioning so a newly submitted turn is anchored to the current visible answer viewport immediately after Send.
- Re-anchors once on the first streamed token to account for layout changes before provider output arrives.
- No SQL/RAG, model selection, Railway variables, Deepgram, PDF, licensing, commerce, or provider configuration changes.
