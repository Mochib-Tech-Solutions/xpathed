# /// script
# dependencies = ["matplotlib==3.11.2"]
# ///
"""Export a completed live comparison: uv run docs/assets/evaluation/engineering-plot.py RUN_DIRECTORY."""
import hashlib
import json
import sys
from html import escape
from pathlib import Path
from tempfile import gettempdir

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np

root = Path(__file__).resolve().parent
run = Path(sys.argv[1]).resolve()
manifest = json.loads((run / "manifest.json").read_text())
summary = json.loads((run / "summary.json").read_text())
assert manifest["mode"] == summary["mode"] == "live", "Scripted responses cannot measure accuracy"
assert summary["complete"], "Keep incomplete runs separate"
arms = ["basic", "improved", "stagehand"]
trials = []
selection_scores = {arm: {"passed": 0, "total": 0} for arm in arms}
for planned in manifest["plan"]["trials"]:
    for arm in arms:
        identity = hashlib.sha256(f"{planned.get('id', planned['caseId'] + ':' + str(planned['repetition']))}-{arm}".encode()).hexdigest()[:32]
        path = run / "trials" / f"{identity}.json"
        if not path.exists() and manifest["version"] == 2 and planned == manifest["plan"]["trials"][0]:
            identity = hashlib.sha256(f"undefined-{arm}".encode()).hexdigest()[:32]
            path = run / "trials" / f"{identity}.json"
        trial = json.loads(path.read_text())
        assert trial["id"] == identity and trial["caseId"] == planned["caseId"] and trial["arm"] == arm
        spec = next(c for c in manifest["cases"] if c["id"] == trial["caseId"])
        selection_passed = None
        if spec["expected"]["outcome"] != "unsupported":
            metrics = trial["grade"]["metrics"]
            selection_passed = bool(metrics["targetSetsComplete"] and not metrics["operationalError"] and not metrics["unsupported"] and not any(f["category"] in {"contract", "passive_state", "privacy", "fresh_inference", "oracle"} for f in trial["grade"]["failures"]))
            selection_scores[arm]["total"] += 1
            selection_scores[arm]["passed"] += int(selection_passed)
        trials.append({"caseId": trial["caseId"], "selectionPassed": selection_passed, "arm": arm, "passed": trial["grade"]["passed"],
                       "failures": trial["grade"]["failures"], "trialSha256": hashlib.sha256(path.read_bytes()).hexdigest()})
for arm in arms:
    assert sum(t["passed"] for t in trials if t["arm"] == arm) == summary["arms"][arm]["passed"]
assert len(trials) == summary["planned"] == summary["completed"]
aggregate = {"runId": manifest["id"], "createdAt": manifest["createdAt"],
             "manifestSha256": hashlib.sha256((run / "manifest.json").read_bytes()).hexdigest(),
             "code": manifest["code"], "artifacts": manifest["artifacts"], "stagehand": manifest["stagehand"],
             "policy": manifest["policy"], "summary": summary, "cases": trials,
             "continuations": [json.loads(p.read_text()) for p in sorted(run.glob("continuation-*.json")) if p.name != "continuation-images.json"],
             "imageIdentityUpdate": manifest.get("imageIdentityUpdate"), "targetSelection": selection_scores}
(root / "engineering-comparison.json").write_text(json.dumps(aggregate, indent=2) + "\n")

plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11, "figure.facecolor": "#0d1117",
                    "axes.facecolor": "#0d1117", "text.color": "#e6edf3", "axes.labelcolor": "#e6edf3",
                    "xtick.color": "#adb8c6", "ytick.color": "#e6edf3", "svg.hashsalt": "xpathed-engineering"})
groups = {g: rows for g, rows in summary["categories"].items() if rows["basic"]["total"]}
assert sum(rows["basic"]["total"] for rows in groups.values()) == len(manifest["cases"])
fig, ax = plt.subplots(figsize=(12, 9))
fig.subplots_adjust(left=.17, right=.86, top=.74, bottom=.12)
fig.text(.05, .945, "Resolver accuracy by behavior", fontsize=23, weight="bold")
fig.text(.05, .9, f"{len(manifest['cases'])} shared browser cases · one attempt per system · failures included", color="#adb8c6")
colors = ["#9da9bb", "#63d4b0", "#79b8ff"]
y = np.arange(len(groups))
for i, arm in enumerate(arms):
    counts = [rows[arm] for rows in groups.values()]
    rates = [100 * c["passed"] / c["total"] for c in counts]
    offset = (i - 1) * .24
    ax.barh(y + offset, rates, height=.2, color=colors[i], label=summary["arms"][arm]["label"])
    for pos, rate, count in zip(y + offset, rates, counts):
        ax.text(rate + 1, pos, f"{count['passed']}/{count['total']}", va="center", fontsize=9, color=colors[i])
    total = summary["arms"][arm]
    x = .05 + i * .32
    fig.text(x, .835, total["label"], color=colors[i], fontsize=12, weight="bold")
    fig.text(x, .79, f"{100*total['passed']/total['total']:.1f}%  ({total['passed']}/{total['total']})", fontsize=20)
ax.set_yticks(y, [g.capitalize() for g in groups])
ax.invert_yaxis()
ax.set_xlim(0, 110)
ax.set_xticks([0, 25, 50, 75, 100], ["0%", "25%", "50%", "75%", "100%"])
ax.set_xlabel("Cases with the correct action and independently verified target set")
ax.grid(axis="x", color="#293342", linewidth=.6)
ax.set_axisbelow(True)
ax.tick_params(length=0)
for spine in ax.spines.values():
    spine.set_visible(False)
