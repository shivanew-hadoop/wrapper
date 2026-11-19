# Quality v5: Cerebras and DeepSeek

- Added first-person, spoken-interview delivery to both chat-completions provider instruction paths only. Hypothetical questions use "I would"; factual past-tense experience is permitted only with resume evidence.
- Reinforced current-topic guardrails for AWS high availability, Terraform locking and Lake Formation access.
- No modifications to Sol/OpenAI, STT, frontend, RAG retrieval, streaming protocol or provider selection.
- Static tests do not establish 80–90% live answer similarity. Run the 11 interview questions against each provider after deployment.
