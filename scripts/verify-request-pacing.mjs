import assert from "node:assert/strict";
import { jsonResponse, runChecker } from "./vm-harness.mjs";

// Simulate both lists and Instagram's current individual-check fallback.
// Advance a virtual clock for network time as well as sleeps, so an extra
// delay after every response cannot silently creep back into the scanner.
export async function simulateRequestPacing(networkDelayMs, sourceFile) {
  const startedAt = 1788800000000;
  let now = startedAt;
  const RealDate = Date;
  class VirtualDate extends RealDate {
    constructor(...args) {
      super(...(args.length ? args : [now]));
    }
    static now() { return now; }
  }
  const fixedMath = Object.create(Math);
  fixedMath.random = () => 0.5;
  const account = (id) => ({ id: String(id), username: `account_${id}` });
  const following = Array.from({ length: 864 }, (_, i) => account(i + 2));
  const followers = [
    ...following.slice(0, 805),
    ...Array.from({ length: 20 }, (_, i) => account(i + 2000)),
  ];
  const followBackIds = new Set(following.slice(0, 815).map(({ id }) => id));
  const requests = [];
  const counts = ["835 followers", "864 following"].map((textContent) => ({
    textContent,
    getAttribute: () => "",
  }));

  const run = await runChecker({
    ...(sourceFile ? { sourceFile } : {}),
    cookie: "ds_user_id=1; csrftoken=test-csrf",
    config: { resume: false, fetchTimeoutMs: 0, retryLimit: 0 },
    documentOverrides: {
      querySelector: (selector) => selector === 'a[href^="/accounts/edit"]' ? {} : null,
      querySelectorAll: () => counts,
    },
    globals: {
      Date: VirtualDate,
      Math: fixedMath,
      setTimeout(callback, ms) {
        now += Math.max(0, Number(ms) || 0);
        callback();
        return 0;
      },
    },
    fetch: async (url, _init, getContext) => {
      requests.push({
        url,
        at: now,
        progress: { ...getContext().window.IG_FOLLOW_BACK_STATE.statusBar },
      });
      now += networkDelayMs;

      if (url.includes("web_profile_info")) {
        throw new Error("the visible profile must not use the blocked profile endpoint");
      }

      const list = url.match(/^\/api\/v1\/friendships\/1\/(following|followers)\/\?count=\d+(?:&max_id=(\d+))?$/);
      if (list) {
        const accounts = list[1] === "following" ? following : followers;
        const offset = Number(list[2] || 0);
        // Instagram can return only 25 accounts even when count=100.
        const users = accounts.slice(offset, offset + 25);
        return jsonResponse({
          users,
          ...(offset + 25 < accounts.length ? { next_max_id: String(offset + 25) } : {}),
        });
      }

      if (url.startsWith("/api/v1/friendships/show_many/")) {
        const ids = decodeURIComponent(url.split("user_ids=")[1]).split(",");
        return jsonResponse({
          friendship_statuses: Object.fromEntries(ids.map((id) => [id, { following: true }])),
        });
      }

      const individual = url.match(/^\/api\/v1\/friendships\/show\/(\d+)\/$/);
      if (individual) {
        return jsonResponse({ following: true, followed_by: followBackIds.has(individual[1]) });
      }

      throw new Error(`unexpected request: ${url}`);
    },
  });

  return { ...run, requests, elapsedMs: now - startedAt };
}

for (const networkDelayMs of [250, 1500]) {
  const run = await simulateRequestPacing(networkDelayMs);
  assert.ok(run.state.done && run.results, "the full scan must finish");
  assert.equal(run.results.verifiedNotFollowingBack.length, 49);
  assert.equal(run.results.correctedByExactSearch.length, 10, "bulk-list omissions need live correction");
  assert.equal(run.results.unknown.length, 0);

  let checkedListGap = false;
  let checkedIndividualGap = false;
  for (let i = 1; i < run.requests.length; i += 1) {
    const previous = run.requests[i - 1];
    const request = run.requests[i];
    const gap = request.at - previous.at;
    assert.ok(gap >= 600, `the hard request floor was breached: ${gap}ms`);

    // Exclude scheduled breathers and let the adaptive pacing reach its floor.
    if (i < 12 || gap > 10000) continue;

    if (/\/following\//.test(previous.url) && /\/following\//.test(request.url)) {
      assert.ok(gap <= Math.max(700, networkDelayMs), `list response time was charged twice: ${gap}ms`);
      checkedListGap = true;
    }
    if (/\/show\/\d+\/$/.test(previous.url) && /\/show\/\d+\/$/.test(request.url)) {
      assert.ok(gap <= Math.max(700, networkDelayMs), `individual response time was charged twice: ${gap}ms`);
      assert.equal(request.progress.label, "Individual verification");
      assert.equal(request.progress.value, previous.progress.value + 1, "show progress after every check");
      checkedIndividualGap = true;
    }
  }
  assert.ok(checkedListGap && checkedIndividualGap, "both pacing paths must be exercised");
  console.log(`request pacing regression ok (${networkDelayMs}ms responses, ${run.requests.length} requests, ${(run.elapsedMs / 1000).toFixed(1)}s simulated)`);
}
