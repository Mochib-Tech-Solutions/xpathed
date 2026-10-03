# /// script
# dependencies = ["matplotlib==3.11.2"]
# ///
"""Export fresh browser and saved-page comparisons without inference or historical overwrites."""
import argparse
import hashlib
import json
import math
import re
import subprocess
from html import escape
from pathlib import Path
from tempfile import gettempdir

ROOT = Path(__file__).resolve().parent
ARMS = {"basic": "Basic resolver", "improved": "Improved resolver", "stagehand": "Stagehand"}


def read(path):
    return json.loads(path.read_text())


def file_hash(path):
    return hashlib.sha256(path.read_bytes()).hexdigest()


def load(directory, browser):
    manifest, summary = read(directory / "manifest.json"), read(directory / "summary.json")
    assert manifest["mode"] == summary["mode"] == "live", "Live provider inference required"
    assert manifest["plan"]["retries"] == 0, "Retries are outside this comparison"
    # Use JavaScript's original serialization for the recorded content hash.
    subprocess.run(["node", "--input-type=module", "-e", """
      import assert from 'node:assert/strict';
      import {readFileSync,readdirSync} from 'node:fs';
      import {dirname,join} from 'node:path';
      import {createHash} from 'node:crypto';
      import {gradeTrial} from './evaluation/grader.mjs';
      import {gradeComparison} from './evaluation/research/grade.mjs';
      import {assertProviderIntegrity} from './evaluation/research/compare.mjs';
      const hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
      const {contentHash,...body}=JSON.parse(readFileSync(process.argv[1]));
      assert.equal(hash(body),contentHash);
      for(const spec of body.cases.filter(x=>x.track==='offline-selection')) {
        assert.equal(hash(spec.input),spec.labelReview.inputHash);
        assert.equal(hash(spec.expected),spec.labelReview.labelHash);
      }
      const browser=body.track!=='offline-selection';
      const graders=['evaluation/grader.mjs',...(browser?['evaluation/research/grade.mjs']:[])];
      for(const path of graders) assert.equal(createHash('sha256').update(readFileSync(path)).digest('hex'),body.code.files[path],'Grader source changed: '+path);
      const cases=new Map(body.cases.map(x=>[x.id,x]));
      const folder=join(dirname(process.argv[1]),'trials');
      for(const file of readdirSync(folder).filter(x=>x.endsWith('.json'))) {
        const trial=JSON.parse(readFileSync(join(folder,file)));
        const spec=cases.get(trial.caseId);
        assert.ok(spec,'Unknown trial case');
        assertProviderIntegrity(trial);
        if(!browser && trial.evidence?.modelInput) assert.equal(hash(JSON.parse(trial.evidence.modelInput)),spec.labelReview.preparedInputHash);
        assert.deepEqual(trial.grade,browser?gradeComparison(spec,trial):gradeTrial(spec,trial),'Recorded grade differs from replay: '+trial.id);
        if(browser && trial.arm!=='stagehand') assert.deepEqual(trial.contractGrade,gradeTrial(spec,trial),'Recorded full contract grade differs from replay: '+trial.id);
      }
    """, str(directory / "manifest.json")], cwd=ROOT.parents[2], check=True, capture_output=True)
    specs = {spec["id"]: spec for spec in manifest["cases"]}
    assert len(specs) == len(manifest["cases"]) > 0, "Duplicate or empty cases"
    planned = manifest["plan"]["trials"]
    assert len(planned) == len(specs) and {p["caseId"] for p in planned} == set(specs)
    expected = {}
    for item in planned:
        assert item["attempt"] == item["repetition"] == 1
        for arm in ARMS if browser else [None]:
            base = item.get("id", f"{item['caseId']}:{item['repetition']}")
            identity = hashlib.sha256(f"{base}-{arm}".encode()).hexdigest()[:32] if browser else item["id"]
            assert identity not in expected
            expected[identity] = (item["caseId"], arm)
    compatibility = read(directory / "compatibility.json") if browser else []
    compatibility_by_id = {row["id"]: row for row in compatibility}
    if browser:
        assert len(compatibility_by_id) == len(compatibility) == 6, "Expected the two three-arm compatibility gates"
        assert len({row["caseId"] for row in compatibility}) == 2
        for case_id in {row["caseId"] for row in compatibility}:
            assert {row["arm"] for row in compatibility if row["caseId"] == case_id} == set(ARMS)
        assert all(row["grade"]["passed"] is True for row in compatibility)
    assert not set(expected).intersection(compatibility_by_id)
    files = list((directory / "trials").iterdir())
    assert {p.name for p in files} == {f"{identity}.json" for identity in {*expected, *compatibility_by_id}}, "Missing or extra trials"
    trials = []
    provider_ids = set()
    for path in sorted(files):
        trial = read(path)
        assert path.name == f"{trial['id']}.json"
        if trial["id"] in compatibility_by_id:
            gate = compatibility_by_id[trial["id"]]
            assert trial["mode"] == "deterministic" and trial["attempt"] == trial["repetition"] == 1
            assert {key: trial[key] for key in ["id", "caseId", "arm", "grade"]} == gate
            assert not trial.get("provider") and not trial.get("evidence", {}).get("provider")
            continue
        assert (trial["caseId"], trial.get("arm")) == expected[trial["id"]]
        assert trial["mode"] == "live" and trial["attempt"] == trial["repetition"] == 1
        assert type(trial["grade"]["passed"]) is bool
        assert trial.get("error", {}).get("code") != "unreviewed_prepared_input", "Review integrity violation"
        if browser and trial["arm"] != "stagehand":
            assert type(trial["contractGrade"]["passed"]) is bool
        calls = trial.get("evidence", {}).get("provider", [])
        if trial.get("error", {}).get("code") == "invalid_provider_evidence":
            # A retired private guard mislabeled non-2xx HTTP failures. The stock
            # integrity guard above must still pass, and the error stays a failure.
            assert trial["grade"]["passed"] is False and calls
            assert all(call.get("forwarded") is True and isinstance(call.get("status"), int)
                       and 400 <= call["status"] <= 599 and isinstance(call.get("response"), dict)
                       and call["response"].get("error", {}).get("code") == call["status"]
                       for call in calls), "Unexplained provider integrity failure"
        assert [{key: value for key, value in call.items() if key not in {"request", "response"}} for call in calls] == trial.get("provider", []), "Provider metadata differs from retained evidence"
        for call in calls:
            assert call["id"] not in provider_ids and call["attemptId"] == trial["id"]
            provider_ids.add(call["id"])
            assert read(directory / "provider" / f"{call['id']}.json") == call
            assert call.get("responseCacheHit") is not True
        trial["_fileHash"] = file_hash(path)
        trials.append(trial)
    assert {p.name for p in (directory / "provider").glob("*.json")} == {f"{identity}.json" for identity in provider_ids}, "Unbound provider evidence"
    if browser:
        assert summary["complete"] is True
        assert summary["planned"] == summary["completed"] == len(trials)
    else:
        assert manifest["kind"] == "model-selection" and manifest["track"] == "offline-selection"
        assert summary["plannedTrials"] == summary["completedTrials"] == len(trials)
        assert summary["missingTrials"] == 0 and summary["diagnosticReruns"]["trials"] == 0
        assert len(specs) + len(manifest["exclusions"]) == manifest["sourceCases"]
        assert len({x["caseId"] for x in manifest["exclusions"]}) == len(manifest["exclusions"])
        assert not set(specs).intersection(x["caseId"] for x in manifest["exclusions"])
        for spec in specs.values():
            assert spec["labelReview"]["disposition"] == "validated"
    return manifest, summary, specs, trials


