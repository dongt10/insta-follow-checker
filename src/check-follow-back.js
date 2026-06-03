(() => {
  const PAGE_SIZE = 100;
  const MAX_PAGES = 80;
  const REQUEST_DELAY_MS = 250;
  const PROFILE_CHECK_DELAY_MS = 1200;
  const INSTAGRAM_WEB_APP_ID = "936619743392459";
  const INSTAGRAM_HOST_PATTERN = /(^|\.)instagram\.com$/i;
  const RESERVED_PATHS = new Set([
    "about",
    "accounts",
    "api",
    "direct",
    "explore",
    "legal",
    "p",
    "reel",
    "reels",
    "stories",
    "web",
  ]);
  const CONFIG = Object.assign(
    {
      maxProfileChecks: Infinity,
      profileCheckDelayMs: PROFILE_CHECK_DELAY_MS,
    },
    window.IG_FOLLOW_BACK_CONFIG || {},
  );

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizeUsername = (username) => String(username || "").trim().toLowerCase();

  let reportNode = null;

  async function getJson(url) {
    const response = await fetch(url, {
      credentials: "include",
      headers: {
        "x-ig-app-id": INSTAGRAM_WEB_APP_ID,
      },
    });

    if (!response.ok) {
      throw new Error(`${response.status} ${await response.text()}`);
    }

    return response.json();
  }

  function assertInstagramOrigin() {
    const hostname = window.location.hostname || "";

    if (!INSTAGRAM_HOST_PATTERN.test(hostname)) {
      throw new Error("Open instagram.com before running this script.");
    }
  }

  function uniqueByUsername(users) {
    const usersByName = new Map();

    for (const user of users) {
      usersByName.set(normalizeUsername(user.username), user);
    }

    return [...usersByName.values()];
  }

  function formatAccount(account) {
    if (!account.full_name) {
      return `@${account.username}`;
    }

    return `@${account.username} - ${account.full_name}`;
  }

  function getFollowsViewerStatus(account) {
    const friendshipStatus = account.friendship_status || {};
    const possibleValues = [
      friendshipStatus.followed_by,
      friendshipStatus.followedBy,
      account.follows_viewer,
      account.followsViewer,
    ];

    for (const value of possibleValues) {
      if (typeof value === "boolean") {
        return value;
      }
    }

    return null;
  }

  function currentPathUsername() {
    return window.location.pathname
      .split("/")
      .filter(Boolean)[0]
      ?.replace(/^@/, "")
      .trim() || "";
  }

  function getTargetUsername() {
    if (window.IG_FOLLOW_BACK_USERNAME) {
      return String(window.IG_FOLLOW_BACK_USERNAME).replace(/^@/, "").trim();
    }

    const username = currentPathUsername();

    if (
      username
      && /^[a-z0-9._]{1,30}$/i.test(username)
      && !RESERVED_PATHS.has(username.toLowerCase())
    ) {
      return username;
    }

    return prompt("Instagram username to check:")?.replace(/^@/, "").trim();
  }

  function pageLooksLikeOwnProfile(username) {
    const pathUsername = currentPathUsername();
    const editProfileLink = document.querySelector("a[href*='/accounts/edit']");

    return (
      normalizeUsername(pathUsername) === normalizeUsername(username)
      && Boolean(editProfileLink)
    );
  }

  async function loadSignedInUsername(targetUsername) {
    try {
      const currentUser = await getJson("/api/v1/accounts/current_user/?edit=true");
      const username = currentUser.user?.username || currentUser.username || "";

      if (username) {
        return {
          source: "current_user",
          username,
        };
      }
    } catch (error) {
      console.log("current_user lookup failed; checking visible profile controls instead.", error);
    }

    if (pageLooksLikeOwnProfile(targetUsername)) {
      return {
        source: "profile_controls",
        username: targetUsername,
      };
    }

    throw new Error(
      "Could not confirm this is your signed-in profile. Open your own profile page before running the one-by-one checker.",
    );
  }

  function extractProfileUser(profile, username) {
    const user = profile?.data?.user;

    if (!user?.id || !user?.username) {
      throw new Error(`Could not load profile data for @${username}. Instagram may have changed its response.`);
    }

    return user;
  }

  async function loadProfileUser(username) {
    const profile = await getJson(
      `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
    );

    return extractProfileUser(profile, username);
  }

  async function loadRelationshipList(type, userId) {
    const users = [];
    const seenPageCursors = new Set();
    let maxId = "";
    let pageCount = 0;
    let truncated = false;

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const cursor = maxId ? `&max_id=${encodeURIComponent(maxId)}` : "";
      const data = await getJson(
        `/api/v1/friendships/${userId}/${type}/?count=${PAGE_SIZE}${cursor}`,
      );
      pageCount += 1;

      if (!Array.isArray(data.users)) {
        throw new Error(`Unexpected Instagram response: ${JSON.stringify(data)}`);
      }

      users.push(...data.users);

      const nextMaxId = data.next_max_id || "";
      if (!nextMaxId || seenPageCursors.has(nextMaxId)) {
        break;
      }

      if (page === MAX_PAGES - 1) {
        truncated = true;
        break;
      }

      seenPageCursors.add(nextMaxId);
      maxId = nextMaxId;
      await sleep(REQUEST_DELAY_MS);
    }

    return {
      pageCount,
      truncated,
      users: uniqueByUsername(users),
    };
  }

  function renderReport(report) {
    if (!reportNode) {
      reportNode = document.createElement("pre");
      reportNode.style.whiteSpace = "pre-wrap";
      reportNode.style.font = "14px monospace";
      reportNode.style.padding = "20px";
      reportNode.style.background = "white";
      reportNode.style.color = "black";

      document.body.innerHTML = "";
      document.body.append(reportNode);
    }

    reportNode.textContent = report;
  }

  function profileCount(edge) {
    return typeof edge?.count === "number" ? edge.count : "unknown";
  }

  function summarizeProgress({
    user,
    signedInUsername,
    signedInSource,
    following,
    currentIndex,
    currentAccount,
  }) {
    return [
      "Checking profiles one by one. Keep this tab open.",
      "",
      `username @${user.username}`,
      `signed in as @${signedInUsername}`,
      `signed-in check ${signedInSource}`,
      `profile following ${profileCount(user.edge_follow)}`,
      `loaded unique following ${following.length}`,
      `profile checks ${currentIndex}/${following.length}`,
      currentAccount ? `checking ${formatAccount(currentAccount)}` : "",
    ].join("\n");
  }

  async function checkAccountProfile(account, index, total) {
    console.log(`profile check ${index + 1}/${total}: @${account.username}`);

    try {
      const profileUser = await loadProfileUser(account.username);
      const followsViewer = getFollowsViewerStatus(profileUser);
      const checkedAccount = {
        ...account,
        username: profileUser.username || account.username,
        full_name: profileUser.full_name || account.full_name || "",
      };

      if (followsViewer === true) {
        return {
          account: checkedAccount,
          status: "follows-back",
          note: "Profile relationship status says this account follows you.",
        };
      }

      if (followsViewer === false) {
        return {
          account: checkedAccount,
          status: "not-following-back",
          note: "Profile relationship status says this account does not follow you.",
        };
      }

      return {
        account: checkedAccount,
        status: "unknown",
        note: "Profile response did not include follows_viewer status.",
      };
    } catch (error) {
      return {
        account,
        status: "check-error",
        note: String(error && error.message ? error.message : error),
      };
    }
  }

  function resultLines(title, results) {
    return results.length
      ? [title, ...results.map((result) => `${formatAccount(result.account)} - ${result.note}`)]
      : [title, "none"];
  }

  async function run() {
    assertInstagramOrigin();

    const username = getTargetUsername();

    if (!username) {
      throw new Error("Open your Instagram profile page or provide your username.");
    }

    const targetUser = await loadProfileUser(username);
    const signedIn = await loadSignedInUsername(targetUser.username);
    const signedInUsername = signedIn.username;

    if (normalizeUsername(signedInUsername) !== normalizeUsername(targetUser.username)) {
      throw new Error(
        `One-by-one follow-back checks only work for the signed-in profile. You are signed in as @${signedInUsername}, but the target profile is @${targetUser.username}.`,
      );
    }

    renderReport(`Loading accounts followed by @${targetUser.username}...`);

    const followingResult = await loadRelationshipList("following", targetUser.id);
    const following = followingResult.users;
    const maxProfileChecks = Number.isFinite(CONFIG.maxProfileChecks)
      ? Math.max(0, CONFIG.maxProfileChecks)
      : following.length;
    const scanCount = Math.min(following.length, maxProfileChecks);
    const results = [];

    for (let index = 0; index < scanCount; index += 1) {
      renderReport(
        summarizeProgress({
          user: targetUser,
          signedInUsername,
          signedInSource: signedIn.source,
          following,
          currentIndex: index,
          currentAccount: following[index],
        }),
      );

      results.push(await checkAccountProfile(following[index], index, scanCount));

      if (index < scanCount - 1) {
        await sleep(CONFIG.profileCheckDelayMs);
      }
    }

    const skipped = following.slice(scanCount).map((account) => ({
      account,
      status: "not-scanned",
      note: "Skipped by maxProfileChecks.",
    }));
    const allResults = [...results, ...skipped];
    const notFollowingBack = allResults.filter((result) => result.status === "not-following-back");
    const followsBack = allResults.filter((result) => result.status === "follows-back");
    const unknown = allResults.filter((result) => result.status === "unknown");
    const checkErrors = allResults.filter((result) => result.status === "check-error");

    window.IG_FOLLOW_BACK_RESULTS = {
      generatedAt: new Date().toISOString(),
      username: targetUser.username,
      signedInUsername,
      signedInSource: signedIn.source,
      followingPagesLoaded: followingResult.pageCount,
      followingTruncated: followingResult.truncated,
      results: allResults,
    };

    renderReport(
      [
        `username @${targetUser.username}`,
        `signed in as @${signedInUsername}`,
        `signed-in check ${signedIn.source}`,
        `profile following ${profileCount(targetUser.edge_follow)}`,
        `loaded unique following ${following.length}`,
        `following pages loaded ${followingResult.pageCount}`,
        `following list truncated ${followingResult.truncated ? "yes" : "no"}`,
        `profile checks completed ${results.length}`,
        `follows back ${followsBack.length}`,
        `not following back ${notFollowingBack.length}`,
        `unknown ${unknown.length}`,
        `check errors ${checkErrors.length}`,
        "",
        "note each followed profile was checked one by one using its profile relationship status.",
        "full structured results are in window.IG_FOLLOW_BACK_RESULTS",
        "",
        ...resultLines("not following back", notFollowingBack),
        "",
        ...resultLines("unknown", unknown),
        "",
        ...resultLines("check errors", checkErrors),
        ...(skipped.length ? ["", ...resultLines("not scanned", skipped)] : []),
      ].join("\n"),
    );
  }

  run().catch((error) => {
    renderReport(error.stack || String(error));
  });
})();
