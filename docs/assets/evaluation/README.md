# Evaluation figures

These figures use the latest recorded paired browser confirmation from 2026-10-02. They are a fixed measurement snapshot, not a live dashboard.

- `paired-outcomes.svg` includes every planned case: 104 passed both arms, 15 improved, one regressed and 15 failed both.
- `changed-families.svg` shows every family with a changed case and combines the 38 unchanged families in one explicit row. Cell labels show counts; color uses a shared 0–100% scale.
- `confirmation-2026-10-02.json` contains the 135 paired grades, original case/family IDs, settings and source hashes. It excludes raw page and provider content.

The export follows the frozen live trial plan; 148 deterministic setup trials found beside those files are excluded. The saved comparison includes one regression, which would fail the current release gate. Small authored case groups do not establish production accuracy.

## Rebuild

```sh
uv run docs/assets/evaluation/plot.py
```

The script pins Matplotlib, checks the matrix totals against individual case grades, writes SVGs here and writes PNG previews to the system temporary directory. It performs no inference. Review both figures after changing data or layout.

Measurement details are in the [release report](../../research/2026-10-01-release-monitoring-setup.md#first-approved-release--2026-10-02). Archive, manifest and trial hashes are retained in the JSON.
