# v3 Cerebras + DeepSeek quality update

- Both Cerebras and DeepSeek now share topic-aware, concise interview answer instructions.
- The latest interviewer question takes precedence over old conversation content.
- Both chat providers receive a compact prompt containing current question, relevant resume evidence, and genuine follow-up context, without old answers or conflicting format directives.
- Topic hints cover Terraform concurrent apply (including STT 'data home'), Terraform environment structure, AWS HA/DR, Spark slowdown, Kubernetes CPU throttling, EKS approach/syntax, department data governance, and production incidents.
- Existing Sol/OpenAI request inputs and instructions remain unchanged. DeepSeek/Cerebras API adapters, model names, streaming, response formats, RAG retrieval, frontend and STT unchanged.
- No new Railway variables required. Existing Cerebras and DeepSeek API keys/model settings remain valid.

## Validation
- `node --check backend/server.js` passes.
- 8 deterministic topic regression tests and 4 provider-isolation assertions pass.
- No live provider API calls were made; 80-90% generated-answer quality cannot be certified from local checks.
