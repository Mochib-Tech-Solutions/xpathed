# /// script
# dependencies = ["matplotlib==3.11.2"]
# ///
"""Render the archived paired confirmation snapshot: uv run docs/assets/evaluation/plot.py."""

import json
import re
from html import escape
from pathlib import Path
from tempfile import gettempdir

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import ListedColormap

ROOT = Path(__file__).resolve().parent
data = json.loads((ROOT / "confirmation-2026-10-02.json").read_text())
cases = data["cases"]
totals = data["totals"]
assert len(cases) == totals["total"] == len({c["caseId"] for c in cases})
matrix = np.zeros((2, 2), dtype=int)
for case in cases:
    matrix[int(not case["baselinePassed"]), int(not case["candidatePassed"])] += 1
assert matrix.tolist() == data["pairedMatrix"]["counts"]
assert matrix[0].sum() == totals["baselinePassed"]
assert matrix[:, 0].sum() == totals["candidatePassed"]
assert matrix[1, 0] == totals["gains"] and matrix[0, 1] == totals["losses"]

plt.rcParams.update({
    "font.family": "DejaVu Sans",
    "font.size": 12,
    "figure.facecolor": "#0d1117",
    "axes.facecolor": "#0d1117",
    "text.color": "#e6edf3",
    "axes.labelcolor": "#e6edf3",
    "xtick.color": "#e6edf3",
    "ytick.color": "#e6edf3",
    "svg.hashsalt": "xpathed-confirmation-2026-10-02",
})


def save(fig, name, description):
    fig.savefig(ROOT / f"{name}.svg", metadata={"Date": None, "Title": name, "Description": description})
    svg_path = ROOT / f"{name}.svg"
    svg = svg_path.read_text().replace('<svg ', '<svg role="img" aria-labelledby="title description" ', 1)
    start = svg.index('>', svg.index('<svg')) + 1
    svg = svg[:start] + f'\n<title id="title">{escape(name.replace("-", " ").capitalize())}</title><desc id="description">{escape(description)}</desc>' + svg[start:]
    svg_path.write_text(svg)
    # PNGs are optional local previews, kept out of the repository.
    fig.savefig(Path(gettempdir()) / f"xpathed-{name}.png", dpi=160)
    plt.close(fig)


fig = plt.figure(figsize=(9.5, 5.8))
fig.text(.05, .93, "What changed across 135 browser cases", fontsize=19, weight="bold")
fig.text(.05, .87, "2026-10-02 · DeepSeek / Wafer · same cases, one attempt per arm", fontsize=11, color="#adb8c6")
ax = fig.add_axes((.24, .20, .71, .55))
ax.imshow([[0, 1], [2, 3]], cmap=ListedColormap(["#24483f", "#763d48", "#285478", "#343c48"]), vmin=0, vmax=3, aspect="auto")
ax.set_xticks([0, 1], ["Candidate passed", "Candidate failed"])
ax.xaxis.tick_top()
ax.set_yticks([0, 1], ["Baseline\npassed", "Baseline\nfailed"])
ax.tick_params(length=0, pad=12)
for spine in ax.spines.values():
    spine.set_visible(False)
ax.set_xticks([.5], minor=True)
ax.set_yticks([.5], minor=True)
ax.grid(which="minor", color="#0d1117", linewidth=5)
ax.tick_params(which="minor", length=0)
captions = [["kept passing", "regressed"], ["improved", "still failed"]]
for row in range(2):
    for col in range(2):
        ax.text(col, row - .09, str(matrix[row, col]), ha="center", va="center", fontsize=36, weight="bold")
        ax.text(col, row + .22, captions[row][col], ha="center", va="center", fontsize=13)
delta = 100 * (totals["candidatePassed"] - totals["baselinePassed"]) / totals["total"]
fig.text(.05, .105, f"105/135 → 119/135 passed   ·   +{delta:.1f} percentage points", fontsize=14, weight="bold")
fig.text(.05, .045, "15 gains and 1 regression. One attempt per arm; authored fixtures, not production accuracy.", fontsize=10.5, color="#adb8c6")
save(fig, "paired-outcomes", "Paired historical confirmation: 104 cases passed both versions, 15 improved, 1 regressed and 15 failed both. All 135 planned live cases are included.")

# Display every family with a changed case, and explicitly account for the rest.
families = data["groups"]["family"]
changed = [g for g in families if g["gains"] or g["losses"]]
unchanged = [g for g in families if not (g["gains"] or g["losses"])]
remainder = {key: sum(g[key] for g in unchanged) for key in totals}
remainder["id"] = f"Other {len(unchanged)} families (unchanged)"
groups = changed + [remainder]
assert sum(g["total"] for g in groups) == totals["total"]
assert sum(g["gains"] for g in groups) == totals["gains"]
assert sum(g["losses"] for g in groups) == totals["losses"]
rates = np.array([[g["baselinePassed"] / g["total"], g["candidatePassed"] / g["total"]] for g in groups])
fig = plt.figure(figsize=(11, 9))
fig.text(.045, .955, "Which case families changed?", fontsize=20, weight="bold")
fig.text(.045, .916, "2026-10-02 · DeepSeek / Wafer · every changed family and the unchanged remainder", fontsize=11, color="#adb8c6")
ax = fig.add_axes((.39, .20, .34, .64))
ax.imshow(rates, cmap="cividis", vmin=0, vmax=1, aspect="auto")
ax.set_xticks([0, 1], ["Baseline", "Candidate"])
ax.xaxis.tick_top()
ax.set_yticks(range(len(groups)), [re.sub(r"^release(?:-holdout|[234])-", "", g["id"]).replace("-", " ").capitalize() for g in groups], fontsize=10.5)
ax.tick_params(length=0, pad=9)
for spine in ax.spines.values():
    spine.set_visible(False)
for i, g in enumerate(groups):
    for j, field in enumerate(["baselinePassed", "candidatePassed"]):
        ax.text(j, i, f"{g[field]}/{g['total']}", ha="center", va="center", fontsize=12, color="#111827" if rates[i, j] > .65 else "white")
    ax.text(1.75, i, f"+{g['gains']} / −{g['losses']}", ha="center", va="center", fontsize=11, color="#f4a6b3" if g["losses"] else "#e6edf3", clip_on=False)
ax.text(1.75, -1, "Gains / losses", ha="center", va="center", fontsize=11, clip_on=False)
color_ax = fig.add_axes((.39, .125, .34, .02))
fig.colorbar(ax.images[0], cax=color_ax, orientation="horizontal", ticks=[0, .5, 1], format=lambda v, _: f"{v:.0%}")
color_ax.set_xlabel("Passed cases / cases in the row", fontsize=10)
fig.text(.045, .058, "Small families contain 1–3 cases. These counts describe the saved run; they do not estimate site-wide accuracy.", fontsize=10, color="#adb8c6")
fig.text(.045, .028, "Listbox cases kept the same total but included both a gain and a regression.", fontsize=10, color="#adb8c6")
save(fig, "changed-families", "Pass-count heatmap for every family containing a gain or loss, plus all unchanged families aggregated. Counts include all 135 paired cases; the one lost listbox pass remains visible.")
print(f"Rendered paired outcomes and {len(changed)} changed families; included all {len(cases)} cases.")
