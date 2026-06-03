import { readFile } from "node:fs/promises";
import { toBookmarklet } from "./build-bookmarklet.mjs";

const bookmarklet = await readFile(new URL("../bookmarklet.js", import.meta.url), "utf8");
const source = await readFile(new URL("../src/check-follow-back.js", import.meta.url), "utf8");

if (!bookmarklet.startsWith("javascript:")) {
  throw new Error("bookmarklet.js must start with javascript:");
}

if (bookmarklet !== toBookmarklet(source)) {
  throw new Error("bookmarklet.js is out of sync. Run npm run build:bookmarklet.");
}

const bookmarkletSource = bookmarklet.slice("javascript:".length).trim();

new Function(bookmarkletSource);

console.log("bookmarklet syntax and sync ok");
