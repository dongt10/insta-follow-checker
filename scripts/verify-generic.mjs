import { readFile } from "node:fs/promises";

const runnableFiles = [
  new URL("../src/check-follow-back.js", import.meta.url),
  new URL("../bookmarklet.js", import.meta.url),
];

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const packageAuthor = packageJson.author?.trim();

for (const file of runnableFiles) {
  const contents = await readFile(file, "utf8");

  if (packageAuthor && contents.includes(packageAuthor)) {
    throw new Error(
      `${file.pathname} must not hardcode the package author as an Instagram username`,
    );
  }
}

const source = await readFile(
  new URL("../src/check-follow-back.js", import.meta.url),
  "utf8",
);

if (!source.includes("window.location.pathname")) {
  throw new Error("source script must detect the username from the current profile URL");
}

if (!source.includes("loadRelationshipList(\"followers\"")) {
  throw new Error("source script must load followers before exact verification");
}

if (!source.includes("exactFollowerSearch")) {
  throw new Error("source script must exact-search tentative misses before counting them");
}

if (!source.includes("correctedByExactSearch")) {
  throw new Error("source script must report tentative misses corrected by exact follower search");
}

if (!source.includes("unknown.push")) {
  throw new Error("source script must keep auth/rate-limit failures out of verified misses");
}

console.log("generic username check ok");
