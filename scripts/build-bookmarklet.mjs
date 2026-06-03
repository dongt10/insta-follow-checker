import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

const sourceUrl = new URL("../src/check-follow-back.js", import.meta.url);
const bookmarkletUrl = new URL("../bookmarklet.js", import.meta.url);

export function toBookmarklet(source) {
  return `javascript:${source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")}\n`;
}

export async function buildBookmarklet() {
  const source = await readFile(sourceUrl, "utf8");

  await writeFile(bookmarkletUrl, toBookmarklet(source));
  console.log("bookmarklet built");
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildBookmarklet();
}
