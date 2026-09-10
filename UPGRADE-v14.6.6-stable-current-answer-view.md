# v14.6.6 — Stable Current Answer View

- Keeps answer history chronological: oldest at top, newest at bottom.
- On Send/Enter, the newest answer is aligned directly below the LLM ANSWER heading.
- Short answers remain at that top reading position after completion instead of being clamped downward.
- Long answers also remain anchored at their start; streaming does not auto-scroll. The user controls scrolling.
- When the next question starts, the previous turn returns to normal compact history and the new turn becomes the reading slot.
- No provider, backend, RAG/SQL, prompt, PDF, setup, licensing, or model-selection behavior changed.
