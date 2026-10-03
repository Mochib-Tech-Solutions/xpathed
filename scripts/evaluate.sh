#!/bin/sh
set -eu
cd "$(dirname "$0")/.."

mode=deterministic
model=false
xpath=false
qualification=false
comparison=false
resume=false
basic_bundle=
basic_digest=
profile=deepseek
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
    --resume) resume=true; shift; continue ;;
    --comparison) comparison=true; shift; continue ;;
    --model) model=true; shift; continue ;;
    --xpath) xpath=true; shift; continue ;;
    --basic-bundle|--basic-sha256)
      if [ "$#" -lt 2 ]; then echo "Missing value for $1" >&2; exit 2; fi
      case "$1" in --basic-bundle) basic_bundle=$2 ;; --basic-sha256) basic_digest=$2 ;; esac
      shift 2 ;;
    --qualification) qualification=true; shift; continue ;;
    --mode|--repetitions|--seed|--timeout-ms|--case|--output|--suite|--profile|--monitoring|--concurrency)
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
        --profile) profile=$2 ;;
        --monitoring) monitoring=$2 ;;
      esac
      shift 2 ;;
    *) echo "Unknown evaluation option: $1" >&2; exit 2 ;;
  esac
done
if [ "$xpath" = true ]; then
  if [ "$mode" != deterministic ] || [ "$model" = true ] || [ "$qualification" = true ] || [ "$comparison" = true ]; then
    echo "XPath evaluation uses controlled selections without model, qualification or comparison modes" >&2; exit 2
  fi
fi
if [ "$model" = true ]; then
  if [ "$mode" != live ] || [ "$qualification" = true ] || [ "$comparison" = true ] || [ -n "$suite" ] || [ "$repetitions" != 1 ] || [ -n "$concurrency" ]; then
    echo "Model selection requires live mode, one attempt and the reviewed collection; no comparison, qualification or concurrency options" >&2; exit 2
  fi
  node --input-type=module -e 'import { selectModelCases } from "./evaluation/model.mjs"; selectModelCases(process.argv[1] || undefined);' "$case_id"
fi
if [ "$comparison" = true ]; then
  if [ "$qualification" = true ] || [ -n "$suite" ] || [ -n "$concurrency" ] || [ "$repetitions" != 1 ]; then echo "Comparison requires one attempt, no qualification or custom suite/concurrency" >&2; exit 2; fi
  if [ -z "$basic_bundle" ] || [ -z "$basic_digest" ]; then echo "Comparison requires --basic-bundle DIRECTORY --basic-sha256 DIGEST" >&2; exit 2; fi
elif [ -n "$basic_bundle" ] || [ -n "$basic_digest" ]; then
  echo "Basic bundle options require --comparison" >&2; exit 2
fi
if [ -n "$monitoring" ] && [ "$qualification" != true ]; then echo "Monitoring requires the comparison runner" >&2; exit 2; fi
if [ -n "${XPATHED_RELEASE_STATE:-}" ]; then
  if [ "$qualification" != true ] || [ -z "${XPATHED_RELEASE_OVERLAY:-}" ] || [ -z "${XPATHED_RELEASE_SERVICE:-}" ]; then echo "Artifact qualification requires its verified launcher" >&2; exit 2; fi
fi
if [ "$qualification" != true ] && [ "$profile" != deepseek ]; then echo "Model profile requires qualification mode" >&2; exit 2; fi
if [ "$qualification" = true ]; then
  case "$suite" in ''|evaluation/cases/index.json) ;; *) echo "Release qualification uses the complete reviewed collection" >&2; exit 2 ;; esac
  suite=${suite:-evaluation/cases/index.json}
fi
if [ "$resume" = true ] && { [ "$comparison" != true ] || [ -z "$output" ] || [ "$mode" != live ]; }; then echo "Resume requires live comparison and the original output directory" >&2; exit 2; fi
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
if [ -n "$concurrency" ] && { [ "$qualification" = true ]; }; then echo "Concurrency is supported only by the direct browser evaluation runner" >&2; exit 2; fi
set -- --mode "$mode" --repetitions "$repetitions" --seed "$seed" --timeout-ms "$timeout" --output /artifacts
if [ -n "$case_id" ]; then set -- "$@" --case "$case_id"; fi
if [ -n "$concurrency" ]; then set -- "$@" --concurrency "$concurrency"; fi
# Reuse the runner's validation before starting services or creating artifacts.
if [ "$qualification" = true ]; then
  set -- "$@" --profile "$profile"
  if [ -n "$monitoring" ]; then set -- "$@" --monitoring "$monitoring"; fi
  node --input-type=module -e 'import { parseQualificationOptions } from "./evaluation/compare.mjs"; parseQualificationOptions(process.argv.slice(1));' -- "$@"

