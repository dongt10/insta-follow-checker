import { jsonResponse, runChecker } from "./vm-harness.mjs";

// A fetch that never responds must abort after fetchTimeoutMs and retry
// instead of hanging the whole run forever.
const attemptsByUrl = new Map();

const run = await runChecker({
  realTimers: true,
  globals: { AbortController, clearTimeout },
  config: {
    fetchTimeoutMs: 40,
    retryLimit: 1,
    retryBaseDelayMs: 1,
    retryMaxDelayMs: 5,
    relationshipListDelayMs: 0,
    exactSearchDelayMs: 0,
    minRequestIntervalMs: 0,
    breatherEveryRequests: 0,
    relationshipPageSizes: [100],
  },
  fetch: async (url, init) => {
    const attempts = (attemptsByUrl.get(url) || 0) + 1;

    attemptsByUrl.set(url, attempts);

    if (url === "/api/v1/users/web_profile_info/?username=friend") {
      if (attempts === 1) {
        return new Promise((_resolve, reject) => {
          init.signal?.addEventListener("abort", () => {
            reject(Object.assign(new Error("The operation was aborted."), { name: "AbortError" }));
          });
        });
      }

      return jsonResponse({
        data: {
          user: {
            id: "1",
            username: "friend",
            full_name: "Friend",
            edge_follow: { count: 1 },
            edge_followed_by: { count: 1 },
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

    if (url === "/api/v1/friendships/1/followers/?count=100") {
      return jsonResponse({
        users: [{ id: "2", username: "alice", full_name: "Alice" }],
        status: "ok",
      });
    }

    throw new Error(`unexpected fetch ${url}`);
  },
});

if (!run.state?.done) {
  throw new Error("run should finish despite a hung request");
}

if (attemptsByUrl.get("/api/v1/users/web_profile_info/?username=friend") !== 2) {
  throw new Error(`the hung profile request should be retried exactly once, got ${attemptsByUrl.get("/api/v1/users/web_profile_info/?username=friend")}`);
}

if (!run.state.logs.some((entry) => entry.message.includes("request aborted"))) {
  throw new Error(`expected a timeout log entry, got ${JSON.stringify(run.state.logs.map((entry) => entry.message))}`);
}

if (!run.bodyHtml.includes("$ result")) {
  throw new Error(`run should produce a final report after the retry:\n${run.bodyHtml}`);
}

console.log("fetch timeout regression ok");
