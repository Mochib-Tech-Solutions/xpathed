export function reserveCharge(ledger, estimate, id) {
  if (
    !Array.isArray(ledger.entries) ||
    (estimate !== null && (!Number.isFinite(estimate) || estimate < 0))
  )
    throw new Error("Invalid accounting record");
  if (ledger.entries.some((entry) => entry.id === id))
    throw new Error("Repeated attempt reservation");
  ledger.entries.push({ id, reservedUsd: estimate, reportedUsd: null });
  return estimate;
}