else
  node --input-type=module -e 'import { parseOptions } from "./evaluation/run.mjs"; parseOptions(process.argv.slice(1));' -- "$@"
  if [ "$comparison" = true ]; then
    node --input-type=module -e 'import { selectCases } from "./evaluation/research/compare.mjs"; selectCases(process.argv[1] || undefined);' "$case_id"
  fi
fi

evaluation_default_project=xpathed-evaluation
if [ "$model" = true ]; then evaluation_default_project=xpathed-evaluation-model; fi
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
if [ "$comparison" = true ]; then
  XPATHED_BASIC_ARTIFACT=$(node --input-type=module -e '
    import { verify, restoreVerified, localDocker } from "./scripts/release/bundle.mjs";
    const verified = await verify(process.argv[1], process.argv[2]);
    await restoreVerified(verified, await localDocker());
    process.stdout.write(JSON.stringify({...verified.manifest, manifestSha256: process.argv[2]}));
  ' "$basic_bundle" "$basic_digest")
  export XPATHED_BASIC_BROWSER=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).images.find(i=>i.component==="browser").id)' "$XPATHED_BASIC_ARTIFACT")
  export XPATHED_BASIC_RESOLVER=$(node -e 'process.stdout.write(JSON.parse(process.argv[1]).images.find(i=>i.component==="resolver").id)' "$XPATHED_BASIC_ARTIFACT")
fi
if [ "$resume" = true ]; then
  node --input-type=module -e '
    import {readFileSync,writeFileSync} from "node:fs";
    const dir=process.argv[1], manifest=JSON.parse(readFileSync(dir+"/manifest.json","utf8"));
    const services=Object.fromEntries(["browser","resolver","stagehand"].map(name=>{
      const image=manifest.artifacts?.currentImages?.[name];
      if(!/^sha256:[a-f0-9]{64}$/.test(image ?? "")) throw new Error("Missing original comparison image");
      return [name,{image}];
    }));
    writeFileSync(dir+"/continuation-images.json",JSON.stringify({services}));
  ' "$XPATHED_EVALUATION_OUTPUT"
fi
compose() {
  if [ -n "${XPATHED_RELEASE_STATE:-}" ]; then
    docker/compose.sh --env-file "$evaluation_env" -f docker/compose.evaluation.yaml -f docker/compose.qualification.yaml -f "$XPATHED_RELEASE_OVERLAY" "$@"
  elif [ "$comparison" = true ] && [ "$resume" = true ]; then
    docker/compose.sh --env-file "$evaluation_env" -f docker/compose.evaluation.yaml -f docker/compose.comparison.yaml -f "$XPATHED_EVALUATION_OUTPUT/continuation-images.json" "$@"
  elif [ "$comparison" = true ]; then
    docker/compose.sh --env-file "$evaluation_env" -f docker/compose.evaluation.yaml -f docker/compose.comparison.yaml "$@"
  elif [ "$qualification" = true ]; then
    docker/compose.sh --env-file "$evaluation_env" -f docker/compose.evaluation.yaml -f docker/compose.qualification.yaml "$@"
  elif [ "$model" = true ]; then
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
    browser-basic|resolver-basic|stagehand) if [ "$comparison" != true ]; then echo "Unexpected comparison service" >&2; exit 2; fi ;;
    browser-baseline|resolver-baseline) if [ -z "${XPATHED_RELEASE_COMPARISON_JSON:-}" ]; then echo "Unexpected baseline service" >&2; exit 2; fi ;;
    *) echo "Evaluation project contains a non-evaluation service: $service" >&2; exit 2 ;;
  esac
done
mkdir -p "$(dirname "$XPATHED_EVALUATION_OUTPUT")"
if [ "$resume" = true ]; then
  test -f "$XPATHED_EVALUATION_OUTPUT/manifest.json"
else
  mkdir "$XPATHED_EVALUATION_OUTPUT"
fi
if [ "$qualification" = true ] || [ "$model" = true ]; then
  mkdir -p .artifacts/datasets
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
  if [ "$comparison" = true ] && [ "$resume" = true ]; then
    compose up --no-build --pull never --wait browser resolver browser-basic resolver-basic stagehand evaluation-fixture
  elif [ "$comparison" = true ]; then
    compose up --build --wait browser resolver browser-basic resolver-basic stagehand evaluation-fixture
  elif [ "$model" = true ]; then
    compose up --build --no-deps --wait resolver evaluation-fixture
  elif [ "$xpath" = true ]; then
    compose up --build --no-deps --wait browser evaluation-fixture
  else
    compose up --build --wait browser resolver evaluation-fixture
  fi
