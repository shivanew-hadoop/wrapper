# Topper v4 — Cerebras + DeepSeek targeted quality fixes

## Evidence reviewed
- ChatGPT interview reference PDF (`ER930pm_2.pdf`), previously supplied.
- Cerebras v2 and v3 interview transcripts (11 questions each).
- DeepSeek v3 interview transcript (`Topper_Nov20th_1251AM_IST_deepseek.pdf`, 11 questions).

## Changes
Only `backend/server.js` chat-provider quality guidance and input assembly were changed relative to v3. Sol/OpenAI provider routing, Deepgram STT, RAG generation/retrieval, Electron frontend, HTTP endpoint contracts, model IDs and stream handling remain as in v3.

- Spark: baseline-vs-regression, evidence-based skew diagnosis; avoid repartitioning on the same hot key as a skew fix.
- AWS HA/DR: avoid invented Kinesis/Route 53/EMR behaviors, quantify throughput and test RPO/RTO.
- Kubernetes: direct CFS throttled-period ratio; distinguish quota throttling from node saturation.
- Terraform: valid literal or -backend-config S3 backend, `use_lockfile=true`; separate environment state; avoid unsafe lockfile assumptions.
- Terraform CI/CD: target-state plan, approval, same saved plan artifact, detect stale plans; avoid grep-based policy gates.
- AWS security/department access: remain in the current cloud context; use Lake Formation row/column restrictions where relevant; don't jump to GCP unprompted.
- Real-world incidents: require resume evidence for first-person facts and numbers; otherwise give a clearly labeled representative approach.
- DeepSeek: retain v3's working responses; shared targeted guidance only, no provider/parameter changes.

## Checks performed
- `node --check backend/server.js` — PASS.
- 12 deterministic interview topic regression cases — PASS.
- Both provider prompt isolation tests (resume evidence/presentation preference retained, old answers excluded) — PASS.
- OpenAI/Sol prompt selection untouched — PASS by source inspection and isolated test.
- ZIP integrity — PASS.

## Not verified
- No live API keys or Railway runtime were used. Actual Cerebras/DeepSeek quality, latency, production deployments and an 80–90% ChatGPT-equivalence target **cannot be certified** from syntax and deterministic tests. Repeat the same 11 interview questions through each provider after deployment and score factual correctness, topic relevance, resume grounding, and response time.

## Deployment
Deploy the updated package/backend as before. Keep existing environment variables and API keys. No new Railway variable is required. Keep the previous v3 ZIP as rollback.