def totals(rows):
    calls = [c for row in rows for c in row.get("evidence", {}).get("provider", []) if c.get("forwarded")]
    amounts = [c["reportedUsd"] for c in calls if c.get("reportedUsd") is not None]
    assert all(isinstance(x, (int, float)) and math.isfinite(x) and x >= 0 for x in amounts)
    cohorts = {}
    for name in sorted({row.get("_reportingCohort", row.get("execution", {}).get("cohort", "serial")) for row in rows}):
        group = [row for row in rows if row.get("_reportingCohort", row.get("execution", {}).get("cohort", "serial")) == name]
        times = sorted(row["elapsedMs"] for row in group if isinstance(row.get("elapsedMs"), (float, int)) and math.isfinite(row["elapsedMs"]) and row["elapsedMs"] >= 0)
        cohorts[name] = {"attempts": len(group), "measured": len(times), "unavailable": len(group) - len(times),
                         "medianMs": times[math.ceil(len(times) * .5) - 1] if times else None,
                         "p95Ms": times[math.ceil(len(times) * .95) - 1] if times else None}
    settings = {json.dumps({k: call.get("request", {}).get(k) for k in ["model", "provider", "reasoning", "max_tokens"]}, sort_keys=True) for call in calls}
    return {"settings": [json.loads(value) for value in sorted(settings)],
            "total": len(rows), "passed": sum(row["grade"]["passed"] for row in rows),
            "providerCalls": len(calls), "knownReportedUsd": sum(amounts),
            "unknownCharges": len(calls) - len(amounts), "latencyCohorts": cohorts}


def paired(rows, before, after, field):
    left = {r["caseId"]: r[field] for r in rows if r["arm"] == before}
    right = {r["caseId"]: r[field] for r in rows if r["arm"] == after}
    assert left.keys() == right.keys()
    return {"gains": sorted(k for k in left if left[k] is False and right[k] is True),
            "regressions": sorted(k for k in left if left[k] is True and right[k] is False)}


