import { jsonResponse, runChecker } from "./vm-harness.mjs";

function domElement(textContent, options = {}) {
  return {
    textContent,
    parentElement: options.parentElement || null,
    getAttribute(name) {
      return options[name] || "";
    },
    querySelector() {
      return null;
    },
  };
}

const followers = domElement("100 followers");
const following = domElement("3 following");

const run = await runChecker({
  username: "friend",
  cookie: "ds_user_id=1; csrftoken=test-csrf",
  config: {
    relationshipListDelayMs: 0,
    exactSearchDelayMs: 0,
    batchDelayMs: 0,
    minRequestIntervalMs: 0,
    retryBaseDelayMs: 0,
    retryLimit: 0,
    relationshipPageSizes: [100],
    includeFollowingStatusHints: false,
    resume: false,
  },
  documentOverrides: {
    querySelector: (selector) => (
      selector === 'a[href^="/accounts/edit"]' ? {} : null
    ),
    querySelectorAll: () => [followers, following],
  },
  fetch: async (url) => {
    if (url.includes("web_profile_info")) {
      throw new Error("the current profile page must avoid the rate-limited profile endpoint");
    }

    if (url === "/api/v1/friendships/1/following/?count=100") {
      return jsonResponse({
        users: [
          { id: "2", username: "alice", full_name: "Alice" },
          { id: "3", username: "bob", full_name: "Bob" },
          { id: "4", username: "carol", full_name: "Carol" },
        ],
      });
    }

    if (url === "/api/v1/friendships/1/followers/?count=100") {
      return jsonResponse({
        users: [
          { id: "2", username: "alice", full_name: "Alice" },
          { id: "3", username: "bob", full_name: "Bob" },
        ],
      });
    }

    if (url.startsWith("/api/v1/friendships/show_many/?user_ids=")) {
      const ids = decodeURIComponent(url.split("user_ids=")[1] || "").split(",").filter(Boolean);

      return jsonResponse({
        friendship_statuses: Object.fromEntries(ids.map((id) => [id, { following: true }])),
        status: "ok",
      });
    }

    const individualMatch = url.match(/^\/api\/v1\/friendships\/show\/(\d+)\/$/);

    if (individualMatch) {
      return jsonResponse({
        following: true,
        followed_by: individualMatch[1] !== "4",
        status: "ok",
      });
    }

    throw new Error(`unexpected fetch ${url}`);
  },
});

if (!run.results) {
  throw new Error("current-page profile fallback did not finish");
}

if (run.fetchCalls.some(({ url }) => url.includes("web_profile_info"))) {
  throw new Error("current-page profile fallback still called the profile endpoint");
}

if (!run.fetchCalls.some(({ url }) => url === "/api/v1/friendships/1/followers/?count=100")) {
  throw new Error("auto mode must load followers when the bulk response omits followed_by");
}

if (run.results.target.id !== "1") {
  throw new Error(`expected the signed-in profile id, got ${run.results.target.id}`);
}

if (run.results.profileCounts.followers !== 100 || run.results.profileCounts.following !== 3) {
  throw new Error(`unexpected current-page counts: ${JSON.stringify(run.results.profileCounts)}`);
}

if (run.results.verifiedNotFollowingBack.map(({ username }) => username).join(",") !== "carol") {
  throw new Error("the fallback profile record must continue through batch verification");
}

console.log("current-page profile fallback regression ok");
