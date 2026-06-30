import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const BOOKMARKLET_TARGETS = [
  {
    id: "self-script",
    title: "Self-check console script",
    description: "Use this on your own Instagram profile. It uses exact batch friendship checks when possible.",
    source: "../src/check-follow-back.js",
    bookmarklet: "../bookmarklet.js",
    bookmarkletTitle: "Self-check bookmarklet",
  },
  {
    id: "public-script",
    title: "Public-account console script",
    description: "Use this for another visible account. It compares follower and following lists without per-account search storms.",
    source: "../src/check-non-followers-public.js",
    bookmarklet: "../bookmarklet-public.js",
    bookmarkletTitle: "Public-account bookmarklet",
  },
];
export const COPY_PAGE_TARGET = "../copy.html";

export function toBookmarklet(source) {
  return `javascript:${source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")}\n`;
}

function escapeJsonForScript(value) {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

function formatBytes(value) {
  if (value < 1024) {
    return `${value} B`;
  }

  return `${Math.round(value / 102.4) / 10} KB`;
}

export async function getCopyItems() {
  const items = [];

  for (const target of BOOKMARKLET_TARGETS) {
    const source = await readFile(new URL(target.source, import.meta.url), "utf8");
    const bookmarklet = toBookmarklet(source);

    items.push({
      id: target.id,
      title: target.title,
      description: target.description,
      file: target.source.replace("../", ""),
      buttonLabel: "Copy script",
      content: source,
      size: formatBytes(Buffer.byteLength(source, "utf8")),
    });
    items.push({
      id: `${target.id}-bookmarklet`,
      title: target.bookmarkletTitle,
      description: "Paste this into a browser bookmark URL, then click it while viewing the Instagram profile.",
      file: target.bookmarklet.replace("../", ""),
      buttonLabel: "Copy bookmarklet",
      content: bookmarklet,
      size: formatBytes(Buffer.byteLength(bookmarklet, "utf8")),
    });
  }

  return items;
}

export function toCopyPage(items) {
  const payload = {
    generatedAt: new Date(0).toISOString(),
    items,
  };

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Instagram Follow Back Checker - Copy Scripts</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f6f8fb;
      --panel: #ffffff;
      --text: #172033;
      --muted: #5d6b82;
      --border: #d7deea;
      --primary: #0f766e;
      --primary-strong: #115e59;
      --accent: #2563eb;
      --warn: #b45309;
      --shadow: 0 18px 45px rgba(15, 23, 42, 0.08);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
    }

    main {
      width: min(1080px, calc(100vw - 32px));
      margin: 0 auto;
      padding: 28px 0 40px;
    }

    header {
      display: grid;
      gap: 10px;
      margin-bottom: 20px;
    }

    h1 {
      margin: 0;
      font-size: 30px;
      line-height: 1.1;
      letter-spacing: 0;
    }

    p {
      margin: 0;
      color: var(--muted);
      max-width: 780px;
    }

    .notice {
      margin: 18px 0;
      padding: 12px 14px;
      border: 1px solid #f3c982;
      border-radius: 8px;
      background: #fff8e8;
      color: #5f3b08;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
      gap: 14px;
    }

    .item {
      display: grid;
      gap: 12px;
      min-height: 220px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }

    .item-head {
      display: grid;
      gap: 5px;
    }

    h2 {
      margin: 0;
      font-size: 18px;
      line-height: 1.25;
      letter-spacing: 0;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--muted);
      font-size: 13px;
    }

    .meta code {
      color: #334155;
      background: #edf2f7;
      border-radius: 5px;
      padding: 2px 6px;
    }

    .actions {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      align-items: center;
      margin-top: auto;
    }

    button,
    a.button {
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 40px;
      padding: 0 13px;
      border: 1px solid transparent;
      border-radius: 7px;
      background: var(--primary);
      color: white;
      font: inherit;
      font-weight: 650;
      text-decoration: none;
      cursor: pointer;
    }

    button:hover,
    button:focus-visible {
      background: var(--primary-strong);
    }

    a.button.secondary,
    button.secondary {
      background: white;
      color: var(--accent);
      border-color: var(--border);
    }

    a.button.secondary:hover,
    button.secondary:hover,
    a.button.secondary:focus-visible,
    button.secondary:focus-visible {
      background: #eef5ff;
    }

    .status {
      min-height: 24px;
      margin: 16px 0 0;
      color: var(--primary-strong);
      font-weight: 650;
    }

    .fallback {
      position: fixed;
      inset: auto 16px 16px 16px;
      display: none;
      grid-template-columns: 1fr;
      gap: 8px;
      max-width: 900px;
      margin: 0 auto;
      padding: 12px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: white;
      box-shadow: var(--shadow);
    }

    .fallback.visible {
      display: grid;
    }

    textarea {
      width: 100%;
      min-height: 140px;
      resize: vertical;
      border: 1px solid var(--border);
      border-radius: 7px;
      padding: 10px;
      color: var(--text);
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>Copy Instagram Follow Back Checker</h1>
      <p>Choose the script you need, copy it, then paste it into the Instagram DevTools Console or into a bookmark URL.</p>
    </header>

    <div class="notice">Only run browser-console scripts you trust. These scripts run locally in your current Instagram browser session.</div>

    <section id="items" class="grid" aria-live="polite"></section>
    <div id="status" class="status" role="status"></div>
  </main>

  <section id="fallback" class="fallback" aria-label="Manual copy fallback">
    <strong>Manual copy</strong>
    <textarea id="fallbackText" readonly></textarea>
    <div class="actions">
      <button id="selectFallback" type="button">Select text</button>
      <button id="closeFallback" type="button" class="secondary">Close</button>
    </div>
  </section>

  <script type="application/json" id="copy-data">${escapeJsonForScript(payload)}</script>
  <script>
    const payload = JSON.parse(document.getElementById("copy-data").textContent);
    const itemsEl = document.getElementById("items");
    const statusEl = document.getElementById("status");
    const fallbackEl = document.getElementById("fallback");
    const fallbackText = document.getElementById("fallbackText");

    function setStatus(message, isError = false) {
      statusEl.textContent = message;
      statusEl.style.color = isError ? "#b45309" : "#115e59";
    }

    function showFallback(text) {
      fallbackText.value = text;
      fallbackEl.classList.add("visible");
      fallbackText.focus();
      fallbackText.select();
      setStatus("Clipboard access was blocked. Select and copy from the manual box.", true);
    }

    async function copyText(item) {
      try {
        if (!navigator.clipboard?.writeText) {
          throw new Error("Clipboard API unavailable");
        }

        await navigator.clipboard.writeText(item.content);
        fallbackEl.classList.remove("visible");
        setStatus("Copied " + item.title + ".");
      } catch {
        showFallback(item.content);
      }
    }

    function renderItem(item) {
      const article = document.createElement("article");
      article.className = "item";

      const head = document.createElement("div");
      head.className = "item-head";

      const title = document.createElement("h2");
      title.textContent = item.title;

      const description = document.createElement("p");
      description.textContent = item.description;

      const meta = document.createElement("div");
      meta.className = "meta";

      const file = document.createElement("code");
      file.textContent = item.file;

      const size = document.createElement("span");
      size.textContent = item.size;

      meta.append(file, size);
      head.append(title, description, meta);

      const actions = document.createElement("div");
      actions.className = "actions";

      const copy = document.createElement("button");
      copy.type = "button";
      copy.textContent = item.buttonLabel;
      copy.addEventListener("click", () => copyText(item));

      const open = document.createElement("a");
      open.className = "button secondary";
      open.href = item.file;
      open.textContent = "Open file";

      actions.append(copy, open);
      article.append(head, actions);

      return article;
    }

    for (const item of payload.items) {
      itemsEl.appendChild(renderItem(item));
    }

    document.getElementById("selectFallback").addEventListener("click", () => {
      fallbackText.focus();
      fallbackText.select();
    });

    document.getElementById("closeFallback").addEventListener("click", () => {
      fallbackEl.classList.remove("visible");
      fallbackText.value = "";
    });
  </script>
</body>
</html>
`;
}

export async function buildBookmarklet() {
  for (const target of BOOKMARKLET_TARGETS) {
    const source = await readFile(new URL(target.source, import.meta.url), "utf8");

    await writeFile(new URL(target.bookmarklet, import.meta.url), toBookmarklet(source));
    console.log(`bookmarklet built: ${target.bookmarklet.replace("../", "")}`);
  }

  const copyItems = await getCopyItems();

  await writeFile(new URL(COPY_PAGE_TARGET, import.meta.url), toCopyPage(copyItems));
  console.log(`copy helper built: ${COPY_PAGE_TARGET.replace("../", "")}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildBookmarklet();
}