fi
if [ "$model" = true ]; then
  compose exec -T evaluation-fixture node /checks/ready.mjs http://resolver:8080/health http://evaluation-fixture:8090/health
elif [ "$xpath" = true ]; then
  compose exec -T evaluation-fixture node /checks/ready.mjs http://browser:8080/health http://evaluation-fixture:8090/health
elif [ -n "${XPATHED_RELEASE_STATE:-}" ]; then
  compose exec -T evaluation-fixture node /checks/ready.mjs http://browser:8080/health "http://$XPATHED_RELEASE_SERVICE:8080/health" http://evaluation-fixture:8090/health
else
  compose exec -T evaluation-fixture node /checks/ready.mjs http://browser:8080/health http://resolver:8080/health http://evaluation-fixture:8090/health
fi
if [ -n "${XPATHED_RELEASE_COMPARISON_JSON:-}" ]; then
  compose exec -T evaluation-fixture node /checks/ready.mjs http://browser-baseline:8080/health http://resolver-baseline:8080/health
fi
if [ "$comparison" = true ]; then
  compose exec -T evaluation-fixture node /checks/ready.mjs http://browser-basic:8080/health http://resolver-basic:8080/health http://stagehand:8092/health
  browser_binary_hash=$(compose exec -T browser sh -c 'sha256sum /ms-playwright/chromium-*/chrome-linux*/chrome' | awk '{print $1}')
  basic_binary_hash=$(compose exec -T browser-basic sh -c 'sha256sum /ms-playwright/chromium-*/chrome-linux*/chrome' | awk '{print $1}')
  if [ "$browser_binary_hash" != "$basic_binary_hash" ]; then echo "Browser parity mismatch: Chromium binary" >&2; exit 2; fi
  current_images=$(docker inspect --format '{{ index .Config.Labels "com.docker.compose.service" }} {{.Image}}' $(compose ps -q browser resolver stagehand))
  XPATHED_ENGINEERING_ARTIFACTS=$(node -e 'process.stdout.write(JSON.stringify({basic:JSON.parse(process.argv[1]),currentImages:Object.fromEntries(process.argv[2].trim().split("\n").map(row=>row.split(" ")))}))' "$XPATHED_BASIC_ARTIFACT" "$current_images")
  if [ "$resume" != true ]; then
    node --input-type=module -e '
      import {execFileSync} from "node:child_process";
      import {randomUUID} from "node:crypto";
      import {writeFileSync} from "node:fs";
      const id=randomUUID(), images=JSON.parse(process.argv[1]).currentImages;
      const tags=Object.fromEntries(Object.entries(images).map(([name,image])=>{
        const tag=`xpathed-engineering-${id}-${name}`;
        execFileSync("docker",["tag",image,tag]);
        return [name,{image,tag}];
      }));
      writeFileSync(process.argv[2]+"/image-tags.json",JSON.stringify(tags,null,2)+"\n",{flag:"wx",mode:0o600});
    ' "$XPATHED_ENGINEERING_ARTIFACTS" "$XPATHED_EVALUATION_OUTPUT"
  fi
  compose exec -T -e "XPATHED_COMPARISON_RESUME=$resume" -e "XPATHED_BROWSER_BINARY_SHA256=$browser_binary_hash" -e "XPATHED_ENGINEERING_ARTIFACTS=$XPATHED_ENGINEERING_ARTIFACTS" evaluation-fixture node /evaluation/research/compare.mjs "$@"
  exit $?
fi
echo "Evaluation artifacts: $XPATHED_EVALUATION_OUTPUT"
if [ "$model" = true ]; then
  node scripts/evaluate-model.mjs "$evaluation_env" "$@"
elif [ "$xpath" = true ]; then
  compose exec -T evaluation-fixture node /evaluation/xpath.mjs "$@"
elif [ "$qualification" = true ]; then
  browser_binary_hash=$(compose exec -T browser sh -c 'sha256sum /ms-playwright/chromium-*/chrome-linux*/chrome' | awk '{print $1}')
  if [ -n "${XPATHED_RELEASE_STATE:-}" ]; then
    compose exec -T -e "XPATHED_BROWSER_BINARY_SHA256=$browser_binary_hash" -e "XPATHED_RELEASE_ARTIFACT_JSON=$XPATHED_RELEASE_ARTIFACT_JSON" -e "XPATHED_RELEASE_COMPARISON_JSON=${XPATHED_RELEASE_COMPARISON_JSON:-}" evaluation-fixture node /evaluation/compare.mjs "$@"
  else
    compose exec -T -e "XPATHED_BROWSER_BINARY_SHA256=$browser_binary_hash" evaluation-fixture node /evaluation/compare.mjs "$@"
  fi

else
  compose exec -T evaluation-fixture node /evaluation/run.mjs "$@"
fi
