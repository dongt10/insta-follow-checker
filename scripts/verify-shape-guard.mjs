import { jsonResponse, runChecker } from "./vm-harness.mjs";

// JSON responses without a recognizable users container (an API shape change)
// must never read as "account not found": exact search keeps the account
// Unknown, and a list page stops the sweep like a wall.
const profileResponse = jsonResponse({
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
const followingResponse = () => jsonResponse({
  users: [
    { id: "2", username: "alice", full_name: "Alice" },
    { id: "3", username: "bob", full_name: "Bob" },
  ],
  status: "ok",
});
const baseConfig = {
  relationshipListDelayMs: 0,
  exactSearchDelayMs: 0,
  retryBaseDelayMs: 0,
  retryLimit: 0,
  relationshipPageSizes: [100],
};

const searchShapeRun = await runChecker({
  config: baseConfig,
  fetch: async (url) => {
    if (url === "/api/v1/users/web_profile_info/?username=friend") {
      return profileResponse;
    }

    if (url === "/api/v1/friendships/1/following/?count=100") {
      return followingResponse();
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
      return jsonResponse({ status: "ok" });
    }

    throw new Error(`unexpected fetch ${url}`);
  },
});

if (!searchShapeRun.bodyHtml.includes("not following back (0)")) {
  throw new Error(`an unrecognized search shape must not verify a miss:\n${searchShapeRun.bodyHtml}`);
}

if (!searchShapeRun.bodyHtml.includes("unknown (1)") || !searchShapeRun.bodyHtml.includes("recognizable result list")) {
  throw new Error(`the shape-guarded account must stay Unknown with its reason:\n${searchShapeRun.bodyHtml}`);
}

console.log("exact-search shape guard ok");

const listShapeRun = await runChecker({
  config: baseConfig,
  fetch: async (url) => {
    if (url === "/api/v1/users/web_profile_info/?username=friend") {
      return profileResponse;
    }

    if (url === "/api/v1/friendships/1/following/?count=100") {
      return followingResponse();
    }

    if (url === "/api/v1/friendships/1/followers/?count=100") {
      return jsonResponse({ status: "ok" });
    }

    throw new Error(`unexpected fetch ${url}`);
  },
});

if (!listShapeRun.bodyHtml.includes("not following back (0)")) {
  throw new Error(`an unrecognized list shape must not produce verified misses:\n${listShapeRun.bodyHtml}`);
}

if (!listShapeRun.bodyHtml.includes("Followers list stopped early") || !listShapeRun.bodyHtml.includes("recognizable account list")) {
  throw new Error(`the list shape guard should stop the sweep like a wall:\n${listShapeRun.bodyHtml}`);
}

if (listShapeRun.fetchCalls.some((call) => call.url.includes("query="))) {
  throw new Error(`exact searches must not run after a shape-blocked follower list:\n${listShapeRun.fetchCalls.map((call) => call.url).join("\n")}`);
}

console.log("list-page shape guard ok");
