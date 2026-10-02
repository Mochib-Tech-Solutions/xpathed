import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  cpSync,
  rmSync,
  realpathSync,
  existsSync,
  readdirSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

function workspace(t) {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "xpathed-artifact-run-")));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const cwd = join(directory, "source");
  mkdirSync(cwd);
  for (const path of ["evaluation", "docker", "tests/resolution"])
    cpSync(path, join(cwd, path), { recursive: true });
  mkdirSync(join(cwd, "scripts"));
  for (const file of ["release-bundle.mjs", "release-evaluate.mjs", "evaluate.sh"])
    cpSync(`scripts/${file}`, join(cwd, "scripts", file));
  writeFileSync(join(cwd, ".gitignore"), ".artifacts/\n");
  const git = (...args) => {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    assert.equal(r.status, 0, r.stderr);
    return r.stdout.trim();
  };
  git("init", "--quiet");
  git("add", ".");
  git(
    "-c",
    "user.name=Fixture",
    "-c",
    "user.email=fixture@example.invalid",
    "commit",
    "--quiet",
    "-m",
    "Fixture",
  );
  const sha = git("rev-parse", "HEAD");
  const bin = join(directory, "bin");
  mkdirSync(bin);
  const log = join(directory, "calls.jsonl");
  const env = {
    ...process.env,
    PATH: `${bin}:${process.env.PATH}`,
    TMPDIR: directory,
    TEST_LOG: log,
    TEST_ROOT: cwd,
    TEST_SHA: sha,
    TEST_STATE: join(directory, "state"),
    DOCKER_HOST: "",
    DOCKER_CONTEXT: "",
    XPATHED_CODE_REVISION: "",
    XPATHED_TREE_HASH: "",
    XPATHED_WORKSPACE: "",
  };
  writeFileSync(
    join(bin, "docker"),
    `#!/usr/bin/env node
const fs=require('node:fs'); const args=process.argv.slice(2); if(args[0]==='--host') args.splice(0,2);
fs.appendFileSync(process.env.TEST_LOG,JSON.stringify(args)+'\\n');
const ids={browser:'sha256:'+'a'.repeat(64),resolver:'sha256:'+'b'.repeat(64)};
if(args[0]==='context') console.log(args[1]==='show'?'fixture':JSON.stringify([{Endpoints:{docker:{Host:'unix:///fixture.sock'}}}]));
else if(args[0]==='info') console.log(JSON.stringify({OSType:'linux',Architecture:'amd64'}));
else if(args[0]==='build'){fs.readFileSync(0); const name=args[args.indexOf('--file')+1].includes('browser')?'browser':'resolver';fs.writeFileSync(args[args.indexOf('--iidfile')+1],ids[name]);}
else if(args[0]==='image'&&args[1]==='inspect'){const id=args.at(-1);console.log(JSON.stringify([{Id:id,Os:'linux',Architecture:'amd64',Config:{Labels:{'org.opencontainers.image.revision':process.env.TEST_SHA,'tn.chiboub.xpathed.component':id===ids.browser?'browser':'resolver'}}}]));}
else if(args[0]==='image'&&args[1]==='save')fs.writeFileSync(args[args.indexOf('--output')+1],'images');
else if(args[0]==='image'&&args[1]==='load'){}
else if(args[0]==='ps') { if(fs.existsSync(process.env.TEST_STATE)){const filter=args.find(a=>a.includes('compose.service=')); const replacement=process.env.TEST_FAIL==='replacement'&&fs.existsSync(process.env.TEST_STATE+'.executed'); if(filter)console.log(filter.endsWith('=browser-baseline')?'4'.repeat(64):filter.endsWith('=resolver-baseline')?'5'.repeat(64):filter.endsWith('=browser')?'1'.repeat(64):(replacement?'3':'2').repeat(64));} }
else if(args[0]==='inspect'){const id=args.at(-1); const reference=['4','5'].some(n=>id===n.repeat(64));const component=['1','4'].some(n=>id===n.repeat(64))?'browser':'resolver';const after=fs.existsSync(process.env.TEST_STATE+'.executed');console.log(JSON.stringify([{Id:id,Image:process.env.TEST_FAIL===(after?'after':'before')?'sha256:'+'f'.repeat(64):ids[component],State:{Running:true},Config:{Labels:{'com.docker.compose.project':process.env.COMPOSE_PROJECT_NAME,'com.docker.compose.service':reference?component+'-baseline':component==='browser'?'browser':'resolver-qwen','com.docker.compose.project.working_dir':process.env.TEST_ROOT}}}]));}
else if(args[0]==='compose'){
 const operation=args.find(a=>['config','down','run','up','exec'].includes(a));
 if(operation==='config'){}
 else if(operation==='down'){try{fs.unlinkSync(process.env.TEST_STATE);}catch{}if(process.env.TEST_FAIL==='cleanup'&&fs.existsSync(process.env.TEST_STATE+'.executed'))process.exit(9);}
 else if(operation==='run'){fs.accessSync('.artifacts/datasets',fs.constants.W_OK);const path=process.env.XPATHED_EVALUATION_OUTPUT+'/.mount-check';fs.writeFileSync(path,fs.readFileSync(path,'utf8')+'-ok');}
 else if(operation==='up'){if(args.includes('--build')||!args.includes('--no-build'))process.exit(91);const overlay=args.filter((a,i)=>args[i-1]==='-f').at(-1);const text=fs.readFileSync(overlay,'utf8');if(!text.includes(ids.browser)||!text.includes(ids.resolver)||!text.includes('!reset null'))process.exit(92);fs.writeFileSync(process.env.TEST_STATE,'running');}
 else if(operation==='exec') {if(args.includes('/evaluation/qualify.mjs')){fs.writeFileSync(process.env.TEST_STATE+'.executed','yes');if(process.env.TEST_FAIL==='runner')process.exit(8);}else if(args.some(a=>a.includes('sha256sum')))console.log('c'.repeat(64));}
 else process.exit(93);
}else process.exit(94);
`,
    { mode: 0o700 },
  );
  const run = (...args) =>
    spawnSync(process.execPath, ["scripts/release-evaluate.mjs", ...args], {
      cwd,
      env,
      encoding: "utf8",
    });
  const bundle = join(directory, "bundle");
  const created = spawnSync(
    process.execPath,
    [
      "scripts/release-bundle.mjs",
      "create",
      "--profile",
      "qwen",
      "--source-sha",
      sha,
      "--output",
      bundle,
    ],
    { cwd, env, encoding: "utf8" },
  );
  assert.equal(created.status, 0, created.stderr);
  const digest = createHash("sha256")
    .update(readFileSync(join(bundle, "manifest.json")))
    .digest("hex");
  writeFileSync(log, "");
  const output = ".artifacts/qualification";
  const evaluate = (...extra) =>
    run(
      "--bundle",
      bundle,
      "--sha256",
      digest,
      "--profile",
      "qwen",
      "--mode",
      "deterministic",
      "--output",
      output,
      ...extra,
    );
  return { cwd, env, run, bundle, digest, output, evaluate, log, git };
}

