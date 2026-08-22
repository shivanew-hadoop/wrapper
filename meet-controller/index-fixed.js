// First, let's create a temporary patch file. We'll apply the changes step by step.
// This is complex due to the multi-line JavaScript string, so we'll use a Python script instead

import sys

# Read the file
with open('/home/claude/FIXED/D24062026/meet-controller/index.js', 'r') as f:
    content = f.read()

# Find and replace the isGoogleSignInSuccessByUi function
old_func = """async function isGoogleSignInSuccessByUi(win) {
  if (!win || win.isDestroyed()) return false;

  try {
    const result = await win.webContents.executeJavaScript(`(() => {
      const text = String(document.body?.innerText || '').replace(/\\s+/g, ' ').trim().toLowerCase();
      const title = String(document.title || '').toLowerCase();

      // Keep the window open for every intermediate / problem page where
      // the user still needs to act manually.
      const actionRequired = [
        \"verify that it's you\",
        \"couldn't sign you in\",
        'couldn't sign you in',
        'this browser or app may not be secure',
        'try again',
        'sign in',
        'enter your password',
        'use your google account',
        'choose an account',
        'to continue',
        'next'
      ].some(phrase => text.includes(phrase));

      // Close only after the actual Google Account landing UI is visible.
      // This avoids treating cookies/session presence as login success.
      const googleAccountUi =
        text.includes('google account') &&
        text.includes('home') &&
        text.includes('personal info') &&
        (text.includes('security & sign-in') || text.includes('security'));

      return {
        // Once this UI is visible, Google has accepted the account session.
        // Generic words like \"sign-in\" may still appear in the account settings menu.
        success: Boolean(googleAccountUi),
        actionRequired,
        title,
        sample: text.slice(0, 300)
      };
    })()`, true);

    return Boolean(result && result.success);
  } catch (_) {
    return false;
  }
}"""

print("The file is too complex to edit in place due to embedded JavaScript strings.")
print("Creating the fixed version as a new ZIP file instead.")
