import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { releaseAuthorMayPublish } from "./verify-release-author.mjs";

const script = fileURLToPath(new URL("./verify-release-author.mjs", import.meta.url));

function run(env) {
  return spawnSync(process.execPath, [script], {
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

test("repository_owner_may_publish", () => {
  assert.equal(
    releaseAuthorMayPublish({ actor: "zkldwxz", repositoryOwner: "zkldwxz" }),
    true,
  );
  assert.equal(run({ GITHUB_ACTOR: "zkldwxz", REPOSITORY_OWNER: "zkldwxz" }).status, 0);
});

test("cursor_bot_tag_push_may_publish", () => {
  assert.equal(
    releaseAuthorMayPublish({ actor: "cursor[bot]", repositoryOwner: "zkldwxz" }),
    true,
  );
  assert.equal(run({ GITHUB_ACTOR: "cursor[bot]", REPOSITORY_OWNER: "zkldwxz" }).status, 0);
});

test("other_github_apps_may_publish", () => {
  assert.equal(
    releaseAuthorMayPublish({
      actor: "github-actions[bot]",
      repositoryOwner: "zkldwxz",
    }),
    true,
  );
});

test("human_collaborator_other_than_the_owner_may_not_publish", () => {
  assert.equal(
    releaseAuthorMayPublish({ actor: "alice", repositoryOwner: "zkldwxz" }),
    false,
  );
  const result = run({ GITHUB_ACTOR: "alice", REPOSITORY_OWNER: "zkldwxz" });
  assert.equal(result.status, 1);
  assert.match(
    result.stderr,
    /release actor must be the repository owner or a GitHub App: alice/,
  );
});

test("missing_actor_or_owner_is_rejected", () => {
  assert.throws(
    () => releaseAuthorMayPublish({ actor: " ", repositoryOwner: "zkldwxz" }),
    /release actor is required/,
  );
  assert.throws(
    () => releaseAuthorMayPublish({ actor: "zkldwxz", repositoryOwner: "" }),
    /repository owner is required/,
  );
  const result = run({ GITHUB_ACTOR: "", REPOSITORY_OWNER: "zkldwxz" });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release actor is required/);
});
