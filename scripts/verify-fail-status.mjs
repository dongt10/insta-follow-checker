import { jsonResponse, runChecker } from "./vm-harness.mjs";

// A 200 response with {"status":"fail"} and an unrecognized message must be
// treated as a wall, not as clean data: an empty-looking "fail" search result
// must never verify an account as not following back.
const run = await runChecker({
  config: {
    relationshipListDelayMs: 0,
    exactSearchDelayMs: 0,
    retryBaseDelayMs: 0,
    retryLimit: 0,
    relationshipPageSizes: [100],
  },
  fetch: async (url) => {
    if (url === "/api/v1/users/web_profile_info/?username=friend") {
      return jsonResponse({
        data: {
          user: {
            id: "1",
            username: "friend",
            full_name: "Friend",
            edge_follow: { count: 2 },
            edge_followed_by: { count: 2 },
          },
        },
      });
    }

    if (url === "/api/v1/friendships/1/following/?count=100") {
      return jsonResponse({
        users: [
          { id: "2", username: "alice", full_name: "Alice" },
          { id: "3", username: "bob", full_name: "Bob" },
        ],
        status: "ok",
      });
    }

    if (url === "/api/v1/friendships/1/followers/?count=100") {
      return jsonResponse({
        users: [{ id: "2", username: "alice", full_name: "Alice" }],
        status: "ok",
      });
    }

    if (url === "/api/v1/friendships/1/followers/?count=50&search_surface=follow_list_page&query=alice") {
      return jsonResponse({
        users: [{ id: "2", username: "alice", full_name: "Alice" }],
        status: "ok",
      });
    }

    if (
      url === "/api/v1/friendships/1/followers/?count=50&search_surface=follow_list_page&query=bob"
      || url === "/api/v1/friendships/1/followers/?count=50&query=bob"
    ) {
      return jsonResponse({ status: "fail", message: "unexpected_block_reason" });
    }

    throw new Error(`unexpected fetch ${url}`);
  },
});

if (!run.bodyHtml.includes("not following back (0)")) {
  throw new Error(`a status:"fail" search response must not verify a miss:\n${run.bodyHtml}`);
}

if (!run.bodyHtml.includes("unknown (1)") || !run.bodyHtml.includes("@bob")) {
  throw new Error(`the walled account must stay Unknown:\n${run.bodyHtml}`);
}

if (!run.bodyHtml.includes("rate-limit wall (200)")) {
  throw new Error(`the fail-status response should be classified as a rate wall:\n${run.bodyHtml}`);
}

if (run.state.walls < 1) {
  throw new Error(`the fail-status wall should register as a wall, got ${run.state.walls}`);
}

if (!run.bodyHtml.includes("class=\"reason\"")) {
  throw new Error(`unknown accounts should show their reason in the report:\n${run.bodyHtml}`);
}

if (
  !run.bodyHtml.includes("ig-fb-copy-misses")
  || !run.bodyHtml.includes("ig-fb-download-json")
  || !run.bodyHtml.includes("ig-fb-download-csv")
) {
  throw new Error(`the report should include copy/download actions:\n${run.bodyHtml}`);
}

if (!run.results.warnings.some((warning) => warning.includes("wall appeared during exact verification"))) {
  throw new Error(`expected an exact-verification wall warning, got ${JSON.stringify(run.results.warnings)}`);
}

console.log("fail-status wall regression ok");
