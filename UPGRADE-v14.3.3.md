# Topper v14.3.3 — stable private cursor

## Behaviour

- Inside Topper, the user sees a protected moving cursor across the content, header and window bounds.
- Screen-share viewers see a normal cursor frozen at the point where it entered Topper.
- Outside Topper, the Windows cursor resumes normally.
- All overlay title/hover tooltips have been removed.

## Release

1. Run `npm ci` from the project root.
2. Run `npm run dist:installer`.
3. Test full-screen sharing on the supported Windows and meeting-app versions.
4. Publish both `Topper-Setup-v14.3.3.exe` and the stable `Topper-Setup.exe` asset.

The native Windows resize cursor can briefly be controlled by Windows at the outermost resize border. Normal overlay content and header tracking use the protected cursor.
