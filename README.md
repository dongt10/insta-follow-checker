# Insta Follow Checker

Browser scripts that check which Instagram accounts do not follow back, with exact verification when Instagram exposes enough relationship data and conservative "unknown" or "unconfirmed" results when it does not.

By [dongt10](https://github.com/dongt10).

## Easy Copy

Open the rendered helper page: [copy instagram follow back checker](https://raw.githack.com/dongt10/insta-follow-checker/main/copy.html?v=1814cd0).

Click the button for the script or bookmarklet you want. It copies to your clipboard automatically; if the browser blocks clipboard access, the page shows a manual copy box.

- **Self-check console script** for your own account.
- **Public-account console script** for another visible account.
- Matching bookmarklets for both scripts.

Source links: [self-check script](https://raw.githubusercontent.com/dongt10/insta-follow-checker/main/src/check-follow-back.js), [public-account script](https://raw.githubusercontent.com/dongt10/insta-follow-checker/main/src/check-non-followers-public.js), [self-check bookmarklet](https://raw.githubusercontent.com/dongt10/insta-follow-checker/main/bookmarklet.js), [public-account bookmarklet](https://raw.githubusercontent.com/dongt10/insta-follow-checker/main/bookmarklet-public.js).

## Which script to use

There are two scripts because checking your own account and checking someone else's account have fundamentally different, and conflicting, request patterns. Using the right one keeps each fast and block-safe.

| You are checking | Use | Why |
| --- | --- | --- |
| **Your own account** | [src/check-follow-back.js](src/check-follow-back.js) | Can use Instagram's batch friendship endpoint (`show_many`) — a definitive answer for ~25 accounts per request. Fastest and exact. |
| **Anyone else's account** you can view (public, or private you follow) | [src/check-non-followers-public.js](src/check-non-followers-public.js) | `show_many` only reports relationships relative to *you*, so it cannot answer whether one other account follows another. This script reads the target's follower list once, gently, and takes the exact difference, avoiding the per-account search storm that triggers Instagram's action block. |

You do **not** need the target's password. You only need to be able to see their followers and following from your own logged-in account.

The rest of this README documents the main self-check script. The public script is documented in [its own section below](#checking-someone-elses-account-public-script).

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
4. Open the [copy helper](https://raw.githack.com/dongt10/insta-follow-checker/main/copy.html?v=1814cd0) and click **copy script** for the self-check script, or paste the script from [src/check-follow-back.js](src/check-follow-back.js).
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

If you prefer a bookmarklet, copy it from the [copy helper](https://raw.githack.com/dongt10/insta-follow-checker/main/copy.html?v=1814cd0) or use the one-line version in [bookmarklet.js](bookmarklet.js).

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

The commit history shows this script has mostly evolved around avoiding false positives and avoiding Instagram action blocks. The current scripts are careful, but they still have real limits:

- They depend on Instagram's private web endpoints and page data. Instagram can change those APIs, cookies, response shapes, or rate-limit behavior without warning.
- They only work from a signed-in browser session that can already view the target profile's follower and following lists. Private, blocked, restricted, or temporarily hidden lists cannot be bypassed.
- Large lists can be incomplete because of stale counts, unavailable accounts, pagination quirks, or Instagram returning HTML instead of JSON. The scripts try to verify tentative misses before counting them, but blocked data can still leave accounts in `Unknown` or `Unconfirmed`.
- Instagram may return fewer users than requested on each relationship-list page; for example, a request for `count=100` can still return roughly 25 users. This makes follower-list scans slower than the request size suggests.
- Self-checks are the most reliable path because `show_many` can answer whether each account follows you back. Small unresolved leftovers, or usernames you explicitly pass in `previousUnknownUsernames`, are rechecked one by one with the individual friendship endpoint. If a batch response shape breaks and hundreds of accounts become unresolved at once, the script stops that wave at `maxIndividualRechecks` and keeps the rest in `Unknown` instead of hammering Instagram.
- The public/other-account script is intentionally slower and may stop early. That is by design: earlier per-account search patterns could trigger "We limit how often you can do certain things" blocks, so unresolved accounts are parked for a later rerun instead of being forced through.
- Lowering the delays or verification caps can make the run faster, but it also increases the chance of temporary blocks, logout prompts, and incomplete results.
- Saved progress stores a local browser snapshot with a 1 hour default TTL. It helps resume interrupted runs, and saved not-following-back results are cross-checked live before reporting, but profile changes during a scan can still leave accounts in `Unknown`.
- The scripts do not run on Instagram's behalf as an approved integration. Treat them as inspectable browser-console utilities, not a guaranteed long-term API client.

## Checking someone else's account (public script)

Use [src/check-non-followers-public.js](src/check-non-followers-public.js) to check a friend's account you can view but do not own. Paste it into the console exactly like the main script, while viewing the profile you want to check (or set `window.IG_NON_FOLLOWERS_CONFIG = { targetUsername: "their_username" }` first). There is a matching one-line bookmarklet in [bookmarklet-public.js](bookmarklet-public.js).

**How it avoids the action block.** Instagram shows a "We limit how often you can do certain things" warning, and temporarily hides follower/following lists, when it sees rapid automated list loading. The biggest trigger is searching the follower list once per missing account — hundreds of near-identical requests. This script is built to not do that:

- It reads the following list and the follower list **once each**, paged gently (a longer delay between pages, a 1.5s minimum interval between any two requests, automatic slowdown up to 8x whenever Instagram pushes back).
- If the follower list reads to the end and matches the profile's follower count, the difference is **exact with zero per-account searches** — this is the normal case for accounts up to ~2k, and it is completely block-safe. A 2,000-follower account finishes in roughly 35 requests over about 2-3 minutes.
- Per-account exact search runs **only** when Instagram under-reported the follower list (so some accounts genuinely cannot be confirmed from the bulk read). Even then it is capped per run (`maxVerifications`, default 150), paced slowly, preceded by a known-follower reliability check, and it **aborts on the first sign of a block** — parking the rest as "Unconfirmed" rather than pushing into a block.
- At the **first** action block, the run stops, saves progress, and tells you to wait. Rerunning reuses saved pages and verified results, so the rerun is light and continues where the block hit instead of starting the heavy load over.

**Results are split by certainty so nothing is overstated:**

- **Not following back — confirmed:** exact. Either the follower list was read completely, or the account was individually verified as a non-follower.
- **Not following back — unconfirmed:** the follower list was incomplete and the account could not be proven. It is *not* counted as a definite non-follower. Rerun later (saved progress resumes) to resolve these.
- **Actually follows back — removed:** a tentative miss that verification proved is really a follower (a false positive the bulk read would have shown).
- **Unknown:** verification hit a wall for these specific accounts.
- **Bonus:** followers the target does not follow back, computed for free from the same two lists.

**Speed vs. block-safety knobs** (set in `window.IG_NON_FOLLOWERS_CONFIG` before pasting):

```js
window.IG_NON_FOLLOWERS_CONFIG = {
  targetUsername: "",        // or detect from the profile URL you are viewing
  listDelayMs: 3500,         // delay between follower/following pages (lower = faster, riskier)
  minRequestIntervalMs: 1500, // hard minimum spacing between any two requests
  verifyMisses: "auto",      // "auto" = verify only when the follower list is incomplete; false = never search; true = always
  verifyDelayMs: 4500,       // delay between exact searches when verification is needed
  maxVerifications: 150,     // safety cap on searches per run; reruns continue beyond it
  resume: true,              // reuse saved progress from interrupted runs
};
```

The defaults are deliberately conservative because you got action-blocked before. They are gentle enough that the common (complete-list) case never searches at all. The full structured result is kept in `window.IG_NON_FOLLOWERS_RESULTS` until the page is reloaded.

Note: this script also works on your own account, but [src/check-follow-back.js](src/check-follow-back.js) is faster there because it can use the batch friendship endpoint.

## Safety

Only run browser-console scripts you trust. These scripts are intentionally plain JavaScript with no dependencies so they can be inspected before running.

## license

[mit](LICENSE)
