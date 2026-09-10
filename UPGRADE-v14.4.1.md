# Topper v14.4.1 — commit boundary and required-output guard

## Fixed

- Manual Send, Enter and Ctrl+Enter commit exactly the visible transcript snapshot.
- Late cumulative Deepgram interim/final packets are compared with the committed tail; only genuinely new words remain for the next question.
- Exact duplicated model output is collapsed before it becomes interview history.
- Coding response type is stored with the turn, so coding follow-ups retain the complete-code requirement and receive the correct token budget.
- Coding and diagram requests use medium verbosity and a strict response-specific output contract.
- The existing screen-extraction request now returns CODING/DIAGRAM/OTHER metadata, so captured questions do not depend on the literal words "code" or "flowchart".
- Invalid prose-only code output gets one format-correction attempt; normal valid responses have no additional request.
- Arrow-chain diagram prose is converted immediately into a vertical Notepad/draw.io-ready box flow. A model correction is used only if no usable chain exists.

## Deployment

1. Push `backend/server.js` and the portal/backend files to the existing GitHub repository, then verify Railway redeploys the new commit.
2. From the project root run `npm ci` and `npm run dist:installer`.
3. Install and test v14.4.1 while system audio continues through a manual-send boundary.
4. Publish both the versioned installer and stable `Topper-Setup.exe` release asset.

No database migration or new environment variable is required.
