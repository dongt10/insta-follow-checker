import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/check-follow-back.js", import.meta.url), "utf8");
const fetchCalls = [];
let bodyHtml = "";

function jsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: (name) => (name === "content-type" ? "application/json; charset=utf-8" : null),
    },
    text: async () => JSON.stringify(body),
  };
}

const elementById = new Map();
const documentElement = {
  appendChild(element) {
    if (element.id) {
      elementById.set(element.id, element);
    }
  },
};

const context = vm.createContext({
  console,
  prompt: () => "friend",
  setTimeout: (callback) => {
    callback();
    return 0;
  },
  fetch: async (url, init = {}) => {
    fetchCalls.push({ url: String(url), init });

    if (url === "/api/v1/users/web_profile_info/?username=friend") {
      return jsonResponse({
        data: {
          user: {
            id: "1",
            username: "friend",
            full_name: "Friend",
            edge_follow: { count: 3 },
            edge_followed_by: { count: 100 },
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
      });
    }

    if (url === "/api/v1/friendships/1/following/?count=50") {
      return jsonResponse({ users: [] });
    }

    if (String(url).startsWith("https://www.instagram.com/graphql/query/?")) {
      const parsedUrl = new URL(String(url));
      const variables = JSON.parse(parsedUrl.searchParams.get("variables"));

      if (variables.id !== "1" || variables.first !== 24) {
        throw new Error(`unexpected following-feed variables: ${JSON.stringify(variables)}`);
      }

      return jsonResponse({
        data: {
          user: {
            edge_follow: {
              count: 3,
              page_info: {
                has_next_page: false,
                end_cursor: "",
              },
              edges: [
                { node: { id: "2", username: "alice", full_name: "Alice", follows_viewer: true } },
                { node: { id: "3", username: "bob", full_name: "Bob", follows_viewer: false } },
                { node: { id: "4", username: "carol", full_name: "Carol", follows_viewer: false } },
              ],
            },
          },
        },
      });
    }

    if (url === "/api/v1/friendships/show_many/") {
      if (init.body !== `user_ids=${encodeURIComponent("2,3,4")}`) {
        throw new Error(`unexpected show_many body: ${init.body}`);
      }

      return jsonResponse({
        friendship_statuses: {
          2: { following: true, followed_by: true },
          3: { following: true, followed_by: false },
          4: { following: true, followed_by: true },
        },
        status: "ok",
      });
    }

    throw new Error(`unexpected fetch ${url}`);
  },
  window: {
    IG_FOLLOW_BACK_CONFIG: {
      compareFollowingFeed: true,
      relationshipListDelayMs: 0,
      followingFeedDelayMs: 0,
      exactSearchDelayMs: 0,
      batchDelayMs: 0,
      minRequestIntervalMs: 0,
      retryBaseDelayMs: 0,
      retryLimit: 0,
      relationshipPageSizes: [100, 50],
    },
    location: {
      hostname: "www.instagram.com",
      pathname: "/friend/",
    },
  },
  document: {
    title: "",
    cookie: "ds_user_id=1; csrftoken=test-csrf",
    documentElement,
    body: {
      set innerHTML(value) {
        bodyHtml = value;
      },
      get innerHTML() {
        return bodyHtml;
      },
    },
    getElementById: (id) => elementById.get(id) || null,
    createElement: () => ({
      id: "",
      style: {},
      innerHTML: "",
    }),
  },
});

vm.runInContext(source, context);

for (
  let index = 0;
  index < 100 && !bodyHtml.includes("Instagram following-feed hint (2)");
  index += 1
) {
  await new Promise((resolve) => setImmediate(resolve));
}

const urls = fetchCalls.map((call) => call.url);

if (!urls.some((url) => url.startsWith("https://www.instagram.com/graphql/query/?"))) {
  throw new Error(`expected the optional following-feed comparison to run:\n${urls.join("\n")}`);
}

if (!bodyHtml.includes("Verified not following back (1)") || !bodyHtml.includes("@bob")) {
  throw new Error(`expected bob to be verified as not following back:\n${bodyHtml}`);
}

if (!bodyHtml.includes("Follows back - corrected (2)") || !bodyHtml.includes("@carol")) {
  throw new Error(`expected carol to be corrected by batch verification:\n${bodyHtml}`);
}

if (!bodyHtml.includes("Instagram following-feed hint (2)")) {
  throw new Error(`expected the follows_viewer hint section:\n${bodyHtml}`);
}

if (!bodyHtml.includes("Hint not verified as missing (1)") || !bodyHtml.includes("likely source of differences")) {
  throw new Error(`expected the report to explain why simpler tools can show more:\n${bodyHtml}`);
}

console.log("following-feed hint comparison regression ok");