def public_trial(trial, arm, browser, spec):
    selected = None
    if browser and spec["expected"]["outcome"] != "unsupported":
        grade = trial["grade"]
        selected = bool(grade["metrics"]["targetSetsComplete"] and not grade["metrics"]["operationalError"]
                        and not grade["metrics"]["unsupported"] and not any(f["category"] in
                        {"contract", "passive_state", "privacy", "fresh_inference", "oracle"} for f in grade["failures"]))
    return {"id": trial["id"], "caseId": trial["caseId"], "arm": arm,
            "passed": trial["grade"]["passed"],
            "fullContractPassed": trial["contractGrade"]["passed"] if browser and arm != "stagehand" else None,
            "targetSelectionPassed": selected,
            "failureCategories": sorted({f["category"] for f in trial["grade"]["failures"]}),
            "fullContractFailureCategories": sorted({f["category"] for f in trial.get("contractGrade", {}).get("failures", [])}),
            "trialSha256": trial["_fileHash"]}


def provenance(directory, manifest):
    compatibility = directory / "compatibility.json"
    gates = ({"compatibilitySha256": file_hash(compatibility),
              "compatibilityTrials": [{"id": row["id"], "caseId": row["caseId"], "arm": row["arm"],
                                        "trialSha256": file_hash(directory / "trials" / f"{row['id']}.json")}
                                       for row in read(compatibility)]} if compatibility.exists() else {})
    return {**gates,"runId": manifest["id"], "createdAt": manifest["createdAt"],
            "manifestSha256": file_hash(directory / "manifest.json"),
            "summarySha256": file_hash(directory / "summary.json"),
            "source": manifest["code"]["revision"], "sourceFiles": manifest["code"]["files"],
            "resolverImage": manifest.get("resolverImage"), "artifacts": manifest.get("artifacts"),
            "stagehand": manifest.get("stagehand")}


def basic_provenance(directory, manifest):
    receipt_path = directory / "basic-runtime-receipt.json"
    lineage_path = directory / "basic-bundle-lineage.json"
    receipt, lineage = read(receipt_path), read(lineage_path)
    basic = manifest["artifacts"]["basic"]
    assert receipt["archivedSource"] == lineage["source"] == basic["sourceSha"]
    assert lineage["projectedManifestSha256"] == basic["manifestSha256"]
    files = ["configuration.json", "images.tar", "source.tar"]
    assert {key: lineage["unchangedFiles"][key] for key in files} == {key: basic["files"][key] for key in files}
    containers = {row["service"]: row for row in receipt["containers"]}
    assert len(containers) == len(receipt["containers"])
    images = {row["component"]: row["id"] for row in basic["images"]}
    assert containers["browser-basic"]["imageId"] == images["browser"]
    assert containers["resolver-basic-native"]["imageId"] == images["resolver"]
    assert containers["resolver"]["imageId"] == manifest["artifacts"]["currentImages"]["resolver"]
    adapter_files = {key: receipt["adapterFiles"][key] for key in ["basic-envelope.mjs", "basic-compose.yaml", "run-browser.sh"]}
    assert all(re.fullmatch(r"[a-f0-9]{64}", value) for value in adapter_files.values())
    assert re.fullmatch(r"[a-f0-9]{64}", lineage["originalManifestSha256"])
    return {"runtimeReceiptSha256": file_hash(receipt_path), "lineageReceiptSha256": file_hash(lineage_path),
            "archivedSource": receipt["archivedSource"], "adapterFiles": adapter_files,
            "containers": [{key: containers[service][key] for key in ["service", "containerId", "imageId"]}
                           for service in ["resolver", "browser-basic", "resolver-basic-native", "resolver-basic"]],
            "originalManifestSha256": lineage["originalManifestSha256"],
            "projectedManifestSha256": lineage["projectedManifestSha256"],
            "unchangedFiles": {key: {field: lineage["unchangedFiles"][key][field] for field in ["sha256", "bytes"]} for key in files}}


