# Topper v14.3.2 — Private overlay cursor

## What changed

- The real Windows cursor is hidden while it is over Topper's renderer area.
- Topper draws a local replacement cursor inside its existing capture-protected overlay.
- Buttons, typing, dragging, streaming, credits, audio, payments and backend behavior are unchanged.

## Build and release

1. Run `npm ci`.
2. Run `npm run dist:installer`.
3. Test the installer on Windows while sharing the full screen in the meeting application you support.
4. Publish `Topper-Setup-v14.3.2.exe` and the stable `Topper-Setup.exe` release asset.

## Windows limitation

The native resize border is owned by Windows rather than the protected web renderer. Resize Topper before screen sharing. The private cursor applies to all normal controls and content inside the overlay.
