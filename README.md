# Topper v14.7.8

Replacement package based strictly on the attached v14.7.2 baseline. No new Railway environment variables are required.

## Changes

- Interview answers are calibrated for a more natural, speakable senior-candidate style: direct opening, short connected paragraphs, concrete current/recent project mechanics, and less generic tool-list wording.
- Resume remains the authority for personal experience; JD is used for relevance/order only and cannot create candidate experience.
- Follow-up resolution for this/that/these/those/it/them is strengthened locally using the immediately previous interview turn, without an additional LLM call.
- The live answer overlay now renders selective `**important keywords**` as bold and preserves clearer paragraph spacing.
- Coding answers render the existing `Complete code:` / `Code snippet:` portion in a separate editor-style block while preserving the existing coding contract.
- Streaming cadence, retrieval, embeddings, model routing, token ceilings, STT, screen capture, payment, licensing, portal, PDF and other application behavior are unchanged.

## Validation

Changed JavaScript is validated with `node --check`; the replacement ZIP is validated with `unzip -t`.



## v14.7.4 — live-intent precision

- Filters typing/screen/window/audio/video and other interview logistics from answer intent.
- Long conversational transcripts now prefer the latest substantive technical request instead of replaying older questions.
- Factual questions use answer-first/gunshot openings; no setup before the requested value/code/status.
- Interviewer handoff ("any questions for me?") produces concise questions to ask the interviewer instead of a self-introduction.
- Normal spoken answers prioritize the strongest 3-5 points, target <=90 seconds, and reserve up to two minutes only for explicit deep dives.
- Retrieval architecture, embeddings, provider/model routing, streaming transport, STT, licensing, payments and screen capture are unchanged.


## v14.7.6 precision patch
- Narrow SQL example requests now return only the requested query plus tiny sample input/output; no unsolicited table/schema/insert scaffolding.
- Added deterministic context-supported STT repair for SQL `joints` -> `joins` and Playwright `custom fixer` -> `custom fixture`, including the common `username of custom fixer` -> `use of custom fixture` phrase when session context supports Playwright/fixtures.
- No provider routing, retrieval architecture, embedding flow, streaming, STT transport, licensing, payment, or screen-capture changes.

- v14.7.6: Fixed custom-fixture STT repair so the explicit phrase itself can trigger correction even when Playwright was not retained in extracted profile vocabulary; also repairs "username of custom fixture" to "use of custom fixture" only in that narrow context.


## v14.7.7 narrow-intent quality patch
- Based strictly on v14.7.6 Fixture STT Fix.
- Removes non-semantic live-speech vocalizations such as mhmm/hmm/aaa/uh/laughter before intent detection and retrieval.
- Adds hard narrow-question scope discipline: answer the exact mechanism first, avoid option surveys and adjacent architecture unless asked.
- Uses current framework/recent interview context to prioritize the most relevant mechanism (for example Spring MVC session state for a server-side multi-page workflow).
- Keeps Spring JDBC explanations on the direct DataSource -> connection pool -> JdbcTemplate/DAO execution path.
- No changes to retrieval architecture, embeddings, provider/model routing, streaming, STT transport, screen capture, licensing, payment, or overlay behavior.


## v14.7.8 continuity + overlay reliability patch
- Resolves this/that/it/feature/situation follow-ups from recent interview turns before asking for clarification.
- Conservatively inherits a stable recent technical topic for mildly corrupted STT instead of switching to unrelated technologies.
- Prefers production-shaped CV/JD-supported examples over classroom examples for senior concept questions.
- Uses short implementation snippets for resource/pattern questions instead of unnecessary full applications.
- Renders fenced or labelled code in a true black editor block.
- Reasserts Windows topmost Z-order once per second without focusing the overlay. Content protection remains enabled.
- Retrieval, embeddings, provider/model routing, token ceilings, streaming transport, licensing, payments and preparation architecture are unchanged.


## v14.7.9 - Context regression guard
- Explicit current technical topics now always override inherited recent-topic context.
- Recent-turn continuity is used only for genuine pronouns/ellipsis or noisy ambiguous fragments.
- Leading interview connection/audio/network chatter is silently discarded before intent processing.
- Bold interview keywords use a distinct high-contrast accent in the overlay; code editor behavior remains unchanged.
- No changes to retrieval architecture, embeddings, model routing, streaming, token budgets, licensing, payment, or screen capture.
