# DeepSeek spoken quality pilot
Only backend/server.js changed in application code. Existing version and other providers retained. New local prompt regression test included.
Observed transcript issues: Q7 speech noise; Q14 lost AI antecedent; Q17 GPO ambiguity; Q2 invented split; Q6/Q8 SLA recovery; Q23 Redshift terminology. New spoken input retains three bounded interviewer questions, separates resume/JD, includes bounded project timeline and asks for concrete implementation and concise speech. Existing specialized intent, flow, handoff and regenerate routes retained. No additional network call or token budget change. Existing format repair remains unchanged.
Tests: node --check backend/server.js; all six existing QUALITY suites and new QUALITY_DEEPSEEK_SPOKEN_TESTS.js passed locally. These are deterministic prompt tests, not live model output tests. No API credentials or deployed Windows environment available; latency and live quality not verified. Deploy backend in staging, replay all 24 transcript questions with original CV/JD, compare correctness and p50/p95 first-token and total latency before rollout. Rollback by restoring original backend/server.js. Other dropdowns intentionally unchanged pending pilot validation.

## v14.9.23 format + grounding pass (DeepSeek spoken only)
Changed: backend/server.js (DeepSeek spoken prompt text and deterministic STT repairs only); added QUALITY_DEEPSEEK_FORMAT_TESTS.js.
Fixes from the 24 Nov transcript vs ChatGPT: labelled "- **Label:** detail" bullets for flow/design/how-to answers (overlay already renders these); answer the data layer (S3/Lambda/Snowflake) instead of LangChain/RAG when the thread is ingestion; answer every distinct question in a long speech; CV-listed tools (S3, Lambda, Snowflake Streams, Databricks) are no longer denied; no CV/JD/gap talk in speech; STT repairs (s three, snow pipe, next scale).
Unchanged: routing, models, retrieval, token budgets, format repair, no extra network call, Cerebras/OpenAI paths. Added ~1.9k chars to the system prompt and ~0.9k bounded chars to the user prompt; timeline excerpt trimmed 2600->2300. Live quality and latency not verified (no API key here): replay the 17 questions in staging and compare p50/p95 first-token.
Rollback: restore previous backend/server.js.

## v14.9.24 plain format, consistency, GPT-4o option, role extraction
Changed: backend/server.js, main.js, setup/index.html, setup/setup.js; QUALITY_DEEPSEEK_FORMAT_TESTS.js rewritten; one assertion in QUALITY_DEEPSEEK_SPOKEN_TESTS.js updated (earlier answers are now passed, bounded and labelled).
- Format: plain 3-5 spoken lines by default; bullets only for real multi-part sequences; no stock "I validate by" closer; plain words plus real API/config names.
- Contradictions (production vs pilot, MCP): the spoken prompt previously carried earlier questions but not earlier answers, and the resume does not state rollout status. Now the last two answers (<=1000 chars) are passed as consistency context, unknown facts are never asserted, and local technical checks cover "tool calling only MCP" (answer No) and project status / user counts.
- "ok" / "thank you" style acknowledgements go through the existing no-answer guard: no model call.
- Screen capture + spoken question are kept apart in the prompt; coding requirements are implemented literally.
- GPT-4o dropdown option ("gpt4o"): OpenAI Chat Completions, model GPT4O_MODEL (default gpt-4o), same instructions/input/token ceiling/streaming as DeepSeek, local retrieval (no embedding calls), no extra calls, no reasoning/service-tier fields. Uses OPENAI_API_KEY.
- Role: title pattern now knows Forward-Deployed, GenAI, Conversational, Scientist etc.; ALL-CAPS titles are title-cased; a JD title line beats a "looking for ... engineer" sentence; CV "A / B / C" lists keep the CV seniority and pick the alternative matching the JD's role noun. Priority is unchanged: supplied role, CV title, JD title, inferred.
Not verified live: model output quality and latency (no API keys here). Replay the 12 questions in staging for DeepSeek and GPT-4o and compare p50/p95 first-token and total latency. Rollback: restore previous backend/server.js, main.js, setup files.

## v14.9.25 (built on v14.9.23; v14.9.24 prompt changes dropped)
Baseline: v14.9.23 DeepSeek spoken prompt and input builder, restored verbatim (v14.9.24's plain-by-default format, plain-words block, earlier-answers memory and screen split are NOT included).
Changed on top of v23:
- Format: bullets keep v23's trigger (flow/design/how-to) but are now "- I ..." sentences with the stage/topic folded into the sentence; no headings, "Label:" prefixes or bold. Definitions ("what is/what are") stay plain lines.
- SQL vs SOQL: "SQL" means standard relational SQL; SOQL only when the interviewer says SOQL/Salesforce (local technical check + rule "technology asked = technology answered").
- Mishearing repairs (local, no model call): joints->joins (near SQL), implicit/explicit/fluent rate->wait, optics->objects (near Salesforce), profiles and roads->roles. Never tell the interviewer a term "doesn't exist".
Kept from v14.9.24 because they do not change answer format: GPT-4o dropdown option (same prompts/limits/streaming as DeepSeek), CV+JD role extraction, "ok/thank you" no-answer guard, local checks for "tool calling only MCP" (answer No) and project status/user counts.
Not verified live (no API keys). Replay in staging and compare p50/p95 latency. Rollback: restore previous backend/server.js, main.js, setup files.
