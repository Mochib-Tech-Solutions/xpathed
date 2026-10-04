# /// script
# dependencies = ["matplotlib==3.11.2"]
# ///
"""Render Gemini approach durations from the verified public aggregate."""
import json
from html import escape
from pathlib import Path
from tempfile import gettempdir

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt

ROOT = Path(__file__).resolve().parent
COLORS = ["#9da9bb", "#63d4b0", "#79b8ff"]
plt.rcParams.update({"font.family": "DejaVu Sans", "font.size": 11,
                     "figure.facecolor": "#0d1117", "axes.facecolor": "#0d1117",
                     "text.color": "#e6edf3", "axes.labelcolor": "#e6edf3",
                     "xtick.color": "#adb8c6", "ytick.color": "#e6edf3",
                     "svg.hashsalt": "xpathed-comparison-figures"})


def canvas(title, subtitle):
    fig, axes = plt.subplots(1, 2, figsize=(13, 5.8))
    fig.subplots_adjust(left=.17, right=.96, top=.71, bottom=.25, wspace=.6)
    fig.text(.045, .93, title, fontsize=23, weight="bold")
    fig.text(.045, .86, subtitle, color="#adb8c6")
    return fig, axes


def style(ax, labels):
    ax.set_yticks(range(len(labels)), labels)
    ax.set_ylim(len(labels) - .4, -.6)
    ax.grid(axis="x", color="#293342", linewidth=.6)
    ax.set_axisbelow(True)
    ax.tick_params(length=0)
    for spine in ax.spines.values():
        spine.set_visible(False)


def save(fig, name, description):
    path = ROOT / (name + ".svg")
    fig.savefig(path, metadata={"Date": None, "Title": name.replace("-", " ").title(), "Description": description})
    svg = path.read_text().replace('<svg ', '<svg role="img" aria-labelledby="title description" ', 1)
    start = svg.index('>', svg.index('<svg')) + 1
    svg = svg[:start] + f'\n<title id="title">{escape(name.replace("-", " ").title())}</title><desc id="description">{escape(description)}</desc>' + svg[start:]
    path.write_text("\n".join(line.rstrip() for line in svg.splitlines()) + "\n")
    fig.savefig(Path(gettempdir()) / ("xpathed-" + name + ".png"), dpi=160)
    plt.close(fig)


def durations(data, arms, name, title, subtitle):
    fig, axes = canvas(title, subtitle)
    descriptions = []
    for ax, track, heading in zip(axes, ["browser", "savedPage"], ["Live-browser Resolver", "Saved-page selection"]):
        ax.set_title(heading + "\nMedian and p95 duration", loc="left", pad=16)
        points = []
        for index, (arm, label) in enumerate(arms.items()):
            score = data[track]["arms"].get(arm)
            if score is None:
                ax.text(.03, index, "N/A — no saved-page arm", va="center", color="#adb8c6")
                continue
            cohorts = score["latencyCohorts"]
            assert len(cohorts) == 1, "Do not pool timing cohorts; render each separately."
            cohort, timing = next(iter(cohorts.items()))
            assert timing["measured"] + timing["unavailable"] == score["total"]
            if timing["medianMs"] is None:
                ax.text(.03, index, "Duration unavailable", va="center", color="#adb8c6")
                continue
            median, p95 = timing["medianMs"] / 1000, timing["p95Ms"] / 1000
            points.append(p95)
            ax.plot([median, p95], [index, index], color=COLORS[index], linewidth=3)
            ax.scatter([median], [index], color=COLORS[index], s=70, zorder=3)
            ax.scatter([p95], [index], facecolor="#0d1117", edgecolor=COLORS[index], s=70, zorder=3)
            ax.text(p95 + .07, index, f"{median:.2f} / {p95:.2f} s", va="center", fontsize=10)
            descriptions.append(f"{heading}, {label}, {cohort}: median {median:.3f} seconds, p95 {p95:.3f} seconds; {timing['measured']} measured, {timing['unavailable']} unavailable.")
        style(ax, list(arms.values()))
        ax.set_xlim(0, max(points, default=1) * 1.4 + .6)
        ax.set_xlabel("Seconds")
    fig.text(.045, .14, "● median     ○ p95     All original attempts included; unavailable measurements remain explicit.", fontsize=10)
    fig.text(.045, .07, "Browser: observed resolution duration. Saved page: Resolver CLI inference process, preparation excluded. Cohorts differ.", fontsize=9, color="#adb8c6")
    save(fig, name, " ".join(descriptions) + " Different execution cohorts do not establish a fastest model.")


if __name__ == "__main__":
    systems = json.loads((ROOT / "clean-comparison.json").read_text())
    assert not any(score.get("providerAccessRefusals", 0) for data in [systems] for track in ["browser", "savedPage"] for score in data[track]["arms"].values()), "Provider access/spending refusals are operational evidence, not presentation accuracy."
    durations(systems, systems["labels"], "system-duration", "System duration using Gemini 3.8 Flash", "All three browser systems use Gemini / Google AI Studio · same recorded inference profile")
    print("Wrote verified Gemini approach duration figure and preview.")
