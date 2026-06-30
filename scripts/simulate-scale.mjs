import vm from "node:vm";
import { readFile } from "node:fs/promises";

const source = await readFile(new URL("../src/check-follow-back.js", import.meta.url), "utf8");
const RealDate = Date;

function makeAccount(id, prefix) {
  return {
    pk: String(id),
    username: `${prefix}_${String(id).padStart(5, "0")}`,
    full_name: `${prefix} ${id}`,
    is_private: false,
  };
}

function pageOf(list, count, offsetParam) {
  const offset = offsetParam ? Number(offsetParam) : 0;
  const slice = list.slice(offset, offset + count);
  const next = offset + count;
  const body = { users: slice, status: "ok" };

  if (next < list.length) {
    body.next_max_id = String(next);
  }

  return body;
}

function mockJsonResponse(body) {
  return {
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (header) => (header === "content-type" ? "application/json; charset=utf-8" : null) },
    text: async () => JSON.stringify(body),
  };
}

function runScenario({ name, profile, following, servedFollowers, groundTruthFollowerIds, walls, config, storage, viewerId }) {
  const fetchLog = [];
  const attemptsByUrl = new Map();
  let virtualNow = 1765000000000;
  let bodyHtml = "";
  const sleeps = [];

  const jsonResponse = (body) => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: (header) => (header === "content-type" ? "application/json; charset=utf-8" : null) },
    text: async () => JSON.stringify(body),
  });
  const rateWall = () => ({
    ok: true,
    status: 200,
    statusText: "OK",
    headers: { get: () => null },
    text: async () => "Please wait a few minutes before you try again.",
  });
  const tooManyRequests = (retryAfterSeconds) => ({
    ok: false,
    status: 429,
    statusText: "Too Many Requests",
    headers: {
      get: (header) => {
        if (header === "retry-after") {
          return String(retryAfterSeconds);
        }

        return header === "content-type" ? "application/json" : null;
      },
    },
    text: async () => JSON.stringify({ message: "rate limited", status: "fail" }),
  });

  const elementById = new Map();
  const localStorageMock = {
    getItem: (key) => (storage.has(key) ? storage.get(key) : null),
    setItem: (key, value) => storage.set(key, String(value)),
    removeItem: (key) => storage.delete(key),
  };

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
      const waitMs = Math.max(0, Number(ms) || 0);

      sleeps.push(waitMs);
      virtualNow += waitMs;
      callback();

      return 0;
    },
    fetch: async (url, init = {}) => {
      virtualNow += 300;
      fetchLog.push({ url: String(url), init });

      const attempts = (attemptsByUrl.get(url) || 0) + 1;

      attemptsByUrl.set(url, attempts);

      const wallResponse = walls ? walls(String(url), attempts, init) : null;

      if (wallResponse) {
        return wallResponse === "rate-text" ? rateWall() : wallResponse;
      }

      if (url === `/api/v1/users/web_profile_info/?username=${profile.username}`) {
        return jsonResponse({
          data: {
            user: {
              id: profile.id,
              username: profile.username,
              full_name: "Sim User",
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

      if (url === "/api/v1/friendships/show_many/") {
        const bodyText = String(init.body || "");
        const ids = decodeURIComponent(bodyText.replace(/^user_ids=/, "")).split(",");
        const friendshipStatuses = {};

        for (const id of ids) {
          friendshipStatuses[id] = {
            following: true,
            followed_by: groundTruthFollowerIds.has(id),
          };
        }

        return jsonResponse({ friendship_statuses: friendshipStatuses, status: "ok" });
      }

      const individualMatch = String(url).match(/^\/api\/v1\/friendships\/show\/(\d+)\/$/);

      if (individualMatch) {
        return jsonResponse({
          following: true,
          followed_by: groundTruthFollowerIds.has(individualMatch[1]),
          status: "ok",
        });
      }

      throw new Error(`unexpected fetch ${url}`);
    },
    window: {
      IG_FOLLOW_BACK_CONFIG: config || {},
      location: { hostname: "www.instagram.com", pathname: `/${profile.username}/` },
      localStorage: localStorageMock,
    },
    document: {
      title: "",
      cookie: `ds_user_id=${viewerId}; csrftoken=sim-csrf`,
      documentElement: {
        appendChild(element) {
          if (element.id) {
            elementById.set(element.id, element);
          }
        },
      },
      body: {
        set innerHTML(value) {
          bodyHtml = value;
        },
        get innerHTML() {
          return bodyHtml;
        },
      },
      getElementById: (id) => elementById.get(id) || null,
      createElement: () => ({ id: "", style: {}, innerHTML: "" }),
    },
  });

  const startedAt = virtualNow;

  vm.runInContext(source, context);

  return (async () => {
    for (let index = 0; index < 200000 && !context.window.IG_FOLLOW_BACK_STATE?.done; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const state = context.window.IG_FOLLOW_BACK_STATE;
    const results = context.window.IG_FOLLOW_BACK_RESULTS;

    if (!state?.done) {
      throw new Error(`${name}: simulation did not finish`);
    }

    if (!results) {
      throw new Error(`${name}: script ended without results: ${state.message}`);
    }

    return {
      name,
      results,
      fetchLog,
      durationMinutes: (virtualNow - startedAt) / 60000,
      requestCount: fetchLog.length,
    };
  })();
}

function assertExactSet(name, actualAccounts, expectedUsernames) {
  const actual = actualAccounts.map((account) => account.username).sort();
  const expected = [...expectedUsernames].sort();

  if (actual.length !== expected.length) {
    throw new Error(`${name}: expected ${expected.length} accounts, got ${actual.length}`);
  }

  for (let index = 0; index < expected.length; index += 1) {
    if (actual[index] !== expected[index]) {
      throw new Error(`${name}: mismatch at ${index}: ${actual[index]} vs ${expected[index]}`);
    }
  }
}

function report(run) {
  const { results } = run;

  console.log(`--- ${run.name}`);
  console.log(`    requests: ${run.requestCount}, simulated wall-clock: ${run.durationMinutes.toFixed(1)} min`);
  console.log(`    loaded: following ${results.loaded.following}, followers ${results.loaded.followers}`);
  console.log(`    verified not following back: ${results.verifiedNotFollowingBack.length}, follows back: ${results.correctedByExactSearch.length}, unknown: ${results.unknown.length}`);
}

const SELF_ID = "42";

{
  const following = [];

  for (let id = 1; id <= 1400; id += 1) {
    following.push(makeAccount(id, "user"));
  }

  const followBack = following.slice(0, 1150);
  const pureFollowers = [];

  for (let id = 5000; id < 5850; id += 1) {
    pureFollowers.push(makeAccount(id, "fan"));
  }

  const realFollowers = [...followBack, ...pureFollowers];
  const omittedFromBulk = new Set(followBack.slice(0, 30).map((user) => user.pk));
  const servedFollowers = realFollowers.filter((user) => !omittedFromBulk.has(user.pk));
  const groundTruthFollowerIds = new Set(realFollowers.map((user) => user.pk));
  const expectedMisses = following.slice(1150).map((user) => user.username);
  const storage = new Map();

  const run = await runScenario({
    name: "A: self-check, 2,000 followers / 1,400 following, lossy bulk list, rate walls",
    profile: { id: SELF_ID, username: "bigself", followerCount: 2000, followingCount: 1400 },
    following,
    servedFollowers,
    groundTruthFollowerIds,
    viewerId: SELF_ID,
    storage,
    config: { skipFollowerListWhenSelf: false },
    walls: (url, attempts) => {
      if (url === `/api/v1/friendships/${SELF_ID}/following/?count=100&max_id=200` && attempts === 1) {
        return {
          ok: false,
          status: 429,
          statusText: "Too Many Requests",
          headers: {
            get: (header) => (header === "retry-after" ? "5" : (header === "content-type" ? "application/json" : null)),
          },
          text: async () => JSON.stringify({ message: "rate limited", status: "fail" }),
        };
      }

      if (url === `/api/v1/friendships/${SELF_ID}/followers/?count=100&max_id=600` && attempts === 1) {
        return "rate-text";
      }

      return null;
    },
  });

  assertExactSet(run.name, run.results.verifiedNotFollowingBack, expectedMisses);

  if (run.results.correctedByExactSearch.length !== 30) {
    throw new Error(`A: the 30 bulk-omitted real followers must be corrected, got ${run.results.correctedByExactSearch.length}`);
  }

  if (run.results.unknown.length !== 0 || run.results.authLost) {
    throw new Error(`A: expected a clean run, got ${run.results.unknown.length} unknown, authLost ${run.results.authLost}`);
  }

  if (run.fetchLog.some((call) => call.url.includes("query="))) {
    throw new Error("A: self-check must not fall back to exact search");
  }

  if (storage.size !== 0) {
    throw new Error("A: resume state must be cleared after a clean run");
  }

  report(run);
}

{
  const following = [];

  for (let id = 1; id <= 800; id += 1) {
    following.push(makeAccount(id, "user"));
  }

  const followBack = following.slice(0, 600);
  const groundTruthFollowerIds = new Set(followBack.map((user) => user.pk));
  const expectedMisses = following.slice(600).map((user) => user.username);
  const storage = new Map();

  const run = await runScenario({
    name: "B: self-check, 5,000 followers / 800 following, bulk follower list skipped",
    profile: { id: SELF_ID, username: "popularself", followerCount: 5000, followingCount: 800 },
    following,
    servedFollowers: [],
    groundTruthFollowerIds,
    viewerId: SELF_ID,
    storage,
    walls: null,
  });

  assertExactSet(run.name, run.results.verifiedNotFollowingBack, expectedMisses);

  if (run.results.loaded.followers !== "skipped") {
    throw new Error(`B: bulk follower list should be skipped, got ${JSON.stringify(run.results.loaded.followers)}`);
  }

  if (run.fetchLog.some((call) => call.url.includes("/followers/?count="))) {
    throw new Error("B: no bulk follower pages should be fetched");
  }

  if (run.results.unknown.length !== 0) {
    throw new Error(`B: expected no unknowns, got ${run.results.unknown.length}`);
  }

  report(run);
}

{
  const following = [1, 2, 3].map((id) => makeAccount(id, "canary"));
  const storage = new Map();

  const run = await runScenario({
    name: "B2: self-check, skipped follower list, unresolved batch fixed individually",
    profile: { id: SELF_ID, username: "canaryself", followerCount: 100, followingCount: 3 },
    following,
    servedFollowers: [],
    groundTruthFollowerIds: new Set(["1", "2"]),
    viewerId: SELF_ID,
    storage,
    walls: (url) => {
      if (url === "/api/v1/friendships/show_many/") {
        return mockJsonResponse({
          friendship_statuses: {
            1: { following: true, followed_by: true },
            2: { following: true, followed_by: true },
          },
          status: "ok",
        });
      }

      if (url.includes("/followers/?") && url.includes("query=")) {
        return mockJsonResponse({ users: [], status: "ok" });
      }

      return null;
    },
  });

  if (run.results.verifiedNotFollowingBack.length !== 1 || run.results.verifiedNotFollowingBack[0].username !== "canary_00003") {
    throw new Error(`B2: expected canary_00003 to be resolved by individual recheck, got ${JSON.stringify(run.results.verifiedNotFollowingBack)}`);
  }

  if (run.results.unknown.length !== 0) {
    throw new Error(`B2: expected no unknowns after individual recheck, got ${JSON.stringify(run.results.unknown)}`);
  }

  if (run.fetchLog.some((call) => decodeURIComponent(String(call.url)).includes("query=canary_00003"))) {
    throw new Error("B2: exact follower search should not run once the individual recheck resolves the account");
  }

  if (!run.fetchLog.some((call) => String(call.url) === "/api/v1/friendships/show/3/")) {
    throw new Error("B2: unresolved batch account must be rechecked individually");
  }

  report(run);
}

{
  const following = [1, 2].map((id) => makeAccount(id, "silent"));
  const storage = new Map();

  const run = await runScenario({
    name: "B3: self-check, individual recheck also withholds relationship status",
    profile: { id: SELF_ID, username: "silentself", followerCount: 100, followingCount: 2 },
    following,
    servedFollowers: [],
    groundTruthFollowerIds: new Set(["1"]),
    viewerId: SELF_ID,
    storage,
    walls: (url) => {
      if (url === "/api/v1/friendships/show_many/") {
        return mockJsonResponse({
          friendship_statuses: {},
          status: "ok",
        });
      }

      if (String(url).startsWith("/api/v1/friendships/show/")) {
        return mockJsonResponse({ status: "ok" });
      }

      return null;
    },
  });

  if (run.results.verifiedNotFollowingBack.length !== 0) {
    throw new Error(`B3: unanswered individual checks must not become verified misses: ${JSON.stringify(run.results.verifiedNotFollowingBack)}`);
  }

  if (run.results.unknown.length !== 2) {
    throw new Error(`B3: expected both unanswered accounts to stay Unknown, got ${JSON.stringify(run.results.unknown)}`);
  }

  report(run);
}

{
  const following = [];

  for (let id = 1; id <= 546; id += 1) {
    following.push(makeAccount(id, "blocked"));
  }

  const storage = new Map();

  const run = await runScenario({
    name: "B4: self-check, broken batch shape does not recheck hundreds individually",
    profile: { id: SELF_ID, username: "blockedself", followerCount: 5000, followingCount: 546 },
    following,
    servedFollowers: [],
    groundTruthFollowerIds: new Set(following.slice(0, 500).map((user) => user.pk)),
    viewerId: SELF_ID,
    storage,
    walls: (url) => {
      if (url === "/api/v1/friendships/show_many/") {
        return mockJsonResponse({
          friendship_statuses: {},
          status: "ok",
        });
      }

      return null;
    },
  });

  if (run.fetchLog.some((call) => String(call.url).startsWith("/api/v1/friendships/show/"))) {
    throw new Error("B4: a broken batch wave must not become hundreds of individual friendship checks");
  }

  if (run.results.unknown.length !== 546) {
    throw new Error(`B4: expected all unresolved accounts to stay Unknown, got ${run.results.unknown.length}`);
  }

  if (!run.results.warnings.some((warning) => warning.includes("individual-recheck safety cap"))) {
    throw new Error(`B4: expected a safety-cap warning, got ${JSON.stringify(run.results.warnings)}`);
  }

  report(run);
}

{
  const following = [];

  for (let id = 1; id <= 100; id += 1) {
    following.push(makeAccount(id, "retry"));
  }

  const storage = new Map();

  const run = await runScenario({
    name: "B5: self-check, only prior Unknown accounts are rechecked individually over cap",
    profile: { id: SELF_ID, username: "retryself", followerCount: 5000, followingCount: 100 },
    following,
    servedFollowers: [],
    groundTruthFollowerIds: new Set(["5"]),
    viewerId: SELF_ID,
    storage,
    config: { previousUnknownUsernames: ["retry_00005", "retry_00009"] },
    walls: (url) => {
      if (url === "/api/v1/friendships/show_many/") {
        return mockJsonResponse({
          friendship_statuses: {},
          status: "ok",
        });
      }

      return null;
    },
  });

  const individualUrls = run.fetchLog
    .map((call) => String(call.url))
    .filter((url) => url.startsWith("/api/v1/friendships/show/"));

  if (individualUrls.length !== 2) {
    throw new Error(`B5: expected exactly two prior Unknown individual checks, got ${individualUrls.join(", ")}`);
  }

  if (!individualUrls.includes("/api/v1/friendships/show/5/") || !individualUrls.includes("/api/v1/friendships/show/9/")) {
    throw new Error(`B5: wrong accounts rechecked individually: ${individualUrls.join(", ")}`);
  }

  assertExactSet("B5 corrected", run.results.correctedByExactSearch, ["retry_00005"]);
  assertExactSet("B5 missing", run.results.verifiedNotFollowingBack, ["retry_00009"]);

  if (run.results.unknown.length !== 98) {
    throw new Error(`B5: expected the other 98 accounts to stay Unknown, got ${run.results.unknown.length}`);
  }

  report(run);
}

{
  const following = [makeAccount(1, "stale")];
  const storage = new Map();
  const savedAccounts = following.map((user) => ({
    username: user.username,
    fullName: user.full_name,
    id: user.pk,
    isPrivate: false,
    isVerified: false,
  }));

  storage.set(`ig-follow-back-resume:${SELF_ID}:${SELF_ID}`, JSON.stringify({
    createdAt: 1765000000000,
    lists: {
      following: {
        complete: true,
        accounts: savedAccounts,
        maxId: "",
        pageSize: 0,
      },
    },
    verdicts: {
      "v:1": {
        followsBack: false,
        checkedAt: "2025-12-06T00:00:00.000Z",
      },
    },
  }));

  const run = await runScenario({
    name: "B6: self-check, resumed false positive is reverified and corrected",
    profile: { id: SELF_ID, username: "staleself", followerCount: 5000, followingCount: 1 },
    following,
    servedFollowers: [],
    groundTruthFollowerIds: new Set(["1"]),
    viewerId: SELF_ID,
    storage,
    walls: null,
  });

  if (run.fetchLog.some((call) => String(call.url).includes("/following/?count="))) {
    throw new Error("B6: complete saved following list should be reused");
  }

  if (!run.fetchLog.some((call) => String(call.url) === "/api/v1/friendships/show_many/")) {
    throw new Error("B6: saved not-following-back verdict must be rechecked live");
  }

  if (run.results.verifiedNotFollowingBack.length !== 0) {
    throw new Error(`B6: stale saved miss must not remain a verified miss: ${JSON.stringify(run.results.verifiedNotFollowingBack)}`);
  }

  assertExactSet("B6 corrected stale false positive", run.results.correctedByExactSearch, ["stale_00001"]);

  report(run);
}

{
  const following = [];

  for (let id = 1; id <= 547; id += 1) {
    following.push(makeAccount(id, "ratio"));
  }

  const followBack = following.slice(0, 506);
  const groundTruthFollowerIds = new Set(followBack.map((user) => user.pk));
  const expectedMisses = following.slice(506).map((user) => user.username);
  const storage = new Map();

  const run = await runScenario({
    name: "B7: self-check, near-even follower ratio loads followers when batch is unreadable",
    profile: { id: SELF_ID, username: "ratioself", followerCount: 506, followingCount: 547 },
    following,
    servedFollowers: followBack,
    groundTruthFollowerIds,
    viewerId: SELF_ID,
    storage,
    walls: (url) => {
      if (url === "/api/v1/friendships/show_many/") {
        return mockJsonResponse({
          friendship_statuses: {},
          status: "ok",
        });
      }

      return null;
    },
  });

  if (run.results.loaded.followers === "skipped") {
    throw new Error("B7: near-even follower/following ratio must not skip the follower list");
  }

  if (!run.fetchLog.some((call) => String(call.url).includes("/followers/?count="))) {
    throw new Error("B7: follower list should be loaded before relying on batch checks");
  }

  if (run.results.unknown.length !== 0) {
    throw new Error(`B7: expected no unknowns after individual recheck of real misses, got ${run.results.unknown.length}`);
  }

  assertExactSet(run.name, run.results.verifiedNotFollowingBack, expectedMisses);

  report(run);
}

{
  const following = [];

  for (let id = 1; id <= 1200; id += 1) {
    following.push(makeAccount(id, "user"));
  }

  const followBack = following.slice(0, 950);
  const pureFollowers = [];

  for (let id = 7000; id < 7050; id += 1) {
    pureFollowers.push(makeAccount(id, "fan"));
  }

  const realFollowers = [...followBack, ...pureFollowers];
  const groundTruthFollowerIds = new Set(realFollowers.map((user) => user.pk));
  const expectedMisses = following.slice(950).map((user) => user.username);
  const storage = new Map();
  let wallActive = true;

  const interruptedWalls = (url, attempts, init) => {
    if (wallActive && url === "/api/v1/friendships/show_many/" && init?.body) {
      const ids = decodeURIComponent(String(init.body).replace(/^user_ids=/, "")).split(",");

      if (Number(ids[0]) > 1025) {
        return "rate-text";
      }
    }

    return null;
  };

  const firstRun = await runScenario({
    name: "C1: self-check, 1,000 followers / 1,200 following, wall mid-verification",
    profile: { id: SELF_ID, username: "midself", followerCount: 1000, followingCount: 1200 },
    following,
    servedFollowers: realFollowers,
    groundTruthFollowerIds,
    viewerId: SELF_ID,
    storage,
    config: { resume: true, retryLimit: 1 },
    walls: interruptedWalls,
  });

  if (firstRun.results.unknown.length === 0 || !firstRun.results.authLost) {
    throw new Error("C1: the wall should leave accounts in Unknown");
  }

  if (storage.size === 0) {
    throw new Error("C1: interrupted run must keep resume state");
  }

  report(firstRun);

  wallActive = false;

  const secondRun = await runScenario({
    name: "C2: rerun after the wall clears, resuming saved progress",
    profile: { id: SELF_ID, username: "midself", followerCount: 1000, followingCount: 1200 },
    following,
    servedFollowers: realFollowers,
    groundTruthFollowerIds,
    viewerId: SELF_ID,
    storage,
    config: { resume: true },
    walls: null,
  });

  assertExactSet(secondRun.name, secondRun.results.verifiedNotFollowingBack, expectedMisses);

  if (secondRun.results.unknown.length !== 0) {
    throw new Error(`C2: expected no unknowns after resume, got ${secondRun.results.unknown.length}`);
  }

  if (secondRun.fetchLog.some((call) => /\/(following|followers)\/\?count=/.test(call.url))) {
    throw new Error("C2: resumed run must not re-fetch relationship lists");
  }

  if (secondRun.requestCount >= firstRun.requestCount) {
    throw new Error(`C2: resumed run should be lighter (${secondRun.requestCount} vs ${firstRun.requestCount})`);
  }

  if (storage.size !== 0) {
    throw new Error("C2: resume state must be cleared after the clean rerun");
  }

  report(secondRun);
}

console.log("scale simulation ok");
