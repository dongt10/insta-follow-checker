# Instagram Follow Back Checker

A small browser script that compares the accounts you follow with the accounts that follow you back on Instagram.

By [dongt10](https://github.com/dongt10).

## What it does

- Loads the accounts you follow from the currently signed-in browser tab.
- Detects the username from the Instagram profile URL you are currently viewing.
- De-duplicates usernames across paginated responses.
- Checks each account you follow one by one by loading that profile's relationship status.
- Prints the accounts you follow that do not follow you back.
- Runs locally in your browser session.

It does not follow, unfollow, message, post, or change your Instagram account.

## Quick Start

1. Open Instagram in a desktop browser and sign in.
2. Go to your profile page, for example `https://www.instagram.com/your_username/`.
3. Open DevTools Console:
   - macOS: `Command + Option + J`
   - Windows/Linux: `Ctrl + Shift + J`
4. Paste the script from [src/check-follow-back.js](src/check-follow-back.js).
5. Press Enter.

The page will be replaced with a plain text progress report while it checks profiles one by one.

Refresh the page to return to Instagram.

## Check a Different Username

The script automatically uses the first part of the current Instagram profile URL. If you want to override that, run this in the console before pasting the script:

```js
window.IG_FOLLOW_BACK_USERNAME = "your_username";
```

The one-by-one check only works for the profile you are signed in as. If Instagram blocks the signed-in user API, the script falls back to confirming that the current profile page shows your own profile controls. If you override the username, use your own username.

## Scan Settings

By default, the script pauses between profile checks. To change the delay or cap a test run, set this before pasting the script:

```js
window.IG_FOLLOW_BACK_CONFIG = {
  profileCheckDelayMs: 1200,
  maxProfileChecks: Infinity,
};
```

## Bookmarklet

If you prefer a bookmarklet, use the one-line version in [bookmarklet.js](bookmarklet.js).

Create a new bookmark, paste the contents of `bookmarklet.js` into the URL field, then click that bookmark while you are on your Instagram profile page.

## Notes

Instagram may show profile counts that differ slightly from the loaded list counts because of stale counts, unavailable accounts, or pagination quirks. The script prints both the profile counts and the loaded unique counts so you can see that difference.

The script makes one profile lookup for every account you follow. Keep the tab open until the final report appears, and use a slower delay if Instagram starts rate limiting requests.

## Safety

Only run browser-console scripts you trust. This script is intentionally plain JavaScript with no dependencies so it can be inspected before running.

## License

MIT
