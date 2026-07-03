# Adaptive Request Pacing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (chosen by the user) to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make 500+-account runs of the Instagram follow-back checker 2–4× faster while braking harder than today on the first sign of an Instagram wall.

**Context:** Runs on accounts with 500+ followers/followings take minutes for only ~35–60 requests. Measured causes (see `docs/superpowers/specs/2026-07-02-adaptive-pacing-design.md`, approved + committed at 46366c8): (1) the wall-slowdown ratchet needs 25 clean responses per halving so one transient wall keeps the whole rest of a run at 2–8× spacing, (2) flat worst-case delays with add-only jitter, (3) a full count=50 re-sweep of a list whenever the profile count exceeds the loaded count (normal — profile counts include deactivated accounts), (4) fixed 2.4s per exact-search verification on other people's accounts. Total request volume stays tiny, so pacing can be adaptive: speed up ~7%/clean response toward a floor, jump 3× on any wall, keep every existing wall/retry/resume safety.

**Architecture:** All behavior lives in one IIFE browser script, `src/check-follow-back.js` (~2100 lines). Verification is vm-based Node scripts under `scripts/` run by `npm run check`; `scripts/simulate-scale.mjs` mocks `Date`/`setTimeout`/`fetch` with a **virtual clock**, so pacing changes are assertable in simulated minutes with zero real waiting. `bookmarklet.js` and `copy.html` are build artifacts regenerated deterministically by `npm run build:bookmarklet`; CI (`npm run check`) fails if they are stale.

**Tech Stack:** Plain browser JS (IIFE, `"use strict"`, no deps), Node 22 vm-harness scripts, GitHub Actions running `npm run check`.

## Global Constraints

- **Never** add `Co-Authored-By: Claude` or any AI attribution to commits (user rule).
- The working tree has unrelated pending changes (deleted `.env.example`/`DESIGN.md`, modified `.gitignore`, untracked `docs/` files). `git add` **only the files named in each commit step** — never `git add -A`/`-u`/`.`.
- Every task ends with `npm run build:bookmarklet && npm run check` green, and every commit includes the regenerated `bookmarklet.js` + `copy.html` (CI verifies they match `src/`).
- Config keys and defaults exactly as listed in Task 1/2/3 (they implement the approved spec; Task 3 includes one approved-in-plan spec amendment — see below).
- Match existing style in `src/check-follow-back.js`: 2-space indent, trailing commas, blank line after guard clauses, functions declared with `function` at IIFE scope, arrow consts for one-liners.
- Timing assertions in the simulator use generous upper bounds (jitter is real `Math.random`); never assert exact durations.

