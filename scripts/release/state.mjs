import { execFileSync } from "node:child_process";

const ensure = (condition, message) => {
  if (!condition) throw new Error(message);
};
export const emptyState = () => ({
  version: 1,
  current: null,
  previous: null,
  history: [],
  exposures: [],
  monitoring: null,
  lastCompletedMonitoring: null,
});
export function verifyExposure(snapshot, release) {
  if (release.monitoring?.version === 2) return;
  const receipt = release.exposure;
  ensure(
    receipt?.repository?.toLowerCase() === snapshot.repo.toLowerCase() &&
      receipt.sourceSha === release.sourceSha &&
      receipt.families?.length > 0 &&
      receipt.families.every((family) =>
        snapshot.state.exposures.some(
          (entry) =>
            entry.family === family &&
            entry.runId === receipt.runId &&
            entry.sourceSha === receipt.sourceSha &&
            entry.reservedAt === receipt.reservedAt,
        ),
      ),
    "Qualification does not match authoritative held-out reservations",
  );
}
export function transition(
  state,
  operation,
  release,
  { expectedCurrent, actor, reason, now = new Date().toISOString() },
) {
  ensure(
    state?.version === 1 && Array.isArray(state.history) && Array.isArray(state.exposures),
    "Invalid release state",
  );
  ensure(
    (state.current?.candidateSha256 ?? "none") === expectedCurrent,
    "Approved release changed; refresh before proceeding",
  );
  ensure(
    typeof actor === "string" && actor.trim() && typeof reason === "string" && reason.trim(),
    "Actor and reason are required",
  );
  ensure(
    ["promote", "rollback"].includes(operation) &&
      /^[a-f\d]{64}$/.test(release?.candidateSha256 ?? "") &&
      /^[a-f\d]{40}$/.test(release.sourceSha ?? "") &&
      release.contractVersion === "4" &&
      release.status === "qualified",
    "Only a verified compatible qualified release can be selected",
  );
  ensure(release.candidateSha256 !== state.current?.candidateSha256, "Release is already approved");
  if (operation === "rollback")
    ensure(
      release.candidateSha256 === state.previous?.candidateSha256,
      "Rollback must select the retained previous approved release",
    );
  return {
    ...state,
    previous: state.current,
    current: release,
    history: [
      ...state.history,
      {
        operation,
        at: now,
        actor,
        reason,
        from: state.current?.candidateSha256 ?? null,
        to: release.candidateSha256,
      },
    ],
  };
}

const gh = (...args) => execFileSync("gh", args, { encoding: "utf8", maxBuffer: 20 * 1024 * 1024 });
const api = (path, body) =>
  JSON.parse(
    execFileSync("gh", ["api", path, ...(body ? ["--method", "POST", "--input", "-"] : [])], {
      encoding: "utf8",
      input: body ? JSON.stringify(body) : undefined,
      maxBuffer: 20 * 1024 * 1024,
    }),
  );
export function repository() {
  const repo = JSON.parse(gh("repo", "view", "--json", "nameWithOwner,isPrivate"));
  ensure(
    repo.isPrivate === true && /^[\w.-]+\/[\w.-]+$/.test(repo.nameWithOwner),
    "Release state requires this private repository",
  );
  return repo.nameWithOwner;
}
export function readState(repo = repository()) {
  const refs = api(`repos/${repo}/git/matching-refs/heads/release-state`);
  if (!refs.some((r) => r.ref === "refs/heads/release-state"))
    return { repo, state: emptyState(), sha: null };
  const file = api(`repos/${repo}/contents/state.json?ref=release-state`);
  const state = JSON.parse(Buffer.from(file.content, "base64"));
  ensure(
    state.version === 1 && Array.isArray(state.history) && Array.isArray(state.exposures),
    "Invalid authoritative release state",
  );
  return { repo, state, sha: file.sha };
}
export function saveState(snapshot, state, message) {
  const content = JSON.stringify(state, null, 2) + "\n";
  if (!snapshot.sha) {
    const tree = api(`repos/${snapshot.repo}/git/trees`, {
      tree: [{ path: "state.json", mode: "100644", type: "blob", content }],
    });
    const commit = api(`repos/${snapshot.repo}/git/commits`, {
      message,
      tree: tree.sha,
      parents: [],
    });
    api(`repos/${snapshot.repo}/git/refs`, { ref: "refs/heads/release-state", sha: commit.sha });
  } else {
    JSON.parse(
      execFileSync(
        "gh",
        ["api", `repos/${snapshot.repo}/contents/state.json`, "--method", "PUT", "--input", "-"],
        {
          encoding: "utf8",
          input: JSON.stringify({
            branch: "release-state",
            message,
            sha: snapshot.sha,
            content: Buffer.from(content).toString("base64"),
          }),
        },
      ),
    );
  }
}
export const actor = () => process.env.GITHUB_ACTOR || api("user").login;

if (import.meta.main) {
  try {
    const snapshot = readState();
    if (process.argv[2] === "init" && !snapshot.sha)
      saveState(snapshot, snapshot.state, "chore(release): initialize approved release state");
    else
      ensure(
        process.argv[2] === "status" || process.argv[2] === "init",
        "Use release-state.mjs init|status",
      );
    console.log(JSON.stringify(snapshot.state, null, 2));
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
