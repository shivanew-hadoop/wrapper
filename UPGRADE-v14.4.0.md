# Topper v14.4.0

## Included fixes

- Uses the current Windows Arrow cursor image, dimensions and hotspot for both the protected moving pointer and frozen share-visible pointer. No npm dependency was added.
- Send and Ctrl+Enter wait only for a currently arriving transcript tail, include the visible interim words, and clear the full sent question.
- Typed and captured code formatting is preserved through the desktop/backend request.
- Coding questions always return a short Logic section followed by complete working code with inline comments.
- Coding follow-ups explain the requested point and repeat the complete solution for continuity.
- Flowchart and architecture-diagram requests return detailed Notepad/draw.io-friendly ASCII flows.
- Screen-captured and typed prompts use the same answer classification and quality rules.
- Enter submits portal login; Enter also submits the admin credit form.

## Deployment

1. Push the complete `backend` changes to the existing GitHub repository and allow Railway to redeploy.
2. From the project root run `npm ci` and `npm run dist:installer`.
3. Install and test v14.4.0 on Windows.
4. Publish `Topper-Setup-v14.4.0.exe` and replace the stable GitHub release asset `Topper-Setup.exe`.

No database migration or Railway variable change is required.
