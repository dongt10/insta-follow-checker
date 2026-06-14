import { readFile, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const BOOKMARKLET_TARGETS = [
  { source: "../src/check-follow-back.js", bookmarklet: "../bookmarklet.js" },
  { source: "../src/check-non-followers-public.js", bookmarklet: "../bookmarklet-public.js" },
];

export function toBookmarklet(source) {
  return `javascript:${source
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .join(" ")}\n`;
}

export async function buildBookmarklet() {
  for (const target of BOOKMARKLET_TARGETS) {
    const source = await readFile(new URL(target.source, import.meta.url), "utf8");

    await writeFile(new URL(target.bookmarklet, import.meta.url), toBookmarklet(source));
    console.log(`bookmarklet built: ${target.bookmarklet.replace("../", "")}`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await buildBookmarklet();
}
