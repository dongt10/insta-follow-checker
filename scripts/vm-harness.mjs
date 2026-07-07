import vm from "node:vm";
import { readFile } from "node:fs/promises";

export function jsonResponse(body) {
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

export async function runChecker({
  fetch: fetchHandler,
  config = {},
  cookie = "",
  username = "friend",
  sourceFile = "../src/check-follow-back.js",
  localStorage = null,
  globals = {},
  realTimers = false,
  maxWaitMs = 5000,
}) {
  const raw = await readFile(new URL(sourceFile, import.meta.url), "utf8");
  // Browsers percent-decode a javascript: URL before executing it, so the
  // bookmarklet must be tested against its decoded form.
  const source = raw.startsWith("javascript:")
    ? decodeURIComponent(raw.slice("javascript:".length))
    : raw;
  const fetchCalls = [];
  const consoleWarnings = [];
  const elementById = new Map();
  let bodyHtml = "";

  const context = vm.createContext({
    console: {
      log: () => {},
      error: () => {},
      warn: (...args) => consoleWarnings.push(args.join(" ")),
    },
    prompt: () => username,
    setTimeout: realTimers
      ? setTimeout
      : (callback) => {
        callback();
        return 0;
      },
    fetch: async (url, init = {}) => {
      fetchCalls.push({ url: String(url), init });

      return fetchHandler(String(url), init, () => context);
    },
    window: {
      IG_FOLLOW_BACK_CONFIG: config,
      location: { hostname: "www.instagram.com", pathname: `/${username}/` },
      ...(localStorage ? { localStorage } : {}),
    },
    document: {
      title: "",
      cookie,
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

          // Register stub elements for every id in the rendered report so
          // tests can look them up and invoke their click listeners.
          for (const match of String(value).matchAll(/ id="([^"]+)"/g)) {
            elementById.set(match[1], {
              id: match[1],
              style: {},
              innerHTML: "",
              textContent: "",
              listeners: [],
              addEventListener(_type, listener) {
                this.listeners.push(listener);
              },
            });
          }
        },
        get innerHTML() {
          return bodyHtml;
        },
        appendChild() {},
      },
      getElementById: (id) => elementById.get(id) || null,
      createElement: () => ({
        id: "",
        style: {},
        innerHTML: "",
        href: "",
        download: "",
        click() {
          this.clicked = true;
        },
        remove() {},
      }),
    },
    ...globals,
  });

  vm.runInContext(source, context);

  if (realTimers) {
    const startedAt = Date.now();

    while (!context.window.IG_FOLLOW_BACK_STATE?.done && Date.now() - startedAt < maxWaitMs) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  } else {
    for (let index = 0; index < 5000 && !context.window.IG_FOLLOW_BACK_STATE?.done; index += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  return {
    get bodyHtml() {
      return bodyHtml;
    },
    fetchCalls,
    consoleWarnings,
    state: context.window.IG_FOLLOW_BACK_STATE,
    results: context.window.IG_FOLLOW_BACK_RESULTS,
    context,
  };
}
