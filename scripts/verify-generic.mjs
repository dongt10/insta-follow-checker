import { readFile } from "node:fs/promises";

const runnableFiles = [
  new URL("../src/check-follow-back.js", import.meta.url),
  new URL("../bookmarklet.js", import.meta.url),
];

for (const file of runnableFiles) {
  const contents = await readFile(file, "utf8");

  if (contents.includes("dongt10")) {
    throw new Error(`${file.pathname} must not hardcode a specific Instagram username`);
  }
}

const source = await readFile(
  new URL("../src/check-follow-back.js", import.meta.url),
  "utf8",
);

if (!source.includes("window.location.pathname")) {
  throw new Error("source script must detect the username from the current profile URL");
}

console.log("generic username check ok");
