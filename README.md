# Insta Follow Checker

A browser script that checks which Instagram accounts do not follow back, with exact verification when Instagram exposes enough relationship data and conservative "unknown" results when it does not. Works on your own account or anyone else's you can view — you do **not** need the target's password, just the ability to see their followers and following from your own logged-in account.

By [dongt10](https://github.com/dongt10).

## Easy Copy

Open the rendered helper page: [copy instagram follow back checker](https://raw.githack.com/dongt10/insta-follow-checker/main/copy.html?v=c978293).

Click the button to copy the script or its bookmarklet. It copies to your clipboard automatically; if the browser blocks clipboard access, the page shows a manual copy box.

Source links: [script](https://raw.githubusercontent.com/dongt10/insta-follow-checker/main/src/check-follow-back.js), [bookmarklet](https://raw.githubusercontent.com/dongt10/insta-follow-checker/main/bookmarklet.js).

## What it does

- Loads the accounts followed by the profile you are viewing.
- Verifies every tentative miss individually before counting it:
  - **Your own account:** uses Instagram's batch friendship endpoint (`show_many`), which returns a definitive follows-you-back answer for ~25 accounts per request. This is both exact and far lighter on requests than paging the whole follower list.
  - **Someone else's account:** loads their follower list and exact-searches each tentative miss in it.
- Paces every request: a minimum interval between requests, jittered delays, exponential backoff that honors `Retry-After` in full (including the HTTP-date form), and automatic slowdown (up to 8x spacing) whenever Instagram pushes back. Deterministic client errors are not retried at all.
- Skips requests it does not need: a relationship list that already loaded completely is not re-paged, self-checks only auto-skip the wall-prone bulk follower list when it is much larger than the following list, and if the following list is blocked outright the run stops before spending any follower requests.
- Saves progress to `localStorage` (1 hour TTL, scoped to your login and the target): interrupted reruns can reuse loaded lists, partial pages, and verified follows-back corrections. Saved not-following-back verdicts are cross-checked live before they appear in the final list, so stale false positives are not reused blindly.
- Prints only verified not-following-back accounts, with follows-back corrections and unknown results separated.
- Runs locally in your browser session.

It does not follow, unfollow, message, post, or change your Instagram account.

## Quick Start

1. Open Instagram in a desktop browser and sign in.
2. Go to the Instagram profile you want to check, for example `https://www.instagram.com/your_username/`.
3. Open DevTools Console:
   - macOS: `Command + Option + J`
   - Windows/Linux: `Ctrl + Shift + J`
4. Open the [copy helper](https://raw.githack.com/dongt10/insta-follow-checker/main/copy.html?v=c978293) and click **copy script**, or paste the script from [src/check-follow-back.js](src/check-follow-back.js).
5. Press Enter.

The page shows a progress overlay (including a live request count and current pacing) while it loads relationship lists and verifies tentative misses. When it finishes, the page is replaced with a result report.

Refresh the page to return to Instagram.

## Check a Different Username

The script automatically uses the first part of the current Instagram profile URL. If you want to override that, run this in the console before pasting the script:

```js
window.IG_FOLLOW_BACK_CONFIG = {
  targetUsername: "your_username",
};
```

The target profile must be visible to your current Instagram login. Private profiles still require normal Instagram access. The batch friendship check is only available when the target is the account you are logged in as; other profiles fall back to exact follower search.

## Scan Settings

All settings are optional. Set them in the console before pasting the script:

```js
window.IG_FOLLOW_BACK_CONFIG = {
  relationshipListDelayMs: 1800,   // delay between relationship-list pages
  exactSearchDelayMs: 2400,        // delay between exact follower searches
  batchDelayMs: 2600,              // delay between batch friendship checks
  individualDelayMs: 3200,         // delay between one-account friendship rechecks
  minRequestIntervalMs: 700,       // hard minimum spacing between any two requests
  batchVerify: true,               // use batch friendship checks on your own account
  batchSize: 25,                   // accounts per batch friendship check
  individualVerifyUnknowns: true,   // recheck unresolved batch results one by one
  maxIndividualRechecks: 80,        // safety cap so a broken batch response does not trigger hundreds of single checks
  previousUnknownUsernames: [],      // optional usernames from a prior Unknown list to prioritize one-by-one
  skipFollowerListWhenSelf: "auto", // skip bulk followers only when it is much larger than following (true, "auto", false)
  includeFollowingStatusHints: true, // use Instagram's follows_viewer hint as extra self-check candidates
  compareFollowingFeed: false,      // self-check only: also scan the GraphQL following feed used by simpler tools
  resume: true,                    // reuse saved list progress from interrupted runs
  resumeTtlMs: 3600000,            // how long saved progress stays valid (1 hour)
  reverifySavedMisses: true,        // cross-check saved not-following-back verdicts before reporting
  retryLimit: 5,                   // retries per request
  retryBaseDelayMs: 12000,         // backoff base; rate walls back off exponentially
};
```

For large accounts, avoid setting delays too low. Instagram can rate-limit or log out fast request bursts. If a run does get walled, wait 10-15 minutes and rerun. Resume makes the rerun lighter, but saved not-following-back verdicts are verified again so stale misses do not become false positives.

## Bookmarklet

If you prefer a bookmarklet, copy it from the [copy helper](https://raw.githack.com/dongt10/insta-follow-checker/main/copy.html?v=c978293) or use the one-line version in [bookmarklet.js](bookmarklet.js).

Create a new bookmark, paste the contents of `bookmarklet.js` into the URL field, then click that bookmark while you are on the Instagram profile page you want to check.

## Accuracy

Instagram may show profile counts that differ from the loaded list counts because of stale counts, unavailable accounts, or pagination quirks. The bulk followers endpoint can also miss people who are actually followers, so self-checks use the follower list when it is reasonably sized and only auto-skip it when it is much larger than the following list.

To be exact down to the last account, the script never trusts the bulk comparison by itself:

- On your own account, every tentative miss is checked with Instagram's batch friendship-status endpoint first. If the batch endpoint withholds a status, the script rechecks those unresolved accounts one by one before leaving them Unknown.
- On your own account, the script also preserves Instagram's `follows_viewer` hint from the following feed and uses it as an extra source of candidates to verify. This is the signal many simpler unfollower scripts count directly, so the final report shows it separately when it disagrees with verified results.
- If you want to compare directly against those simpler tools, set `window.IG_FOLLOW_BACK_CONFIG = { compareFollowingFeed: true }` before running. This adds a slower self-check-only pass over Instagram's GraphQL following feed and verifies anything it flags instead of trusting the hint blindly.
- On other accounts, every tentative miss is exact-searched in the target's followers (paginated, so common username prefixes do not hide a match). If exact search finds the username, the account is moved to "Follows back - corrected."
- Before any exact follower searches run, the script first searches for a known follower as a reliability check. For self-checks that skip the bulk follower list, that canary can come from a positive batch or individual friendship result. If no canary can prove search reliability, or even a known follower cannot be found, unverified accounts are kept in "Unknown" instead of being miscounted.
- If verification fails because of a login or rate-limit wall, or a search has too many similar usernames to check definitively, the account is moved to "Unknown" instead of being counted as not following back. Rerunning after the wall clears finishes the Unknown accounts without redoing the verified ones.

## Rate limits

If you see a warning like `rate-limit wall (200)`, Instagram returned a temporary block page while still using HTTP 200. The script slows itself down (up to 8x spacing), retries with exponential backoff honoring any `Retry-After` header, and if the block persists, stops safely with no verified misses counted. Wait 10-15 minutes, refresh the profile, and rerun; saved list progress is reused when available, while saved misses are cross-checked before reporting.

If you see `HTML/non-JSON wall (200)` on the followers list, Instagram served the normal website HTML instead of follower JSON for that profile/session. This can happen even while the following list still loads, and the Instagram follower modal may also show an empty/suggested-accounts state. When checking someone else's profile, the script stops with zero verified misses because it cannot prove who follows back until Instagram exposes real follower data again. When checking your own account, this wall does not affect accuracy because the batch friendship check answers directly.

The final report also keeps the full structured result in `window.IG_FOLLOW_BACK_RESULTS` and `window.IG_OVER1K_FOLLOW_BACK_RESULTS` until the page is reloaded.

## Limits and known problems

The commit history shows this script has mostly evolved around avoiding false positives and avoiding Instagram action blocks. The script is careful, but it still has real limits:

- It depends on Instagram's private web endpoints and page data. Instagram can change those APIs, cookies, response shapes, or rate-limit behavior without warning.
- It only works from a signed-in browser session that can already view the target profile's follower and following lists. Private, blocked, restricted, or temporarily hidden lists cannot be bypassed.
- Large lists can be incomplete because of stale counts, unavailable accounts, pagination quirks, or Instagram returning HTML instead of JSON. The script tries to verify tentative misses before counting them, but blocked data can still leave accounts in `Unknown`.
- Instagram may return fewer users than requested on each relationship-list page; for example, a request for `count=100` can still return roughly 25 users. This makes follower-list scans slower than the request size suggests.
- Self-checks are the most reliable path because `show_many` can answer whether each account follows you back. Small unresolved leftovers, or usernames you explicitly pass in `previousUnknownUsernames`, are rechecked one by one with the individual friendship endpoint. If a batch response shape breaks and hundreds of accounts become unresolved at once, the script stops that wave at `maxIndividualRechecks` and keeps the rest in `Unknown` instead of hammering Instagram.
- Checking someone else's account is slower and less guarded: `show_many` only answers for your own account, so tentative misses are verified with an exact search per account instead of one batch call. There is no dedicated per-run cap on how many searches that can take, so for accounts with a lot of tentative misses, consider raising `exactSearchDelayMs` and `minRequestIntervalMs` above their defaults to reduce action-block risk.
- Lowering the delays or verification caps can make the run faster, but it also increases the chance of temporary blocks, logout prompts, and incomplete results.
- Saved progress stores a local browser snapshot with a 1 hour default TTL. It helps resume interrupted runs, and saved not-following-back results are cross-checked live before reporting, but profile changes during a scan can still leave accounts in `Unknown`.
- The script does not run on Instagram's behalf as an approved integration. Treat it as an inspectable browser-console utility, not a guaranteed long-term API client.

## Safety

Only run browser-console scripts you trust. This script is intentionally plain JavaScript with no dependencies so it can be inspected before running.

## license

[mit](LICENSE)
