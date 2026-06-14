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
      get: () => "application/json; charset=utf-8",
    },
    text: async () => JSON.stringify(body),
  };
}

function htmlWallResponse() {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: {
      get: () => "text/html; charset=utf-8",
    },
    text: async () => "<!doctype html><html><head><title>Instagram</title></head><body></body></html>",
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
  fetch: async (url) => {
    fetchCalls.push(url);

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
      });
    }

    if (url === "/api/v1/friendships/1/followers/?count=100") {
      return htmlWallResponse();
    }

    throw new Error(`unexpected fetch ${url}`);
  },
  window: {
    IG_FOLLOW_BACK_CONFIG: {
      relationshipListDelayMs: 0,
      exactSearchDelayMs: 0,
      retryBaseDelayMs: 0,
      retryLimit: 0,
      relationshipPageSizes: [100],
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
  index < 100 && !bodyHtml.includes("Instagram follow-back result");
  index += 1
) {
  await new Promise((resolve) => setImmediate(resolve));
}

if (!bodyHtml.includes("Verified not following back (0)")) {
  throw new Error(`HTML follower wall should not count misses:\n${bodyHtml}`);
}

if (!bodyHtml.includes("HTML/non-JSON wall (200)")) {
  throw new Error(`report should explain the HTML wall:\n${bodyHtml}`);
}

if (!bodyHtml.includes("Instagram returned an HTML page instead of follower JSON")) {
  throw new Error(`report should identify the follower-side HTML wall:\n${bodyHtml}`);
}

if (fetchCalls.some((url) => String(url).includes("query="))) {
  throw new Error(`exact searches should not run when followers page 1 is HTML-walled:\n${fetchCalls.join("\n")}`);
}

console.log("HTML follower wall safe-stop regression ok");