**Spec amendment (decided during planning):** the spec's shortfall tolerance `max(3, ceil(expected * 0.02))` misbehaves on small lists (a 3-follower list missing 1 would skip its re-sweep, breaking `scripts/verify-exact-search.mjs`'s exact fetch-sequence assertion, and tolerating 3-of-3 missing is nonsense). Amend: tolerance = `ceil(expected * listShortfallTolerance)` **only when `expected >= 400`**, else `0` (today's exact-completeness rule). Small lists' re-sweeps cost ~1 page, so there is nothing to save; the >500 pain case is fully covered. Task 3 Step 6 updates the spec file accordingly.

---

### Task 1: Adaptive pace factor, lower base delays, recentered jitter, hard throttle floor

**Files:**
- Modify: `src/check-follow-back.js` (DEFAULT_CONFIG ~19–49; config normalization ~61–70; `jitter` ~83–85; `state` ~87–104; `pacing`/`paceDelay`/`reportWall`/`reportCleanResponse` ~108–136; `throttleBeforeRequest` ~155–164; overlay pacing display ~313)
- Modify: `scripts/simulate-scale.mjs` (fetch mock ~102–105; `runScenario` return ~215–221; scenario A assertions after ~302; scenario B7 assertions after ~636)
- Test: `scripts/simulate-scale.mjs` (this repo's tests ARE the verify/sim scripts)

**Interfaces:**
- Consumes: nothing new.
- Produces (later tasks rely on): `pacing.paceFactor` (float, replaces `pacing.slowdownFactor`; `pacing.cleanStreak` deleted), `state.paceFactor` (mirror for observability), config keys `minPaceFactor`/`paceSpeedupPerClean`/`wallSlowdownMultiplier`, helper `clampConfigNumber(value, min, max, fallback)`, and `runScenario(...)` now returning `{ name, results, fetchLog, durationMinutes, requestCount, state, sleeps }` with each `fetchLog` entry shaped `{ url, init, at }` (`at` = virtual ms at request start).

- [ ] **Step 1: Write the failing sim assertions**

In `scripts/simulate-scale.mjs`, instrument the harness. In the fetch mock (~line 102), capture the request-start timestamp:

```js
    fetch: async (url, init = {}) => {
      const at = virtualNow;

      virtualNow += 300;
      fetchLog.push({ url: String(url), init, at });
```

In the async return block of `runScenario` (~line 215), return the state handle and sleeps:

```js
    return {
      name,
      results,
      fetchLog,
      durationMinutes: (virtualNow - startedAt) / 60000,
      requestCount: fetchLog.length,
      state,
      sleeps,
    };
```

After scenario A's existing assertions (just before its `report(run)` at ~line 320), add:

```js
  if (run.state.walls !== 2) {
    throw new Error(`A: expected 2 walls, got ${run.state.walls}`);
  }

  const slowdownLogs = run.state.logs.filter((entry) => entry.message.includes("slowing to 3.0x spacing"));

  if (slowdownLogs.length !== 2) {
    throw new Error(`A: expected two 3.0x slowdown messages, got ${slowdownLogs.length}`);
  }

  if (!(run.state.paceFactor < 1.2)) {
    throw new Error(`A: pace factor should recover below 1.2 by run end, got ${run.state.paceFactor}`);
  }

  if (run.durationMinutes > 3.5) {
    throw new Error(`A: expected at most 3.5 simulated minutes, got ${run.durationMinutes.toFixed(1)}`);
  }
```

After scenario B7's existing assertions (before its `report(run)` at ~line 651), add:

```js
  if (run.durationMinutes > 2.5) {
    throw new Error(`B7: expected at most 2.5 simulated minutes, got ${run.durationMinutes.toFixed(1)}`);
  }
```

- [ ] **Step 2: Run to verify the new assertions fail against current code**

Run: `node scripts/simulate-scale.mjs`
Expected: FAIL with `A: expected two 3.0x slowdown messages, got 0` (`state.walls` is already 2 today, so the first assertion passes; the message assertion fails because the current text is "slowing all requests to 2x spacing").

- [ ] **Step 3: Implement the governor in `src/check-follow-back.js`**

DEFAULT_CONFIG — change five values, add three keys (keep all other keys as they are):

```js
    relationshipListDelayMs: 1100,
    exactSearchDelayMs: 1600,
    ...
    batchDelayMs: 1800,
    ...
    individualDelayMs: 2200,
    ...
    followingFeedDelayMs: 1100,
    minRequestIntervalMs: 600,
    minPaceFactor: 0.6,
    paceSpeedupPerClean: 0.93,
    wallSlowdownMultiplier: 3,
```

After the existing `CONFIG.maxIndividualRechecks` normalization (~line 70), add:

```js
  const clampConfigNumber = (value, min, max, fallback) => {
    const parsed = Number(value);

    return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
  };

  CONFIG.minPaceFactor = clampConfigNumber(CONFIG.minPaceFactor, 0.05, 1, DEFAULT_CONFIG.minPaceFactor);
  CONFIG.paceSpeedupPerClean = clampConfigNumber(CONFIG.paceSpeedupPerClean, 0.5, 0.999, DEFAULT_CONFIG.paceSpeedupPerClean);
  CONFIG.wallSlowdownMultiplier = clampConfigNumber(CONFIG.wallSlowdownMultiplier, 1, 10, DEFAULT_CONFIG.wallSlowdownMultiplier);
```

Replace `jitter` (~83–85):

```js
  const jitter = (baseMs) => Math.round(baseMs * (0.85 + Math.random() * 0.35));
```

Add `paceFactor: 1,` to the `state` literal (after `walls: 0,`).

Replace the `pacing` object and the three pacing functions (~108–136):

```js
  const pacing = {
    paceFactor: 1,
    lastRequestAt: 0,
  };
  let resumeSaveWarned = false;

  function paceDelay(baseMs) {
    return jitter(baseMs * pacing.paceFactor);
  }

  function reportWall() {
    state.walls += 1;

    const raisedFactor = Math.min(
      CONFIG.maxSlowdownFactor,
      Math.max(pacing.paceFactor, 1) * CONFIG.wallSlowdownMultiplier,
    );

    if (raisedFactor > pacing.paceFactor) {
      pacing.paceFactor = raisedFactor;
      state.paceFactor = raisedFactor;
      progress(`Instagram is pushing back: slowing to ${raisedFactor.toFixed(1)}x spacing (speeds back up while responses stay clean).`);
    }
  }

  function reportCleanResponse() {
    pacing.paceFactor = Math.max(CONFIG.minPaceFactor, pacing.paceFactor * CONFIG.paceSpeedupPerClean);
    state.paceFactor = pacing.paceFactor;
  }
```

(`cleanStreak` is deleted; `resumeSaveWarned` keeps its current position.)

Replace `throttleBeforeRequest` (~155–164) — the hard floor never scales below the configured interval:

```js
  async function throttleBeforeRequest() {
    const minIntervalMs = CONFIG.minRequestIntervalMs * Math.max(1, pacing.paceFactor);
    const waitMs = pacing.lastRequestAt + minIntervalMs - Date.now();

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    pacing.lastRequestAt = Date.now();
  }
```

In `renderProgress` (~line 313), change the pacing display:

```js
      <div><strong>Requests:</strong> ${escapeHtml(state.requests)} | <strong>Pacing:</strong> ${escapeHtml(pacing.paceFactor.toFixed(1))}x</div>
```

- [ ] **Step 4: Rebuild artifacts and run the full check**

Run: `npm run build:bookmarklet && npm run check`
Expected: all scripts pass, ending `scale simulation ok`. Scenario A's printed wall-clock should drop from ~6.0 to ~1.3–2 min, B7 from ~3.1 to ~1.2–1.8 min. If a duration assertion trips, something is wrong with the implementation — do not just raise the bound.

- [ ] **Step 5: Commit**

```bash
git add src/check-follow-back.js scripts/simulate-scale.mjs bookmarklet.js copy.html
git commit -m "Replace the wall ratchet with an adaptive pace factor"
```

---

### Task 2: Periodic breather

**Files:**
- Modify: `src/check-follow-back.js` (DEFAULT_CONFIG; config clamps from Task 1; `pacing` object; `throttleBeforeRequest`)
- Test: `scripts/simulate-scale.mjs` (new scenario E, appended before the final `console.log("scale simulation ok")`)

**Interfaces:**
- Consumes: `clampConfigNumber`, `pacing.paceFactor`, `jitter`, `runScenario` returning `state`/`sleeps`/`fetchLog[].at` (Task 1).
- Produces: config keys `breatherEveryRequests` (int, 0 disables) and `breatherMs`; `pacing.requestsSinceBreather` / `pacing.nextBreatherAt`.

- [ ] **Step 1: Write failing scenario E (breather + hard-floor gap)**

Append to `scripts/simulate-scale.mjs` before the final `console.log`:

```js
{
  const following = [];

  for (let id = 1; id <= 600; id += 1) {
    following.push(makeAccount(id, "burst"));
  }

  const followBack = following.slice(0, 550);
  const groundTruthFollowerIds = new Set(followBack.map((user) => user.pk));
  const expectedMisses = following.slice(550).map((user) => user.username);
  const storage = new Map();

  const run = await runScenario({
    name: "E: self-check at full speed, breathers fire and the request floor holds",
    profile: { id: SELF_ID, username: "burstself", followerCount: 5000, followingCount: 600 },
    following,
    servedFollowers: [],
    groundTruthFollowerIds,
    viewerId: SELF_ID,
    storage,
    config: {
      relationshipListDelayMs: 100,
      batchDelayMs: 100,
      minRequestIntervalMs: 600,
      breatherEveryRequests: 8,
      breatherMs: 15000,
    },
    walls: null,
  });

  assertExactSet(run.name, run.results.verifiedNotFollowingBack, expectedMisses);

  if (!run.sleeps.some((ms) => ms >= 12000)) {
    throw new Error("E: expected at least one breather sleep of >= 12000 virtual ms");
  }

  if (!run.state.logs.some((entry) => entry.message.includes("breather"))) {
    throw new Error("E: expected a breather progress message");
  }

  const gaps = run.fetchLog.slice(1).map((call, index) => call.at - run.fetchLog[index].at);
  const minGap = Math.min(...gaps);

  if (minGap < 600) {
    throw new Error(`E: request floor violated, smallest gap ${minGap}ms`);
  }

  report(run);
}
```

- [ ] **Step 2: Run to verify it fails**

Run: `node scripts/simulate-scale.mjs`
Expected: FAIL with `E: expected at least one breather sleep...` (all earlier scenarios still pass).

- [ ] **Step 3: Implement the breather**

DEFAULT_CONFIG — add after `wallSlowdownMultiplier: 3,`:

```js
    breatherEveryRequests: 45,
    breatherMs: 15000,
```

Clamps — add after the `wallSlowdownMultiplier` clamp:

```js
  CONFIG.breatherEveryRequests = Math.floor(clampConfigNumber(CONFIG.breatherEveryRequests, 0, Number.MAX_SAFE_INTEGER, DEFAULT_CONFIG.breatherEveryRequests));
  CONFIG.breatherMs = clampConfigNumber(CONFIG.breatherMs, 0, 600000, DEFAULT_CONFIG.breatherMs);
```

Above the `pacing` object add the jittered-target helper, and extend `pacing`:

```js
  const breatherTarget = () => Math.max(
    1,
    Math.round(CONFIG.breatherEveryRequests * (0.8 + Math.random() * 0.4)),
  );

  const pacing = {
    paceFactor: 1,
    lastRequestAt: 0,
    requestsSinceBreather: 0,
    nextBreatherAt: breatherTarget(),
  };
```

Extend `throttleBeforeRequest` — breather check at the top, counter increment at the bottom:

```js
  async function throttleBeforeRequest() {
    if (CONFIG.breatherEveryRequests > 0 && pacing.requestsSinceBreather >= pacing.nextBreatherAt) {
      const breatherMs = jitter(CONFIG.breatherMs);

      progress(`Taking a ~${Math.round(breatherMs / 1000)}s breather after ${pacing.requestsSinceBreather} requests to stay under Instagram's radar.`);
      await sleep(breatherMs);
      pacing.requestsSinceBreather = 0;
      pacing.nextBreatherAt = breatherTarget();
    }

    const minIntervalMs = CONFIG.minRequestIntervalMs * Math.max(1, pacing.paceFactor);
    const waitMs = pacing.lastRequestAt + minIntervalMs - Date.now();

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    pacing.lastRequestAt = Date.now();
    pacing.requestsSinceBreather += 1;
  }
