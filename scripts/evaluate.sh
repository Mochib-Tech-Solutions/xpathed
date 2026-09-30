#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

mode=deterministic
repetitions=1
seed=1
timeout=45000
case_id=
output=
suite=
while [ "$#" -gt 0 ]; do
  case "$1" in
    --) shift; continue ;;
    --mode|--repetitions|--seed|--timeout-ms|--case|--output|--suite)
      if [ "$#" -lt 2 ]; then echo "Missing value for $1" >&2; exit 2; fi
      case "$1" in
        --mode) mode=$2 ;;
        --repetitions) repetitions=$2 ;;
        --seed) seed=$2 ;;
        --timeout-ms) timeout=$2 ;;
        --case) case_id=$2 ;;
        --output) output=$2 ;;
        --suite) suite=$2 ;;
      esac
      shift 2 ;;
    *) echo "Unknown evaluation option: $1" >&2; exit 2 ;;
  esac
done
export XPATHED_EVALUATION_SUITE=
if [ -n "$suite" ]; then
  if [ "$mode" != deterministic ]; then echo "Custom suites support deterministic evaluation only" >&2; exit 2; fi
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
node --input-type=module -e 'import { parseOptions } from "./evaluation/run.mjs"; parseOptions(process.argv.slice(1));' -- "$@"

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
compose() {
  if [ "$mode" = live ]; then
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
    *) echo "Evaluation project contains a non-evaluation service: $service" >&2; exit 2 ;;
  esac
done
mkdir -p "$(dirname "$XPATHED_EVALUATION_OUTPUT")"
mkdir "$XPATHED_EVALUATION_OUTPUT"
compose down
trap 'status=$?; compose down || true; rmdir "$evaluation_lock" || true; exit "$status"' EXIT
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
compose up --build --wait browser resolver evaluation-fixture
compose exec -T evaluation-fixture node /checks/ready.mjs http://browser:8080/health http://resolver:8080/health http://evaluation-fixture:8090/health
echo "Evaluation artifacts: $XPATHED_EVALUATION_OUTPUT"
compose exec -T evaluation-fixture node /evaluation/run.mjs "$@"
