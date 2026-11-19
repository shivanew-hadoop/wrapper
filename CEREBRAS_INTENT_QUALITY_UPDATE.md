# Cerebras interview-answer quality update

## Changes
- Cerebras-only compact interview policy replaces conflicting shared spoken no-bullets instructions.
- Deterministic, zero-LLM-call intent hints for Terraform concurrent applies, Terraform environments, EKS approach/basic syntax, Spark skew, and Kubernetes CPU throttling.
- Direct answer + 3–5 technical points when appropriate, preserving the candidate resume/JD evidence in the existing question prompt.
- Explicit EKS snippet scope; no fabricated terraform apply outputs.
- Existing Sol, DeepSeek, profile, embeddings, UI, licensing, and streaming routes are unchanged.

## Railway settings
CEREBRAS_REASONING_EFFORT=medium
CEREBRAS_ANSWER_STYLE=points
CEREBRAS_SPOKEN_TOKEN_BUDGET=900

## Validation
- node --check backend/server.js passed.
- Static assertions for both /ask and streaming request paths passed.
- No live Cerebras call, end-to-end test, or answer-quality parity guarantee.

## Rollback
Redeploy the previous ZIP or restore the original backend/server.js. No database migration is required.
