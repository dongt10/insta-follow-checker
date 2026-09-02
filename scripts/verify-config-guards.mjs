import { jsonResponse, runChecker } from "./vm-harness.mjs";

// Broken config values (typos, wrong types) must fall back to safe defaults
// instead of silently disabling pacing, and unknown keys must be called out.
const run = await runChecker({
  cookie: "ds_user_id=1; csrftoken=test-csrf",
  config: {
    minRequestIntervalMs: "abc",
    retryLimit: "many",
    relationshipListDelayMs: "fast",
    exactSearchDelayMs: 0,
    batchDelayMs: 0,
    batchSize: 5000,
    individualDelayMs: -50,
    relationshipPageSizes: ["x", -5, "100"],
    typoKey: true,
  },
  fetch: async (url) => {
    if (url === "/api/v1/users/web_profile_info/?username=friend") {
      return jsonResponse({
        data: {
          user: {
            id: "1",
            username: "friend",
            full_name: "Friend",
            edge_follow: { count: 1 },
            edge_followed_by: { count: 100 },
          },
        },
      });
    }

    if (url === "/api/v1/friendships/1/following/?count=100") {
      return jsonResponse({
        users: [{ id: "2", username: "alice", full_name: "Alice" }],
        status: "ok",
      });
    }

    if (url === `/api/v1/friendships/show_many/?user_ids=${encodeURIComponent("2")}`) {
      return jsonResponse({
        friendship_statuses: { 2: { following: true, followed_by: true } },
        status: "ok",
      });
    }

    throw new Error(`unexpected fetch ${url}`);
  },
});

const resolved = run.state.debug.config;

if (resolved.minRequestIntervalMs !== 600) {
  throw new Error(`non-numeric minRequestIntervalMs must fall back to 600, got ${resolved.minRequestIntervalMs}`);
}

if (resolved.retryLimit !== 5) {
  throw new Error(`non-numeric retryLimit must fall back to 5, got ${resolved.retryLimit}`);
}

if (resolved.relationshipListDelayMs !== 1100) {
  throw new Error(`non-numeric relationshipListDelayMs must fall back to 1100, got ${resolved.relationshipListDelayMs}`);
}

if (resolved.fetchTimeoutMs !== 45000) {
  throw new Error(`fetchTimeoutMs default must be 45000, got ${resolved.fetchTimeoutMs}`);
}

if (resolved.batchSize !== 100) {
  throw new Error(`out-of-range batchSize must clamp to 100, got ${resolved.batchSize}`);
}

if (resolved.individualDelayMs !== 0) {
  throw new Error(`negative individualDelayMs must clamp to 0, got ${resolved.individualDelayMs}`);
}

if (JSON.stringify(resolved.relationshipPageSizes) !== JSON.stringify([100])) {
  throw new Error(`relationshipPageSizes must drop invalid entries, got ${JSON.stringify(resolved.relationshipPageSizes)}`);
}

if (!run.consoleWarnings.some((warning) => warning.includes("typoKey"))) {
  throw new Error(`unknown config keys should be warned about, got ${JSON.stringify(run.consoleWarnings)}`);
}

if (!run.bodyHtml.includes("follows back (1)")) {
  throw new Error(`run with clamped config should still complete cleanly:\n${run.bodyHtml}`);
}

const overlay = run.context.document.getElementById("ig-follow-back-progress-box");

if (!overlay || !overlay.innerHTML.includes("Walls:") || !overlay.innerHTML.includes("Elapsed:")) {
  throw new Error(`progress overlay should show wall count and elapsed time:\n${overlay?.innerHTML}`);
}

console.log("config guard regression ok");
