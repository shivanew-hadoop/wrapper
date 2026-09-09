# Topper v14.5.4 — grounded interview quality + setup UX

This update is intentionally narrow and is based on v14.5.3. Existing Cerebras/OpenAI split, RAG, Deepgram, licensing, commerce, capture, overlay, streaming and backend routes remain in place.

## Interview-answer tuning
- Added an explicit spoken-answer shape classifier: DIRECT, CONCEPT, FEATURES, COMPARISON, EXPERIENCE, IMPLEMENTATION_FLOW and TROUBLESHOOTING.
- Added a hard ownership rule: only resume evidence can justify first-person production claims. JD requirements are target context, not proof of past implementation.
- When an exact technology is not in production evidence but adjacent platform experience exists, the answer states that boundary once, then maps the real experience to a practical implementation approach.
- Prevents invented project details, client use cases and numerical improvements not present in resume evidence.
- Requires production mechanics instead of generic textbook/sales wording.
- Adds deterministic final formatting for spoken answers so bullet blocks and longer answers remain readable in the overlay. This is local post-processing and does not add another LLM request.

## Interview setup UX
- Validation errors now render immediately below the setup header and stay visible near the top.
- Validation errors scroll into view automatically.
- Resume and JD inputs now show a Remove action after a file is selected or a saved previous file is loaded.
- Removing a previously saved Resume/JD also clears that saved file from encrypted setup defaults.
- Reduced setup spacing/textarea height so more of the form fits in the initial desktop window.

## Deployment
- Railway/backend: deploy the updated backend as before; no new environment variables are required.
- Electron: because this release changes setup/index.html, setup/setup.js, setup/setup.css, preload.js and main.js, rebuild/repackage Electron to receive the new Remove buttons and validation-error placement.
