# DeepSeek direct-answer + provider-selected preparation update

Base: user-uploaded Topper v14.7.15 Cerebras/DeepSeek v5 First-Person ZIP.

- DeepSeek and Cerebras: yes/no questions lead with Yes/No; short factual questions lead with the fact; concise first-person spoken answers, no unrelated follow-up topic switches.
- Resume/JD preparation: Cerebras and DeepSeek use their own selected API for profile generation, not OpenAI; retrieval uses local lexical ranking and does not call OpenAI embeddings.
- Terra/Luna preparation: use the selected OpenAI model for profile generation; Sol remains default for Sol. Embeddings remain OpenAI for OpenAI-family providers.
- DeepSeek/Cerebras runtime retrieval: local lexical retrieval avoids OpenAI embedding requests.
- No changes to Electron frontend, STT, provider selection UI, or streaming response protocol.

Validation: node --check, ZIP CRC; no live API keys available. This package was built from the uploaded v5 First-Person source, because the newer selected-provider-fix ZIP was not uploaded.
