# Topper v14.6.1 — Overlay + PDF polish

Focused changes only:
- Removed synthetic blank tail after the final LLM response so answer scrolling ends at actual content.
- Removed Markdown triple-backtick language fences from visible final answers for all programming languages; code remains readable plain text.
- Updated transcript PDF filename to `Topper_<Mon><ordinal-day>_<time>_IST.pdf` (example: `Topper_Sep9th_820PM_IST.pdf`).
- PDF header now includes resume/CV filename, target role, years of experience, start/end time on one line with duration, number of questions, and summary.
- PDF question rows now use `Q1-<prompt> [hh:mm:ss pm]`, followed by the answer.
- Existing provider, RAG, STT, setup, licensing, and interview-answer behavior are otherwise unchanged.
