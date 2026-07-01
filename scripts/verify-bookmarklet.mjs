import { readFile } from "node:fs/promises";
import {
  BOOKMARKLET_TARGETS,
  COPY_PAGE_TARGET,
  getCopyItems,
  toBookmarklet,
  toCopyPage,
} from "./build-bookmarklet.mjs";

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

const copyPage = await readFile(new URL(COPY_PAGE_TARGET, import.meta.url), "utf8");
const expectedCopyPage = toCopyPage(await getCopyItems());

if (copyPage !== expectedCopyPage) {
  throw new Error(`${COPY_PAGE_TARGET.replace("../", "")} is out of sync. Run npm run build:bookmarklet.`);
}

if (!copyPage.includes("copy script") || !copyPage.includes("copy bookmarklet")) {
  throw new Error("copy helper must include script and bookmarklet copy actions");
}

console.log(`copy helper sync ok: ${COPY_PAGE_TARGET.replace("../", "")}`);
