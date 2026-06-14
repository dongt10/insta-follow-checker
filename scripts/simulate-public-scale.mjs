import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/check-non-followers-public.js", import.meta.url), "utf8");
const RealDate = Date;

function makeAccount(id, prefix) {
  return { pk: String(id), username: `${prefix}_${String(id).padStart(5, "0")}`, full_name: `${prefix} ${id}` };
}

function pageOf(list, count, offsetParam) {
  const offset = offsetParam ? Number(offsetParam) : 0;
  const slice = list.slice(offset, offset + count);
  const body = { users: slice, status: "ok" };
  if (offset + count < list.length) {
    body.next_max_id = String(offset + count);
  }
  return body;
}

function runScenario({ name, profile, following, servedFollowers, walls, config, storage }) {
  const fetchLog = [];
  const attemptsByUrl = new Map();
  let virtualNow = 1765000000000;
  let bodyHtml = "";
  const elementById = new Map();

  const jsonResponse = (body) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (header) => (header === "content-type" ? "application/json; charset=utf-8" : null) },
    text: async () => JSON.stringify(body),
  });

  function VirtualDate(...args) {
    return args.length ? new RealDate(args[0]) : new RealDate(virtualNow);
  }
  VirtualDate.now = () => virtualNow;
  VirtualDate.parse = RealDate.parse.bind(RealDate);

  const context = vm.createContext({
    console: { log: () => {}, error: () => {}, warn: () => {} },
    prompt: () => profile.username,
    Date: VirtualDate,
    setTimeout: (callback, ms) => {
      virtualNow += Math.max(0, Number(ms) || 0);
      callback();
      return 0;
    },
    fetch: async (url) => {
      virtualNow += 300;
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
      IG_NON_FOLLOWERS_CONFIG: config || {},
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

  const startedAt = virtualNow;
  vm.runInContext(source, context);

  return (async () => {
    for (let index = 0; index < 500000 && !context.window.IG_NON_FOLLOWERS_STATE?.done; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    const results = context.window.IG_NON_FOLLOWERS_RESULTS;
    if (!results) {
      throw new Error(`${name}: did not finish: ${context.window.IG_NON_FOLLOWERS_STATE?.message}`);
    }
    return { name, results, fetchLog, requestCount: fetchLog.length, durationMinutes: (virtualNow - startedAt) / 60000 };
  })();
}

function expectedMissUsernames(following, followBackCount) {
  return following.slice(followBackCount).map((user) => user.username).sort();
}

function report(run) {
  const r = run.results;
  console.log(`--- ${run.name}`);
  console.log(`    requests: ${run.requestCount}, simulated wall-clock: ${run.durationMinutes.toFixed(1)} min`);
  console.log(`    loaded: following ${r.loaded.following}, followers ${r.loaded.followers}, follower list complete: ${r.followerListComplete}`);
  console.log(`    confirmed non-followers: ${r.confirmed.length}, unconfirmed: ${r.unconfirmed.length}, follows back: ${r.rescued.length}, unknown: ${r.unknown.length}`);
}

{
  const following = [];
  for (let id = 1; id <= 1500; id += 1) {
    following.push(makeAccount(id, "follow"));
  }
  const followBack = following.slice(0, 1200);
  const fans = [];
  for (let id = 9000; id < 9800; id += 1) {
    fans.push(makeAccount(id, "fan"));
  }
  const realFollowers = [...followBack, ...fans];
  const storage = new Map();

  const run = await runScenario({
    name: "PUBLIC A: friend's account, 2,000 followers / 1,500 following, complete read (exact, zero searches)",
    profile: { id: "5001", username: "friendbig", followerCount: 2000, followingCount: 1500 },
    following,
    servedFollowers: realFollowers,
    storage,
  });

  const confirmed = run.results.confirmed.map((account) => account.username).sort();
  const expected = expectedMissUsernames(following, 1200);
  if (confirmed.join(",") !== expected.join(",")) {
    throw new Error(`PUBLIC A: expected ${expected.length} confirmed misses, got ${confirmed.length}`);
  }
  if (!run.results.followerListComplete) {
    throw new Error("PUBLIC A: a 2k follower list read to the end should be marked complete");
  }
  if (run.fetchLog.some((url) => url.includes("query="))) {
    throw new Error("PUBLIC A: complete read must do zero exact searches (block-safe path)");
  }
  if (run.results.unconfirmed.length !== 0 || run.results.unknown.length !== 0) {
    throw new Error("PUBLIC A: complete read should leave nothing unconfirmed/unknown");
  }
  if (storage.size !== 0) {
    throw new Error("PUBLIC A: clean run should clear resume state");
  }
  report(run);
}

{
  const following = [];
  for (let id = 1; id <= 1200; id += 1) {
    following.push(makeAccount(id, "follow"));
  }
  const followBack = following.slice(0, 1000);
  const fans = [];
  for (let id = 9000; id < 9050; id += 1) {
    fans.push(makeAccount(id, "fan"));
  }
  const realFollowers = [...followBack, ...fans];
  const servedFollowers = realFollowers.filter((_, index) => index < realFollowers.length - 40);
  const storage = new Map();

  const run = await runScenario({
    name: "PUBLIC B: friend's account, 1,000 followers / 1,200 following, follower list under-reports by 40 (auto-verify)",
    profile: { id: "5002", username: "friendmid", followerCount: 1050, followingCount: 1200 },
    following,
    servedFollowers,
    config: { maxVerifications: 500 },
    storage,
  });

  const confirmed = run.results.confirmed.map((account) => account.username).sort();
  const expected = expectedMissUsernames(following, 1000);
  if (confirmed.join(",") !== expected.join(",")) {
    throw new Error(`PUBLIC B: expected exactly the ${expected.length} true non-followers confirmed, got ${confirmed.length} (unconfirmed ${run.results.unconfirmed.length})`);
  }
  if (run.results.unknown.length !== 0) {
    throw new Error(`PUBLIC B: expected no unknown, got ${run.results.unknown.length}`);
  }
  report(run);
}

{
  const following = [];
  for (let id = 1; id <= 1400; id += 1) {
    following.push(makeAccount(id, "follow"));
  }
  const followBack = following.slice(0, 1150);
  const realFollowers = [...followBack];
  const storage = new Map();
  let wallActive = true;

  const blockOnce = (url, attempts) => {
    if (wallActive && /\/followers\/\?count=\d+&max_id=600$/.test(url) && attempts <= 5) {
      return {
        ok: true,
        status: 200,
        statusText: "OK",
        headers: { get: () => null },
        text: async () => "We limit how often you can do certain things on Instagram. Please wait a few minutes.",
      };
    }
    return null;
  };

  const first = await runScenario({
    name: "PUBLIC C1: friend's account blocked mid follower read",
    profile: { id: "5003", username: "friendblock", followerCount: 1150, followingCount: 1400 },
    following,
    servedFollowers: realFollowers,
    config: { retryLimit: 1 },
    storage,
    walls: blockOnce,
  });

  if (first.results.confirmed.length !== 0) {
    throw new Error("PUBLIC C1: a block before the follower list loads must count nothing");
  }
  if (storage.size === 0) {
    throw new Error("PUBLIC C1: blocked run must save resume progress");
  }
  report(first);

  wallActive = false;

  const second = await runScenario({
    name: "PUBLIC C2: rerun after the block clears (resumes saved follower pages)",
    profile: { id: "5003", username: "friendblock", followerCount: 1150, followingCount: 1400 },
    following,
    servedFollowers: realFollowers,
    storage,
  });

  const confirmed = second.results.confirmed.map((account) => account.username).sort();
  const expected = expectedMissUsernames(following, 1150);
  if (confirmed.join(",") !== expected.join(",")) {
    throw new Error(`PUBLIC C2: expected ${expected.length} confirmed after resume, got ${confirmed.length}`);
  }
  if (!second.results.followerListComplete) {
    throw new Error("PUBLIC C2: resumed follower list should complete");
  }
  const refetchedFollowingFromStart = second.fetchLog.filter((url) => /\/following\/\?count=\d+$/.test(url)).length;
  if (refetchedFollowingFromStart > 0 && second.requestCount >= first.requestCount) {
    throw new Error("PUBLIC C2: resumed run should be lighter than the blocked first run");
  }
  report(second);
}

console.log("public scale simulation ok");
