#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

mode=deterministic
comparison=false
qualification=false
phase=pilot
split=development
profile=luna,gemini,deepseek
pilot=
repetitions=1
seed=1
timeout=45000
case_id=
output=
suite=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; continue ;;
    --comparison) comparison=true; shift; continue ;;
    --qualification) qualification=true; shift; continue ;;
    --mode|--repetitions|--seed|--timeout-ms|--case|--output|--suite|--phase|--split|--profile|--pilot)
      if [ "$#" -lt 2 ]; then echo "Missing value for $1" >&2; exit 2; fi
      case "$1" in
        --mode) mode=$2 ;;
        --repetitions) repetitions=$2 ;;
        --seed) seed=$2 ;;
        --timeout-ms) timeout=$2 ;;
        --case) case_id=$2 ;;
        --output) output=$2 ;;
        --suite) suite=$2 ;;
        --phase) phase=$2 ;;
        --split) split=$2 ;;
        --profile) profile=$2 ;;
        --pilot) pilot=$2 ;;
      esac
      shift 2 ;;
    *) echo "Unknown evaluation option: $1" >&2; exit 2 ;;
  esac
done
if [ -n "${XPATHED_RELEASE_STATE:-}" ]; then
  if [ "$qualification" != true ] || [ -z "${XPATHED_RELEASE_OVERLAY:-}" ] || [ -z "${XPATHED_RELEASE_SERVICE:-}" ]; then echo "Artifact qualification requires its verified launcher" >&2; exit 2; fi
fi
if [ "$comparison" = true ] && [ "$qualification" = true ]; then echo "Choose comparison or qualification" >&2; exit 2; fi
if [ "$qualification" != true ] && { [ "$phase" != pilot ] || [ "$split" != development ] || [ "$profile" != luna,gemini,deepseek ] || [ -n "$pilot" ]; }; then echo "Qualification options require --qualification" >&2; exit 2; fi
if [ "$qualification" = true ]; then
  if [ -n "$suite" ]; then echo "Qualification uses its reviewed versioned suite" >&2; exit 2; fi
  suite=evaluation/qualification-cases.json
fi
if [ "$comparison" = true ] && [ -n "$suite" ]; then echo "Comparison uses its reviewed fixture subset" >&2; exit 2; fi
export XPATHED_COMPARISON_MODE=$mode
export XPATHED_EVALUATION_SUITE=
if [ -n "$suite" ]; then
  if [ "$mode" != deterministic ] && [ "$qualification" != true ]; then echo "Custom suites support deterministic evaluation only" >&2; exit 2; fi
  XPATHED_EVALUATION_SUITE=$(node --input-type=module -e '
    import { realpathSync, statSync } from "node:fs";
    import { relative, isAbsolute } from "node:path";
    const path = realpathSync(process.argv[1]);
    const rel = relative(realpathSync(process.cwd()), path);
    if (!rel || rel.startsWith("..") || isAbsolute(rel) || !statSync(path).isFile() || statSync(path).size > 10000000) throw new Error("Suite must be a JSON file under this checkout, at most 10 MB");
    process.stdout.write("/workspace/" + rel);
  ' "$suite")
fi
set -- --mode "$mode" --repetitions "$repetitions" --seed "$seed" --timeout-ms "$timeout" --output /artifacts
if [ -n "$case_id" ]; then set -- "$@" --case "$case_id"; fi
# Reuse the runner's validation before starting services or creating artifacts.
if [ "$qualification" = true ]; then
  set -- "$@" --phase "$phase" --split "$split" --profile "$profile"
  if [ -n "$pilot" ]; then
    pilot=$(node --input-type=module -e '
      import { realpathSync, statSync } from "node:fs";
      import { relative, isAbsolute } from "node:path";
      const path = realpathSync(process.argv[1]);
      const rel = relative(realpathSync(process.cwd()), path);
      if (!rel || rel.startsWith("..") || isAbsolute(rel) || !statSync(path).isDirectory()) throw new Error("Pilot must be an artifact directory under this checkout");
      process.stdout.write("/workspace/" + rel);
    ' "$pilot")
    set -- "$@" --pilot "$pilot"
  fi
  node --input-type=module -e 'import { parseQualificationOptions } from "./evaluation/qualify.mjs"; parseQualificationOptions(process.argv.slice(1));' -- "$@"
else
  node --input-type=module -e 'import { parseOptions } from "./evaluation/run.mjs"; parseOptions(process.argv.slice(1));' -- "$@"
fi

export COMPOSE_PROJECT_NAME=${XPATHED_EVALUATION_PROJECT:-xpathed-evaluation}
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

# The base Compose file parses unused database settings; no database service starts.
export POSTGRES_PASSWORD=evaluation-unused
evaluation_env=${XPATHED_ENV_FILE:-/dev/null}
if [ "$mode" = live ] && [ -z "${XPATHED_ENV_FILE:-}" ] && [ -f .env ]; then evaluation_env=.env; fi
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
  elif [ "$comparison" = true ]; then
    docker/compose.sh --env-file "$evaluation_env" -f docker/compose.evaluation.yaml -f docker/compose.comparison.yaml "$@"
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
    stagehand) if [ "$comparison" != true ]; then echo "Comparison service belongs to a different runner" >&2; exit 2; fi ;;
    resolver-luna|resolver-gemini|resolver-deepseek-concise|resolver-qwen) if [ "$qualification" != true ]; then echo "Qualification service belongs to a different runner" >&2; exit 2; fi ;;
    *) echo "Evaluation project contains a non-evaluation service: $service" >&2; exit 2 ;;
  esac
