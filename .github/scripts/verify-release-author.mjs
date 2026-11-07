//! Decides whether a tag-push actor may publish a signed desktop GitHub Release.

import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

function requiredName(value, label) {
  const name = value?.trim() ?? "";
  if (!name) throw new Error(`${label} is required`);
  return name;
}

export function releaseAuthorMayPublish({ actor, repositoryOwner }) {
  const resolvedActor = requiredName(actor, "release actor");
  const owner = requiredName(repositoryOwner, "repository owner");
  // Cursor cloud agents and other repo automations push tags as GitHub Apps
  // (`name[bot]`). Write access to create the tag is already the authorization.
  return resolvedActor === owner || resolvedActor.endsWith("[bot]");
}

function main() {
  const actor = process.env.GITHUB_ACTOR ?? "";
  const repositoryOwner = process.env.REPOSITORY_OWNER ?? "";
  if (!releaseAuthorMayPublish({ actor, repositoryOwner })) {
    throw new Error(
      `release actor must be the repository owner or a GitHub App: ${actor.trim()}`,
    );
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
