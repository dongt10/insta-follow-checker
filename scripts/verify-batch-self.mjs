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

const storage = new Map();
let lastSaved = null;
const localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => {
    lastSaved = { key, value: String(value) };
    storage.set(key, String(value));
  },
  removeItem: (key) => storage.delete(key),
};

const context = vm.createContext({
  console,
  prompt: () => "friend",
  setTimeout: (callback) => {
    callback();
    return 0;
  },
  fetch: async (url, init = {}) => {
    fetchCalls.push({ url, init });

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
          { id: "4", username: "carol", full_name: "Carol" },
        ],
      });
    }

    if (url === "/api/v1/friendships/show_many/") {
      if (init.method !== "POST") {
        throw new Error("show_many must be a POST request");
      }

      if (init.headers?.["x-csrftoken"] !== "test-csrf") {
        throw new Error("show_many must send the csrftoken cookie as x-csrftoken");
      }

      if (init.body !== `user_ids=${encodeURIComponent("2,3,4")}`) {
        throw new Error(`unexpected show_many body: ${init.body}`);
      }

      return jsonResponse({
        friendship_statuses: {
          2: { following: true, followed_by: true },
          3: { following: true, followed_by: true },
          4: { following: true, followed_by: false },
        },
        status: "ok",
      });
    }

    throw new Error(`unexpected fetch ${url}`);
  },
  window: {
    IG_FOLLOW_BACK_CONFIG: {
      relationshipListDelayMs: 0,
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
    localStorage,
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
  index < 100 && !bodyHtml.includes("Verified not following back (1)");
  index += 1
) {
  await new Promise((resolve) => setImmediate(resolve));
}

if (!bodyHtml.includes("Verified not following back (1)") || !bodyHtml.includes("@carol")) {
  throw new Error(`expected carol to be verified as not following back:\n${bodyHtml}`);
}

if (!bodyHtml.includes("Follows back - corrected (2)")) {
  throw new Error(`expected alice and bob to be corrected by the batch check:\n${bodyHtml}`);
}

if (!bodyHtml.includes("Unknown - not counted (0)")) {
  throw new Error(`expected no unknown results:\n${bodyHtml}`);
}

const urls = fetchCalls.map((call) => String(call.url));

if (urls.some((url) => url.includes("query="))) {
  throw new Error(`self check should use batch verification, not exact search:\n${urls.join("\n")}`);
}

if (urls.some((url) => url.includes("/followers/?count="))) {
  throw new Error(`self check with many followers should skip the bulk follower list:\n${urls.join("\n")}`);
}

if (urls.includes("/api/v1/friendships/1/following/?count=50")) {
  throw new Error(`complete following list should skip the extra count=50 pass:\n${urls.join("\n")}`);
}

if (!lastSaved || lastSaved.key !== "ig-follow-back-resume:1:1") {
  throw new Error(`resume progress should be saved under a viewer-scoped key: ${JSON.stringify(lastSaved?.key)}`);
}

const parsedResume = JSON.parse(lastSaved.value);

if (parsedResume.verdicts?.["v:4"]?.followsBack !== false) {
  throw new Error(`resume state should record carol's verified verdict by id:\n${lastSaved.value}`);
}

if (parsedResume.lists?.following?.complete !== true) {
  throw new Error(`resume state should record the complete following list:\n${lastSaved.value}`);
}

if (storage.has("ig-follow-back-resume:1:1")) {
  throw new Error("resume state should be cleared after a fully clean run");
}

console.log("batch self-check regression ok");