done
mkdir -p "$(dirname "$XPATHED_EVALUATION_OUTPUT")"
mkdir "$XPATHED_EVALUATION_OUTPUT"
if [ "$qualification" = true ] || [ "$comparison" = true ]; then
  mkdir -p .artifacts/datasets
fi
compose down
release_started=false
cleanup() {
  status=$?
  if [ "$release_started" = true ]; then
    node scripts/release-evaluate.mjs attest "$XPATHED_RELEASE_STATE" after >/dev/null || status=1
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
  compose up --no-build --pull never --wait browser "$XPATHED_RELEASE_SERVICE" evaluation-fixture
  XPATHED_RELEASE_ARTIFACT_JSON=$(node scripts/release-evaluate.mjs attest "$XPATHED_RELEASE_STATE" before)
  export XPATHED_RELEASE_ARTIFACT_JSON
  release_started=true
elif [ "$qualification" = true ]; then
  compose up --build --wait browser resolver resolver-luna resolver-gemini resolver-deepseek-concise resolver-qwen evaluation-fixture
elif [ "$comparison" = true ]; then
  compose up --build --wait browser resolver evaluation-fixture stagehand
else
  compose up --build --wait browser resolver evaluation-fixture
fi
if [ -n "${XPATHED_RELEASE_STATE:-}" ]; then
  compose exec -T evaluation-fixture node /checks/ready.mjs http://browser:8080/health "http://$XPATHED_RELEASE_SERVICE:8080/health" http://evaluation-fixture:8090/health
else
  compose exec -T evaluation-fixture node /checks/ready.mjs http://browser:8080/health http://resolver:8080/health http://evaluation-fixture:8090/health
fi
echo "Evaluation artifacts: $XPATHED_EVALUATION_OUTPUT"
if [ "$qualification" = true ]; then
  if [ -z "${XPATHED_RELEASE_STATE:-}" ]; then
    compose exec -T evaluation-fixture node /checks/ready.mjs http://resolver-luna:8080/health http://resolver-gemini:8080/health http://resolver-deepseek-concise:8080/health http://resolver-qwen:8080/health
  fi
  browser_binary_hash=$(compose exec -T browser sh -c 'sha256sum /ms-playwright/chromium-*/chrome-linux*/chrome' | awk '{print $1}')
  if [ -n "${XPATHED_RELEASE_STATE:-}" ]; then
    compose exec -T -e "XPATHED_BROWSER_BINARY_SHA256=$browser_binary_hash" -e "XPATHED_RELEASE_ARTIFACT_JSON=$XPATHED_RELEASE_ARTIFACT_JSON" evaluation-fixture node /evaluation/qualify.mjs "$@"
  else
    compose exec -T -e "XPATHED_BROWSER_BINARY_SHA256=$browser_binary_hash" evaluation-fixture node /evaluation/qualify.mjs "$@"
  fi
elif [ "$comparison" = true ]; then
  compose exec -T evaluation-fixture node /checks/ready.mjs http://stagehand:8092/health
  browser_binary_hash=$(compose exec -T browser sh -c 'sha256sum /ms-playwright/chromium-*/chrome-linux*/chrome' | awk '{print $1}')
  compose exec -T -e "XPATHED_BROWSER_BINARY_SHA256=$browser_binary_hash" evaluation-fixture node /evaluation/compare.mjs "$@"
else
  compose exec -T evaluation-fixture node /evaluation/run.mjs "$@"
fi
