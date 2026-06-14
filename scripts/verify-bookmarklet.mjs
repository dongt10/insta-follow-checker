import { readFile } from "node:fs/promises";
import { BOOKMARKLET_TARGETS, toBookmarklet } from "./build-bookmarklet.mjs";

for (const target of BOOKMARKLET_TARGETS) {
  const bookmarklet = await readFile(new URL(target.bookmarklet, import.meta.url), "utf8");
  const source = await readFile(new URL(target.source, import.meta.url), "utf8");
  const name = target.bookmarklet.replace("../", "");

  if (!bookmarklet.startsWith("javascript:")) {
    throw new Error(`${name} must start with javascript:`);
  }

  if (bookmarklet !== toBookmarklet(source)) {
    throw new Error(`${name} is out of sync. Run npm run build:bookmarklet.`);
  }

  const bookmarkletSource = bookmarklet.slice("javascript:".length).trim();

  new Function(bookmarkletSource);

  console.log(`bookmarklet syntax and sync ok: ${name}`);
}
