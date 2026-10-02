# /// script
# dependencies = ["matplotlib==3.11.2"]
# ///
"""Render the paired configuration comparison: uv run docs/assets/evaluation/plot.py."""

import json
from html import escape
from pathlib import Path
from tempfile import gettempdir

import matplotlib

matplotlib.use("Agg")
import matplotlib.pyplot as plt
import numpy as np
from matplotlib.colors import ListedColormap

ROOT = Path(__file__).resolve().parent
data = json.loads((ROOT / "configuration-comparison.json").read_text())["browser"]
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
    "svg.hashsalt": "xpathed-configuration-comparison",
})


def save(fig, name, description):
    fig.savefig(ROOT / f"{name}.svg", metadata={"Date": None, "Title": name, "Description": description})
    svg_path = ROOT / f"{name}.svg"
    svg = svg_path.read_text().replace('<svg ', '<svg role="img" aria-labelledby="title description" ', 1)
    start = svg.index('>', svg.index('<svg')) + 1
    svg = svg[:start] + f'\n<title id="title">{escape(name.replace("-", " ").capitalize())}</title><desc id="description">{escape(description)}</desc>' + svg[start:]
    svg_path.write_text("\n".join(line.rstrip() for line in svg.splitlines()) + "\n")
    # PNGs are optional local previews, kept out of the repository.
    fig.savefig(Path(gettempdir()) / f"xpathed-{name}.png", dpi=160)
    plt.close(fig)


fig = plt.figure(figsize=(9.5, 5.8))
fig.text(.05, .93, f"What changed across {len(cases)} browser cases", fontsize=19, weight="bold")
fig.text(.05, .87, "DeepSeek / Wafer · same cases · one attempt per configuration", fontsize=11, color="#adb8c6")
ax = fig.add_axes((.24, .20, .71, .55))
ax.imshow([[0, 1], [2, 3]], cmap=ListedColormap(["#24483f", "#763d48", "#285478", "#343c48"]), vmin=0, vmax=3, aspect="auto")
ax.set_xticks([0, 1], ["Current passed", "Current failed"])
ax.xaxis.tick_top()
ax.set_yticks([0, 1], ["Earlier\npassed", "Earlier\nfailed"])
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
fig.text(.05, .105, f"{totals['baselinePassed']}/{len(cases)} → {totals['candidatePassed']}/{len(cases)} passed   ·   {delta:+.1f} percentage points", fontsize=14, weight="bold")
fig.text(.05, .045, f"{totals['gains']} gains and {totals['losses']} regression{'' if totals['losses'] == 1 else 's'}. Authored fixtures; one observation per case.", fontsize=10.5, color="#adb8c6")
save(fig, "paired-outcomes", f"Paired configurations: {totals['bothPassed']} passed both, {totals['gains']} improved, {totals['losses']} regressed and {totals['bothFailed']} failed both. All {len(cases)} planned browser cases are included.")

# Keep every behavior category, including categories with no changed result.
groups = data["groups"]["behavior"]
assert sum(g["total"] for g in groups) == totals["total"]
assert sum(g["gains"] for g in groups) == totals["gains"]
assert sum(g["losses"] for g in groups) == totals["losses"]
rates = np.array([[g["baselinePassed"] / g["total"], g["candidatePassed"] / g["total"]] for g in groups])
fig = plt.figure(figsize=(9.5, 6.5))
fig.text(.05, .94, "Results by behavior", fontsize=20, weight="bold")
fig.text(.05, .885, "Earlier configuration → current configuration · identical cases", fontsize=11, color="#adb8c6")
ax = fig.add_axes((.25, .21, .40, .56))
ax.imshow(rates, cmap="cividis", vmin=0, vmax=1, aspect="auto")
ax.set_xticks([0, 1], ["Earlier", "Current"])
ax.xaxis.tick_top()
ax.set_yticks(range(len(groups)), [g["id"].capitalize() for g in groups], fontsize=11)
ax.tick_params(length=0, pad=9)
for spine in ax.spines.values():
    spine.set_visible(False)
for i, g in enumerate(groups):
    for j, field in enumerate(["baselinePassed", "candidatePassed"]):
        ax.text(j, i, f"{g[field]}/{g['total']}", ha="center", va="center", fontsize=12, color="#111827" if rates[i, j] > .45 else "white")
    ax.text(2.12, i, f"+{g['gains']} / −{g['losses']}", ha="center", va="center", fontsize=11, color="#f4a6b3" if g["losses"] else "#e6edf3", clip_on=False)
ax.text(2.12, -1, "Gains / losses", ha="center", va="center", fontsize=11, clip_on=False)
color_ax = fig.add_axes((.25, .135, .40, .02))
fig.colorbar(ax.images[0], cax=color_ax, orientation="horizontal", ticks=[0, .5, 1], format=lambda v, _: f"{v:.0%}")
color_ax.set_xlabel("Passed cases / cases in the row", fontsize=10)
fig.text(.05, .035, "Counts include failures. Small authored groups do not estimate production accuracy.", fontsize=10, color="#adb8c6")
save(fig, "category-results", f"Pass counts for all {len(groups)} behavior categories and all {len(cases)} paired browser cases. Each row includes gains and regressions.")
print(f"Rendered paired outcomes and {len(groups)} behavior categories; included all {len(cases)} cases.")
