#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

mode=deterministic
xpath=false
qualification=false
repetitions=1
seed=1
timeout=45000
case_id=
output=
suite=
concurrency=
monitoring=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; continue ;;
    --xpath) xpath=true; shift; continue ;;
    --qualification) qualification=true; shift; continue ;;
    --mode|--repetitions|--seed|--timeout-ms|--case|--output|--suite|--monitoring|--concurrency)
      if [ "$#" -lt 2 ]; then echo "Missing value for $1" >&2; exit 2; fi
      case "$1" in
        --concurrency) concurrency=$2 ;;
        --mode) mode=$2 ;;
        --repetitions) repetitions=$2 ;;
        --seed) seed=$2 ;;
        --timeout-ms) timeout=$2 ;;
        --case) case_id=$2 ;;
        --output) output=$2 ;;
        --suite) suite=$2 ;;
        --monitoring) monitoring=$2 ;;
      esac
      shift 2 ;;
    *) echo "Unknown evaluation option: $1" >&2; exit 2 ;;
  esac
done
if [ "$xpath" = true ]; then
  if [ "$mode" != deterministic ] || [ "$qualification" = true ]; then
    echo "XPath construction and verification uses controlled provider-free selections without qualification mode" >&2; exit 2
  fi
fi
if [ -n "$monitoring" ] && [ "$qualification" != true ]; then echo "Monitoring requires the comparison runner" >&2; exit 2; fi
if [ -n "${XPATHED_RELEASE_STATE:-}" ]; then
  if [ "$qualification" != true ] || [ -z "${XPATHED_RELEASE_OVERLAY:-}" ] || [ -z "${XPATHED_RELEASE_SERVICE:-}" ]; then echo "Artifact qualification requires its verified launcher" >&2; exit 2; fi
fi
if [ "$qualification" = true ]; then
  case "$suite" in ''|evaluation/cases/index.json) ;; *) echo "Release qualification uses the complete browser collection" >&2; exit 2 ;; esac
  suite=${suite:-evaluation/cases/index.json}
fi
export XPATHED_EVALUATION_SUITE=
if [ -n "$suite" ]; then
  if [ "$mode" != deterministic ] && [ "$qualification" != true ]; then echo "Custom suites support controlled provider-free evaluation only (--mode deterministic)" >&2; exit 2; fi
  XPATHED_EVALUATION_SUITE=$(node --input-type=module -e '
    import { realpathSync, statSync } from "node:fs";
    import { relative, isAbsolute } from "node:path";
    const path = realpathSync(process.argv[1]);
    const rel = relative(realpathSync(process.cwd()), path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !statSync(path).isFile() || statSync(path).size > 10000000) throw new Error("Suite must be a JSON file under this checkout, at most 10 MB");
    process.stdout.write("/workspace/" + rel);
  ' "$suite")
fi
if [ -n "$concurrency" ] && { [ "$qualification" = true ]; }; then echo "Concurrency is supported only by the direct Live-browser Resolver or XPath construction and verification runner" >&2; exit 2; fi
set -- --mode "$mode" --repetitions "$repetitions" --seed "$seed" --timeout-ms "$timeout" --output /artifacts
if [ -n "$case_id" ]; then set -- "$@" --case "$case_id"; fi
if [ -n "$concurrency" ]; then set -- "$@" --concurrency "$concurrency"; fi
# Reuse the runner's validation before starting services or creating artifacts.
if [ "$qualification" = true ]; then
  if [ -n "$monitoring" ]; then set -- "$@" --monitoring "$monitoring"; fi
  node --input-type=module -e 'import { parseQualificationOptions } from "./evaluation/compare.mjs"; parseQualificationOptions(process.argv.slice(1));' -- "$@"

else
  node --input-type=module -e 'import { parseOptions } from "./evaluation/run.mjs"; parseOptions(process.argv.slice(1));' -- "$@"
fi

evaluation_default_project=xpathed-evaluation
if [ "$xpath" = true ]; then evaluation_default_project=xpathed-evaluation-xpath; fi
export COMPOSE_PROJECT_NAME=${XPATHED_EVALUATION_PROJECT:-$evaluation_default_project}
case "$COMPOSE_PROJECT_NAME" in ''|*[!a-z0-9_-]*) echo "Invalid evaluation project name" >&2; exit 2 ;; esac
case "$COMPOSE_PROJECT_NAME" in
  xpathed-evaluation|xpathed-evaluation-?*) ;;
  *) echo "Evaluation project must be xpathed-evaluation or start with xpathed-evaluation-" >&2; exit 2 ;;
