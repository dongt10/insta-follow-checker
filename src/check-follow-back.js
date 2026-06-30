(() => {
  "use strict";

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
  const DEFAULT_CONFIG = {
    targetUsername: "",
    relationshipPageSizes: [100, 50],
    relationshipPasses: 1,
    relationshipListDelayMs: 1800,
    exactSearchDelayMs: 2400,
    exactSearchMaxPages: 3,
    batchVerify: true,
    batchSize: 25,
    batchDelayMs: 2600,
    individualVerifyUnknowns: true,
    individualDelayMs: 3200,
    maxIndividualRechecks: 80,
    previousUnknownUsernames: [],
    skipFollowerListWhenSelf: "auto",
    includeFollowingStatusHints: true,
    compareFollowingFeed: false,
    followingFeedPageSize: 24,
    followingFeedDelayMs: 1800,
    minRequestIntervalMs: 700,
    retryLimit: 5,
    retryBaseDelayMs: 12000,
    retryMaxDelayMs: 180000,
    maxSlowdownFactor: 8,
    maxPagesPerPass: 250,
    exactSearchCount: 50,
    stopExactSearchOnAuthLost: true,
    resume: true,
    resumeTtlMs: 3600000,
    reverifySavedMisses: true,
  };
  const CONFIG = Object.assign(
    {},
    DEFAULT_CONFIG,
    window.IG_OVER1K_CONFIG || {},
    window.IG_FOLLOW_BACK_CONFIG || {},
  );

  if (!Array.isArray(CONFIG.relationshipPageSizes) || CONFIG.relationshipPageSizes.length === 0) {
    CONFIG.relationshipPageSizes = DEFAULT_CONFIG.relationshipPageSizes;
  }

  CONFIG.batchSize = Math.max(1, Math.floor(Number(CONFIG.batchSize) || DEFAULT_CONFIG.batchSize));
  const configuredMaxIndividualRechecks = Number(CONFIG.maxIndividualRechecks);
  CONFIG.maxIndividualRechecks = Math.max(
    0,
    Math.floor(
      Number.isFinite(configuredMaxIndividualRechecks)
        ? configuredMaxIndividualRechecks
        : DEFAULT_CONFIG.maxIndividualRechecks,
    ),
  );

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const normalizeUsername = (value) => String(value || "").trim().toLowerCase();
  const formatNumber = (value) => (
    typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "unknown"
  );
  const escapeHtml = (value) => String(value == null ? "" : value).replace(/[&<>"]/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    "\"": "&quot;",
  }[char]));
  const jitter = (baseMs) => Math.round(
    baseMs + Math.random() * Math.min(2500, Math.max(300, baseMs / 3)),
  );

  const state = {
    startedAt: new Date().toISOString(),
    phase: "starting",
    message: "Starting Instagram follow-back check...",
    logs: [],
    requests: 0,
    walls: 0,
    done: false,
    debug: {
      batchResponseShapes: [],
    },
    statusBar: {
      label: "Starting",
      value: 0,
      max: 0,
      percent: null,
    },
  };
  window.IG_FOLLOW_BACK_STATE = state;
  window.IG_OVER1K_STATE = state;

  const pacing = {
    slowdownFactor: 1,
    cleanStreak: 0,
    lastRequestAt: 0,
  };
  let resumeSaveWarned = false;

  function paceDelay(baseMs) {
    return jitter(baseMs * pacing.slowdownFactor);
  }

  function reportWall() {
    state.walls += 1;
    pacing.cleanStreak = 0;

    if (pacing.slowdownFactor < CONFIG.maxSlowdownFactor) {
      pacing.slowdownFactor = Math.min(CONFIG.maxSlowdownFactor, pacing.slowdownFactor * 2);
      progress(`Instagram is pushing back: slowing all requests to ${pacing.slowdownFactor}x spacing.`);
    }
  }

  function reportCleanResponse() {
    pacing.cleanStreak += 1;

    if (pacing.cleanStreak >= 25 && pacing.slowdownFactor > 1) {
      pacing.slowdownFactor = Math.max(1, pacing.slowdownFactor / 2);
      pacing.cleanStreak = 0;
    }
  }

  function setStatusBar(label, value = 0, max = 0) {
    const numericValue = Number(value);
    const numericMax = Number(max);
    const safeValue = Number.isFinite(numericValue) ? Math.max(0, numericValue) : 0;
    const safeMax = Number.isFinite(numericMax) ? Math.max(0, numericMax) : 0;
    const percent = safeMax > 0
      ? Math.max(0, Math.min(100, Math.round((safeValue / safeMax) * 100)))
      : null;

    state.statusBar = {
      label,
      value: safeValue,
      max: safeMax,
      percent,
    };
  }

  async function throttleBeforeRequest() {
    const minIntervalMs = CONFIG.minRequestIntervalMs * pacing.slowdownFactor;
    const waitMs = pacing.lastRequestAt + minIntervalMs - Date.now();

    if (waitMs > 0) {
      await sleep(waitMs);
    }

    pacing.lastRequestAt = Date.now();
  }

  function getCookie(name) {
    try {
      const match = String(document.cookie || "").match(
        new RegExp(`(?:^|;\\s*)${name}=([^;]+)`),
      );

      return match ? decodeURIComponent(match[1]) : "";
    } catch {
      return "";
    }
  }

  class FetchProblem extends Error {
    constructor(message, details = {}) {
      super(message);
      Object.assign(this, details);
    }
  }

  function looksLikeHtml(text) {
    const trimmed = String(text || "").trim().slice(0, 500).toLowerCase();

    return trimmed.startsWith("<!doctype html")
      || trimmed.startsWith("<html")
      || trimmed.includes("<head")
      || trimmed.includes("<body");
  }

  function jsonBlockReason(status, parsed) {
    const message = String(parsed?.message || "").toLowerCase();

    if (
      status === 401
      || status === 403
      || message.includes("login_required")
      || message.includes("challenge_required")
    ) {
      return "auth";
    }

    if (
      status === 429
      || message.includes("please wait a few minutes")
      || message.includes("temporarily blocked")
      || message.includes("feedback_required")
    ) {
      return "rate";
    }

    return "";
  }

  function rawBlockReason(status, text, contentType = "") {
    const lowered = String(text || "").toLowerCase();
    const loweredContentType = String(contentType || "").toLowerCase();

    if (
      status === 401
      || status === 403
      || lowered.includes("login_required")
      || lowered.includes("challenge_required")
    ) {
      return "auth";
    }

    if (status === 429 || lowered.includes("please wait a few minutes") || lowered.includes("temporarily blocked")) {
      return "rate";
    }

    if (lowered.includes("login") && lowered.includes("required")) {
      return "auth";
    }

    if (loweredContentType.includes("text/html") || looksLikeHtml(text)) {
      return "html";
    }

    return "";
  }

  function parseRetryAfterMs(response) {
    const header = response.headers?.get?.("retry-after");
    const headerText = header == null ? "" : String(header).trim();

    if (!headerText) {
      return 0;
    }

    const seconds = Number(headerText);

    if (Number.isFinite(seconds) && seconds > 0) {
      return seconds * 1000;
    }

    const dateMs = Date.parse(headerText) - Date.now();

    return Number.isFinite(dateMs) && dateMs > 0 ? dateMs : 0;
  }

  function progress(message, phase = state.phase) {
    state.phase = phase;
    state.message = message;
    state.logs.push({ at: new Date().toISOString(), message });
    console.log(`[IG follow-back] ${message}`);
    renderProgress();
  }

  function renderProgress() {
    let box = document.getElementById("ig-follow-back-progress-box");

    if (!box) {
      box = document.createElement("div");
      box.id = "ig-follow-back-progress-box";
      Object.assign(box.style, {
        position: "fixed",
        zIndex: 2147483647,
        top: "14px",
        left: "14px",
        width: "min(520px, calc(100vw - 28px))",
        maxHeight: "70vh",
        overflow: "auto",
        color: "#f8fafc",
        background: "rgba(15, 23, 42, 0.96)",
        border: "1px solid rgba(148, 163, 184, 0.55)",
        borderRadius: "8px",
        padding: "14px 16px",
        font: "13px/1.45 -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif",
        boxShadow: "0 18px 60px rgba(0, 0, 0, 0.35)",
      });
      document.documentElement.appendChild(box);
    }

    const recentLogs = state.logs
      .slice(-6)
      .map((entry) => `<li>${escapeHtml(entry.message)}</li>`)
      .join("");
    const statusBar = state.statusBar || {};
    const statusPercent = typeof statusBar.percent === "number" ? statusBar.percent : null;
    const statusWidth = statusPercent == null ? 35 : statusPercent;
    const statusMeta = statusPercent == null
      ? "Working"
      : `${formatNumber(statusBar.value)} / ${formatNumber(statusBar.max)} (${statusPercent}%)`;

    box.innerHTML = `
      <div style="font-weight:700;font-size:15px;margin-bottom:6px;">IG follow-back checker</div>
      <div><strong>Phase:</strong> ${escapeHtml(state.phase)}</div>
      <div><strong>Status:</strong> ${escapeHtml(state.message)}</div>
      <div><strong>Requests:</strong> ${escapeHtml(state.requests)} | <strong>Pacing:</strong> ${escapeHtml(pacing.slowdownFactor)}x</div>
      <div style="margin-top:10px;">
        <div style="display:flex;justify-content:space-between;gap:12px;margin-bottom:5px;color:#cbd5e1;font-size:12px;">
          <span>${escapeHtml(statusBar.label || state.phase || "Working")}</span>
          <span>${escapeHtml(statusMeta)}</span>
        </div>
        <div role="progressbar" aria-label="${escapeHtml(statusBar.label || "Progress")}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${escapeHtml(statusPercent == null ? 0 : statusPercent)}" style="height:8px;overflow:hidden;border-radius:999px;background:rgba(51,65,85,0.95);">
          <div style="height:100%;width:${escapeHtml(statusWidth)}%;border-radius:999px;background:linear-gradient(90deg,#22c55e,#38bdf8);transition:width 180ms ease;"></div>
        </div>
      </div>
      <ol style="margin:10px 0 0 18px;padding:0;">${recentLogs}</ol>
    `;
  }

  async function getJson(url, label, options = {}) {
    let lastError = null;

    for (let attempt = 0; attempt <= CONFIG.retryLimit; attempt += 1) {
      try {
        await throttleBeforeRequest();

        const headers = {
          accept: "application/json",
          "x-ig-app-id": INSTAGRAM_WEB_APP_ID,
        };
        const init = {
          credentials: "include",
          headers,
        };

        if (options.method === "POST") {
          init.method = "POST";
          init.body = options.body || "";
          headers["content-type"] = "application/x-www-form-urlencoded";

          const csrfToken = getCookie("csrftoken");

          if (csrfToken) {
            headers["x-csrftoken"] = csrfToken;
          }
        }

        state.requests += 1;

        const response = await fetch(url, init);
        const text = await response.text();
        const contentType = response.headers?.get?.("content-type") || "";
        const retryAfterMs = parseRetryAfterMs(response);

        let parsed = null;
        let parsedOk = false;

        try {
          parsed = JSON.parse(text);
          parsedOk = true;
        } catch {
          parsedOk = false;
        }

        const blockReason = parsedOk
          ? jsonBlockReason(response.status, parsed)
          : rawBlockReason(response.status, text, contentType);

        if (blockReason) {
          const blockLabel = {
            auth: "login",
            rate: "rate-limit",
            html: "HTML/non-JSON",
          }[blockReason];

          throw new FetchProblem(`${label}: ${blockLabel} wall (${response.status})`, {
            authLost: blockReason === "auth",
            rateLimited: blockReason === "rate",
            relationshipBlocked: blockReason === "html",
            status: response.status,
            contentType,
            retryAfterMs,
          });
        }

        if (!response.ok) {
          const retryAfterNote = retryAfterMs ? ` Retry after ${Math.round(retryAfterMs / 1000)} seconds.` : "";

          throw new FetchProblem(`${label}: ${response.status} ${response.statusText || ""}${retryAfterNote}`, {
            status: response.status,
            retryAfterMs,
          });
        }

        if (parsedOk) {
          reportCleanResponse();

          return parsed;
        }

        throw new FetchProblem(`${label}: non-JSON Instagram response`, {
          status: response.status,
          contentType,
        });
      } catch (error) {
        lastError = error;

        if (error.rateLimited || error.relationshipBlocked) {
          reportWall();
        }

        if (error.authLost && !error.rateLimited) {
          throw error;
        }

        if (
          typeof error.status === "number"
          && error.status >= 400
          && error.status < 500
          && !error.rateLimited
          && !error.relationshipBlocked
        ) {
          throw error;
        }

        if (attempt >= CONFIG.retryLimit) {
          break;
        }

        const backoffMs = error.rateLimited
          ? CONFIG.retryBaseDelayMs * (2 ** attempt)
          : CONFIG.retryBaseDelayMs * (attempt + 1);
        const waitMs = Math.max(
          Math.min(CONFIG.retryMaxDelayMs, jitter(backoffMs)),
          error.retryAfterMs || 0,
        );

        progress(`${label}: retry ${attempt + 1}/${CONFIG.retryLimit} after ${Math.round(waitMs / 1000)}s`);
        await sleep(waitMs);
      }
    }

    throw lastError || new FetchProblem(`${label}: request failed`);
  }

  function assertInstagramOrigin() {
    const hostname = window.location.hostname || "";

    if (!INSTAGRAM_HOST_PATTERN.test(hostname)) {
      throw new Error("Open instagram.com before running this script.");
    }
  }

  function currentPathUsername() {
    return window.location.pathname
      .split("/")
      .filter(Boolean)[0]
      ?.replace(/^@/, "")
      .trim() || "";
  }

  function getTargetUsername() {
    const configuredUsername = CONFIG.targetUsername || window.IG_FOLLOW_BACK_USERNAME;

    if (configuredUsername) {
      return String(configuredUsername).replace(/^@/, "").trim();
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

  function profileCount(user, key) {
    const legacyEdge = key === "followers" ? user.edge_followed_by : user.edge_follow;
    const directKey = key === "followers" ? "follower_count" : "following_count";

    if (typeof legacyEdge?.count === "number") {
      return legacyEdge.count;
    }

    if (typeof user[directKey] === "number") {
      return user[directKey];
    }

    return null;
  }

  function readFollowsViewer(user) {
    const candidates = [
      user.follows_viewer,
      user.followsViewer,
      user.friendship_status?.followed_by,
      user.friendshipStatus?.followedBy,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "boolean") {
        return candidate;
      }
    }

    return null;
  }

  function toAccount(user) {
    return {
      username: user.username,
      fullName: user.full_name || user.fullName || "",
      id: String(user.pk || user.id || ""),
      isPrivate: Boolean(user.is_private ?? user.isPrivate),
      isVerified: Boolean(user.is_verified ?? user.isVerified),
      followsViewer: readFollowsViewer(user),
    };
  }

  function extractUsers(response) {
    const rawUsers = response?.users || response?.items || response?.data?.users || [];

    return rawUsers
      .map((item) => item?.user || item?.node || item)
      .filter((user) => user && user.username);
  }

  function addUsers(targetMap, users) {
    let added = 0;

    for (const user of users) {
      const username = normalizeUsername(user.username);

      if (username && !targetMap.has(username)) {
        targetMap.set(username, toAccount(user));
        added += 1;
      } else if (username) {
        const existing = targetMap.get(username);
        const nextAccount = toAccount(user);

        if (!existing.id && nextAccount.id) {
          existing.id = nextAccount.id;
        }

        if (!existing.fullName && nextAccount.fullName) {
          existing.fullName = nextAccount.fullName;
        }

        if (typeof nextAccount.followsViewer === "boolean") {
          existing.followsViewer = nextAccount.followsViewer;
        }
      }
    }

    return added;
  }

  function resumeKey(targetId) {
    return `ig-follow-back-resume:${getCookie("ds_user_id") || "anon"}:${targetId}`;
  }

  function verdictKey(account) {
    return `v:${account.id || normalizeUsername(account.username)}`;
  }

  function retryableUnknownFromSavedVerdict(savedVerdict) {
    return Boolean(savedVerdict?.unknown && savedVerdict.retryIndividually);
  }

  function clearResumeState(targetId) {
    try {
      window.localStorage?.removeItem?.(resumeKey(targetId));
    } catch {
      return;
    }
  }

  function loadResumeState(targetId) {
    const empty = {
      createdAt: Date.now(),
      lists: {},
      verdicts: {},
      loadedFromStorage: false,
      ageMinutes: 0,
    };

    if (!CONFIG.resume) {
      clearResumeState(targetId);

      return empty;
    }

    try {
      const raw = window.localStorage ? window.localStorage.getItem(resumeKey(targetId)) : null;

      if (!raw) {
        return empty;
      }

      const saved = JSON.parse(raw);

      if (
        !saved
        || typeof saved.createdAt !== "number"
        || Date.now() - saved.createdAt > CONFIG.resumeTtlMs
      ) {
        clearResumeState(targetId);

        return empty;
      }

      return {
        createdAt: saved.createdAt,
        lists: saved.lists && typeof saved.lists === "object" ? saved.lists : {},
        verdicts: saved.verdicts && typeof saved.verdicts === "object" ? saved.verdicts : {},
        loadedFromStorage: true,
        ageMinutes: Math.max(0, Math.round((Date.now() - saved.createdAt) / 60000)),
      };
    } catch {
      clearResumeState(targetId);

      return empty;
    }
  }

  function saveResumeState(targetId, resume) {
    if (!CONFIG.resume) {
      return;
    }

    const payloads = [
      { createdAt: resume.createdAt, lists: resume.lists, verdicts: resume.verdicts },
      { createdAt: resume.createdAt, lists: {}, verdicts: resume.verdicts },
    ];

    for (const payload of payloads) {
      try {
        window.localStorage?.setItem?.(resumeKey(targetId), JSON.stringify(payload));

        return;
      } catch {
        continue;
      }
    }

    if (!resumeSaveWarned) {
      resumeSaveWarned = true;
      progress("Could not save resume progress (browser storage full or unavailable); a rerun would start fresh.");
    }
  }

  function rerunAdvice() {
    if (CONFIG.resume) {
      return "Wait 10-15 minutes and rerun: saved progress is reused, and saved not-following-back results are rechecked before being shown.";
    }

    return "Wait 10-15 minutes, refresh the profile, and rerun fresh.";
  }

  async function loadProfileUser(username) {
    setStatusBar("Loading profile", 0, 1);
    progress(`Loading profile @${username}`, "profile");
    const profile = await getJson(
      `/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
      "profile",
    );
    const user = profile?.data?.user || profile?.user;

    if (!user?.id && !user?.pk) {
      throw new Error(`Could not load profile data for @${username}. Instagram may have changed its response or the profile may be unavailable.`);
    }

    return {
      id: String(user.id || user.pk),
      username: user.username || username,
      fullName: user.full_name || "",
      followerCount: profileCount(user, "followers"),
      followingCount: profileCount(user, "following"),
    };
  }

  async function loadRelationshipList(type, target, resume, options = {}) {
    const expectedCount = type === "followers" ? target.followerCount : target.followingCount;
    const savedList = resume.lists[type];
    const savedAccounts = Array.isArray(savedList?.accounts)
      ? savedList.accounts.filter((account) => account && typeof account.username === "string" && account.username)
      : [];
    const usersByUsername = new Map();
    const passes = [];
    const expectedStatusCount = typeof expectedCount === "number" && expectedCount > 0
      ? expectedCount
      : 0;
    const listIsComplete = () => (
      typeof expectedCount === "number"
      && expectedCount >= 0
      && usersByUsername.size >= expectedCount
    );

    if (
      savedList?.complete
      && savedAccounts.length > 0
      && (typeof expectedCount !== "number" || savedAccounts.length >= expectedCount)
    ) {
      addUsers(usersByUsername, savedAccounts);
      setStatusBar(`${type}: reused saved list`, usersByUsername.size, expectedStatusCount || usersByUsername.size);
      progress(
        `Reusing the ${type} list saved ${resume.ageMinutes} minutes ago (${usersByUsername.size} accounts), no new list-page requests needed.`,
        type,
      );

      return {
        usersByUsername,
        passes: [{
          kind: type,
          pass: "resume",
          count: "-",
          pages: 0,
          before: 0,
          after: usersByUsername.size,
          added: usersByUsername.size,
          status: "resumed",
        }],
        stoppedEarly: false,
        stopReason: "",
        stopStatus: "",
        resumed: true,
      };
    }

    let resumeCursor = "";
    let resumePageSize = 0;

    if (savedAccounts.length > 0) {
      addUsers(usersByUsername, savedAccounts);

      if (!savedList.complete && savedList.maxId) {
        resumeCursor = String(savedList.maxId);
        resumePageSize = Number(savedList.pageSize) > 0 ? Number(savedList.pageSize) : CONFIG.relationshipPageSizes[0];
      }

      setStatusBar(`${type}: resuming`, usersByUsername.size, expectedStatusCount);
      progress(
        `Seeding the ${type} list with ${usersByUsername.size} accounts saved ${resume.ageMinutes} minutes ago${resumeCursor ? ", continuing from the saved position" : ""}.`,
        type,
      );
    }

    const savePartial = (maxId, pageSize) => {
      if (!CONFIG.resume) {
        return;
      }

      resume.lists[type] = {
        complete: false,
        accounts: [...usersByUsername.values()],
        maxId: maxId || "",
        pageSize,
      };
      saveResumeState(target.id, resume);
    };

    const runSweep = async (pageSize, passName, initialMaxId = "") => {
      let maxId = initialMaxId || "";
      let pageCount = 0;
      const before = usersByUsername.size;

      while (pageCount < CONFIG.maxPagesPerPass) {
        pageCount += 1;

        const cursorParam = maxId ? `&max_id=${encodeURIComponent(maxId)}` : "";
        let response;

        try {
          response = await getJson(
            `/api/v1/friendships/${target.id}/${type}/?count=${encodeURIComponent(pageSize)}${cursorParam}`,
            `${type} page ${pageCount}`,
          );
        } catch (error) {
          if (!error.authLost && !error.rateLimited && !error.relationshipBlocked) {
            if (initialMaxId && pageCount === 1) {
              progress(`${type}: the saved resume position was rejected, restarting this list from the beginning.`, type);
              passes.push({
                kind: type,
                pass: passName,
                count: pageSize,
                pages: pageCount,
                before,
                after: usersByUsername.size,
                added: 0,
                status: "cursor-rejected",
              });

              return { outcome: "cursor-rejected" };
            }

            throw error;
          }

          const stopReason = error.message || String(error);
          const stopStatus = error.rateLimited
            ? "rate-limited"
            : error.relationshipBlocked
              ? "html-blocked"
              : "auth-blocked";

          setStatusBar(`${type}: stopped early`, usersByUsername.size, expectedStatusCount);
          progress(`${type} stopped early: ${stopReason}`, type);
          passes.push({
            kind: type,
            pass: passName,
            count: pageSize,
            pages: pageCount,
            before,
            after: usersByUsername.size,
            added: usersByUsername.size - before,
            status: stopStatus,
          });
          savePartial(maxId, pageSize);

          return { outcome: "stopped", stopReason, stopStatus };
        }

        const users = extractUsers(response);
        const added = addUsers(usersByUsername, users);

        setStatusBar(`${type}: loading`, usersByUsername.size, expectedStatusCount);
        progress(
          `${type} requested ${pageSize}: page ${pageCount}, returned ${users.length}, added ${added}, union ${usersByUsername.size}`,
          type,
        );

        const nextMaxId = response.next_max_id || response.nextMaxId || response?.page_info?.end_cursor || "";

        if (!nextMaxId || response.has_more === false || users.length === 0) {
          break;
        }

        maxId = nextMaxId;
        await sleep(paceDelay(CONFIG.relationshipListDelayMs));
      }

      passes.push({
        kind: type,
        pass: passName,
        count: pageSize,
        pages: pageCount,
        before,
        after: usersByUsername.size,
        added: usersByUsername.size - before,
        status: "ended",
      });

      return { outcome: "ended", added: usersByUsername.size - before };
    };

    const stoppedResult = (stopReason, stopStatus) => ({
      usersByUsername,
      passes,
      stoppedEarly: true,
      stopReason,
      stopStatus,
    });

    let resumeSweepEnded = false;

    if (resumeCursor) {
      const resumedSweep = await runSweep(resumePageSize, "resume", resumeCursor);

      if (resumedSweep.outcome === "stopped") {
        return stoppedResult(resumedSweep.stopReason, resumedSweep.stopStatus);
      }

      resumeSweepEnded = resumedSweep.outcome === "ended";
    }

    const totalSweeps = CONFIG.relationshipPasses * CONFIG.relationshipPageSizes.length;
    let sweepIndex = 0;

    sweeps:
    for (let pass = 1; pass <= CONFIG.relationshipPasses; pass += 1) {
      for (const pageSize of CONFIG.relationshipPageSizes) {
        sweepIndex += 1;

        if (options.singleSweep && (sweepIndex > 1 || resumeSweepEnded)) {
          break sweeps;
        }

        if ((sweepIndex > 1 || resumeSweepEnded) && listIsComplete()) {
          break sweeps;
        }

        const sweepResult = await runSweep(pageSize, `round${pass}`);

        if (sweepResult.outcome === "stopped") {
          return stoppedResult(sweepResult.stopReason, sweepResult.stopStatus);
        }

        if (listIsComplete()) {
          if (sweepIndex < totalSweeps) {
            progress(
              `${type}: loaded all ${usersByUsername.size} of ${expectedCount} expected accounts, skipping extra passes to save requests.`,
              type,
            );
          }

          break sweeps;
        }

        if (sweepIndex > 1 && sweepResult.added === 0) {
          break sweeps;
        }

        if (sweepIndex < totalSweeps) {
          await sleep(paceDelay(CONFIG.relationshipListDelayMs * 2));
        }
      }
    }

    if (CONFIG.resume) {
      resume.lists[type] = {
        complete: typeof expectedCount !== "number" || usersByUsername.size >= expectedCount,
        accounts: [...usersByUsername.values()],
        maxId: "",
        pageSize: 0,
      };
      saveResumeState(target.id, resume);
    }

    return {
      usersByUsername,
      passes,
      stoppedEarly: false,
      stopReason: "",
      stopStatus: "",
    };
  }

  function followingFeedUrl(targetId, after = "") {
    const variables = {
      id: targetId,
      include_reel: true,
      fetch_mutual: false,
      first: Math.max(1, Math.floor(Number(CONFIG.followingFeedPageSize) || 24)),
    };

    if (after) {
      variables.after = after;
    }

    return `https://www.instagram.com/graphql/query/?query_hash=3dec7e2c57367ef3da3d987d89f9dbc8&variables=${encodeURIComponent(JSON.stringify(variables))}`;
  }

  async function loadFollowingFeedHints(target, followingLoad) {
    const usersByUsername = followingLoad.usersByUsername;
    const passes = [];
    let after = "";
    let pageCount = 0;
    const before = usersByUsername.size;
    const expectedStatusCount = typeof target.followingCount === "number" && target.followingCount > 0
      ? target.followingCount
      : 0;

    while (pageCount < CONFIG.maxPagesPerPass) {
      pageCount += 1;

      let response;

      try {
        response = await getJson(
          followingFeedUrl(target.id, after),
          `following-feed hint page ${pageCount}`,
        );
      } catch (error) {
        const stopReason = error.message || String(error);
        const stopStatus = error.rateLimited
          ? "rate-limited"
          : error.relationshipBlocked
            ? "html-blocked"
            : error.authLost
              ? "auth-blocked"
              : "error";

        setStatusBar("following-feed hints: stopped", usersByUsername.size, expectedStatusCount);
        progress(`following-feed hint scan stopped early: ${stopReason}`, "following hints");
        passes.push({
          kind: "following-hints",
          pass: "graphql",
          count: CONFIG.followingFeedPageSize,
          pages: pageCount,
          before,
          after: usersByUsername.size,
          added: usersByUsername.size - before,
          status: stopStatus,
        });

        return {
          passes,
          stoppedEarly: true,
          stopReason,
          stopStatus,
        };
      }

      const edgeFollow = response?.data?.user?.edge_follow;
      const edges = Array.isArray(edgeFollow?.edges) ? edgeFollow.edges : [];
      const users = edges
        .map((edge) => edge?.node)
        .filter((user) => user && user.username);
      const added = addUsers(usersByUsername, users);
      const hints = users.filter((user) => readFollowsViewer(user) === false).length;

      setStatusBar("following-feed hints", usersByUsername.size, expectedStatusCount);
      progress(
        `following-feed hints: page ${pageCount}, users ${users.length}, hinted misses ${hints}, added ${added}, union ${usersByUsername.size}`,
        "following hints",
      );

      const pageInfo = edgeFollow?.page_info || {};

      if (!pageInfo.has_next_page || !pageInfo.end_cursor || users.length === 0) {
        break;
      }

      after = pageInfo.end_cursor;
      await sleep(paceDelay(CONFIG.followingFeedDelayMs));
    }

    passes.push({
      kind: "following-hints",
      pass: "graphql",
      count: CONFIG.followingFeedPageSize,
      pages: pageCount,
      before,
      after: usersByUsername.size,
      added: usersByUsername.size - before,
      status: "ended",
    });

    return {
      passes,
      stoppedEarly: false,
      stopReason: "",
      stopStatus: "",
    };
  }

  async function exactFollowerSearch(target, username) {
    const encodedUsername = encodeURIComponent(username);
    const baseUrls = [
      `/api/v1/friendships/${target.id}/followers/?count=${CONFIG.exactSearchCount}&search_surface=follow_list_page&query=${encodedUsername}`,
      `/api/v1/friendships/${target.id}/followers/?count=${CONFIG.exactSearchCount}&query=${encodedUsername}`,
    ];
    let truncated = false;

    for (const baseUrl of baseUrls) {
      let maxId = "";

      for (let page = 1; page <= CONFIG.exactSearchMaxPages; page += 1) {
        const cursorParam = maxId ? `&max_id=${encodeURIComponent(maxId)}` : "";
        const response = await getJson(`${baseUrl}${cursorParam}`, `exact follower search @${username}`);
        const users = extractUsers(response);
        const exactMatch = users.some(
          (user) => normalizeUsername(user.username) === normalizeUsername(username),
        );

        if (exactMatch) {
          return true;
        }

        const nextMaxId = response.next_max_id || response.nextMaxId || "";

        if (!nextMaxId || response.has_more === false || users.length === 0) {
          break;
        }

        if (page === CONFIG.exactSearchMaxPages) {
          truncated = true;
          break;
        }

        maxId = nextMaxId;
        await sleep(paceDelay(CONFIG.exactSearchDelayMs));
      }
    }

    if (truncated) {
      throw new FetchProblem(`exact follower search @${username}: too many similar usernames to check definitively`, {
        searchTruncated: true,
      });
    }

    return false;
  }

  async function batchFriendshipStatuses(accounts) {
    const ids = accounts.map((account) => account.id).join(",");
    const response = await getJson(
      "/api/v1/friendships/show_many/",
      `friendship batch (${accounts.length} accounts)`,
      {
        method: "POST",
        body: `user_ids=${encodeURIComponent(ids)}`,
      },
    );

    rememberBatchResponseShape(response);

    return (
      response?.friendship_statuses
      || response?.relationships
      || response?.data?.friendship_statuses
      || response?.data?.relationships
      || response?.data
      || response
      || null
    );
  }

  function describeShape(value, depth = 0) {
    if (value == null || typeof value !== "object") {
      return { type: value == null ? "null" : typeof value };
    }

    if (Array.isArray(value)) {
      return {
        type: "array",
        length: value.length,
        sample: depth < 2 && value.length ? describeShape(value[0], depth + 1) : undefined,
      };
    }

    const keys = Object.keys(value).slice(0, 12);
    const shape = { type: "object", keys };

    if (depth < 2) {
      shape.fields = Object.fromEntries(
        keys.slice(0, 6).map((key) => [key, describeShape(value[key], depth + 1)]),
      );
    }

    return shape;
  }

  function rememberBatchResponseShape(response) {
    if (state.debug.batchResponseShapes.length >= 3) {
      return;
    }

    state.debug.batchResponseShapes.push(describeShape(response));
  }

  function accountIdFromStatus(candidate) {
    const rawId = (
      candidate?.id
      || candidate?.pk
      || candidate?.user_id
      || candidate?.userId
      || candidate?.target_id
      || candidate?.user?.id
      || candidate?.user?.pk
      || candidate?.relationship?.id
      || candidate?.relationship?.user_id
      || candidate?.friendship_status?.id
      || candidate?.friendship_status?.user_id
    );

    return rawId == null ? "" : String(rawId);
  }

  function usernameFromStatus(candidate) {
    return normalizeUsername(
      candidate?.username
      || candidate?.user?.username
      || candidate?.relationship?.username
      || candidate?.friendship_status?.username,
    );
  }

  function statusMatchesAccount(candidate, account) {
    const candidateId = accountIdFromStatus(candidate);

    if (account?.id && candidateId && candidateId === String(account.id)) {
      return true;
    }

    const candidateUsername = usernameFromStatus(candidate);

    return Boolean(candidateUsername && candidateUsername === normalizeUsername(account?.username));
  }

  function lookupFriendshipStatus(statuses, account) {
    if (!statuses) {
      return null;
    }

    const accountId = String(account?.id || "");
    const username = String(account?.username || "");
    const normalizedUsername = normalizeUsername(username);
    const containers = [
      statuses,
      statuses?.friendship_statuses,
      statuses?.relationships,
      statuses?.users,
      statuses?.items,
      statuses?.data,
      statuses?.data?.friendship_statuses,
      statuses?.data?.relationships,
      statuses?.data?.users,
    ].filter(Boolean);

    for (const container of containers) {
      if (Array.isArray(container)) {
        const match = container.find((candidate) => statusMatchesAccount(candidate, account));

        if (match) {
          return match;
        }

        continue;
      }

      if (typeof container !== "object") {
        continue;
      }

      const directMatches = [
        accountId && container[accountId],
        username && container[username],
        normalizedUsername && container[normalizedUsername],
      ].filter(Boolean);

      if (directMatches.length > 0) {
        return directMatches[0];
      }

      if (statusMatchesAccount(container, account)) {
        return container;
      }
    }

    return null;
  }

  function followedByFromStatus(status, account) {
    const candidates = [
      status,
      status?.friendship_status,
      status?.relationship,
      status?.data,
    ];

    if (account?.id && status?.friendship_statuses) {
      candidates.push(status.friendship_statuses[account.id]);
      candidates.push(status.friendship_statuses[String(account.id)]);
    }

    for (const candidate of candidates) {
      if (candidate && typeof candidate.followed_by === "boolean") {
        return candidate.followed_by;
      }
    }

    return null;
  }

  async function individualFriendshipStatus(account) {
    if (!account.id) {
      return null;
    }

    const response = await getJson(
      `/api/v1/friendships/show/${encodeURIComponent(account.id)}/`,
      `individual friendship check @${account.username}`,
    );

    return followedByFromStatus(response, account);
  }

  function resultLines(results) {
    return results.length
      ? results.map((account) => `<li><a href="https://www.instagram.com/${escapeHtml(account.username)}/" target="_blank" rel="noreferrer">@${escapeHtml(account.username)}</a> ${escapeHtml(account.fullName)}</li>`).join("")
      : "<li>None</li>";
  }

  function statCard(label, value) {
    const display = typeof value === "number" ? formatNumber(value) : (value || "unknown");

    return `<div class="card"><span>${escapeHtml(label)}</span><strong>${escapeHtml(display)}</strong></div>`;
  }

  function optionalFollowingHintReport(hints) {
    if (!hints?.available) {
      return "";
    }

    return `
      <h2>Instagram following-feed hint (${hints.notFollowingBack.length})</h2>
      <p>This is the same <code>follows_viewer</code> signal many simpler console tools use. It is shown for comparison and as extra verification input; the verified sections above remain the counted result.</p>
      <div class="grid">
        ${statCard("Hint also verified missing", hints.verifiedMissing.length)}
        ${statCard("Hint corrected as follows back", hints.corrected.length)}
        ${statCard("Hint unknown", hints.unknown.length)}
        ${statCard("Hint not verified", hints.unresolved.length)}
      </div>
      <h2>Hint not verified as missing (${hints.notVerifiedMissing.length})</h2>
      <ol class="cols">${resultLines(hints.notVerifiedMissing)}</ol>
    `;
  }

  function renderFinalReport(result) {
    const warningItems = result.warnings.length
      ? result.warnings.map((warning) => `<li>${escapeHtml(warning)}</li>`).join("")
      : "<li>None</li>";
    const passRows = result.loadPasses.map((pass) => `
      <tr>
        <td>${escapeHtml(pass.kind)}</td>
        <td>${escapeHtml(pass.pass)}</td>
        <td>${escapeHtml(pass.count)}</td>
        <td>${escapeHtml(pass.pages)}</td>
        <td>${escapeHtml(pass.before)}</td>
        <td>${escapeHtml(pass.after)}</td>
        <td>${escapeHtml(pass.added)}</td>
        <td>${escapeHtml(pass.status)}</td>
      </tr>
    `).join("");

    document.getElementById("ig-follow-back-progress-box")?.remove?.();
    document.title = `Instagram follow-back result - @${result.target.username}`;
    document.body.innerHTML = `
      <style>
        body { margin: 24px; background: #f8fafc; color: #0f172a; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
        h1 { margin: 0 0 10px; font-size: 28px; }
        h2 { margin: 24px 0 10px; font-size: 20px; }
        p { max-width: 880px; }
        .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(190px, 1fr)); gap: 10px; max-width: 1000px; }
        .card { background: white; border: 1px solid #dbe3ef; border-radius: 8px; padding: 14px; }
        .card span { display: block; color: #475569; font-size: 13px; }
        .card strong { display: block; margin-top: 5px; font-size: 23px; }
        .warn { max-width: 1000px; background: #fffbeb; border: 1px solid #f59e0b; border-radius: 8px; padding: 12px 14px; margin: 16px 0; }
        .cols { columns: 2 320px; }
        li { break-inside: avoid; margin: 5px 0; }
        a { color: #2563eb; text-decoration: none; }
        table { border-collapse: collapse; background: white; border: 1px solid #dbe3ef; }
        th, td { padding: 8px 10px; border: 1px solid #dbe3ef; text-align: left; }
        code { background: #e2e8f0; border-radius: 4px; padding: 2px 5px; }
      </style>
      <h1>Instagram follow-back result: @${escapeHtml(result.target.username)}</h1>
      <p>Only accounts in <strong>Verified not following back</strong> are counted as misses. Every tentative miss was verified with ${escapeHtml(result.verificationMethod)}; accounts that actually follow back were removed, and failures or auth issues are kept in Unknown instead of being counted.</p>
      <p><strong>Verification method:</strong> ${escapeHtml(result.verificationMethod)}</p>
      <div class="grid">
        ${statCard("Profile following", result.profileCounts.following)}
        ${statCard("Loaded following", result.loaded.following)}
        ${statCard("Profile followers", result.profileCounts.followers)}
        ${statCard("Loaded followers", result.loaded.followers)}
        ${statCard("Tentative misses checked", result.tentativeMisses)}
        ${statCard("Verified not following back", result.verifiedNotFollowingBack.length)}
        ${statCard("Follows back (corrected)", result.correctedByExactSearch.length)}
        ${statCard("Unknown, excluded", result.unknown.length)}
        ${result.followingStatusHints?.available ? statCard("IG hint misses", result.followingStatusHints.notFollowingBack.length) : ""}
        ${statCard("Requests made", result.requestsMade)}
      </div>
      <div class="warn"><strong>Warnings</strong><ul>${warningItems}</ul></div>
      <h2>Verified not following back (${result.verifiedNotFollowingBack.length})</h2>
      <ol class="cols">${resultLines(result.verifiedNotFollowingBack)}</ol>
      <h2>Unknown - not counted (${result.unknown.length})</h2>
      <ol>${resultLines(result.unknown)}</ol>
      <h2>Follows back - corrected (${result.correctedByExactSearch.length})</h2>
      <ol class="cols">${resultLines(result.correctedByExactSearch)}</ol>
      ${optionalFollowingHintReport(result.followingStatusHints)}
      <h2>Load passes</h2>
      <table>
        <thead><tr><th>Kind</th><th>Pass</th><th>Count</th><th>Pages</th><th>Before</th><th>After</th><th>Added</th><th>Status</th></tr></thead>
        <tbody>${passRows}</tbody>
      </table>
      <p>Full structured results are in <code>window.IG_FOLLOW_BACK_RESULTS</code> and <code>window.IG_OVER1K_FOLLOW_BACK_RESULTS</code> until this page is reloaded.</p>
    `;
  }

  async function run() {
    assertInstagramOrigin();

    const username = getTargetUsername();

    if (!username) {
      throw new Error("Open an Instagram profile page or provide a username.");
    }

    const target = await loadProfileUser(username);

    setStatusBar("Profile loaded", 1, 1);
    progress(
      `Resolved @${target.username}: ${formatNumber(target.followerCount)} followers, ${formatNumber(target.followingCount)} following`,
      "profile",
    );

    const viewerId = getCookie("ds_user_id");
    const selfRelationship = Boolean(viewerId && viewerId === target.id);
    const batchVerification = Boolean(
      CONFIG.batchVerify
      && selfRelationship
      && getCookie("csrftoken"),
    );
    const verificationMethod = batchVerification
      ? "batch friendship checks plus individual rechecks"
      : "exact follower search";
    const resume = loadResumeState(target.id);
    const warnings = [];

    if (
      resume.loadedFromStorage
      && (Object.keys(resume.lists).length > 0 || Object.keys(resume.verdicts).length > 0)
    ) {
      warnings.push(`Reused saved progress from ${resume.ageMinutes} minutes ago to avoid repeating list requests. Saved not-following-back results are rechecked before appearing in the final list.`);
    }

    if (batchVerification) {
      setStatusBar("Self-check mode", 1, 1);
      progress(
        "You are checking your own account: tentative misses will be verified with exact batch friendship checks (far fewer requests).",
        "profile",
      );
    }

    const followingLoad = await loadRelationshipList("following", target, resume);
    const followingListUnavailable = (
      followingLoad.stoppedEarly
      && followingLoad.usersByUsername.size === 0
      && (typeof target.followingCount !== "number" || target.followingCount > 0)
    );
    const useFollowingStatusHints = Boolean(
      selfRelationship
      && CONFIG.includeFollowingStatusHints !== false
    );
    let followingFeedHintLoad = {
      passes: [],
      stoppedEarly: false,
      stopReason: "",
      stopStatus: "",
    };

    if (
      useFollowingStatusHints
      && CONFIG.compareFollowingFeed
      && !followingListUnavailable
    ) {
      setStatusBar("following-feed hints", followingLoad.usersByUsername.size, target.followingCount || 0);
      progress(
        "Running the optional following-feed comparison used by simpler unfollower tools.",
        "following hints",
      );
      followingFeedHintLoad = await loadFollowingFeedHints(target, followingLoad);
    }

    const skipFollowerList = batchVerification && (
      CONFIG.skipFollowerListWhenSelf === true
      || (
        CONFIG.skipFollowerListWhenSelf === "auto"
        && typeof target.followerCount === "number"
        && typeof target.followingCount === "number"
        && target.followerCount > target.followingCount * 2
      )
    );
    const skippedFollowerLoad = (status) => ({
      usersByUsername: new Map(),
      passes: [{
        kind: "followers",
        pass: "skipped",
        count: "-",
        pages: 0,
        before: 0,
        after: 0,
        added: 0,
        status,
      }],
      stoppedEarly: false,
      stopReason: "",
      stopStatus: "",
      skipped: true,
    });

    let followerLoad;

    if (followingListUnavailable) {
      setStatusBar("followers: skipped", 0, 1);
      progress(
        "Skipping the follower list: the following list was blocked before any accounts loaded, so this run cannot produce a result anyway.",
        "followers",
      );
      followerLoad = skippedFollowerLoad("skipped (following list blocked)");
    } else if (skipFollowerList) {
      setStatusBar("followers: skipped", 1, 1);
      progress(
        `Skipping the bulk follower list (${formatNumber(target.followerCount)} followers): every followed account is verified directly with batch friendship checks, which needs far fewer requests.`,
        "followers",
      );
      followerLoad = skippedFollowerLoad("skipped (batch verification)");
    } else {
      followerLoad = await loadRelationshipList("followers", target, resume, { singleSweep: batchVerification });
    }

    const followerListUnavailable = (
      !batchVerification
      && followerLoad.stoppedEarly
      && followerLoad.usersByUsername.size === 0
      && (typeof target.followerCount !== "number" || target.followerCount > 0)
    );
    const followingAccounts = [...followingLoad.usersByUsername.values()];
    const followingStatusHintAccounts = useFollowingStatusHints
      ? followingAccounts
        .filter((account) => account.followsViewer === false)
        .sort((left, right) => left.username.localeCompare(right.username))
      : [];
    const followingStatusHintsAvailable = useFollowingStatusHints
      && followingAccounts.some((account) => typeof account.followsViewer === "boolean");
    const tentativeMisses = [];

    if (!followerListUnavailable && !followingListUnavailable) {
      const tentativeByUsername = new Map();

      for (const account of followingAccounts) {
        const username = normalizeUsername(account.username);

        if (!username) {
          continue;
        }

        if (
          !followerLoad.usersByUsername.has(username)
          || (useFollowingStatusHints && account.followsViewer === false)
        ) {
          tentativeByUsername.set(username, account);
        }
      }

      tentativeMisses.push(
        ...[...tentativeByUsername.values()]
          .sort((left, right) => left.username.localeCompare(right.username)),
      );
    }
    const verifiedNotFollowingBack = [];
    const correctedByExactSearch = [];
    const unknown = [];
    let authLost = false;

    if (followerListUnavailable || followingListUnavailable) {
      setStatusBar("Verification blocked", 0, 1);
      progress(
        "Stopped safely before exact verification because Instagram blocked a required relationship list. No accounts were counted.",
        "blocked",
      );
    } else {
      setStatusBar("Verification queued", 0, tentativeMisses.length);
      progress(
        `Verifying ${tentativeMisses.length} tentative misses with ${verificationMethod}. Unknowns will not be counted as not following back.`,
        "exact verification",
      );

      const configuredPreviousUnknowns = new Set(
        (
          Array.isArray(CONFIG.previousUnknownUsernames)
            ? CONFIG.previousUnknownUsernames
            : String(CONFIG.previousUnknownUsernames || "").split(",")
        )
          .map(normalizeUsername)
          .filter(Boolean),
      );
      const retryablePreviousUnknownKeys = new Set();
      const recordVerdict = (account, followsBack) => {
        (followsBack ? correctedByExactSearch : verifiedNotFollowingBack).push(account);
        resume.verdicts[verdictKey(account)] = {
          followsBack,
          checkedAt: new Date().toISOString(),
        };
      };
      const recordUnknown = (account, reason, options = {}) => {
        unknown.push({ ...account, reason });
        resume.verdicts[verdictKey(account)] = {
          followsBack: null,
          unknown: true,
          reason,
          reasonCode: options.reasonCode || "",
          retryIndividually: Boolean(options.retryIndividually),
          checkedAt: new Date().toISOString(),
        };
      };
      const shouldRecheckUnknownIndividually = (account) => (
        retryablePreviousUnknownKeys.has(verdictKey(account))
        || configuredPreviousUnknowns.has(normalizeUsername(account.username))
      );
      const pendingVerification = [];
      let resumedFollowsBack = 0;
      let recheckingSavedMisses = 0;

      for (const account of tentativeMisses) {
        const key = verdictKey(account);
        const savedVerdict = resume.verdicts[key];

        if (savedVerdict && savedVerdict.followsBack === true) {
          correctedByExactSearch.push(account);
          resumedFollowsBack += 1;
        } else {
          if (savedVerdict && savedVerdict.followsBack === false && CONFIG.reverifySavedMisses !== false) {
            recheckingSavedMisses += 1;
          } else if (savedVerdict && savedVerdict.followsBack === false) {
            verifiedNotFollowingBack.push(account);
            continue;
          }

          if (retryableUnknownFromSavedVerdict(savedVerdict)) {
            retryablePreviousUnknownKeys.add(key);
          }

          pendingVerification.push(account);
        }
      }

      if (resumedFollowsBack > 0 || recheckingSavedMisses > 0) {
        setStatusBar(
          "Verification queued",
          resumedFollowsBack + verifiedNotFollowingBack.length,
          tentativeMisses.length,
        );
        progress(
          `Reused ${resumedFollowsBack} saved follows-back results and rechecking ${recheckingSavedMisses} saved not-following-back results to prevent false positives. ${pendingVerification.length} accounts still need verification.`,
          "exact verification",
        );
      }

      let pendingExactSearch = pendingVerification;

      if (batchVerification && pendingVerification.length > 0) {
        const withIds = pendingVerification.filter((account) => account.id);
        const exactFallback = pendingVerification.filter((account) => !account.id);
        const individualFallback = [];
        let batchResolvedCount = 0;
        const parkUnresolvedBatchAccount = (account, reason) => {
          if (followerLoad.skipped) {
            recordUnknown(account, reason, { reasonCode: "batch-unresolved-large" });
          } else {
            exactFallback.push(account);
          }
        };

        for (let index = 0; index < withIds.length; index += CONFIG.batchSize) {
          const batchAccounts = withIds.slice(index, index + CONFIG.batchSize);

          if (authLost && CONFIG.stopExactSearchOnAuthLost) {
            for (const account of batchAccounts) {
              recordUnknown(
                account,
                "Login or rate-limit wall appeared before this batch was checked.",
                { reasonCode: "batch-auth-wall" },
              );
            }
            continue;
          }

          try {
            const statuses = await batchFriendshipStatuses(batchAccounts);

            for (const account of batchAccounts) {
              const status = lookupFriendshipStatus(statuses, account);
              const followsBack = followedByFromStatus(status, account);

              if (typeof followsBack === "boolean") {
                batchResolvedCount += 1;
                recordVerdict(account, followsBack);
              } else {
                individualFallback.push(account);
              }
            }
          } catch (error) {
            if (error.authLost || error.rateLimited || error.relationshipBlocked) {
              authLost = true;

              for (const account of batchAccounts) {
                recordUnknown(account, error.message || String(error), {
                  reasonCode: "batch-wall",
                });
              }
            } else {
              exactFallback.push(...batchAccounts);
            }
          }

          setStatusBar(
            "Batch verification",
            verifiedNotFollowingBack.length + correctedByExactSearch.length + unknown.length,
            tentativeMisses.length,
          );
          progress(
            `Batch checked ${Math.min(index + CONFIG.batchSize, withIds.length)}/${withIds.length}: follows back ${correctedByExactSearch.length}, verified missing ${verifiedNotFollowingBack.length}, unknown ${unknown.length}`,
            "exact verification",
          );
          saveResumeState(target.id, resume);

          if (index + CONFIG.batchSize < withIds.length) {
            await sleep(paceDelay(CONFIG.batchDelayMs));
          }
        }

        if (individualFallback.length > 0) {
          const previousUnknownCandidates = individualFallback.filter(shouldRecheckUnknownIndividually);
          let individualCandidates = [];
          const skippedIndividual = [];

          if (!CONFIG.individualVerifyUnknowns) {
            skippedIndividual.push(...individualFallback);
          } else if (authLost && CONFIG.stopExactSearchOnAuthLost) {
            for (const account of individualFallback) {
              recordUnknown(
                account,
                "Login or rate-limit wall appeared before this individual check.",
                { reasonCode: "individual-auth-wall" },
              );
            }
          } else if (individualFallback.length <= CONFIG.maxIndividualRechecks) {
            individualCandidates = individualFallback;
          } else {
            individualCandidates = previousUnknownCandidates.slice(0, CONFIG.maxIndividualRechecks);

            const individualCandidateKeys = new Set(individualCandidates.map(verdictKey));
            skippedIndividual.push(
              ...individualFallback.filter((account) => !individualCandidateKeys.has(verdictKey(account))),
            );
          }

          if (skippedIndividual.length > 0) {
            const skippedDestination = followerLoad.skipped
              ? "kept the rest Unknown"
              : "sent the rest to exact follower search";
            const capReason = CONFIG.individualVerifyUnknowns
              ? `Batch friendship checks left ${individualFallback.length} accounts unresolved, above the ${CONFIG.maxIndividualRechecks} individual-recheck safety cap. Rechecked ${individualCandidates.length} prior Unknown accounts individually and ${skippedDestination} instead of making hundreds of requests.`
              : "Individual friendship rechecks are disabled; unresolved batch accounts were not counted as not following back.";

            progress(capReason, "exact verification");
            warnings.push(capReason);

            for (const account of skippedIndividual) {
              parkUnresolvedBatchAccount(account, capReason);
            }
          }

          if (individualCandidates.length > 0) {
            progress(
              `Rechecking ${individualCandidates.length} unresolved account${individualCandidates.length === 1 ? "" : "s"} one by one with individual friendship checks.`,
              "exact verification",
            );
          }

          for (let index = 0; index < individualCandidates.length; index += 1) {
            const account = individualCandidates[index];

            try {
              const followsBack = await individualFriendshipStatus(account);

              if (typeof followsBack === "boolean") {
                recordVerdict(account, followsBack);
              } else if (followerLoad.skipped) {
                recordUnknown(account, "Individual friendship check did not return a readable relationship status.", {
                  reasonCode: "individual-unreadable",
                  retryIndividually: true,
                });
              } else {
                exactFallback.push(account);
              }
            } catch (error) {
              if (error.authLost || error.rateLimited || error.relationshipBlocked) {
                authLost = true;
                recordUnknown(account, error.message || String(error), {
                  reasonCode: "individual-wall",
                  retryIndividually: true,
                });
              } else {
                exactFallback.push(account);
              }
            }

            if ((index + 1) % 10 === 0 || index + 1 === individualCandidates.length) {
              progress(
                `Individual checked ${index + 1}/${individualCandidates.length}: follows back ${correctedByExactSearch.length}, verified missing ${verifiedNotFollowingBack.length}, unknown ${unknown.length}`,
                "exact verification",
              );
              saveResumeState(target.id, resume);
            }

            if (index + 1 < individualCandidates.length) {
              await sleep(paceDelay(CONFIG.individualDelayMs));
            }
          }
        }

        if (batchResolvedCount === 0 && individualFallback.length > CONFIG.maxIndividualRechecks) {
          const shapeWarning = "The batch friendship endpoint returned no readable followed_by statuses. Response-shape notes are saved in window.IG_FOLLOW_BACK_STATE.debug.batchResponseShapes for troubleshooting.";

          warnings.push(shapeWarning);
          progress(shapeWarning, "exact verification");
        }

        if (exactFallback.length > 0) {
          progress(
            `Falling back to exact follower search for ${exactFallback.length} accounts the batch check could not resolve.`,
            "exact verification",
          );
        }

        pendingExactSearch = exactFallback;
      }

      const exactSearchCanary = followerLoad.usersByUsername.size > 0
        ? followerLoad.usersByUsername.values().next().value
        : (followerLoad.skipped && batchVerification ? correctedByExactSearch[0] : null);

      if (
        pendingExactSearch.length > 0
        && exactSearchCanary
        && !(authLost && CONFIG.stopExactSearchOnAuthLost)
      ) {
        const canary = exactSearchCanary;
        let canaryProblem = "";

        try {
          if (!(await exactFollowerSearch(target, canary.username))) {
            canaryProblem = `Exact follower search could not find @${canary.username}, a known follower, so search results are not reliable right now.`;
          }
        } catch (error) {
          if (error.authLost || error.rateLimited || error.relationshipBlocked) {
            authLost = true;
          }

          canaryProblem = `Exact follower search reliability check failed: ${error.message || String(error)}`;
        }

        if (canaryProblem) {
          setStatusBar("Verification reliability check failed", 0, 1);
          progress(canaryProblem, "exact verification");
          warnings.push(`${canaryProblem} Unverified accounts were kept in Unknown instead of being counted as not following back. Wait 10-15 minutes and rerun.`);

          for (const account of pendingExactSearch) {
            recordUnknown(account, canaryProblem, { reasonCode: "exact-canary-failed" });
          }

          pendingExactSearch = [];
        } else {
          await sleep(paceDelay(CONFIG.exactSearchDelayMs));
        }
      } else if (
        pendingExactSearch.length > 0
        && followerLoad.skipped
        && batchVerification
        && !(authLost && CONFIG.stopExactSearchOnAuthLost)
      ) {
        const canaryProblem = "Exact follower search was skipped because no known follower was available to prove follower-search reliability after the bulk follower list was skipped.";

        progress(canaryProblem, "exact verification");
        warnings.push(`${canaryProblem} Unverified accounts were kept in Unknown instead of being counted as not following back.`);

        for (const account of pendingExactSearch) {
          recordUnknown(account, canaryProblem, { reasonCode: "exact-canary-missing" });
        }

        pendingExactSearch = [];
      }

      for (let index = 0; index < pendingExactSearch.length; index += 1) {
        const account = pendingExactSearch[index];

        if (authLost && CONFIG.stopExactSearchOnAuthLost) {
          recordUnknown(account, "Login or rate-limit wall appeared before exact search.", {
            reasonCode: "exact-auth-wall",
          });
          continue;
        }

        try {
          recordVerdict(account, await exactFollowerSearch(target, account.username));
        } catch (error) {
          if (error.authLost || error.rateLimited || error.relationshipBlocked) {
            authLost = true;
          }

          recordUnknown(account, error.message || String(error), {
            reasonCode: "exact-error",
          });
        }

        if ((index + 1) % 10 === 0 || index + 1 === pendingExactSearch.length) {
          setStatusBar(
            "Exact verification",
            verifiedNotFollowingBack.length + correctedByExactSearch.length + unknown.length,
            tentativeMisses.length,
          );
          progress(
            `Exact checked ${index + 1}/${pendingExactSearch.length}: follows back ${correctedByExactSearch.length}, verified missing ${verifiedNotFollowingBack.length}, unknown ${unknown.length}`,
            "exact verification",
          );
          saveResumeState(target.id, resume);
        }

        if (index + 1 < pendingExactSearch.length) {
          await sleep(paceDelay(CONFIG.exactSearchDelayMs));
        }
      }
    }

    const usernamesIn = (accounts) => new Set(accounts.map((account) => normalizeUsername(account.username)));
    const verifiedMissingNames = usernamesIn(verifiedNotFollowingBack);
    const correctedNames = usernamesIn(correctedByExactSearch);
    const unknownNames = usernamesIn(unknown);
    const followingStatusHintBuckets = {
      available: followingStatusHintsAvailable,
      source: CONFIG.compareFollowingFeed ? "loaded list plus optional following-feed comparison" : "loaded following list",
      notFollowingBack: followingStatusHintAccounts,
      verifiedMissing: followingStatusHintAccounts.filter(
        (account) => verifiedMissingNames.has(normalizeUsername(account.username)),
      ),
      corrected: followingStatusHintAccounts.filter(
        (account) => correctedNames.has(normalizeUsername(account.username)),
      ),
      unknown: followingStatusHintAccounts.filter(
        (account) => unknownNames.has(normalizeUsername(account.username)),
      ),
      unresolved: followingStatusHintAccounts.filter((account) => {
        const username = normalizeUsername(account.username);

        return !verifiedMissingNames.has(username)
          && !correctedNames.has(username)
          && !unknownNames.has(username);
      }),
    };
    followingStatusHintBuckets.notVerifiedMissing = [
      ...followingStatusHintBuckets.corrected,
      ...followingStatusHintBuckets.unknown,
      ...followingStatusHintBuckets.unresolved,
    ].sort((left, right) => left.username.localeCompare(right.username));

    if (followingLoad.stoppedEarly) {
      warnings.push(`Following list stopped early: ${followingLoad.stopReason}. Loaded accounts were kept, but accounts Instagram did not expose cannot be checked in this run. ${rerunAdvice()}`);
    }

    if (followingFeedHintLoad.stoppedEarly) {
      warnings.push(`Optional following-feed comparison stopped early: ${followingFeedHintLoad.stopReason}. The verified result still used the relationship lists and any hints already loaded.`);
    }

    if (followerLoad.stoppedEarly) {
      if (batchVerification) {
        warnings.push(`Followers list stopped early: ${followerLoad.stopReason}. Accuracy is unaffected: every tentative miss was still verified directly with batch friendship checks.`);
      } else {
        warnings.push(`Followers list stopped early: ${followerLoad.stopReason}. No false positives were counted from the blocked data.`);
      }

      if (followerLoad.stopStatus === "html-blocked" && !batchVerification) {
        warnings.push("Instagram returned an HTML page instead of follower JSON for this profile/session. That is the same follower-side wall the Instagram modal can show as empty or suggested accounts; rerun only after the follower modal can show real followers.");
      }
    }

    if (followingListUnavailable || followerListUnavailable) {
      warnings.push(`No reliable not-following-back result was produced because Instagram blocked a required list before enough data loaded. ${rerunAdvice()}`);
    }

    if (
      typeof target.followingCount === "number"
      && followingLoad.usersByUsername.size < target.followingCount
      && !followingListUnavailable
    ) {
      warnings.push(`Bulk following list exposed ${followingLoad.usersByUsername.size} of ${target.followingCount}. The verified list has no known false positives, but it may miss not-followbacks among accounts Instagram did not expose.`);
    }

    if (
      !batchVerification
      && !followerLoad.skipped
      && typeof target.followerCount === "number"
      && followerLoad.usersByUsername.size < target.followerCount
      && !followerListUnavailable
    ) {
      warnings.push(`Bulk followers list exposed ${followerLoad.usersByUsername.size} of ${target.followerCount}. Each tentative miss was exact-searched in followers; exact-search hits were corrected, and exact-search failures were moved to Unknown.`);
    }

    if (authLost) {
      warnings.push(`Login, HTML, or rate-limit wall appeared during exact verification; affected accounts were moved to Unknown instead of counted. ${rerunAdvice()}`);
    }

    if (
      followingStatusHintBuckets.available
      && followingStatusHintBuckets.notFollowingBack.length > 0
      && followingStatusHintBuckets.notVerifiedMissing.length > 0
    ) {
      const verifiedHintCount = followingStatusHintBuckets.verifiedMissing.length;
      const notVerifiedHintCount = followingStatusHintBuckets.notVerifiedMissing.length;

      warnings.push(`Instagram's following-feed hint flagged ${followingStatusHintBuckets.notFollowingBack.length} accounts as not following you back; ${verifiedHintCount} ${verifiedHintCount === 1 ? "was" : "were"} verified missing, and ${notVerifiedHintCount} ${notVerifiedHintCount === 1 ? "was" : "were"} corrected, unknown, or not verified. This is the likely source of differences with simpler unfollower tools.`);
    }

    if (
      !followingLoad.stoppedEarly
      && !followingFeedHintLoad.stoppedEarly
      && !followerLoad.stoppedEarly
      && !authLost
      && unknown.length === 0
    ) {
      clearResumeState(target.id);
    } else {
      saveResumeState(target.id, resume);
    }

    const result = {
      generatedAt: new Date().toISOString(),
      target,
      profileCounts: {
        followers: target.followerCount,
        following: target.followingCount,
      },
      loaded: {
        followers: followerLoad.skipped ? "skipped" : followerLoad.usersByUsername.size,
        following: followingLoad.usersByUsername.size,
      },
      tentativeMisses: tentativeMisses.length,
      verifiedNotFollowingBack,
      correctedByExactSearch,
      unknown,
      authLost,
      warnings,
      verificationMethod,
      requestsMade: state.requests,
      resumedFromPreviousRun: resume.loadedFromStorage,
      followingStatusHints: followingStatusHintBuckets,
      loadPasses: [...followingLoad.passes, ...followingFeedHintLoad.passes, ...followerLoad.passes],
      accuracyNote: "Only accounts in Verified not following back are counted as misses. Every tentative miss is individually verified; accounts that follow back are removed, and failures/auth issues are kept in Unknown instead of being counted.",
    };

    window.IG_FOLLOW_BACK_RESULTS = result;
    window.IG_OVER1K_FOLLOW_BACK_RESULTS = result;
    state.done = true;
    setStatusBar("Done", 1, 1);
    progress(
      `Done: ${verifiedNotFollowingBack.length} verified not following back, ${correctedByExactSearch.length} follow back, ${unknown.length} unknown, ${state.requests} requests.`,
      "done",
    );
    console.log("IG_FOLLOW_BACK_RESULT_SUMMARY", {
      target: result.target.username,
      loaded: result.loaded,
      profileCounts: result.profileCounts,
      tentativeMisses: result.tentativeMisses,
      verifiedNotFollowingBack: result.verifiedNotFollowingBack.length,
      correctedByExactSearch: result.correctedByExactSearch.length,
      unknown: result.unknown.length,
      followingStatusHintNotFollowingBack: result.followingStatusHints.notFollowingBack.length,
      followingStatusHintNotVerifiedMissing: result.followingStatusHints.notVerifiedMissing.length,
      authLost: result.authLost,
      verificationMethod: result.verificationMethod,
      requestsMade: result.requestsMade,
      warnings: result.warnings,
    });
    renderFinalReport(result);
  }

  run().catch((error) => {
    state.done = true;
    setStatusBar("Error", 1, 1);
    progress(error.message || String(error), "error");
    console.error("Instagram follow-back checker failed", error);
  });
})();