```

Note: verify scripts run with < 36 requests each, so the default breather never fires there, and their mocked `setTimeout` resolves instantly anyway. Scenario A/B7 durations absorb one ~15s virtual breather comfortably inside their Task 1 bounds.

- [ ] **Step 4: Rebuild and run the full check**

Run: `npm run build:bookmarklet && npm run check`
Expected: all pass; scenario E reports and the suite ends `scale simulation ok`.

- [ ] **Step 5: Commit**

```bash
git add src/check-follow-back.js scripts/simulate-scale.mjs bookmarklet.js copy.html
git commit -m "Add a periodic breather pause between request bursts"
```

---

### Task 3: Shortfall tolerance for the second sweep (≥400-account lists only)

**Files:**
- Modify: `src/check-follow-back.js` (constant near the top; DEFAULT_CONFIG; clamps; `loadRelationshipList`: `listIsComplete` ~705–709, saved-list reuse gate ~711–714, skip-passes progress message ~910–919, resume `complete` marking ~931–939)
- Modify: `docs/superpowers/specs/2026-07-02-adaptive-pacing-design.md` (spec amendment, §4 + verification item 2)
- Test: `scripts/simulate-scale.mjs` (scenarios D1/D2 appended before the final `console.log`)

**Interfaces:**
- Consumes: `clampConfigNumber` (Task 1), `runScenario` extensions (Task 1).
- Produces: config key `listShortfallTolerance` (default 0.02); module constant `SHORTFALL_TOLERANCE_MIN_COUNT = 400`.

- [ ] **Step 1: Write failing scenarios D1 (skip re-sweep) and D2 (resume reuse within tolerance)**

Append before the final `console.log`:

```js
{
  const following = [];

  for (let id = 1; id <= 985; id += 1) {
    following.push(makeAccount(id, "tol"));
  }

  const followBack = following.slice(0, 960);
  const groundTruthFollowerIds = new Set(followBack.map((user) => user.pk));
  const expectedMisses = following.slice(960).map((user) => user.username);
  const storage = new Map();

  const run = await runScenario({
    name: "D1: self-check, profile count 1,000 but bulk serves 985, no wasted re-sweep",
    profile: { id: SELF_ID, username: "tolself", followerCount: 5000, followingCount: 1000 },
    following,
    servedFollowers: [],
    groundTruthFollowerIds,
    viewerId: SELF_ID,
    storage,
    walls: null,
  });

  assertExactSet(run.name, run.results.verifiedNotFollowingBack, expectedMisses);

  if (run.fetchLog.some((call) => call.url.includes("/following/?count=50"))) {
    throw new Error("D1: a shortfall within tolerance must not trigger the count=50 re-sweep");
  }

  if (!run.results.warnings.some((warning) => warning.includes("exposed 985 of 1000"))) {
    throw new Error(`D1: the exposed-count warning must remain, got ${JSON.stringify(run.results.warnings)}`);
  }

  if (storage.size !== 0) {
    throw new Error("D1: clean run must clear resume state");
  }

  report(run);

  const seeded = new Map();
  const savedAccounts = following.map((user) => ({
    username: user.username,
    fullName: user.full_name,
    id: user.pk,
    isPrivate: false,
    isVerified: false,
  }));

  seeded.set(`ig-follow-back-resume:${SELF_ID}:${SELF_ID}`, JSON.stringify({
    createdAt: 1765000000000,
    lists: {
      following: { complete: true, accounts: savedAccounts, maxId: "", pageSize: 0 },
    },
    verdicts: {},
  }));

  const rerun = await runScenario({
    name: "D2: saved 985-account list is reused although the profile still claims 1,000",
    profile: { id: SELF_ID, username: "tolself", followerCount: 5000, followingCount: 1000 },
    following,
    servedFollowers: [],
    groundTruthFollowerIds,
    viewerId: SELF_ID,
    storage: seeded,
    walls: null,
  });

  assertExactSet(rerun.name, rerun.results.verifiedNotFollowingBack, expectedMisses);

  if (rerun.fetchLog.some((call) => call.url.includes("/following/?count="))) {
    throw new Error("D2: a saved list within tolerance must be reused without list requests");
  }

  report(rerun);
}
```

- [ ] **Step 2: Run to verify D1 fails**

Run: `node scripts/simulate-scale.mjs`
Expected: FAIL with `D1: a shortfall within tolerance must not trigger the count=50 re-sweep` (today the incomplete list re-pages everything at count=50).

- [ ] **Step 3: Implement the tolerance**

Near the top constants (after `RESERVED_PATHS`, ~line 18): 

```js
  const SHORTFALL_TOLERANCE_MIN_COUNT = 400;
