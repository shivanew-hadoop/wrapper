# Topper v14.7.1

This is the replacement package based on v14.7.0. No new Railway environment variables are required.

## v14.7.1 changes

- Removed the temporary `[PERF]` / `[PERF UI]` latency diagnostic logging path while retaining v14.7.0 latency optimizations, prefetching, caches, fast retrieval, and SSE no-buffer behavior.
- Coding follow-up intent is preserved. A modifier such as `without StringBuilder`, `avoid streams`, or `another approach` stays attached to the previous coding task and requires the complete updated code.
- Broken/dead-link implementation questions return a concise explanation plus a practical `Code snippet:` instead of explanation only.
- Resume is required; job description is optional. With no JD, interview context and retrieval use the resume alone.
- Years of experience and target role are auto-detected during Prepare Interview, shown as disabled fields, and saved for the next setup reload. Years are inferred from the resume; role prefers the JD title when available and otherwise the resume role.
- Added `Re-answer` in the overlay. It reruns the previous prompt with the same grounding and constraints while asking for a materially different accurate approach rather than repeating the prior answer.
- Repeated Capture Screen clicks accumulate numbered screen captures. Capture follows the display under the mouse pointer, so moving the pointer to another monitor before Capture Screen stages that display too. On Send, any current unsent spoken question/follow-up is appended after the captured screen content and submitted together.
- Screen extraction keeps all visible material relevant to the solution, including supporting code, errors, constraints, expected output, data, and diagram labels. Screen-capture prompts allow a larger input size for multi-screen tasks.
- Live transcript correction still uses resume/JD canonical vocabulary and recent technical context, with an explicit high-confidence correction for speech such as `ask and quarks` to `*args and **kwargs`.
- Version questions answer with the version first. When a technology is in the interview context but the exact project version is undocumented, the answer uses a conservative production-era version estimate rather than stopping with a resume disclaimer.
- Unsupported technologies keep the factual boundary, then immediately provide a strong production-style implementation/validation approach. The app does not fabricate unsupported personal POC, freelance, or production claims.

## Intentionally unchanged

Model selection and routing (Sol, Terra, Luna, Cerebras), reasoning settings, answer token ceilings, resume grounding rules, adaptive examples, Deepgram/system-audio capture and recovery, SQL/commerce/licensing, PDF transcript behavior, overlay size/position, and Railway configuration are otherwise unchanged.