def continuation_provenance(directory, manifest, trials):
    amendment = manifest.get("continuationAmendment")
    if not amendment:
        return None
    receipt_path = directory / amendment["receipt"]
    assert file_hash(receipt_path) == amendment["receiptSha256"]
    receipt = read(receipt_path)
    parent_path = directory / "parent-evidence/manifest.json"
    parent = read(parent_path)
    assert file_hash(parent_path) == receipt["parentManifestSha256"] == amendment["parentManifestSha256"]
    assert parent["id"] == receipt["parentRunId"] == amendment["parentRunId"]
    assert parent["contentHash"] == receipt["parentManifestContentHash"]
    for field in ["plan", "cases", "artifacts", "graderHash", "browserBinarySha256", "stagehand", "policy", "mode"]:
        assert parent[field] == manifest[field], f"Continuation changed {field}"
    changed = {path for path in parent["code"]["files"] | manifest["code"]["files"] if parent["code"]["files"].get(path) != manifest["code"]["files"].get(path)}
    assert changed == {"evaluation/research/compare.mjs"}
    assert receipt["changedFiles"] == [{"path": path, "before": parent["code"]["files"][path], "after": manifest["code"]["files"][path]} for path in sorted(changed)]
    snapshot = directory / "parent-evidence"
    assert {p.relative_to(snapshot).as_posix() for p in snapshot.rglob("*") if p.is_file()} == {row["path"] for row in receipt["originalEvidence"]}
    for entry in receipt["originalEvidence"]:
        relative = Path(entry["path"])
        assert not relative.is_absolute() and ".." not in relative.parts
        assert file_hash(directory / "parent-evidence" / relative) == entry["sha256"]
        if relative.parts[0] in {"trials", "provider"}:
            assert file_hash(directory / relative) == entry["sha256"], "Original attempt changed during continuation"
    retained, pending = set(amendment["retainedTrialIds"]), set(amendment["pendingTrialIds"])
    assert len(retained) == len(amendment["retainedTrialIds"]) and len(pending) == len(amendment["pendingTrialIds"])
    assert not retained.intersection(pending) and retained | pending == {t["id"] for t in trials}
    assert retained == set(receipt["retainedTrialIds"])
    assert pending == {row["id"] for row in receipt["pendingTrials"]}
    parent_trials = [read(p) for p in (snapshot / "trials").glob("*.json")]
    assert retained == {t["id"] for t in parent_trials if t["mode"] == "live"}
    assert [(row["name"], set(row["trialIds"]), row["activeArms"]) for row in receipt["cohorts"]] == [("original-parallel", retained, 3), ("stagehand-continuation", pending, 1)]
    for row in receipt["pendingTrials"]:
        trial = next(t for t in trials if t["id"] == row["id"])
        assert trial["caseId"] == row["caseId"] and trial["arm"] == row["arm"]
    cohorts = {identity: row["name"] for row in receipt["cohorts"] for identity in row["trialIds"]}
    assert sum(len(row["trialIds"]) for row in receipt["cohorts"]) == len(cohorts) == len(trials)
    assert cohorts.keys() == {t["id"] for t in trials}
    for trial in trials:
        trial["_reportingCohort"] = cohorts[trial["id"]]
    return {"receiptSha256": file_hash(receipt_path), "parentManifestSha256": file_hash(parent_path),
            "parentRunId": parent["id"], "parentSource": parent["code"]["revision"],
            "runnerPatchSha256": receipt["runnerPatchSha256"], "changedFiles": receipt["changedFiles"],
            "retainedTrialIds": sorted(retained), "pendingTrialIds": sorted(pending),
            "cohorts": [{key: row[key] for key in ["name", "trialIds", "activeArms"]} for row in receipt["cohorts"]],
            "originalEvidence": [{key: row[key] for key in ["path", "sha256"]} for row in receipt["originalEvidence"]]}


