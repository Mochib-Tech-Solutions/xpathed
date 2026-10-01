export async function reserveHoldout(manifest, repository, token, fetchImpl = fetch) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository ?? "") || !token)
    throw new Error("Current-view confirmation requires authoritative release-state credentials");
  const families = [
    ...new Set(manifest.cases.filter((c) => c.split === "held-out").map((c) => c.family)),
  ].sort();
  if (!families.length) throw new Error("Confirmation has no held-out families");
  const url = `https://api.github.com/repos/${repository}/contents/state.json`;
  const headers = {
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "Content-Type": "application/json",
  };
  async function request(method, body) {
    try {
      const response = await fetchImpl(method === "GET" ? `${url}?ref=release-state` : url, {
        method,
        headers,
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        ...(body ? { body: JSON.stringify(body) } : {}),
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      throw new Error("Held-out reservation failed; no confirmation inference allowed");
    }
  }
  const file = await request("GET");
  if (file.encoding !== "base64" || !/^[a-f\d]{40}$/.test(file.sha ?? ""))
    throw new Error("Invalid authoritative release state");
  const state = JSON.parse(Buffer.from(file.content, "base64"));
  if (state.version !== 1 || !Array.isArray(state.exposures))
    throw new Error("Invalid release state");
  if (state.exposures.some((entry) => families.includes(entry.family)))
    throw new Error("Held-out families were previously exposed or reserved");
  const reservation = {
    repository,
    runId: manifest.id,
    sourceSha: manifest.code.revision,
    reservedAt: new Date().toISOString(),
    families,
  };
  state.exposures.push(
    ...families.map((family) => ({ ...reservation, families: undefined, family })),
  );
  const saved = await request("PUT", {
    branch: "release-state",
    sha: file.sha,
    message: "chore(evaluation): reserve fresh held-out families",
    content: Buffer.from(JSON.stringify(state, null, 2) + "\n").toString("base64"),
  });
  if (!/^[a-f\d]{40}$/.test(saved.content?.sha ?? ""))
    throw new Error("Missing reservation receipt");
  return reservation;
}
