import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const BOOKMARKLET_TARGETS = [
  {
    id: "self-script",
    title: "self check",
    description: "for your own instagram profile.",
    source: "../src/check-follow-back.js",
    bookmarklet: "../bookmarklet.js",
    bookmarkletTitle: "self bookmarklet",
  },
  {
    id: "public-script",
    title: "public account",
    description: "for another visible profile.",
    source: "../src/check-non-followers-public.js",
    bookmarklet: "../bookmarklet-public.js",
    bookmarkletTitle: "public bookmarklet",
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
    return `${value} b`;
  }

  return `${Math.round(value / 102.4) / 10} kb`;
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
      buttonLabel: "copy script",
      content: source,
      size: formatBytes(Buffer.byteLength(source, "utf8")),
    });
    items.push({
      id: `${target.id}-bookmarklet`,
      title: target.bookmarkletTitle,
      description: "paste into a bookmark url.",
      file: target.bookmarklet.replace("../", ""),
      buttonLabel: "copy bookmarklet",
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
  <title>instagram follow back checker - copy scripts</title>
  <style>
    :root {
      color-scheme: dark;
      --bg: #080807;
      --panel: #12110f;
      --panel-soft: #171512;
      --text: #f4f1ea;
      --muted: #a59e93;
      --quiet: #746d64;
      --border: #2a2722;
      --primary: #f4f1ea;
      --primary-strong: #ffffff;
      --primary-text: #11100e;
      --accent: #98d8aa;
      --warn: #f0b36a;
      --shadow: 0 24px 70px rgba(0, 0, 0, 0.38);
    }

    * {
      box-sizing: border-box;
    }

    body {
      margin: 0;
      background: var(--bg);
      color: var(--text);
      font: 15px/1.5 -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      overflow-x: hidden;
    }

    main {
      width: min(960px, calc(100% - 32px));
      margin: 0 auto;
      padding: 56px 0 64px;
    }

    header {
      display: grid;
      gap: 14px;
      max-width: 680px;
      margin-bottom: 28px;
    }

    h1 {
      margin: 0;
      font-size: clamp(38px, 8vw, 72px);
      line-height: 1.1;
      letter-spacing: 0;
    }

    p {
      margin: 0;
      color: var(--muted);
      max-width: 620px;
    }

    .notice {
      display: inline-flex;
      width: fit-content;
      max-width: 100%;
      margin: 4px 0 28px;
      padding: 8px 11px;
      border: 1px solid #4a3a24;
      border-radius: 8px;
      background: #18120b;
      color: var(--warn);
      font-size: 13px;
    }

    .grid {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
      gap: 10px;
    }

    .item {
      display: grid;
      gap: 18px;
      min-height: 190px;
      padding: 16px;
      border: 1px solid var(--border);
      border-radius: 8px;
      background: var(--panel);
      box-shadow: var(--shadow);
    }

    .item-head {
      display: grid;
      gap: 8px;
    }

    h2 {
      margin: 0;
      font-size: 19px;
      line-height: 1.25;
      letter-spacing: 0;
    }

    .meta {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      color: var(--quiet);
      font-size: 12px;
    }

    .meta code {
      color: var(--muted);
      background: var(--panel-soft);
      border: 1px solid var(--border);
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
      color: var(--primary-text);
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
      background: transparent;
      color: var(--muted);
      border-color: var(--border);
    }

    a.button.secondary:hover,
    button.secondary:hover,
    a.button.secondary:focus-visible,
    button.secondary:focus-visible {
      background: var(--panel-soft);
      color: var(--text);
    }

    .status {
      min-height: 24px;
      margin: 18px 0 0;
      color: var(--accent);
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
      background: var(--panel);
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
      background: #0d0c0b;
      color: var(--text);
      font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    }

    @media (max-width: 860px) {
      main {
        width: min(358px, calc(100% - 32px));
        margin-left: 16px;
        margin-right: auto;
        padding: 48px 0 44px;
      }

      header {
        margin-bottom: 24px;
      }

      .grid {
        grid-template-columns: 1fr;
      }

      .item {
        min-height: auto;
      }
    }
  </style>
</head>
<body>
  <main>
    <header>
      <h1>copy the checker.</h1>
      <p>pick a script, copy it, paste it into instagram. nothing installs.</p>
    </header>

    <div class="notice">runs locally in your browser session.</div>

    <section id="items" class="grid" aria-live="polite"></section>
    <div id="status" class="status" role="status"></div>
  </main>

  <section id="fallback" class="fallback" aria-label="manual copy fallback">
    <strong>manual copy</strong>
    <textarea id="fallbackText" readonly></textarea>
    <div class="actions">
      <button id="selectFallback" type="button">select text</button>
      <button id="closeFallback" type="button" class="secondary">close</button>
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
      statusEl.style.color = isError ? "#f0b36a" : "#98d8aa";
    }

    function showFallback(text) {
      fallbackText.value = text;
      fallbackEl.classList.add("visible");
      fallbackText.focus();
      fallbackText.select();
      setStatus("clipboard access was blocked. select and copy from the manual box.", true);
    }

    async function copyText(item) {
      try {
        if (!navigator.clipboard?.writeText) {
          throw new Error("Clipboard API unavailable");
        }

        await navigator.clipboard.writeText(item.content);
        fallbackEl.classList.remove("visible");
        setStatus(item.title + " copied to your clipboard.");
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
      copy.setAttribute("aria-label", "copy " + item.title + " to clipboard");
      copy.addEventListener("click", () => copyText(item));

      const open = document.createElement("a");
      open.className = "button secondary";
      open.href = item.file;
      open.target = "_blank";
      open.rel = "noreferrer";
      open.textContent = "view source";

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
