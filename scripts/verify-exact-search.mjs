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
    text: async () => JSON.stringify(body),
  };
}

const profileUsers = {
  friend: {
    id: "1",
    username: "friend",
    full_name: "Friend",
    edge_follow: { count: 3 },
    edge_followed_by: { count: 3 },
  },
};

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
  fetch: async (url) => {
    fetchCalls.push(url);

    const profileMatch = String(url).match(
      /^\/api\/v1\/users\/web_profile_info\/\?username=([^&]+)$/,
    );

    if (profileMatch) {
      const username = decodeURIComponent(profileMatch[1]);
      return jsonResponse({ data: { user: profileUsers[username] } });
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

    if (url === "/api/v1/friendships/1/following/?count=50") {
      return jsonResponse({ users: [] });
    }

    if (url === "/api/v1/friendships/1/followers/?count=100") {
      return jsonResponse({
        users: [
          { id: "2", username: "alice", full_name: "Alice" },
        ],
      });
    }

    if (url === "/api/v1/friendships/1/followers/?count=50") {
      return jsonResponse({ users: [] });
    }

    if (url === "/api/v1/friendships/1/followers/?count=50&search_surface=follow_list_page&query=alice") {
      return jsonResponse({
        users: [
          { id: "2", username: "alice", full_name: "Alice" },
        ],
      });
    }

    if (url === "/api/v1/friendships/1/followers/?count=50&search_surface=follow_list_page&query=bob") {
      return jsonResponse({
        users: [
          { id: "3", username: "bob", full_name: "Bob" },
        ],
      });
    }

    if (url === "/api/v1/friendships/1/followers/?count=50&search_surface=follow_list_page&query=carol") {
      return jsonResponse({ users: [] });
    }

    if (url === "/api/v1/friendships/1/followers/?count=50&query=carol") {
      return jsonResponse({ users: [] });
    }

    throw new Error(`unexpected fetch ${url}`);
  },
  window: {
    IG_FOLLOW_BACK_CONFIG: {
      relationshipListDelayMs: 0,
      exactSearchDelayMs: 0,
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
  index < 100 && !bodyHtml.includes("Verified not following back (1)");
  index += 1
) {
  await new Promise((resolve) => setImmediate(resolve));
}

const expectedCalls = [
  "/api/v1/friendships/1/following/?count=100",
  "/api/v1/friendships/1/followers/?count=100",
  "/api/v1/friendships/1/followers/?count=50",
  "/api/v1/friendships/1/followers/?count=50&search_surface=follow_list_page&query=alice",
  "/api/v1/friendships/1/followers/?count=50&search_surface=follow_list_page&query=bob",
  "/api/v1/friendships/1/followers/?count=50&search_surface=follow_list_page&query=carol",
  "/api/v1/friendships/1/followers/?count=50&query=carol",
];

for (const expected of expectedCalls) {
  if (!fetchCalls.includes(expected)) {
    throw new Error(`missing fetch: ${expected}\nactual:\n${fetchCalls.join("\n")}`);
  }
}

if (fetchCalls.includes("/api/v1/friendships/1/following/?count=50")) {
  throw new Error(`complete following list should skip the extra count=50 pass:\n${fetchCalls.join("\n")}`);
}

if (!bodyHtml.includes("Verified not following back (1)") || !bodyHtml.includes("@carol")) {
  throw new Error(`expected carol to be verified as not following back:\n${bodyHtml}`);
}

if (!bodyHtml.includes("Follows back - corrected (1)") || !bodyHtml.includes("@bob")) {
  throw new Error(`expected bob to be corrected by exact search:\n${bodyHtml}`);
}

if (!bodyHtml.includes("Unknown - not counted (0)")) {
  throw new Error(`expected no unknown results:\n${bodyHtml}`);
}

console.log("exact follower search regression ok");
