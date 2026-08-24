# Topper v14.3.1 upgrade

## What changed

- Professional public landing page at `https://topper.zapperapp.in`.
- Public features, workflow, pricing, download, login and signup experience.
- Terms, privacy, refund and contact pages for payment-provider onboarding.
- Support email: `support.topper@gmail.com`.
- Overlay default size increased from 760×430 to 1050×620 where the display permits.
- User-adjusted overlay bounds persist across collapse, restore and application restart.
- Visible overlay border and bottom-right resize cue.
- Manual prompt moved below Live Questions and above the button row.
- Buttons remain Capture Screen, Auto Send and Send, with Send last.
- Auto Send defaults to OFF once when upgrading to v14.3.x.
- Logged-in users no longer see Login or Sign up navigation.
- Activity history groups heartbeat deductions into one compact interview-session entry and initially shows only five recent activities.
- Live Questions has vertical scrolling and no horizontal scrolling.
- Dragging the Live Questions resize area grows the entire overlay by the same amount, preserving LLM answer space.

## Railway files

Deploy the complete `backend` folder, excluding local databases and `.env` files. Set:

```env
CORS_ORIGIN=https://topper.zapperapp.in,https://wrapper-production-1eac.up.railway.app
LAUNCH_TOKEN_TTL_SECONDS=120
DESKTOP_SESSION_TTL_DAYS=30
DESKTOP_INSTALLER_URL=https://github.com/shivanew-hadoop/topper-downloads/releases/latest/download/Topper-Setup.exe
REQUIRE_DESKTOP_AUTH=false
```

Keep `JWT_SECRET`, payment secrets, API keys, admin credentials and the `/data` volume unchanged.

## Build

```powershell
npm install
npm run dist:installer
```

Publish both `Topper-Setup-v14.3.1.exe` and an identical copy named `Topper-Setup.exe` in a normal GitHub Release tagged `v14.3.1`.

## Acceptance test

1. Open `https://topper.zapperapp.in` in Incognito and verify every public section and policy page.
2. Log in and verify existing credits/history.
3. Verify Buy Credits opens Razorpay Checkout.
4. Verify Download Topper resolves without 404.
5. Install v14.3.1 over the previous version and launch from the portal.
6. Verify secure account email and credits.
7. Start Listening and confirm Auto Send initially shows OFF.
8. Resize and move the overlay, collapse/expand it, then restart and confirm the bounds persist.
9. Drag Live Questions taller and confirm the overall overlay grows without shrinking the LLM answer area.
10. Confirm Capture Screen, transcription, streaming answers and credit deduction remain operational.