test("qualification uses only the restored component IDs and attests them before and after inference", (t) => {
  const work = workspace(t);
  const result = work.evaluate();
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(join(work.cwd, work.output, "artifact-receipt.json")));
  assert.deepEqual(
    receipt.before.map((r) => r.imageId),
    ["sha256:" + "a".repeat(64), "sha256:" + "b".repeat(64)],
  );
  assert.deepEqual(receipt.after, receipt.before);
  assert.equal(receipt.artifact.bundleManifestSha256, work.digest);
  const calls = readFileSync(work.log, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(
    calls.every(
      (args) => !args.includes("build") && !args.includes("--build") && !args.includes("pull"),
    ),
  );
  const up = calls.find((args) => args.includes("up"));
  assert.deepEqual(up.slice(-3), ["browser", "resolver-qwen", "evaluation-fixture"]);
  assert.equal(up[up.indexOf("--pull") + 1], "never");
  assert.ok(calls.some((args) => args.includes("down")));
});

test("wrong digest, dirty source, source revision, profile and identity overrides fail before Docker", async (t) => {
  for (const failure of ["digest", "dirty", "source", "profile", "override"])
    await t.test(failure, (t) => {
      const work = workspace(t);
      if (failure === "dirty") writeFileSync(join(work.cwd, "untracked.txt"), "dirty");
      if (failure === "source")
        work.git(
          "-c",
          "user.name=Fixture",
          "-c",
          "user.email=fixture@example.invalid",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "Changed source",
        );
      if (failure === "override") work.env.XPATHED_CODE_REVISION = "f".repeat(40);
      const result = work.run(
        "--bundle",
        work.bundle,
        "--sha256",
        failure === "digest" ? "f".repeat(64) : work.digest,
        "--profile",
        failure === "profile" ? "luna" : "qwen",
        "--mode",
        "deterministic",
        "--output",
        work.output,
      );
      assert.notEqual(result.status, 0, result.stdout);
      assert.equal(readFileSync(work.log, "utf8"), "");
      assert.equal(existsSync(join(work.cwd, work.output)), false);
    });
});

test("container mismatch, runner failure and cleanup failure cannot report success", async (t) => {
  for (const failure of ["before", "after", "replacement", "runner", "cleanup"])
    await t.test(failure, (t) => {
      const work = workspace(t);
      work.env.TEST_FAIL = failure;
      const result = work.evaluate();
      assert.notEqual(result.status, 0, result.stdout);
      const calls = readFileSync(work.log, "utf8").trim().split("\n").map(JSON.parse);
      assert.ok(calls.some((args) => args.includes("down")));
      assert.deepEqual(readdirSync(join(work.cwd, ".artifacts/releases")), []);
      if (failure === "before")
        assert.ok(!calls.some((args) => args.includes("/evaluation/qualify.mjs")));
      if (["before", "after", "replacement"].includes(failure))
        assert.equal(existsSync(join(work.cwd, work.output, "artifact-receipt.json")), false);
    });
});

test("paired qualification restores and attests the baseline as separate containers", (t) => {
  const work = workspace(t);
  const result = work.evaluate(
    "--baseline-bundle",
    work.bundle,
    "--baseline-sha256",
    work.digest,
    "--baseline-approval",
    "none",
  );
  assert.equal(result.status, 0, result.stderr);
  const receipt = JSON.parse(readFileSync(join(work.cwd, work.output, "artifact-receipt.json")));
  assert.equal(receipt.comparison.artifact.bundleManifestSha256, work.digest);
  assert.deepEqual(receipt.baselineBefore, receipt.baselineAfter);
  assert.notEqual(receipt.baselineBefore[0].containerId, receipt.before[0].containerId);
  const calls = readFileSync(work.log, "utf8").trim().split("\n").map(JSON.parse);
  assert.ok(calls.find((args) => args.includes("up")).includes("browser-baseline"));
  const execute = calls.find((args) => args.includes("/evaluation/qualify.mjs"));
  assert.ok(execute.some((arg) => arg.startsWith("XPATHED_RELEASE_COMPARISON_JSON=")));
});
