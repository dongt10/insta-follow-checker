# Insta Follow Checker

Browser scripts that check which Instagram accounts do not follow back, with exact verification when Instagram exposes enough relationship data and conservative "unknown" or "unconfirmed" results when it does not.

By [dongt10](https://github.com/dongt10).

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
- Skips requests it does not need: a relationship list that already loaded completely is not re-paged, for self-checks with many followers the wall-prone bulk follower list is skipped entirely, and if the following list is blocked outright the run stops before spending any follower requests.
- Saves progress to `localStorage` (1 hour TTL, scoped to your login and the target): if a rate-limit wall interrupts a run, rerunning the script reuses loaded lists, partially loaded pages (continuing from the saved position), and verified results, so it only requests what is still missing. The saved state is cleared automatically after a fully clean run so results never go stale.
- Prints only verified not-following-back accounts, with follows-back corrections and unknown results separated.
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
  minRequestIntervalMs: 700,       // hard minimum spacing between any two requests
  batchVerify: true,               // use batch friendship checks on your own account
  batchSize: 25,                   // accounts per batch friendship check
  skipFollowerListWhenSelf: "auto", // skip the bulk follower list on self-checks ("auto", true, false)
  resume: true,                    // reuse saved progress from interrupted runs
  resumeTtlMs: 3600000,            // how long saved progress stays valid (1 hour)
  retryLimit: 5,                   // retries per request
  retryBaseDelayMs: 12000,         // backoff base; rate walls back off exponentially
};
```

For large accounts, avoid setting delays too low. Instagram can rate-limit or log out fast request bursts. If a run does get walled, just wait 10-15 minutes and rerun: saved progress means the rerun only requests what is still missing.

## Bookmarklet

If you prefer a bookmarklet, use the one-line version in [bookmarklet.js](bookmarklet.js).

Create a new bookmark, paste the contents of `bookmarklet.js` into the URL field, then click that bookmark while you are on the Instagram profile page you want to check.

## Accuracy

Instagram may show profile counts that differ from the loaded list counts because of stale counts, unavailable accounts, or pagination quirks. This matters on accounts over 1k: the bulk followers endpoint can miss people who are actually followers.

To be exact down to the last account, the script never trusts the bulk comparison by itself:

- On your own account, every tentative miss gets a definitive answer from Instagram's friendship-status endpoint - the same data Instagram uses to render "Follows you" badges.
- On other accounts, every tentative miss is exact-searched in the target's followers (paginated, so common username prefixes do not hide a match). If exact search finds the username, the account is moved to "Follows back - corrected."
- Before any exact searches run, the script first searches for a known follower as a reliability check. If even a known follower cannot be found, search is considered unreliable and all unverified accounts are kept in "Unknown" instead of being miscounted.
- If verification fails because of a login or rate-limit wall, or a search has too many similar usernames to check definitively, the account is moved to "Unknown" instead of being counted as not following back. Rerunning after the wall clears finishes the Unknown accounts without redoing the verified ones.

## Rate limits

If you see a warning like `rate-limit wall (200)`, Instagram returned a temporary block page while still using HTTP 200. The script slows itself down (up to 8x spacing), retries with exponential backoff honoring any `Retry-After` header, and if the block persists, stops safely with no verified misses counted. Wait 10-15 minutes, refresh the profile, and rerun: the rerun reuses saved progress, so it is much lighter than the first run.

If you see `HTML/non-JSON wall (200)` on the followers list, Instagram served the normal website HTML instead of follower JSON for that profile/session. This can happen even while the following list still loads, and the Instagram follower modal may also show an empty/suggested-accounts state. When checking someone else's profile, the script stops with zero verified misses because it cannot prove who follows back until Instagram exposes real follower data again. When checking your own account, this wall does not affect accuracy because the batch friendship check answers directly.

The final report also keeps the full structured result in `window.IG_FOLLOW_BACK_RESULTS` and `window.IG_OVER1K_FOLLOW_BACK_RESULTS` until the page is reloaded.

## Limits and known problems

The commit history shows this script has mostly evolved around avoiding false positives and avoiding Instagram action blocks. The current scripts are careful, but they still have real limits:

- They depend on Instagram's private web endpoints and page data. Instagram can change those APIs, cookies, response shapes, or rate-limit behavior without warning.
- They only work from a signed-in browser session that can already view the target profile's follower and following lists. Private, blocked, restricted, or temporarily hidden lists cannot be bypassed.
- Large lists can be incomplete because of stale counts, unavailable accounts, pagination quirks, or Instagram returning HTML instead of JSON. The scripts try to verify tentative misses before counting them, but blocked data can still leave accounts in `Unknown` or `Unconfirmed`.
- Self-checks are the most reliable path because `show_many` can answer whether each account follows you back. Other-account checks cannot use that endpoint for the target account, so they rely on follower-list reads and limited exact searches.
- The public/other-account script is intentionally slower and may stop early. That is by design: earlier per-account search patterns could trigger "We limit how often you can do certain things" blocks, so unresolved accounts are parked for a later rerun instead of being forced through.
- Lowering the delays or verification caps can make the run faster, but it also increases the chance of temporary blocks, logout prompts, and incomplete results.
- Saved progress is only a local browser snapshot with a 1 hour default TTL. It helps resume interrupted runs, but the result can still become stale if accounts follow, unfollow, deactivate, or change privacy during or after the scan.
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

## License

MIT