```

DEFAULT_CONFIG — add after `breatherMs: 15000,`:

```js
    listShortfallTolerance: 0.02,
```

Clamps — add after the `breatherMs` clamp:

```js
  CONFIG.listShortfallTolerance = clampConfigNumber(CONFIG.listShortfallTolerance, 0, 0.5, DEFAULT_CONFIG.listShortfallTolerance);
```

In `loadRelationshipList`, replace the `listIsComplete` definition (~705–709):

```js
    const shortfallTolerance = (
      typeof expectedCount === "number"
      && expectedCount >= SHORTFALL_TOLERANCE_MIN_COUNT
    )
      ? Math.ceil(expectedCount * CONFIG.listShortfallTolerance)
      : 0;
    const listIsComplete = () => (
      typeof expectedCount === "number"
      && expectedCount >= 0
      && usersByUsername.size >= expectedCount - shortfallTolerance
    );
```

Saved-list reuse gate (~711–714) — apply the same tolerance:

```js
    if (
      savedList?.complete
      && savedAccounts.length > 0
      && (typeof expectedCount !== "number" || savedAccounts.length >= expectedCount - shortfallTolerance)
    ) {
```

Skip-passes progress message (~910–919) — accurate wording when within tolerance:

```js
        if (listIsComplete()) {
          if (sweepIndex < totalSweeps) {
            progress(
              `${type}: loaded ${usersByUsername.size} of ${formatNumber(expectedCount)} expected accounts${usersByUsername.size < expectedCount ? " (within the stale-count tolerance)" : ""}, skipping extra passes to save requests.`,
              type,
            );
          }

          break sweeps;
        }
```

Resume `complete` marking (~931–939):

```js
      resume.lists[type] = {
        complete: typeof expectedCount !== "number" || listIsComplete(),
        accounts: [...usersByUsername.values()],
        maxId: "",
        pageSize: 0,
      };
```

- [ ] **Step 4: Run the sim, confirm small-list verifiers unaffected**

Run: `node scripts/simulate-scale.mjs && node scripts/verify-exact-search.mjs`
Expected: both pass. `verify-exact-search.mjs` matters because its 3-follower mock asserts the count=50 followers re-sweep still happens — below the 400 threshold, tolerance is 0, behavior unchanged.

- [ ] **Step 5: Rebuild and run the full check**

Run: `npm run build:bookmarklet && npm run check`
Expected: all pass, `scale simulation ok`.

- [ ] **Step 6: Amend the spec**

In `docs/superpowers/specs/2026-07-02-adaptive-pacing-design.md` §4, replace the formula sentence

> A list is treated as complete when `loaded >= expectedCount - max(3, ceil(expectedCount * listShortfallTolerance))`.

with:

> A list is treated as complete when `loaded >= expectedCount - tolerance`, where `tolerance = ceil(expectedCount * listShortfallTolerance)` for lists whose expected count is ≥ 400 and `0` otherwise. Small lists keep the exact-completeness rule: their re-sweep costs ~1 page, so there is nothing to save, and a fractional tolerance would skip legitimate re-sweeps on tiny lists (this also keeps `verify-exact-search.mjs`'s expected fetch sequence valid).

And in Verification item 2, change "profile count 1,000, bulk serves 985 → assert no `count=50` list requests" to also mention the seeded-resume reuse case (matches scenarios D1/D2).

- [ ] **Step 7: Commit**

```bash
git add src/check-follow-back.js scripts/simulate-scale.mjs docs/superpowers/specs/2026-07-02-adaptive-pacing-design.md bookmarklet.js copy.html
git commit -m "Skip the redundant re-sweep when a big list is within stale-count tolerance"
```

---

### Task 4: Docs, changelog, cache-buster

**Files:**
- Modify: `README.md` ("What it does" pacing bullet; "Scan Settings" code block + surrounding note; three `copy.html?v=…` links)
- Modify: `CHANGELOG.md` ("Unreleased" section)

**Interfaces:**
- Consumes: final config keys/defaults from Tasks 1–3.
- Produces: nothing downstream.

- [ ] **Step 1: Update README**

Replace the pacing bullet under "What it does":

```markdown
- Paces every request adaptively: requests start at a moderate spacing, speed up ~7% per clean response down to a floor, and take a short breather every ~45 requests. On any rate/HTML wall the spacing immediately triples (up to 8x), with exponential backoff that honors `Retry-After` in full (including the HTTP-date form), then gradually speeds back up while responses stay clean. A hard minimum interval between requests never shrinks. Deterministic client errors are not retried at all.
```

Replace the "Scan Settings" code block:

```js
window.IG_FOLLOW_BACK_CONFIG = {
  relationshipListDelayMs: 1100,   // base delay between relationship-list pages
  exactSearchDelayMs: 1600,        // base delay between exact follower searches
  batchDelayMs: 1800,              // base delay between batch friendship checks
  individualDelayMs: 2200,         // base delay between one-account friendship rechecks
  minRequestIntervalMs: 600,       // hard minimum spacing between any two requests (never shrinks)
  minPaceFactor: 0.6,              // fastest adaptive pacing: 0.6 = up to 40% quicker than the base delays
  paceSpeedupPerClean: 0.93,       // each clean response multiplies pacing by this (lower = speeds up faster)
  wallSlowdownMultiplier: 3,       // any wall multiplies pacing by this immediately
  maxSlowdownFactor: 8,            // pacing ceiling after repeated walls
  breatherEveryRequests: 45,       // pause for a breather roughly this often (0 disables)
  breatherMs: 15000,               // breather length
  listShortfallTolerance: 0.02,    // skip the extra list pass when a 400+ list is this close to the profile count
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

Keep the "For large accounts, avoid setting delays too low" paragraph, appending one sentence:

```markdown
The adaptive pacing raises delays on its own the moment Instagram pushes back, so tune upward only if runs on your account keep hitting walls.
```

- [ ] **Step 2: Update CHANGELOG "Unreleased"**

Add bullets:

```markdown
- Made request pacing adaptive: runs speed up while Instagram responds cleanly, slow down 3x immediately on any wall, recover gradually, and take a short breather every ~45 requests. Large-account runs finish 2-4x faster.
- Skipped the redundant second list pass when a 400+ account list comes within 2% of the profile count (profile counts include deactivated accounts, so the re-page usually added nothing).
- Lowered base delays (list pages 1.8s -> 1.1s, batch checks 2.6s -> 1.8s, exact searches 2.4s -> 1.6s, individual rechecks 3.2s -> 2.2s) with a hard 600ms floor between requests that never shrinks.
```

- [ ] **Step 3: Rebuild, run the full check, commit the docs**

Run: `npm run build:bookmarklet && npm run check`
Expected: all pass.

```bash
git add README.md CHANGELOG.md bookmarklet.js copy.html
git commit -m "Document adaptive pacing defaults and breathers"
```

- [ ] **Step 4: Cache-buster commit (repo convention, see 8731a62)**

Get the short hash of the commit just created: `git rev-parse --short HEAD` → e.g. `abc1234`. Edit the three README links `copy.html?v=c978293` → `copy.html?v=abc1234` (Easy Copy section, Quick Start step 4, Bookmarklet section).

```bash
git add README.md
git commit -m "Refresh copy helper cache-buster after adaptive pacing"
```

---

## Verification (end-to-end)

1. `npm run build:bookmarklet && npm run check` — the whole suite: syntax check, bookmarklet/copy-page sync, generic + exact-search + batch-self + following-hints + rate-limit-wall + html-wall regressions, and the scale simulation with the new pacing assertions.
2. Confirm reported sim timings in the output: scenario A ≈ 1.3–2.5 min (was 6.0), B7 ≈ 1.2–2.0 min (was 3.1), D1 present with no count=50 re-sweep, E present with breathers.
3. `git log --oneline -6` — five commits (4 tasks + cache-buster), none touching the unrelated pending working-tree changes (`.gitignore`, deleted `.env.example`/`DESIGN.md` stay uncommitted).
4. Field check (manual, optional): paste `src/check-follow-back.js` into the DevTools console on instagram.com on a 500+ account; watch the overlay — pacing should read `0.9x → 0.6x` while clean, jump to `3.0x` with a "slowing to" message if a wall appears, and show a breather message roughly once per ~45 requests.

## Out of scope

- No changes to wall detection, retry limits, `Retry-After` handling, resume format, verification ordering, canary logic, or safety caps.
- No count=200 page probing, no parallel list loading (rejected as risk-raising in brainstorming).