esac
evaluation_lock="${TMPDIR:-/tmp}/$COMPOSE_PROJECT_NAME.lock"
if ! mkdir "$evaluation_lock" 2>/dev/null; then
  echo "An evaluation already owns $COMPOSE_PROJECT_NAME; choose XPATHED_EVALUATION_PROJECT for a parallel run" >&2
  exit 2
fi
trap 'rmdir "$evaluation_lock"' EXIT

evaluation_env=${XPATHED_ENV_FILE:-/dev/null}
if [ "$mode" = live ] && [ -z "${XPATHED_ENV_FILE:-}" ] && [ -f .env ]; then evaluation_env=.env; fi
if [ "$mode" = live ]; then
  OPENROUTER_EVAL_API_KEY=$(node --input-type=module -e '
    import { readEvaluationKey } from "./evaluation/provider.mjs";
    const key = await readEvaluationKey();
    if (!key) throw new Error("Set OPENROUTER_EVAL_API_KEY for live evaluation");
    process.stdout.write(key);
  ')
else
  OPENROUTER_EVAL_API_KEY=
fi
export OPENROUTER_EVAL_API_KEY
export XPATHED_CODE_REVISION=$(git rev-parse HEAD)
export XPATHED_TREE_HASH=$(node --input-type=module <<'NODE'
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readlinkSync } from "node:fs";
const paths = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], { encoding: "utf8" }).split("\0").filter(Boolean).sort();
const hash = createHash("sha256");
for (const path of new Set(paths)) {
  hash.update(path + "\0");
  try { hash.update(lstatSync(path).isSymbolicLink() ? readlinkSync(path) : readFileSync(path)); }
  catch (error) { if (error.code !== "ENOENT") throw error; hash.update("[deleted]"); }
  hash.update("\0");
}
process.stdout.write(hash.digest("hex"));
NODE
)
if [ -z "$output" ]; then output=".artifacts/evaluation/$(node -p 'crypto.randomUUID()')"; fi
export XPATHED_EVALUATION_OUTPUT=$(node -e 'process.stdout.write(require("node:path").resolve(process.argv[1]))' "$output")
export XPATHED_EVALUATION_UID=$(id -u)
export XPATHED_EVALUATION_GID=$(id -g)
compose() {
  if [ -n "${XPATHED_RELEASE_STATE:-}" ]; then
    docker/compose.sh --env-file "$evaluation_env" -f docker/compose.evaluation.yaml -f docker/compose.qualification.yaml -f "$XPATHED_RELEASE_OVERLAY" "$@"
  elif [ "$qualification" = true ]; then
    docker/compose.sh --env-file "$evaluation_env" -f docker/compose.evaluation.yaml -f docker/compose.qualification.yaml "$@"
  elif [ "$mode" = live ]; then
    docker/compose.sh --env-file "$evaluation_env" -f docker/compose.evaluation.yaml -f docker/compose.evaluation-live.yaml "$@"
  else
    docker/compose.sh --env-file "$evaluation_env" -f docker/compose.evaluation.yaml "$@"
  fi
}
compose config --quiet
project_dir=$(pwd -P)
for container in $(docker ps -aq --filter "label=com.docker.compose.project=$COMPOSE_PROJECT_NAME"); do
  owner=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.project.working_dir" }}' "$container")
  if [ "$owner" != "$project_dir" ]; then echo "Evaluation project belongs to another checkout" >&2; exit 2; fi
  service=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }}' "$container")
  case "$service" in
    browser|resolver|evaluation-fixture) ;;
    browser-baseline|resolver-baseline) if [ -z "${XPATHED_RELEASE_COMPARISON_JSON:-}" ]; then echo "Unexpected baseline service" >&2; exit 2; fi ;;
    *) echo "Evaluation project contains a non-evaluation service: $service" >&2; exit 2 ;;
  esac
done
mkdir -p "$(dirname "$XPATHED_EVALUATION_OUTPUT")"
mkdir "$XPATHED_EVALUATION_OUTPUT"
if [ "$qualification" = true ]; then
  mkdir -p .artifacts/accounting
