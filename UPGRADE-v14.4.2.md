# Topper v14.4.2 upgrade

This release fixes response-intent routing without adding an extra model call.

## Changed behavior

- The final complete interviewer question is reframed locally and sent to the LLM as the authoritative intent.
- Experience, behavioral, project and conceptual questions remain spoken answers even when their transcript contains words such as `code`, `coding`, `DevOps`, a language, class or module.
- Code output is used only for explicit implementation/algorithm tasks or an unambiguous follow-up about the immediately previous code.
- A new unrelated question exits coding mode immediately.
- Coding answers require short logic, complete runnable code and meaningful inline comments.
- Coding follow-ups answer the follow-up briefly and repeat the complete previous solution.
- Diagram requests require Unicode box-drawing output suitable for Notepad or draw.io; one-line prose flows are converted locally when possible.
- Screen-capture task extraction follows the same intent rules.

## Railway backend deployment

1. Replace the repository files with this release while preserving your real `.env`, Railway variables and persistent data volume.
2. This ZIP intentionally excludes `backend/users.json`, `.env`, databases, installers and dependency folders. Never overwrite or commit live account data or secrets.
3. If `backend/users.json` was previously tracked, preserve your local copy and run `git rm --cached backend/users.json` once; the updated `.gitignore` prevents it being committed again.
4. Commit and push at least `.gitignore`, `backend/.dockerignore`, `backend/server.js`, `package.json`, `package-lock.json` and this guide.
5. Confirm the Railway service root directory remains `/backend`.
6. Railway should build from `backend/package.json`; no new environment variable or database migration is required.
7. Redeploy and confirm `/health` returns `{ "ok": true }`.
8. Test the Agile and Xpedition experience examples from the release checklist below.

## Windows installer

From the project root on Windows:

```powershell
npm ci
npm run dist:installer
```

Upload `dist/Topper-v14.4.2/Topper-Setup-v14.4.2.exe` to the matching GitHub release and update the Railway download-version variable only if your portal uses one. The response-intent fix itself is backend-side, so users receive it after Railway deploys; the new installer carries the matching app version.

## Release checklist

- The Agile question that mentions code returns a normal spoken answer without `Logic:` or Java code.
- The Xpedition/Capital experience question returns a normal spoken answer even immediately after a coding question.
- `Find the first non-duplicate character in a string` returns logic and complete commented code.
- `Why did you use a HashMap in that code?` answers briefly and repeats the full prior code.
- A later unrelated experience question resets to spoken mode.
- A flowchart request returns connected `┌ ─ ┐ │ └ ┘` boxes with arrows.
- Typed, system-audio and captured-screen inputs follow the same routing rules.

## Latency expectation

Intent detection and reframing are local and add no network request. Streaming still begins as soon as the answer provider returns its first token. A sub-500 ms first token cannot be guaranteed for every unique remote LLM request because provider compute, network distance and Railway routing remain external factors.
