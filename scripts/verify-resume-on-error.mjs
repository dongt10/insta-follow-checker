import { jsonResponse, runChecker } from "./vm-harness.mjs";

// An unexpected (non-wall) error mid-list must not lose progress: the pages
// loaded so far are saved for resume before the run reports the error.
const storage = new Map();
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => storage.set(key, String(value)),
  removeItem: (key) => storage.delete(key),
};

const run = await runChecker({
  localStorage,
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
            edge_follow: { count: 4 },
            edge_followed_by: { count: 4 },
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
        next_max_id: "2",
        status: "ok",
      });
    }

    if (url === "/api/v1/friendships/1/following/?count=100&max_id=2") {
      throw new Error("simulated network failure");
    }

    throw new Error(`unexpected fetch ${url}`);
  },
});

if (!run.state?.done || run.state.phase !== "error") {
  throw new Error(`run should end in the error phase, got phase ${run.state?.phase}`);
}

const savedRaw = storage.get("ig-follow-back-resume:anon:1");

if (!savedRaw) {
  throw new Error(`resume progress should be saved when a run dies unexpectedly, storage keys: ${JSON.stringify([...storage.keys()])}`);
}

const saved = JSON.parse(savedRaw);

if (saved.lists?.following?.complete !== false || saved.lists.following.accounts.length !== 2) {
  throw new Error(`the partially loaded following list should be saved for resume:\n${savedRaw}`);
}

if (saved.lists.following.maxId !== "2") {
  throw new Error(`the resume cursor should be saved so the rerun continues mid-list, got ${JSON.stringify(saved.lists.following.maxId)}`);
}

console.log("resume-on-unexpected-error regression ok");