fi
compose down
release_started=false
cleanup() {
  status=$?
  if [ "$release_started" = true ]; then
    node scripts/release/evaluate.mjs attest "$XPATHED_RELEASE_STATE" after >/dev/null || status=1
  fi
  compose down || status=1
  rmdir "$evaluation_lock" || status=1
  exit "$status"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
mount_marker=$(node -p 'crypto.randomUUID()')
printf '%s' "$mount_marker" > "$XPATHED_EVALUATION_OUTPUT/.mount-check"
if ! compose run --rm --no-deps --entrypoint node evaluation-fixture -e '
  const fs = require("node:fs"), marker = process.argv[1], path = "/artifacts/.mount-check";
  try {
    if (fs.readFileSync(path, "utf8") !== marker) process.exit(1);
    fs.writeFileSync(path, marker + "-ok");
  } catch { process.exit(1); }
' "$mount_marker" || [ "$(cat "$XPATHED_EVALUATION_OUTPUT/.mount-check")" != "$mount_marker-ok" ]; then
  echo "Evaluation output is not shared read/write with Docker. Choose a directory under this checkout or configure Docker file sharing." >&2
  exit 2
fi
rm "$XPATHED_EVALUATION_OUTPUT/.mount-check"
if [ -n "${XPATHED_RELEASE_STATE:-}" ]; then
  if [ -n "${XPATHED_RELEASE_COMPARISON_JSON:-}" ]; then
    compose up --no-build --pull never --wait browser "$XPATHED_RELEASE_SERVICE" browser-baseline resolver-baseline evaluation-fixture
  else
    compose up --no-build --pull never --wait browser "$XPATHED_RELEASE_SERVICE" evaluation-fixture
  fi
  XPATHED_RELEASE_ARTIFACT_JSON=$(node scripts/release/evaluate.mjs attest "$XPATHED_RELEASE_STATE" before)
  export XPATHED_RELEASE_ARTIFACT_JSON
  release_started=true

else
  if [ "$xpath" = true ]; then
    compose up --build --no-deps --wait browser evaluation-fixture
  else
    compose up --build --wait browser resolver evaluation-fixture
  fi
fi
if [ "$xpath" = true ]; then
  compose exec -T evaluation-fixture node /checks/ready.mjs http://browser:8080/health http://evaluation-fixture:8090/health
elif [ -n "${XPATHED_RELEASE_STATE:-}" ]; then
  compose exec -T evaluation-fixture node /checks/ready.mjs http://browser:8080/health "http://$XPATHED_RELEASE_SERVICE:8080/health" http://evaluation-fixture:8090/health
else
  compose exec -T evaluation-fixture node /checks/ready.mjs http://browser:8080/health http://resolver:8080/health http://evaluation-fixture:8090/health
fi
if [ -n "${XPATHED_RELEASE_COMPARISON_JSON:-}" ]; then
  compose exec -T evaluation-fixture node /checks/ready.mjs http://browser-baseline:8080/health http://resolver-baseline:8080/health
fi
echo "Evaluation artifacts: $XPATHED_EVALUATION_OUTPUT"
if [ "$xpath" = true ]; then
  compose exec -T evaluation-fixture node /evaluation/xpath.mjs "$@"
elif [ "$qualification" = true ]; then
  browser_binary_hash=$(compose exec -T browser sh -c 'sha256sum /ms-playwright/chromium-*/chrome-linux*/chrome' | awk '{print $1}')
  if [ -n "${XPATHED_RELEASE_STATE:-}" ]; then
    compose exec -T -e "XPATHED_BROWSER_BINARY_SHA256=$browser_binary_hash" -e "XPATHED_RELEASE_ARTIFACT_JSON=$XPATHED_RELEASE_ARTIFACT_JSON" -e "XPATHED_INITIAL_BASELINE=${XPATHED_INITIAL_BASELINE:-}" -e "XPATHED_RELEASE_COMPARISON_JSON=${XPATHED_RELEASE_COMPARISON_JSON:-}" evaluation-fixture node /evaluation/compare.mjs "$@"
  else
    compose exec -T -e "XPATHED_BROWSER_BINARY_SHA256=$browser_binary_hash" evaluation-fixture node /evaluation/compare.mjs "$@"
  fi

else
  compose exec -T evaluation-fixture node /evaluation/run.mjs "$@"
fi