def saved_provenance(basic_dir, improved_dir, saved):
    assert basic_dir.parent == improved_dir.parent, "Saved arms require their shared frozen launcher plan"
    parent = basic_dir.parent
    plan = read(parent / "plan.json")
    subprocess.run(["node", "--input-type=module", "-e", """
      import assert from 'node:assert/strict';import{readFileSync,readdirSync}from'node:fs';
      import{join}from'node:path';import{createHash}from'node:crypto';
      const root=process.argv[1],read=p=>JSON.parse(readFileSync(join(root,p))),hash=x=>createHash('sha256').update(JSON.stringify(x)).digest('hex');
      const plan=read('plan.json'),{contentHash,...body}=plan;assert.equal(hash(body),contentHash);
      assert.equal(hash(readFileSync(join(root,'launch.mjs'),'utf8')),plan.launcherHash);
      assert.equal(hash(readFileSync(join(root,'request-binding.mjs'),'utf8')),plan.requestBindingHash);
      const previous=new Set(readdirSync(root).filter(x=>x.startsWith('plan-before-')&&x.endsWith('.json')).map(file=>{
        const {contentHash,...body}=read(file);assert.equal(hash(body),contentHash);return contentHash;
      }));
      if(plan.continuation) {
        const c=plan.continuation,parent=join(root,c.parentDirectory);
        const {contentHash,...body}=JSON.parse(readFileSync(join(parent,'plan.json')));
        assert.equal(hash(body),contentHash);assert.equal(contentHash,c.parentPlanHash);
        for(const key of ['images','manifests','sourceRevision','caseCount','plannedAttempts','retries','execution']) assert.deepEqual(plan[key],body[key]);
        assert.equal(hash(read(c.receipt)),c.receiptHash);
        assert.equal(hash(read(c.testReceipt)),c.testReceiptHash);
        assert.equal(hash(readFileSync('evaluation/research/compare.mjs','utf8')),plan.providerIntegritySourceHash);
        for(const [file,key] of [['launch.mjs','launcherHash'],['request-binding.mjs','requestBindingHash']]) assert.equal(hash(readFileSync(join(parent,file),'utf8')),body[key]);
      }
      for(const [key,value]of Object.entries(plan).filter(([key])=>key.endsWith('Amendment'))) {
        assert.ok(previous.has(value.previousPlanHash));assert.equal(hash(read(value.testReceipt)),value.testReceiptHash);
      }
    """, str(parent)], cwd=ROOT.parents[2], check=True, capture_output=True)
    assert plan["retries"] == plan["execution"]["retries"] == 0
    assert plan["caseCount"] == len(saved["basic"][2]) and plan["plannedAttempts"] == sum(len(run[3]) for run in saved.values())
    prepared = read(parent / "prepared.json")
    assert prepared["planHash"] == plan["contentHash"]
    preparation = {}
    for arm, key, directory in [("basic", "basic", basic_dir), ("improved", "current", improved_dir)]:
        manifest, _, specs, _ = saved[arm]
        assert plan["manifests"][key] == manifest["contentHash"]
        assert plan["images"][key] == manifest["resolverImage"]
        assert plan["sourceRevision"] == manifest["code"]["revision"]
        receipt = read(directory / "preparation.json")
        assert receipt["image"] == manifest["resolverImage"] and receipt["manifestHash"] == manifest["contentHash"]
        assert len(receipt["records"]) == len(specs) and {row["caseId"] for row in receipt["records"]} == specs.keys()
        for row in receipt["records"]:
            assert row["preparedInputHash"] == specs[row["caseId"]]["labelReview"]["preparedInputHash"]
        preparation[arm] = {"receiptSha256": file_hash(directory / "preparation.json"), "records": len(receipt["records"])}
    amendments = {key: {field: value[field] for field in ["previousPlanHash", "testReceiptHash"]}
                  for key, value in plan.items() if key.endswith("Amendment")}
    return {"planSha256": file_hash(parent / "plan.json"), "planContentHash": plan["contentHash"],
            "preparedReceiptSha256": file_hash(parent / "prepared.json"), "preparation": preparation,
            **{key: plan[key] for key in ["sourceRevision", "images", "manifests", "caseCount", "plannedAttempts", "retries", "launcherHash", "requestBindingHash", "execution"]},
            "amendments": amendments, "continuation": saved_continuation(parent, plan, saved)}


def saved_continuation(directory, plan, saved):
    amendment = plan.get("continuation")
    if not amendment:
        return None
    parent = (directory / amendment["parentDirectory"]).resolve()
    receipt = read(directory / amendment["receipt"])
    assert receipt["parentDirectory"] == amendment["parentDirectory"]
    assert receipt["parentPlanHash"] == amendment["parentPlanHash"]
    assert receipt["priorUnknownChargesPreserved"] is True and receipt["originalRateLimitedAttemptNotRetried"] is True
    copies = receipt["byteIdenticalCopies"]
    assert len({row["destination"] for row in copies}) == len(copies)
    for row in copies:
        for field in ["source", "destination"]:
            path = Path(row[field])
            assert not path.is_absolute() and ".." not in path.parts
        assert file_hash(parent / row["source"]) == file_hash(directory / row["destination"]) == row["sha256"], "Saved continuation changed original evidence"
    cohorts = {}
    for arm, key in [("basic", "basic"), ("improved", "current")]:
        partition = receipt["arms"][key]
        retained, remaining = set(partition["retained"]), set(partition["remaining"])
        rows = saved[arm][3]
        assert len(retained) == len(partition["retained"]) and len(remaining) == len(partition["remaining"])
        assert not retained.intersection(remaining) and retained | remaining == {row["id"] for row in rows}
        assert retained == {p.stem for p in (parent / key / "trials").glob("*.json")}
        for folder in ["trials", "provider"]:
            originals = {f"{key}/{folder}/{p.name}" for p in (parent / key / folder).glob("*.json")}
            copied = {row["source"] for row in copies if row["source"].startswith(f"{key}/{folder}/") and row["source"] == row["destination"]}
            assert originals == copied, "Original trial/provider evidence omitted from continuation"
        for row in rows:
            expected = plan["execution"]["cohort"] if row["id"] in retained else amendment["cohort"]
            assert row["execution"]["cohort"] == expected
        cohorts[arm] = {"retainedTrialIds": sorted(retained), "remainingTrialIds": sorted(remaining)}
    for field, key in [("retainedAttempts", "retainedTrialIds"), ("remainingAttempts", "remainingTrialIds")]:
        assert receipt[field] == amendment[field] == sum(len(row[key]) for row in cohorts.values())
    return {"receiptSha256": file_hash(directory / amendment["receipt"]),
            "parentPlanSha256": file_hash(parent / "plan.json"), "parentPlanContentHash": amendment["parentPlanHash"],
            "copiedEvidenceFiles": len(copies), "retainedAttempts": receipt["retainedAttempts"],
            "remainingAttempts": receipt["remainingAttempts"], "cohorts": cohorts,
            "providerIntegritySourceHash": plan["providerIntegritySourceHash"],
            "testReceiptHash": amendment["testReceiptHash"]}


