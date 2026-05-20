(() => {
  const PAGE_SIZE = 50;
  const MAX_PAGES = 40;
  const REQUEST_DELAY_MS = 250;
  const INSTAGRAM_WEB_APP_ID = "936619743392459";
  const RESERVED_PATHS = new Set([
    "accounts",
    "direct",
    "explore",
    "p",
    "reel",
    "reels",
    "stories",
  ]);

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

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

  function uniqueByUsername(users) {
    const usersByName = new Map();

    for (const user of users) {
      usersByName.set(user.username.toLowerCase(), user);
    }

    return [...usersByName.values()];
  }

  function getTargetUsername() {
    if (window.IG_FOLLOW_BACK_USERNAME) {
      return String(window.IG_FOLLOW_BACK_USERNAME).replace(/^@/, "").trim();
    }

    const username = window.location.pathname
      .split("/")
      .filter(Boolean)[0]
      ?.replace(/^@/, "")
      .trim();

    if (username && !RESERVED_PATHS.has(username.toLowerCase())) {
      return username;
    }

    return prompt("Instagram username to check:")?.replace(/^@/, "").trim();
  }

  async function loadRelationshipList(type, userId) {
    const users = [];
    const seenPageCursors = new Set();
    let maxId = "";

    for (let page = 0; page < MAX_PAGES; page += 1) {
      const cursor = maxId ? `&max_id=${encodeURIComponent(maxId)}` : "";
      const data = await getJson(
        `/api/v1/friendships/${userId}/${type}/?count=${PAGE_SIZE}${cursor}`,
      );

      if (!Array.isArray(data.users)) {
        throw new Error(`Unexpected Instagram response: ${JSON.stringify(data)}`);
      }

      users.push(...data.users);

      const nextMaxId = data.next_max_id || "";
      if (!nextMaxId || seenPageCursors.has(nextMaxId)) {
        break;
      }

      seenPageCursors.add(nextMaxId);
      maxId = nextMaxId;
      await sleep(REQUEST_DELAY_MS);
    }

    return uniqueByUsername(users);
  }

  function renderReport(report) {
    const pre = document.createElement("pre");
    pre.style.whiteSpace = "pre-wrap";
    pre.style.font = "14px monospace";
    pre.style.padding = "20px";
    pre.style.background = "white";
    pre.style.color = "black";
    pre.textContent = report;

    document.body.innerHTML = "";
    document.body.append(pre);
  }

  async function run() {
    const username = getTargetUsername();

    if (!username) {
      throw new Error("Open an Instagram profile page or provide a username.");
    }

    const profile = await getJson(
      `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
    );

    const user = profile.data.user;
    const [following, followers] = await Promise.all([
      loadRelationshipList("following", user.id),
      loadRelationshipList("followers", user.id),
    ]);

    const followersByUsername = new Set(
      followers.map((follower) => follower.username.toLowerCase()),
    );

    const notFollowingBack = following
      .filter((account) => !followersByUsername.has(account.username.toLowerCase()))
      .map((account) => {
        if (!account.full_name) {
          return account.username;
        }

        return `${account.username} - ${account.full_name}`;
      });

    renderReport(
      [
        `username ${user.username}`,
        `profile following ${user.edge_follow.count}`,
        `profile followers ${user.edge_followed_by.count}`,
        `loaded unique following ${following.length}`,
        `loaded unique followers ${followers.length}`,
        `not following back ${notFollowingBack.length}`,
        "",
        ...notFollowingBack,
      ].join("\n"),
    );
  }

  run().catch((error) => {
    renderReport(error.stack || String(error));
  });
})();
