import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/check-non-followers-public.js", import.meta.url), "utf8");

function makeRunner({ profile, following, servedFollowers, walls, config }) {
  const fetchLog = [];
  const attemptsByUrl = new Map();
  let bodyHtml = "";
  const elementById = new Map();
  const storage = new Map();

  const jsonResponse = (body) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (header) => (header === "content-type" ? "application/json; charset=utf-8" : null) },
    text: async () => JSON.stringify(body),
  });

  const pageOf = (list, count, offsetParam) => {
    const offset = offsetParam ? Number(offsetParam) : 0;
    const slice = list.slice(offset, offset + count);
    const body = { users: slice, status: "ok" };

    if (offset + count < list.length) {
      body.next_max_id = String(offset + count);
    }

    return body;
  };

  const context = vm.createContext({
    console: { log: () => {}, error: () => {}, warn: () => {} },
    prompt: () => profile.username,
    setTimeout: (callback) => {
      callback();
      return 0;
    },
    fetch: async (url) => {
      fetchLog.push(String(url));

      const attempts = (attemptsByUrl.get(String(url)) || 0) + 1;
      attemptsByUrl.set(String(url), attempts);

      const wall = walls ? walls(String(url), attempts) : null;
      if (wall) {
        return wall;
      }

      if (url === `/api/v1/users/web_profile_info/?username=${profile.username}`) {
        return jsonResponse({
          data: {
            user: {
              id: profile.id,
              username: profile.username,
              full_name: "Target",
              is_private: false,
              edge_follow: { count: profile.followingCount },
              edge_followed_by: { count: profile.followerCount },
            },
          },
        });
      }

      const listMatch = String(url).match(
        /^\/api\/v1\/friendships\/(\d+)\/(following|followers)\/\?count=(\d+)(?:&max_id=([^&]+))?$/,
      );
      if (listMatch && listMatch[1] === profile.id) {
        const list = listMatch[2] === "following" ? following : servedFollowers;
        return jsonResponse(pageOf(list, Number(listMatch[3]), listMatch[4]));
      }

      const searchMatch = String(url).match(/[?&]query=([^&]+)/);
      if (searchMatch) {
        const query = decodeURIComponent(searchMatch[1]);
        const match = servedFollowers.find((user) => user.username === query);
        return jsonResponse({ users: match ? [match] : [], status: "ok" });
      }

      throw new Error(`unexpected fetch ${url}`);
    },
    window: {
      IG_NON_FOLLOWERS_CONFIG: Object.assign(
        { listDelayMs: 0, minRequestIntervalMs: 0, verifyDelayMs: 0, retryBaseDelayMs: 0, retryLimit: 0 },
        config || {},
      ),
      location: { hostname: "www.instagram.com", pathname: `/${profile.username}/` },
      localStorage: {
        getItem: (key) => (storage.has(key) ? storage.get(key) : null),
        setItem: (key, value) => storage.set(key, String(value)),
        removeItem: (key) => storage.delete(key),
      },
    },
    document: {
      title: "",
      cookie: "ds_user_id=999",
      documentElement: { appendChild: (element) => element.id && elementById.set(element.id, element) },
      body: {
        set innerHTML(value) { bodyHtml = value; },
        get innerHTML() { return bodyHtml; },
      },
      getElementById: (id) => elementById.get(id) || null,
      createElement: () => ({ id: "", style: {}, innerHTML: "" }),
    },
  });

  return { context, fetchLog, storage, getBody: () => bodyHtml };
}

async function settle(context) {
  for (let index = 0; index < 5000 && !context.window.IG_NON_FOLLOWERS_STATE?.done; index += 1) {
    await new Promise((resolve) => setImmediate(resolve));
  }

  const results = context.window.IG_NON_FOLLOWERS_RESULTS;
  if (!results) {
    throw new Error(`run did not finish: ${context.window.IG_NON_FOLLOWERS_STATE?.message}`);
  }
  return results;
}

const names = (accounts) => accounts.map((account) => account.username).sort().join(",");

function acct(id, prefix) {
  return { pk: String(id), username: `${prefix}${id}`, full_name: `${prefix} ${id}` };
}

