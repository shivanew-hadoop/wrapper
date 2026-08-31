# Topper v14.5.1

- Restores the live answer critical path: no visible Thinking placeholder and no prompt duplication in the answer pane.
- Keeps previous answers scrollable; each new answer snaps to the top and streams there immediately.
- Transcript prompts remain in memory only for end-session persistence/PDF.
- Latest three sessions remain backend-only and are saved only when the session ends.
- Adds deterministic session summary in portal/PDF without any extra LLM call.
- Persists the previous Resume/JD/experience/target-role inputs encrypted on the desktop for convenient reuse.
- PhonePe, STT, RAG/vector retrieval, answer prompts/model settings and response-generation backend are unchanged.
