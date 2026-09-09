# Topper v14.6.4 — Current Answer Top Anchor

Focused overlay-only behavior fix on top of v14.6.3.

- The newest LLM answer is now inserted at the top of the answer viewport instead of appended at the bottom.
- Pressing Send/Enter immediately resets the LLM answer pane to the top, ready for the first streamed line.
- The first provider delta re-confirms the same top anchor, but streaming does not continuously auto-scroll afterward.
- If the answer becomes longer than the pane, the user scrolls normally.
- Previous answers are preserved below the current answer for reference.
- No synthetic tail spacer is added, so the earlier blank-space/extra-scrollbar issue remains fixed.
- No backend, SQL/RAG, provider, model, Railway, PDF, transcript, licensing, or setup behavior was changed.
