# Hybrid routing — Cerebras + GPT-5.6 Sol Fast

This build keeps the existing Topper UI, Electron IPC, Deepgram STT, RAG, prompt construction, streaming SSE contract, screen capture, licensing and Go Back behavior unchanged.

## Routing policy
The router is deterministic and local, so it adds no classifier API call and no classifier latency. It is deliberately conservative: uncertain requests go to Sol.

**Cerebras GPT-OSS-120B** is used only when a question is clearly self-contained and straightforward, such as short definitions, basic explanations and simple comparisons.

**GPT-5.6 Sol Fast** is used for coding, diagrams, debugging, architecture/system design, scenarios, production/trade-off questions, candidate/resume-grounded questions, follow-ups, multi-part or long questions, and any question whose simple-route confidence is below the configured threshold. Screen/vision remains OpenAI.

If Cerebras fails or stalls before the first answer token, the same request automatically falls back to Sol Fast. No partial Cerebras answer is mixed with Sol.

## Railway variables
Keep all existing variables and add/confirm:

OPENAI_API_KEY=<key>
OPENAI_MODEL=gpt-5.6-sol
OPENAI_PROFILE_MODEL=gpt-5.6-sol
OPENAI_VISION_MODEL=gpt-5.6-sol
OPENAI_SERVICE_TIER=fast
LLM_REASONING_EFFORT=low
CEREBRAS_API_KEY=<key>
CEREBRAS_MODEL=gpt-oss-120b
CEREBRAS_API_BASE=https://api.cerebras.ai/v1
CEREBRAS_SERVICE_TIER=default
LLM_ROUTING_ENABLED=true
LLM_ROUTER_SOL_THRESHOLD=5
LLM_ROUTER_MIN_SIMPLE_CONFIDENCE=0.78

## Tuning
Defaults favor quality. Raise `LLM_ROUTER_SOL_THRESHOLD` (for example 6) or lower `LLM_ROUTER_MIN_SIMPLE_CONFIDENCE` slightly only if you deliberately want more traffic on Cerebras. Lowering the Sol threshold makes routing more quality-conservative.

`/health` reports whether both providers are configured and whether routing is enabled. Runtime logs and SSE metadata include the selected model tier and route reason.
