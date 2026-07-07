import { jsonResponse, runChecker } from "./vm-harness.mjs";

// A followers list that ends cleanly with zero accounts while the profile
// count is positive is a soft wall (the "empty follower modal" state). The
// run must stop safely instead of exact-searching everything against empty
// results, which would verify the entire following list as misses.
// The same scenario runs against the built bookmarklet to prove the minified
// artifact behaves identically.
async function runScenario(sourceFile) {
  return runChecker({
    sourceFile,
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
        return jsonResponse({ users: [], status: "ok" });
      }

      throw new Error(`unexpected fetch ${url}`);
    },
  });
}

for (const sourceFile of ["../src/check-follow-back.js", "../bookmarklet.js"]) {
  const run = await runScenario(sourceFile);
  const label = sourceFile.replace("../", "");

  if (!run.bodyHtml.includes("not following back (0)")) {
    throw new Error(`${label}: an empty follower list must not produce verified misses:\n${run.bodyHtml}`);
  }

  if (run.fetchCalls.some((call) => call.url.includes("query="))) {
    throw new Error(`${label}: exact searches must not run without any known follower:\n${run.fetchCalls.map((call) => call.url).join("\n")}`);
  }

  if (!run.results.warnings.some((warning) => warning.includes("No reliable not-following-back result was produced"))) {
    throw new Error(`${label}: expected the unavailable-list warning, got ${JSON.stringify(run.results.warnings)}`);
  }

  console.log(`empty follower list safe-stop ok: ${label}`);
}

// A target whose profile honestly reports 0 followers dodges the
// unavailable-list guard, so the no-canary rule must park every tentative
// miss in Unknown instead of trusting exact searches against emptiness.
const zeroFollowerRun = await runChecker({
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
            edge_followed_by: { count: 0 },
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
      return jsonResponse({ users: [], status: "ok" });
    }

    throw new Error(`unexpected fetch ${url}`);
  },
});

if (!zeroFollowerRun.bodyHtml.includes("not following back (0)") || !zeroFollowerRun.bodyHtml.includes("unknown (2)")) {
  throw new Error(`without a canary, tentative misses must stay Unknown:\n${zeroFollowerRun.bodyHtml}`);
}

if (zeroFollowerRun.fetchCalls.some((call) => call.url.includes("query="))) {
  throw new Error(`exact searches must not run without a reliability canary:\n${zeroFollowerRun.fetchCalls.map((call) => call.url).join("\n")}`);
}

if (!zeroFollowerRun.results.warnings.some((warning) => warning.includes("no known follower was available"))) {
  throw new Error(`expected the missing-canary warning, got ${JSON.stringify(zeroFollowerRun.results.warnings)}`);
}

console.log("no-canary parking ok: zero-follower target");

// A following list that ends cleanly with zero accounts while the profile
// count is positive must stop the run before it produces a clean-looking
// "0 not following back" report from missing data.
const emptyFollowingRun = await runChecker({
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
      return jsonResponse({ users: [], status: "ok" });
    }

    throw new Error(`unexpected fetch ${url}`);
  },
});

if (emptyFollowingRun.fetchCalls.some((call) => call.url.includes("/followers/"))) {
  throw new Error(`the follower list must be skipped when the following list is empty:\n${emptyFollowingRun.fetchCalls.map((call) => call.url).join("\n")}`);
}

if (!emptyFollowingRun.results.warnings.some((warning) => warning.includes("No reliable not-following-back result was produced"))) {
  throw new Error(`an empty following list must be reported as unavailable, got ${JSON.stringify(emptyFollowingRun.results.warnings)}`);
}

console.log("empty following list safe-stop ok");