def xpath_results(directory):
    manifest = read(directory / "manifest.json")
    # Reuse the existing provider-free grader and replay, rather than duplicating XPath checks.
    code = """
      import assert from 'node:assert/strict';
      import {readFileSync,readdirSync} from 'node:fs';
      import {join} from 'node:path';
      import {createHash} from 'node:crypto';
      import {replay} from './evaluation/run.mjs';
      import {loadCases} from './evaluation/cases/load.mjs';
      import {selectXPathCases} from './evaluation/xpath.mjs';
      import {gradeTrial} from './evaluation/grader.mjs';
      const root=process.argv[1], read=p=>JSON.parse(readFileSync(p));
      const manifest=read(join(root,'manifest.json')), saved=read(join(root,'summary.json'));
      assert.equal(manifest.track,'xpath'); assert.equal(manifest.mode,'deterministic');
      assert.equal(manifest.plan.retries,0); assert.equal(manifest.plan.repetitions,1);
      const selected=selectXPathCases(loadCases().cases);
      const sort=xs=>xs.toSorted((a,b)=>a.id.localeCompare(b.id));
      assert.deepEqual(sort(manifest.cases),sort(selected.cases));
      assert.deepEqual(manifest.exclusions,selected.exclusions);
      assert.deepEqual(await replay(root),saved);
      assert.equal(saved.missingTrials,0); assert.equal(saved.diagnosticReruns.trials,0);
      assert.equal(saved.completedTrials,manifest.cases.length);
      assert.deepEqual(readdirSync(join(root,'trials')).sort(),manifest.plan.trials.map(t=>t.id+'.json').sort());
      const cases=new Map(manifest.cases.map(c=>[c.id,c]));
      const trials=manifest.plan.trials.map(p=>{
        const path=join(root,'trials',p.id+'.json'), t=read(path);
        for(const key of ['id','caseId','attempt','repetition'])assert.equal(t[key],p[key]);
        assert.equal(t.attempt,1); assert.equal(t.repetition,1);
        assert.equal((t.provider??[]).length,0);assert.equal((t.mutation?.fresh?.provider??[]).length,0);
        assert.equal((t.evidence?.provider??[]).length,0);
        const grade=gradeTrial(cases.get(t.caseId),t);
        return {id:t.id,caseId:t.caseId,passed:grade.passed,
          savedLocatorPassed:grade.metrics.savedLocator?.passed??null,
          freshResolutionPassed:grade.metrics.freshResolution?.passed??null,
          failureCategories:[...new Set(grade.failures.map(f=>f.category))].sort(),
          trialSha256:createHash('sha256').update(readFileSync(path)).digest('hex')};
      });
      const first=saved.firstAttempt;
      console.log(JSON.stringify({mode:'controlled provider-free',total:first.trials,passed:first.passed,
        savedLocator:first.savedLocator,
        freshResolution:{trials:first.freshResolution?.trials??0,passed:first.freshResolution?.passed??0,failed:first.freshResolution?.failed??0},
        exclusions:manifest.exclusions,replayMatched:true,trials}));
    """
    result = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", code, str(directory)], cwd=ROOT.parents[2], text=True))
    result["provenance"] = provenance(directory, manifest)
    return result