fig.text(.05, .055, f"Basic → Improved: {len(summary['changes']['gained'])} gains · {len(summary['changes']['lost'])} regressions", weight="bold")
fig.text(.05, .025, "Authored regression cases; not unseen-site accuracy. Stagehand uses stock observe with a current-view instruction.", fontsize=10, color="#adb8c6")
description = "Action and target-set accuracy by behavior for Basic resolver, Improved resolver and Stagehand. Counts include failed attempts."
svg_path = root / "engineering-category-results.svg"
fig.savefig(svg_path, metadata={"Date": None, "Title": "Resolver accuracy by behavior", "Description": description})
svg = svg_path.read_text().replace('<svg ', '<svg role="img" aria-labelledby="title description" ', 1)
start = svg.index('>', svg.index('<svg')) + 1
svg = svg[:start] + f'\n<title id="title">Resolver accuracy by behavior</title><desc id="description">{escape(description)}</desc>' + svg[start:]
svg_path.write_text("\n".join(line.rstrip() for line in svg.splitlines()) + "\n")
fig.savefig(Path(gettempdir()) / "xpathed-engineering-comparison.png", dpi=160)
plt.close(fig)

lines = ["# Basic resolver, Improved resolver and Stagehand", "", "## Results", "",
         "All three systems received the same frozen browser cases and independent target labels, with one original attempt per case and no retries. These are authored regression cases, not an estimate of accuracy on unseen websites.", "",
         "| System | Action + targets | Target selection only | Full resolver contract | Parallel median / p95 | Known cost | Unreported charges |",
         "| --- | ---: | ---: | ---: | ---: | ---: | ---: |"]
for arm in arms:
    a = summary["arms"][arm]
    full = "Unavailable" if a["fullContractPassed"] is None else f"{a['fullContractPassed']}/{a['total']}"
    cohort = a["latencyCohorts"].get("parallel", a["latencyMs"])
    timing = " / ".join("Unavailable" if cohort[k] is None else f"{cohort[k]/1000:.3f}s" for k in ["p50", "p95"])
    target = selection_scores[arm]
    selection = f"{target['passed']}/{target['total']} ({100*target['passed']/target['total']:.1f}%)"
    lines.append(f"| {a['label']} | {a['passed']}/{a['total']} ({100*a['passed']/a['total']:.1f}%) | {selection} | {full} | {timing} | ${a['knownReportedUsd']:.8f} | {a['unreportedCharges']} |")
lines += ["", "![Accuracy by behavior](../assets/evaluation/engineering-category-results.svg)", "",
          f"Basic → Improved: **{len(summary['changes']['gained'])} gained passes and {len(summary['changes']['lost'])} lost passes**.", "",
          "Regressions: " + (", ".join(f"`{c}`" for c in summary["changes"]["lost"]) or "none observed") + ".", "",
          "## What changed", "",
          "Basic resolver is the archived earlier setup. Improved resolver uses the current implementation: one shared prompt and schema, explicit rules for requested controls versus surrounding context, scoped absence, and current-view membership revalidation. These changes are measured together; the comparison does not isolate the effect of each change.", "",
          "Stagehand uses stock `observe`, with caching and self-healing disabled, a current-view instruction, and the same DeepSeek V4.1 Flash/Wafer route, 4,096-token output limit and disabled reasoning. Its DOM representation and prompt differ from ours. The browser binaries, viewport, document, initial state, language and time zone are checked for parity.", "",
          "## What the score means", "",
          "The common score requires the correct interaction and complete set of independently labelled nodes. Each XPath must identify one eligible node. Singleton grading keeps the first Stagehand suggestion; plural grading checks the whole returned set. Wrong, missing, extra and duplicate targets fail. Operational errors remain in the denominator. Correct rejection of unsupported instructions is included; an adapter selector-conversion failure is not a correct instruction refusal.", "",
          "The target-selection column separately checks exact node sets and correct absence, without requiring the interaction name. Its denominator excludes the explicitly unsupported-instruction cases, which do not have a supported target set. All errors within that subset still fail. This helps distinguish selecting the wrong element from interpreting the action differently.", "",
          "Stagehand returns targets without xpathed's absence explanations or readiness contract. For an empty result, action interpretation is unavailable; the common score accepts correct absence. For a partly absent request, the common score checks the complete found set. The separate full resolver score also checks outcome details, capture coverage, readiness and summary fields. Neither system executes actions.", "",
          "## Timing and evidence", "",
          "Each system has its own serial worker; the three workers run concurrently with isolated browser sessions and provider accounting. Stagehand waits for the corresponding Basic browser observation to establish parity. Browser setup and independent grading are outside the measured inference interval. Timings above describe the parallel phase; retained serial attempts have separate timing fields in the aggregate. Provider caching and host contention can affect timings. Costs are reported amounts, with missing billing records kept separate.", "",
          f"Run: `{manifest['id']}`; started `{manifest['createdAt']}`. The [aggregate evidence](../assets/evaluation/engineering-comparison.json) records source and image identities, case outcomes and original evidence hashes. Private request/response payloads remain in the local run directory.", "",
          "The initial runner stopped after one case per arm because it reused an attempt ID. Those three original outcomes remain included. Continuation ran only the remaining cases after the bookkeeping fix. Docker build-attestation wrappers changed during restart; saved build logs verify identical platform manifests and runtime configurations. Original and continuation image identities and the original manifest are retained in the evidence. No failed model attempt was retried.", "",
          "This research comparison does not approve or activate a release. See [evaluation commands](../evaluation.md#engineering-comparison) to reproduce it.", ""]
(root.parent.parent / "research" / "engineering-comparison.md").write_text("\n".join(lines))
print(f"Exported {len(trials)} original attempts across {len(groups)} categories.")
