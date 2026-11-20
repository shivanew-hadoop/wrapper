# v7 DeepSeek follow-up and readability patch

Base: v6 DeepSeek Direct Answers + Selected Provider Preparation.

Only backend/server.js behavior changed. The active interview topic for ambiguous short follow-ups is grounded in recent interviewer questions, not prior model responses. Azure DevOps ARM service connections stay distinct from ServiceNow. Terraform module registry questions retain JFrog/Artifactory and terraform init context. Yes/No-first is restricted to actual yes/no questions. Cerebras and DeepSeek spoken prompts request short, separated lines instead of dense paragraphs; code/diagram contracts are preserved.

No frontend, STT, model routing, selected-provider resume/JD preparation, or streaming protocol changes. OpenAI/Sol prompt path is unchanged.

Static validation: node --check and QUALITY_V7_REGRESSION_TESTS.js passed. Live API end-to-end testing was not possible without provider credentials and deployment.
