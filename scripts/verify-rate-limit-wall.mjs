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

function rateWallResponse() {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    text: async () => "Please wait a few minutes before you try again.",
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
            edge_follow: { count: 3 },
            edge_followed_by: { count: 3 },
          },
        },
      });
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
      return rateWallResponse();
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
  throw new Error(`blocked follower load should not count misses:\n${bodyHtml}`);
}

if (!bodyHtml.includes("rate-limit wall (200)")) {
  throw new Error(`report should explain the rate wall:\n${bodyHtml}`);
}

if (!bodyHtml.includes("No reliable not-following-back result was produced")) {
  throw new Error(`report should tell the user to rerun later:\n${bodyHtml}`);
}

if (fetchCalls.some((url) => String(url).includes("query="))) {
  throw new Error(`exact searches should not run when followers page 1 is blocked:\n${fetchCalls.join("\n")}`);
}

console.log("rate-limit wall safe-stop regression ok");