def export(browser_dir, basic_dir, improved_dir, xpath_dir):
    bm, bs, bcases, browser = load(browser_dir, True)
    continuation = continuation_provenance(browser_dir, bm, browser)
    # Bind the browser cohort to today's full eligible case definitions, including expectations.
    browser_inventory = json.loads(subprocess.check_output(["node", "--input-type=module", "-e", """
      import assert from 'node:assert/strict';
      import {readFileSync} from 'node:fs';
      import {selectCases} from './evaluation/research/compare.mjs';
      import {loadCases} from './evaluation/cases/load.mjs';
      import {selectQualificationCases} from './evaluation/compare.mjs';
      const recorded=JSON.parse(readFileSync(process.argv[1])).cases;
      const sort=xs=>xs.toSorted((a,b)=>a.id.localeCompare(b.id));
      assert.deepEqual(sort(recorded),sort(selectCases()));
      const selected=selectQualificationCases(loadCases().cases);
      console.log(JSON.stringify({sourceCases:selected.sourceCases,exclusions:selected.exclusions}));
    """, str(browser_dir / "manifest.json")], cwd=ROOT.parents[2], text=True))
    saved = {"basic": load(basic_dir, False), "improved": load(improved_dir, False)}
    basic_images = {row["component"]: row["id"] for row in bm["artifacts"]["basic"]["images"]}
    assert saved["basic"][0]["resolverImage"] == basic_images["resolver"]
    assert saved["improved"][0]["resolverImage"] == bm["artifacts"]["currentImages"]["resolver"]
    left, right = saved["basic"][2], saved["improved"][2]
    assert left.keys() == right.keys(), "Saved-page arms must use identical case IDs"
    repository = ROOT.parents[2]
    collection = read(repository / "evaluation/datasets/collection.json")
    review_path = repository / collection["labelReview"]["path"]
    assert file_hash(review_path) == collection["labelReview"]["sha256"]
    reviews = read(review_path)["cases"]
    active = {row["caseId"]: row for row in reviews if row["disposition"] == "validated"}
    assert left.keys() == active.keys(), "Run does not cover the complete admitted collection"
    assert {row["caseId"] for row in reviews if row["disposition"] != "validated"} == {row["caseId"] for row in saved["basic"][0]["exclusions"]}
    for identity, spec in left.items():
        assert spec["labelReview"] == active[identity], f"Changed review: {identity}"
    for identity in left:
        for key in ["instruction", "input", "expected", "labelReview"]:
            assert left[identity][key] == right[identity][key], f"Changed {key}: {identity}"
    assert saved["basic"][0]["exclusions"] == saved["improved"][0]["exclusions"]
    output = {"version": 1, "inferenceMode": "live provider inference", "labels": ARMS,
              "validation": {"exporterSha256": file_hash(Path(__file__)),
                             "currentVerifierFiles": {path: file_hash(repository / path) for path in
                                                      ["evaluation/grader.mjs", "evaluation/research/grade.mjs", "evaluation/research/compare.mjs"]}},
              "browser": {**browser_inventory, "provenance": provenance(browser_dir, bm),
                          "basicRuntime": basic_provenance(browser_dir, bm), "continuation": continuation, "arms": {}, "trials": []},
              "savedPage": {"orchestration": saved_provenance(basic_dir, improved_dir, saved),
                            "arms": {}, "trials": [], "sourceCases": saved["basic"][0]["sourceCases"],
                            "labelReviewSha256": collection["labelReview"]["sha256"],
                            "activeArchiveSha256": collection["sha256"],
                            "exclusions": saved["basic"][0]["exclusions"],
                            "unavailable": {"stagehand": "No Saved-page selection arm; stock observe requires a live page."}}}
    for arm in ARMS:
        rows = [t for t in browser if t["arm"] == arm]
        metrics = totals(rows)
        public = [public_trial(t, arm, True, bcases[t["caseId"]]) for t in rows]
        metrics["fullContractPassed"] = sum(t["fullContractPassed"] for t in public) if arm != "stagehand" else None
        metrics["targetSelection"] = {"passed": sum(t["targetSelectionPassed"] is True for t in public),
                                      "total": sum(t["targetSelectionPassed"] is not None for t in public)}
        expected = bs["arms"][arm]
        for key in ["total", "passed", "fullContractPassed"]:
            assert metrics[key] == expected[key]
        assert metrics["providerCalls"] == expected["calls"]
        assert metrics["unknownCharges"] == expected["unreportedCharges"]
        assert math.isclose(metrics["knownReportedUsd"], expected["knownReportedUsd"], abs_tol=1e-10)
        output["browser"]["arms"][arm] = metrics
        output["browser"]["trials"].extend(public)
    categories = {}
    for group in sorted({bm["groups"][identity] for identity in bcases}):
        categories[group] = {}
        for arm in ARMS:
            rows = [t for t in output["browser"]["trials"] if t["arm"] == arm and bm["groups"][t["caseId"]] == group]
            scores = {"total": len(rows), "passed": sum(t["passed"] for t in rows)}
            assert scores == bs["categories"][group][arm]
            scores["fullContractPassed"] = sum(t["fullContractPassed"] for t in rows) if arm != "stagehand" else None
            categories[group][arm] = scores
    output["browser"]["categories"] = categories
    for arm, directory in [("basic", basic_dir), ("improved", improved_dir)]:
        manifest, summary, specs, trials = saved[arm]
        metrics = totals(trials)
        expected = summary["firstAttempt"]
        assert metrics["passed"] == expected["passed"]
        assert metrics["unknownCharges"] == expected["cost"]["reportedUsd"]["unavailable"]
        reported = expected["cost"]["reportedUsd"]["total"]
        assert reported is None or math.isclose(metrics["knownReportedUsd"], reported, abs_tol=1e-10)
        metrics["provenance"] = provenance(directory, manifest)
        output["savedPage"]["arms"][arm] = metrics
        output["savedPage"]["trials"].extend(public_trial(t, arm, False, specs[t["caseId"]]) for t in trials)
    output["savedPage"]["caseBindings"] = [{"caseId": identity, **{k: left[identity]["labelReview"][k] for k in ["inputHash", "labelHash", "preparedInputHash"]}} for identity in sorted(left)]
    for track in ["browser", "savedPage"]:
        rows = output[track]["trials"]
        rows.sort(key=lambda t: (t["caseId"], t["arm"]))
        output[track]["basicToImproved"] = paired(rows, "basic", "improved", "passed")
    output["browser"]["basicToImprovedFullContract"] = paired(output["browser"]["trials"], "basic", "improved", "fullContractPassed")
    assert output["browser"]["basicToImproved"]["gains"] == sorted(bs["changes"]["gained"])
    assert output["browser"]["basicToImproved"]["regressions"] == sorted(bs["changes"]["lost"])
    output["xpath"] = xpath_results(xpath_dir)
    output["limits"] = ["Separate saved-page exact-selection and browser action/target denominators; do not pool.",
                        "Full browser contract and supported-instruction target-only counts are separate metrics.",
                        "All original attempts remain; unknown charges are not zero. Latency cohorts remain separate.",
                        "Paired gains and regressions are observations, not a release approval or unseen-site accuracy estimate."]
    return output


