# Instagram Follow Back Checker

A small browser script that checks which Instagram accounts do not follow back, with extra verification for large profiles where Instagram's bulk follower pages can be incomplete.

By [dongt10](https://github.com/dongt10).

## What it does

- Loads the accounts followed by the profile you are viewing.
- Loads the accounts that follow that profile.
- Detects the username from the Instagram profile URL you are currently viewing.
- De-duplicates usernames across paginated responses.
- Treats missing follower-list matches as tentative, then exact-searches the target profile's followers for each tentative miss.
- Prints only verified not-following-back accounts, with corrected and unknown results separated.
- Runs locally in your browser session.

It does not follow, unfollow, message, post, or change your Instagram account.

## Quick Start

1. Open Instagram in a desktop browser and sign in.
2. Go to the Instagram profile you want to check, for example `https://www.instagram.com/your_username/`.
3. Open DevTools Console:
   - macOS: `Command + Option + J`
   - Windows/Linux: `Ctrl + Shift + J`
4. Paste the script from [src/check-follow-back.js](src/check-follow-back.js).
5. Press Enter.

The page shows a progress overlay while it loads relationship lists and exact-checks tentative misses. When it finishes, the page is replaced with a result report.

Refresh the page to return to Instagram.

## Check a Different Username

The script automatically uses the first part of the current Instagram profile URL. If you want to override that, run this in the console before pasting the script:

```js
window.IG_FOLLOW_BACK_CONFIG = {
  targetUsername: "your_username",
};
```

The target profile must be visible to your current Instagram login. Private profiles still require normal Instagram access.

## Scan Settings

By default, the script pauses between paginated relationship-list requests and exact follower searches. To change those delays, set this before pasting the script:

```js
window.IG_FOLLOW_BACK_CONFIG = {
  relationshipListDelayMs: 1100,
  exactSearchDelayMs: 1400,
};
```

For large accounts, avoid setting these too low. Instagram can rate-limit or log out fast request bursts.

## Bookmarklet

If you prefer a bookmarklet, use the one-line version in [bookmarklet.js](bookmarklet.js).

Create a new bookmark, paste the contents of `bookmarklet.js` into the URL field, then click that bookmark while you are on the Instagram profile page you want to check.

## Notes

Instagram may show profile counts that differ from the loaded list counts because of stale counts, unavailable accounts, or pagination quirks. This matters on accounts over 1k: the bulk followers endpoint can miss people who are actually followers.

To avoid false positives, the script does not trust the bulk comparison by itself. It exact-searches each tentative miss in the target profile's followers. If exact search finds the username, the account is moved to "Corrected by exact follower search." If exact search fails because of a login or rate-limit wall, the account is moved to "Unknown" instead of being counted as not following back.

The final report also keeps the full structured result in `window.IG_FOLLOW_BACK_RESULTS` and `window.IG_OVER1K_FOLLOW_BACK_RESULTS` until the page is reloaded.

## Safety

Only run browser-console scripts you trust. This script is intentionally plain JavaScript with no dependencies so it can be inspected before running.

## License

MIT
