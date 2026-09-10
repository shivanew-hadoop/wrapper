# Topper v14.6.7

Targeted changes only:
- Added self-healing health monitoring to the existing Windows loopback system-audio renderer. Existing PCM16/16 kHz capture path is unchanged when healthy.
- Decoupled transient credit-heartbeat failures from the overlay transcription status so they no longer appear as a misleading caption/capture reconnect state.
- Added GPT-5.6 Luna as a manual OpenAI live-answer option, using the same prompt/RAG path as Sol/Terra.
- Standalone questions no longer receive previous Q/A history in the LLM prompt; genuine contextual follow-ups still do. This prevents prior-topic contamination such as BDD Hooks leaking into a new OOP question.
- Setup opens maximized/full-page for data entry.
- Overlay default expanded dimensions are approximately 80% of the prior defaults (840x496 vs 1050x620), including the pre-listening and listening views because they share the same overlay window.
- No new capture-concealment behavior was added to the setup page.

Railway: existing OPENAI_API_KEY is sufficient. Optional explicit variable: OPENAI_LUNA_MODEL=gpt-5.6-luna. Existing OPENAI_SERVICE_TIER=fast applies to Luna through the same OpenAI request path.
