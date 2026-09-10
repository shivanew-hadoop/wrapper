# Topper v14.6.5 — Chronological Current Answer + Code I/O Example

Focused changes only:

- LLM answer history remains chronological: oldest answers at top, newest answers appended at bottom.
- On Send/Enter the viewport moves to the newest turn so its first line starts directly below `LLM ANSWER`.
- A temporary, non-content spacer exists only while the newest response is generating, solely to provide sufficient scroll range for short answers. It is removed on `done` or `error`, so completed responses do not retain synthetic trailing blank space.
- Streaming does not continuously chase the user's scroll position; after the initial anchor, manual scrolling remains under user control.
- Complete runnable coding answers now include one concise `Sample input:` and corresponding `Sample output:` after the code. Tiny snippets without a meaningful input/output contract are exempt.
- No provider, SQL/RAG, resume grounding, Railway, PDF, licensing, setup, Deepgram, or model-selection behavior was changed.