def plot(data):
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.pyplot as plt
    plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11, "figure.facecolor": "#0d1117",
                         "axes.facecolor": "#0d1117", "text.color": "#e6edf3", "axes.labelcolor": "#e6edf3",
                         "xtick.color": "#adb8c6", "ytick.color": "#e6edf3", "svg.hashsalt": "xpathed-clean-comparison"})
    fig, axes = plt.subplots(1, 2, figsize=(13, 5.8))
    fig.subplots_adjust(left=.17, right=.96, top=.71, bottom=.25, wspace=.6)
    fig.text(.045, .93, "Comparison on the audited evaluation set", fontsize=23, weight="bold")
    fig.text(.045, .86, "Live provider inference · one original attempt per case and system · failures included", color="#adb8c6")
    for ax, track, title, subtitle in zip(axes, ["browser", "savedPage"],
                                        ["Live-browser Resolver", "Saved-page selection"],
                                        ["Correct action and target set", "Exact expected target set"]):
        ax.set_title(title + "\n" + subtitle, loc="left", pad=16)
        for index, (arm, color) in enumerate(zip(ARMS, ["#9da9bb", "#63d4b0", "#79b8ff"])):
            scores = data[track]["arms"].get(arm)
            if scores is None:
                ax.text(2, index, "N/A — no saved-page arm", va="center", color="#adb8c6")
                continue
            rate = 100 * scores["passed"] / scores["total"]
            ax.barh(index, rate, height=.55, color=color)
            ax.text(2, index, f"{scores['passed']}/{scores['total']} · {rate:.1f}%", va="center", color="#10171e", weight="bold")
        ax.set_yticks(range(3), list(ARMS.values()))
        ax.set_ylim(2.6, -.6)
        ax.set_xlim(0, 100)
        ax.set_xticks([0, 25, 50, 75, 100], ["0%", "25%", "50%", "75%", "100%"])
        ax.grid(axis="x", color="#293342", linewidth=.6)
        ax.set_axisbelow(True)
        ax.tick_params(length=0)
        for spine in ax.spines.values():
            spine.set_visible(False)
    for x, track in [(.045, "browser"), (.54, "savedPage")]:
        pair = data[track]["basicToImproved"]
        fig.text(x, .14, f"Basic → Improved: {len(pair['gains'])} gains · {len(pair['regressions'])} regressions", fontsize=11)
    fig.text(.045, .07, "Separate metrics; no combined score. Full browser-contract and target-only results are in the report.", fontsize=10, color="#adb8c6")
    description = "Basic and Improved on identical reviewed saved-page cases; Basic, Improved and Stagehand on shared live-browser cases. Counts include all original failed attempts."
    path = ROOT / "clean-comparison.svg"
    fig.savefig(path, metadata={"Date": None, "Title": "Comparison on the audited evaluation set", "Description": description})
    svg = path.read_text().replace('<svg ', '<svg role="img" aria-labelledby="title description" ', 1)
    start = svg.index('>', svg.index('<svg')) + 1
    svg = svg[:start] + f'\n<title id="title">Comparison on the audited evaluation set</title><desc id="description">{escape(description)}</desc>' + svg[start:]
    path.write_text("\n".join(line.rstrip() for line in svg.splitlines()) + "\n")
    fig.savefig(Path(gettempdir()) / "xpathed-clean-comparison.png", dpi=160)
    plt.close(fig)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("browser_run", type=Path)
    parser.add_argument("basic_saved_run", type=Path)
    parser.add_argument("improved_saved_run", type=Path)
    parser.add_argument("xpath_run", type=Path)
    args = parser.parse_args()
    result = export(args.browser_run.resolve(), args.basic_saved_run.resolve(), args.improved_saved_run.resolve(), args.xpath_run.resolve())
    plot(result)
    (ROOT / "clean-comparison.json").write_text(json.dumps(result, indent=2, ensure_ascii=False) + "\n")
    print("Verified all planned attempts; wrote clean-comparison.json and clean-comparison.svg.")
