import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/check-follow-back.js", import.meta.url), "utf8");
const fetchCalls = [];
let renderedText = "";

function jsonResponse(body) {
  return {
    ok: true,
    json: async () => body,
  };
}

const profileUsers = {
  me: {
    id: "1",
    username: "me",
    full_name: "Me",
    edge_follow: { count: 3 },
  },
  alice: {
    id: "2",
    username: "alice",
    full_name: "Alice",
    follows_viewer: true,
  },
  bob: {
    id: "3",
    username: "bob",
    full_name: "Bob",
    follows_viewer: false,
  },
  carol: {
    id: "4",
    username: "carol",
    full_name: "Carol",
    follows_viewer: true,
  },
};

const context = vm.createContext({
  console,
  prompt: () => "me",
  setTimeout: (callback) => {
    callback();
    return 0;
  },
  fetch: async (url) => {
    fetchCalls.push(url);

    if (url === "/api/v1/accounts/current_user/?edit=true") {
      return {
        ok: false,
        status: 400,
        text: async () => '{"message":"useragent mismatch","status":"fail"}',
      };
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

    const profileMatch = String(url).match(
      /^\/api\/v1\/users\/web_profile_info\/\?username=([^&]+)$/,
    );

    if (profileMatch) {
      const username = decodeURIComponent(profileMatch[1]);
      return jsonResponse({ data: { user: profileUsers[username] } });
    }

    throw new Error(`unexpected fetch ${url}`);
  },
  window: {
    IG_FOLLOW_BACK_CONFIG: {
      profileCheckDelayMs: 0,
    },
    location: {
      hostname: "www.instagram.com",
      pathname: "/me/",
    },
  },
  document: {
    body: {
      innerHTML: "",
      append: () => {},
    },
    querySelector: (selector) => (
      selector === "a[href*='/accounts/edit']"
        ? { href: "/accounts/edit/" }
        : null
    ),
    createElement: () => ({
      style: {},
      set textContent(value) {
        renderedText = value;
      },
      get textContent() {
        return renderedText;
      },
    }),
  },
});

vm.runInContext(source, context);

for (let index = 0; index < 100 && !renderedText.includes("not following back"); index += 1) {
  await new Promise((resolve) => setImmediate(resolve));
}

const expectedProfileChecks = ["alice", "bob", "carol"].map(
  (username) => `/api/v1/users/web_profile_info/?username=${username}`,
);

for (const expected of expectedProfileChecks) {
  if (!fetchCalls.includes(expected)) {
    throw new Error(`missing one-by-one profile check: ${expected}`);
  }
}

if (!renderedText.includes("not following back 1") || !renderedText.includes("@bob - Bob")) {
  throw new Error(`unexpected report:\n${renderedText}`);
}

console.log("one-by-one profile checks ok");
