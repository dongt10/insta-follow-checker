import { jsonResponse, runChecker } from "./vm-harness.mjs";

// The report's export actions must actually work: the CSV escapes quotes and
// neutralizes spreadsheet formulas, the JSON round-trips, and the copy action
// falls back to the console when no clipboard exists.
let lastBlob = null;

class FakeBlob {
  constructor(parts, options) {
    this.content = parts.join("");
    this.type = options?.type || "";
  }
}

const run = await runChecker({
  globals: {
    Blob: FakeBlob,
    URL: {
      createObjectURL: (blob) => {
        lastBlob = blob;

        return "blob:fake";
      },
      revokeObjectURL: () => {},
    },
  },
  config: {
    relationshipListDelayMs: 0,
    exactSearchDelayMs: 0,
    retryBaseDelayMs: 0,
    retryLimit: 0,
    relationshipPageSizes: [100],
  },
  fetch: async (url) => {
    if (url === "/api/v1/users/web_profile_info/?username=friend") {
      return jsonResponse({
        data: {
          user: {
            id: "1",
            username: "friend",
            full_name: "Friend",
            edge_follow: { count: 2 },
            edge_followed_by: { count: 2 },
          },
        },
      });
    }

    if (url === "/api/v1/friendships/1/following/?count=100") {
      return jsonResponse({
        users: [
          { id: "2", username: "alice", full_name: "Alice" },
          { id: "3", username: "bob", full_name: "=HYPERLINK(\"x\") \"Bob\"" },
        ],
        status: "ok",
      });
    }

    if (url === "/api/v1/friendships/1/followers/?count=100") {
      return jsonResponse({
        users: [{ id: "2", username: "alice", full_name: "Alice" }],
        status: "ok",
      });
    }

    if (url === "/api/v1/friendships/1/followers/?count=50&search_surface=follow_list_page&query=alice") {
      return jsonResponse({
        users: [{ id: "2", username: "alice", full_name: "Alice" }],
        status: "ok",
      });
    }

    if (
      url === "/api/v1/friendships/1/followers/?count=50&search_surface=follow_list_page&query=bob"
      || url === "/api/v1/friendships/1/followers/?count=50&query=bob"
    ) {
      return jsonResponse({ users: [], status: "ok" });
    }

    throw new Error(`unexpected fetch ${url}`);
  },
});

if (!run.bodyHtml.includes("not following back (1)")) {
  throw new Error(`expected bob as a verified miss:\n${run.bodyHtml}`);
}

const clickButton = (id) => {
  const button = run.context.document.getElementById(id);

  if (!button || button.listeners.length === 0) {
    throw new Error(`report button ${id} should have a click listener`);
  }

  for (const listener of button.listeners) {
    listener();
  }
};
const note = run.context.document.getElementById("ig-fb-action-note");

clickButton("ig-fb-download-csv");

const csv = lastBlob?.content || "";

if (!csv.startsWith('"status","username","full_name","profile_url","note"')) {
  throw new Error(`csv should start with the header row:\n${csv}`);
}

if (!csv.includes('"not_following_back","bob"')) {
  throw new Error(`csv should list bob as not following back:\n${csv}`);
}

if (!csv.includes('"\'=HYPERLINK(""x"") ""Bob"""')) {
  throw new Error(`csv must escape quotes and neutralize leading formula characters:\n${csv}`);
}

if (note?.textContent !== "csv downloaded") {
  throw new Error(`csv download should confirm via the note, got ${JSON.stringify(note?.textContent)}`);
}

clickButton("ig-fb-download-json");

const exported = JSON.parse(lastBlob?.content || "null");

if (exported?.verifiedNotFollowingBack?.length !== 1 || exported.verifiedNotFollowingBack[0].username !== "bob") {
  throw new Error(`json export should round-trip the results:\n${lastBlob?.content?.slice(0, 400)}`);
}

clickButton("ig-fb-copy-misses");

if (!note?.textContent.includes("console")) {
  throw new Error(`copy without a clipboard should fall back to the console, got ${JSON.stringify(note?.textContent)}`);
}

console.log("report export actions regression ok");
