import { jsonResponse, runChecker } from "./vm-harness.mjs";

// Requesting a stop mid-run must halt before the next request, keep already
// verified results, park everything unchecked in Unknown, and save resume
// progress instead of counting anything unverified.
const following = [];

for (let id = 101; id <= 160; id += 1) {
  following.push({ id: String(id), username: `user_${id}`, full_name: `User ${id}` });
}

const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};
let showManyCalls = 0;

const run = await runChecker({
  cookie: "ds_user_id=1; csrftoken=test-csrf",
  localStorage,
  config: {
    relationshipListDelayMs: 0,
    exactSearchDelayMs: 0,
    batchDelayMs: 0,
    minRequestIntervalMs: 0,
    retryBaseDelayMs: 0,
    retryLimit: 0,
    relationshipPageSizes: [100],
  },
  fetch: async (url, init, sandbox) => {
    if (url === "/api/v1/users/web_profile_info/?username=friend") {
      return jsonResponse({
        data: {
          user: {
            id: "1",
            username: "friend",
            full_name: "Friend",
            edge_follow: { count: 60 },
            edge_followed_by: { count: 5000 },
          },
        },
      });
    }

    if (url === "/api/v1/friendships/1/following/?count=100") {
      return jsonResponse({ users: following, status: "ok" });
    }

    if (url === "/api/v1/friendships/show_many/") {
      showManyCalls += 1;

      // Stop through the overlay's click delegation, the same path a real
      // click on the stop button takes.
      const box = sandbox().document.getElementById("ig-follow-back-progress-box");

      if (typeof box?.onclick !== "function") {
        throw new Error("progress overlay should have a click handler for the stop button");
      }

      box.onclick({ target: { closest: (selector) => (selector === "[data-ig-fb-stop]" ? {} : null) } });

      const ids = decodeURIComponent(String(init.body || "").replace(/^user_ids=/, "")).split(",");
      const friendshipStatuses = {};

      for (const id of ids) {
        friendshipStatuses[id] = { following: true, followed_by: true };
      }

      return jsonResponse({ friendship_statuses: friendshipStatuses, status: "ok" });
    }

    throw new Error(`unexpected fetch ${url}`);
  },
});

if (showManyCalls !== 1) {
  throw new Error(`no further batch requests may run after the stop, got ${showManyCalls}`);
}

if (run.results.stoppedByUser !== true) {
  throw new Error("results should record that the run was stopped by the user");
}

if (!run.bodyHtml.includes("follows back (25)")) {
  throw new Error(`verdicts recorded before the stop must be kept:\n${run.bodyHtml}`);
}

if (!run.bodyHtml.includes("not following back (0)") || !run.bodyHtml.includes("unknown (35)")) {
  throw new Error(`unchecked accounts must be parked in Unknown, not counted:\n${run.bodyHtml}`);
}

if (!run.results.warnings.some((warning) => warning.includes("Run stopped by user"))) {
  throw new Error(`expected a stopped-by-user warning, got ${JSON.stringify(run.results.warnings)}`);
}

if (storage.size === 0) {
  throw new Error("resume progress should be saved after a stopped run");
}

if (typeof run.context.window.IG_FOLLOW_BACK_STOP !== "function") {
  throw new Error("the console stop hook window.IG_FOLLOW_BACK_STOP should be exposed");
}

console.log("stop request regression ok");
