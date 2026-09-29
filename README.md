# Topper v14.7.3

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

