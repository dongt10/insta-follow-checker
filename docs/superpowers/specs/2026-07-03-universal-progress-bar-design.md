# One universal progress bar across the whole run

## Context

The progress overlay (`renderProgress()` in `src/check-follow-back.js`) renders a single bar
element, but the bar restarts at 0% for every phase of the run: profile load, following list,
optional following-feed hints, follower list, verification. Watching it fill and reset four or
five times reads as "multiple bars" and gives no sense of overall completion. The user asked for
one universal bar that fills once, 0→100%, across the entire run.

Two decisions were made during brainstorming:

- **Layout:** the text row above the bar keeps the current step's label and counts on the left
  (e.g. `followers: loading · 1,240 / 3,400`) and shows the overall percent on the right
  (e.g. `62%`). The bar itself tracks only overall progress.
- **Progress math:** a weighted phase plan (phases weighted by estimated request counts,
  re-planned as estimates firm up) was chosen over fixed per-phase bar segments, because the
  run's shape varies too much for fixed slices — the follower list may be skipped entirely in
  self-check mode, and verification is often the longest phase.

## Scope

- `src/check-follow-back.js` only: a new overall-progress tracker, `setStatusBar()` wiring,
  `renderProgress()` bar/label row, and phase bookkeeping in `run()`.
- New regression script `scripts/verify-progress-bar.mjs`, added to `npm run check`.
- `bookmarklet.js` / `copy.html`: build outputs, regenerated only.
- `CHANGELOG.md`: one `Unreleased` bullet.

Out of scope:

- Restyling the overlay to match the terminal-log results report — it keeps its current
  sans-serif boxed style.
- The final results report, README (already says just "progress overlay"), and the `copy.html`
  template.

## Design

### Overall-progress tracker

A small self-contained tracker next to the `pacing` object (~60 lines). It holds an ordered
phase plan and produces one monotonic overall percent:

```js
overallProgress.plan(entries)        // [{ key, units }] in run order; creates or replaces the plan
overallProgress.update(key, value, max) // in-phase completion fraction = clamp(value / max, 0..1)
overallProgress.setUnits(key, units) // re-estimate one phase's weight
overallProgress.complete(key)        // phase finished (or skipped/stopped): fraction locked at 1
overallProgress.finish()             // run finished: percent becomes exactly 100
overallProgress.percent()            // integer 0..100, never decreases
```

**Units** approximate request counts. Computed once the profile counts are known:

| Phase | Units | Notes |
|---|---|---|
| `profile` | 1 | already complete when the plan is created |
| `following` | `ceil(followingCount / relationshipPageSizes[0])` | min 1; fallback 4 when the profile count is unknown |
| `hints` | `ceil(followingCount / followingFeedPageSize)` | only present when the hints comparison will run |
| `followers` | `ceil(followerCount / relationshipPageSizes[0])` | min 1; 0 when the skip predicate already says it will not load |
| `verification` | prior, see below | replaced by the real count when known |

Verification prior: batch mode with the follower list skipped → `ceil(followingCount /
batchSize)` (every followed account is batch-checked); batch mode with a real follower list →
`ceil(0.1 × followingCount / batchSize)`; exact-search mode → `ceil(0.1 × followingCount)`.
Always at least 1. The prior only shapes how much of the bar the list phases consume; once
verification is the last remaining phase it owns the remaining span regardless.

**Floor-and-redistribute invariant.** `plan()` and `setUnits()` lock the currently displayed
percent as a floor and spread the remaining span (floor→100) across the remaining (incomplete)
units. Within a phase, progress moves the bar by that phase's share of the remaining span.
Consequences:

- The bar never moves backward, even when an estimate shrinks or a phase is dropped; a final
  `max(previousPercent, computed)` clamp guarantees it against count jitter (e.g. loaded size
  exceeding the profile count, which happens with deactivated accounts).
- A phase whose `max` is 0/unknown contributes nothing while running (bar waits at the phase
  start) and jumps to the phase's end on `complete()`.
- `complete()` on a phase with 0 units is a no-op for the width but marks it done.
- Before the first `plan()` call (during the profile request) `percent()` is 0, and `update()`
  for a phase not in the plan (or before the plan exists) is a safe no-op.
- `finish()` is the only way to reach exactly 100. The fatal-error path never calls it, so on
  errors the bar freezes at its last value under the `Error` label — a deliberate change from
  today, where the error path fills the bar to 100% and reads as success.

### Wiring

`setStatusBar(label, value, max)` gains an optional fourth argument `phaseKey`. When present, it
forwards `overallProgress.update(phaseKey, value, max)`; when absent the call is label-only.
Call sites:

| Site | Label | Phase key |
|---|---|---|
| `loadProfileUser` start | `Loading profile` (0/1) | `profile` |
| after profile resolves | `Profile loaded` (1/1) | `profile` |
| `loadRelationshipList`: reused / resuming / stopped early / loading | `${type}: …` | `type` (`following` / `followers`) |
| `loadFollowingFeedHints` (2 sites) + seed call in `run()` | `following-feed hints…` | none — see below |
| verification queued (both sites), batch loop, exact loop | `Verification queued` / `Batch verification` / `Exact verification` | `verification` |
| individual-recheck loop (new, see below) | `Individual rechecks` | `verification` |
| `Self-check mode`, `followers: skipped` (×2), `Verification blocked`, `Verification reliability check failed`, `Done`, `Error` | status flashes with placeholder 0/1 or 1/1 numbers | none |

**Hints phase exception:** the hints loader accumulates into the *shared* following map, so its
account counts sit at ≈100% from the phase's first page — useless as a fraction. Its
`setStatusBar` calls stay label-only (the visible counts remain accounts), and the loop calls
`overallProgress.update("hints", pageCount, ceil(followingCount / followingFeedPageSize))`
directly after each page.

**Bonus fix in scope:** the individual-recheck loop (between the batch and exact-search loops)
currently never calls `setStatusBar`, so today's bar silently stalls there. It gets the same
every-10-accounts update the other verification loops have: `setStatusBar("Individual
rechecks", verified + corrected + unknown, tentativeMisses.length, "verification")`.

### Phase bookkeeping in `run()`

- After `loadProfileUser` resolves: build the plan — `profile` (1), `following`, `hints` (only
  when `selfRelationship && CONFIG.includeFollowingStatusHints !== false &&
  CONFIG.compareFollowingFeed`), `followers` (0 units when `batchVerification` plus
  `skipFollowerListWhenSelf` — `true`, or `"auto"` with `followerCount > 2 × followingCount` —
  already says it will skip), `verification` (prior). Then `complete("profile")`.
- After `loadRelationshipList("following")`: `complete("following")` (stopped-early included —
  no more work happens in that phase either way).
- At the hints branch: if the phase runs, `complete("hints")` after it returns; if it is in the
  plan but will not run (following list unavailable), `setUnits("hints", 0)` +
  `complete("hints")`.
- At the followers branch: on either skip path, `setUnits("followers", 0)` +
  `complete("followers")`; after a real load, `complete("followers")`.
- At verification: blocked path → `setUnits("verification", 0)` + `complete("verification")`;
  otherwise `setUnits("verification", realCount)` when `tentativeMisses.length` is known (0
  tentative misses means the phase completes immediately), and `complete("verification")` after
  the verification block ends.
- `Done` path → `overallProgress.finish()`. The `Error` path does not call it.

### Rendering and debug surface

In `renderProgress()`:

- Label row: left `label` plus ` · value / max` when `max > 0` (per-phase percent text is
  dropped — the counts carry that information); right `` `${overallPercent}%` ``.
- Bar width = overall percent; the `35%`-wide fake-indeterminate state is deleted (the overall
  percent is always defined, starting at 0).
- `aria-valuenow` = overall percent; `aria-label` stays the step label.

`state.statusBar` keeps `label / value / max / percent` (per-phase, for inspectability) and
gains `overallPercent`, refreshed whenever the tracker changes, so
`window.IG_FOLLOW_BACK_STATE.statusBar.overallPercent` is readable mid-run.

### Regression script

New `scripts/verify-progress-bar.mjs`, same vm-sandbox pattern as `verify-batch-self.mjs`:
mock a self-check run whose shape exercises multiple phases (following and followers both a few
pages — follower count below the 2× auto-skip threshold so the follower list actually loads —
then batch verification with a mix of follows-back / missing verdicts). The fetch mock records
`window.IG_FOLLOW_BACK_STATE.statusBar.overallPercent` after every request. Assertions:

1. The recorded sequence never decreases.
2. It is strictly greater than 0 by the end of the following phase and strictly increases
   across phase boundaries (list loading → verification).
3. After the run resolves, `overallPercent === 100` and the progress box's last rendered HTML
   (the script's own fake DOM keeps the element inspectable) shows `width:100%`.
4. The label row shows step counts (`following: loading · 3 / 3` style) rather than a per-phase
   percent.

Wired into `package.json`'s `check` chain alongside the existing verify scripts.

### Non-goals

- No timing/ETA estimates, no request-per-second display — only completion percent.
- No change to what requests are made or their pacing; this is presentation plus bookkeeping.
- No attempt to make the percent proportional to wall-clock time (batch requests and list pages
  have different delays); units are request counts, which is close enough.

## Verification plan

1. `node --check src/check-follow-back.js` while iterating.
2. `npm run check` — includes the new `verify-progress-bar.mjs`; all existing verify scripts
   must pass unchanged (none assert on the status bar today).
3. `npm run build:bookmarklet` to regenerate `bookmarklet.js` and `copy.html`.
4. `CHANGELOG.md` gains an `Unreleased` bullet describing the universal bar and the
   error-freeze behavior change.
5. Field test against real Instagram is done by the user before any push (per project
   convention); commits stay local until then.
