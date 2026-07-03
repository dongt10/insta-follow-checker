# Adaptive request pacing

**Date:** 2026-07-02
**Status:** Approved
**Goal:** Make runs on accounts with 500+ followers/followings substantially faster without raising the chance that Instagram walls the session. The pacing layer should find each session's sweet spot automatically instead of hardcoding worst-case delays.

## Background: measured baseline

`node scripts/simulate-scale.mjs` (virtual clock, no real requests) today:

| scenario | requests | simulated wall-clock |
|---|---|---|
| A: 2,000 followers / 1,400 following, 2 transient rate walls | 49 | 6.0 min |
| B7: 506 followers / 547 following, unreadable batch | 56 | 3.1 min |
| B: 5,000 followers / 800 following, follower list skipped | 41 | 2.0 min |

Four causes, in order of impact:

1. **Slowdown ratchet never recovers.** Any wall doubles `pacing.slowdownFactor` (up to 8×) and it only halves after 25 consecutive clean responses. Whole runs are ~35–60 requests, so one wall early means the rest of the run stays at 2–4× spacing.
2. **Flat worst-case delays.** 1800ms between list pages, 2600ms between batches, 3200ms between individual checks, even when every response is clean. Jitter only *adds* time (+0–600ms).
3. **Redundant second sweep.** When the loaded list is smaller than the profile count — normal, because profile counts include deactivated accounts — the entire list is re-paged at count=50 (double the pages) and usually adds ~0 accounts.
4. **Exact-search path** (other people's accounts): 2400ms per tentative miss; hundreds of misses take many minutes.

Total request volume (35–350 per run) is far below the region where Instagram pushes back. The script over-brakes; it does not over-drive.

## Design

Four mechanisms. Everything else — wall detection (auth/rate/HTML), the retry loop with exponential backoff and `Retry-After` honoring, resume/localStorage, verdict rechecking, the exact-search canary, the individual-recheck safety cap, verification ordering — is untouched.

### 1. Continuous pace factor (replaces the integer ratchet)

`pacing.slowdownFactor` (integer 1→2→4→8) becomes `pacing.paceFactor`, a float in `[minPaceFactor, maxSlowdownFactor]` (defaults 0.6–8.0), starting at 1.0.

- **Clean response** (`reportCleanResponse`): `paceFactor = max(minPaceFactor, paceFactor * paceSpeedupPerClean)` with `paceSpeedupPerClean: 0.93`. Roughly 10 clean responses reach ~half pacing; the speedup carries across phases. The `cleanStreak` counter is removed.
- **Wall** (`reportWall`, fired on rate/HTML walls as today): `paceFactor = min(maxSlowdownFactor, max(paceFactor, 1) * wallSlowdownMultiplier)` with `wallSlowdownMultiplier: 3`. That is a harder immediate brake than today's ×2, but recovery takes ~15 clean responses instead of 25+ per halving. The existing retry backoff (12s base, exponential for rate walls, 180s cap, `Retry-After` honored in full) still runs on top, unchanged.
- **Hard floor on request spacing:** `throttleBeforeRequest` uses `minRequestIntervalMs * max(1, paceFactor)` — the factor can stretch the minimum interval but never shrink it below the configured value. Even at 0.6× the script never fires faster than one request per `minRequestIntervalMs`.
- `paceDelay(base)` stays `jitter(base * paceFactor)`.
- **Observability:** the current factor is mirrored to `state.paceFactor` (shown in the progress overlay rounded to 1 decimal, e.g. `0.8x`, and readable by the simulator).
- The wall progress message becomes: `Instagram is pushing back: slowing to {factor}x spacing (speeds back up as responses stay clean).` Any verify script that greps the old message text is updated.

### 2. Lower base delays, recentered jitter

`jitter(baseMs)` becomes multiplicative: `Math.round(baseMs * (0.85 + Math.random() * 0.35))` → ×[0.85, 1.20], mean ≈ base. It applies everywhere `jitter` is used today (pace delays and retry backoff).

| config key | today | new default |
|---|---|---|
| `relationshipListDelayMs` | 1800 | 1100 |
| `exactSearchDelayMs` | 2400 | 1600 |
| `batchDelayMs` | 2600 | 1800 |
| `individualDelayMs` | 3200 | 2200 |
| `followingFeedDelayMs` | 1800 | 1100 |
| `minRequestIntervalMs` | 700 | 600 |

Rationale for the zone: Instagram's own web client pages follower modals in zero-delay bursts as the user scrolls, and community tooling paginates these endpoints at ~1s/page routinely; the risky region reported in the field is hundreds of requests in a ~10-minute window, which these runs do not approach. Both the self-check path and the exact-search path (other accounts) get the new defaults.

### 3. Periodic breather

Every `breatherEveryRequests` requests (default 45, jittered ±20%), `throttleBeforeRequest` sleeps `jitter(breatherMs)` (default 15000) before issuing the next request, with a progress message (e.g. `Taking a short breather (~15s) so Instagram sees a human-paced session.`). `breatherEveryRequests: 0` disables. Self-check runs (~35–50 requests) hit it at most once; a 300-request exact-search run hits it ~6 times (~90s total on a run that saves minutes). The breather counter counts issued requests, including retries.

### 4. Shortfall tolerance for the second sweep

New config `listShortfallTolerance: 0.02`. A list is treated as complete when
`loaded >= expectedCount - max(3, ceil(expectedCount * listShortfallTolerance))`.

- The close-enough check replaces `listIsComplete()` wherever it gates *additional sweeps*, so a 1,000-account list that serves 985 stops after the count=100 sweep instead of re-paging everything at count=50. Shortfalls beyond the tolerance still trigger the extra-page-size sweep — that is the real lossy-pagination safety net and it stays.
- Resume state marks the list `complete` under the same tolerance, and the saved-list reuse check applies it too; otherwise a rerun within the TTL would re-page a list the tolerance already accepted.
- The existing warning (`Bulk following list exposed X of Y…`) still appears whenever loaded < profile count, so the gap is never silent.

### Config validation

Clamp on startup alongside the existing normalization: `minPaceFactor` to (0, 1], `paceSpeedupPerClean` to (0, 1), `wallSlowdownMultiplier` to ≥ 1, `breatherEveryRequests`/`breatherMs` to ≥ 0, `listShortfallTolerance` to [0, 0.5].

## Expected outcomes (verifiable in the simulator)

- Scenario A (49 requests, 2 walls): 6.0 → ~2–2.5 simulated minutes.
- Clean 1,400-following self-check: ~3.5 → ~1 min.
- 300-miss other-account run: ~12 → ~6–7 min including breathers.

## Verification

All in `scripts/simulate-scale.mjs` (virtual clock; timing assertions use generous upper bounds so jitter cannot flake):

1. All existing scenario assertions stay green (including C2 resumed-run-lighter).
2. New stale-count scenario: profile count 1,000, bulk serves 985 → assert no `count=50` list requests, run completes clean, resume state cleared.
3. Wall-recovery scenario: one rate wall early in a long list load → assert `state.paceFactor` jumps to ≥3 and ends < 1.2 after the remaining clean responses.
4. Breather: scenario configured with a small `breatherEveryRequests` → assert a sleep ≥ `0.8 * breatherMs` occurs between list requests.
5. Hard floor: record a virtual timestamp per fetch in the sim; in a scenario configured with deliberately tiny phase delays (e.g. `relationshipListDelayMs: 100`) so the throttle is the binding constraint, assert the minimum gap between consecutive requests is ≥ `minRequestIntervalMs`.
6. Upper-bound wall-clock assertions: scenario A ≤ 3.5 simulated minutes, B7 ≤ 2.0.

Field validation caveat: Instagram's real thresholds are account- and session-dependent and cannot be proven in CI. The defaults sit well inside observed-safe territory, every knob remains configurable via `window.IG_FOLLOW_BACK_CONFIG`, and the governor reacts to the first wall signal by braking harder than the current script does.

## Docs and packaging

- README: update the Scan Settings block (new defaults + new keys), and the pacing bullet in "What it does" (describe speed-up-when-clean / brake-on-wall behavior and breathers).
- CHANGELOG entry.
- Rebuild `bookmarklet.js` via `scripts/build-bookmarklet.mjs`; bump the copy-helper cache-buster links (`copy.html?v=…`) per repo convention.