{
  const following = [acct(1, "a"), acct(2, "a"), acct(3, "a"), acct(4, "a")];
  const servedFollowers = [acct(1, "a"), acct(2, "a")];
  const runner = makeRunner({
    profile: { id: "1", username: "complete", followerCount: 2, followingCount: 4 },
    following,
    servedFollowers,
  });

  vm.runInContext(source, runner.context);
  const results = await settle(runner.context);

  if (!results.followerListComplete) {
    throw new Error("scenario 1: follower list should be complete");
  }
  if (names(results.confirmed) !== "a3,a4") {
    throw new Error(`scenario 1: expected a3,a4 confirmed, got ${names(results.confirmed)}`);
  }
  if (results.unconfirmed.length !== 0) {
    throw new Error(`scenario 1: expected no unconfirmed, got ${results.unconfirmed.length}`);
  }
  if (runner.fetchLog.some((url) => url.includes("query="))) {
    throw new Error("scenario 1: a complete list must NOT trigger any exact searches (this is what avoids the block)");
  }
  if (runner.storage.size !== 0) {
    throw new Error("scenario 1: clean run should clear resume state");
  }
  console.log("public scenario 1 (complete list, zero searches) ok");
}

{
  const following = [acct(1, "b"), acct(2, "b"), acct(3, "b")];
  const fullFollowers = [acct(1, "b"), acct(2, "b")];
  const servedFollowers = [acct(1, "b")];
  const runner = makeRunner({
    profile: { id: "2", username: "incomplete", followerCount: 2, followingCount: 3 },
    following,
    servedFollowers: fullFollowers,
    walls: (url) => {
      const isBulkFollowers = /\/followers\/\?count=\d+(&max_id=\d+)?$/.test(url);
      if (isBulkFollowers && !url.includes("query=") && url.includes("max_id=1")) {
        return null;
      }
      if (isBulkFollowers && !url.includes("query=") && !url.includes("max_id")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: (header) => (header === "content-type" ? "application/json" : null) },
          text: async () => JSON.stringify({ users: [servedFollowers[0]], next_max_id: null, status: "ok" }),
        };
      }
      return null;
    },
  });

  vm.runInContext(source, runner.context);
  const results = await settle(runner.context);

  if (results.followerListComplete) {
    throw new Error("scenario 2: follower list should be detected incomplete");
  }
  if (names(results.confirmed) !== "b3") {
    throw new Error(`scenario 2: expected b3 confirmed, got ${names(results.confirmed)}`);
  }
  if (names(results.rescued) !== "b2") {
    throw new Error(`scenario 2: expected b2 rescued by verification, got ${names(results.rescued)}`);
  }
  if (results.unknown.length !== 0) {
    throw new Error(`scenario 2: expected no unknown, got ${results.unknown.length}`);
  }
  console.log("public scenario 2 (incomplete list verified, false positive rescued) ok");
}

{
  const following = [acct(1, "c"), acct(2, "c")];
  const runner = makeRunner({
    profile: { id: "3", username: "blocked", followerCount: 5, followingCount: 2 },
    following,
    servedFollowers: [],
    walls: (url) => {
      if (/\/followers\/\?count=/.test(url) && !url.includes("query=")) {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          headers: { get: () => null },
          text: async () => "We limit how often you can do certain things on Instagram to protect our community. Try again later.",
        };
      }
      return null;
    },
  });

  vm.runInContext(source, runner.context);
  const results = await settle(runner.context);

  if (results.confirmed.length !== 0) {
    throw new Error(`scenario 3: an action block must not count any misses, got ${results.confirmed.length}`);
  }
  if (runner.fetchLog.some((url) => url.includes("query="))) {
    throw new Error("scenario 3: must not run exact searches once the follower list is blocked");
  }
  if (!results.warnings.some((warning) => warning.includes("action-block") || warning.includes("blocked"))) {
    throw new Error(`scenario 3: report should explain the action block:\n${results.warnings.join("\n")}`);
  }
  if (runner.storage.size === 0) {
    throw new Error("scenario 3: a blocked run should keep resume state for a lighter rerun");
  }
  console.log("public scenario 3 (action-block safe stop) ok");
}

console.log("public non-follower checker regression ok");
