export async function githubBudget(repository, token, fetchImpl = fetch) {
  if (!/^[a-z\d][a-z\d-]*\/[a-z\d._-]+$/i.test(repository) || !token)
    throw new Error("GitHub budget requires OWNER/REPO and GH_TOKEN");
  repository = repository.toLowerCase();
  const branch = "evaluation-budget";
  const path = "experiment-budget.json";
  const authority = `github:${repository}:${branch}:${path}`;
  const url = `https://api.github.com/repos/${repository}/contents/${path}`;
  async function request(method, body) {
    try {
      const response = await fetchImpl(method === "GET" ? `${url}?ref=${branch}` : url, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
          "X-GitHub-Api-Version": "2022-11-28",
        },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(10000),
      });
      if (!response.ok) throw new Error();
      return await response.json();
    } catch {
      throw new Error(`GitHub budget ${method === "GET" ? "read" : "conditional write"} failed`);
    }
  }
  const file = await request("GET");
  if (
    file.type !== "file" ||
    file.encoding !== "base64" ||
    !/^[a-f\d]{40}$/.test(file.sha ?? "") ||
    typeof file.content !== "string"
  )
    throw new Error("Invalid GitHub budget file");
  let ledger;
  try {
    ledger = JSON.parse(Buffer.from(file.content, "base64").toString("utf8"));
  } catch {
    throw new Error("Invalid GitHub budget ledger");
  }
  if (ledger?.remoteAuthority !== authority) throw new Error("GitHub budget authority mismatch");
  let sha = file.sha;
  return {
    authority,
    ledger,
    async persist(value) {
      const updated = await request("PUT", {
        branch,
        sha,
        message: "Record evaluation budget accounting",
        content: Buffer.from(JSON.stringify(value, null, 2) + "\n").toString("base64"),
      });
      if (!/^[a-f\d]{40}$/.test(updated.content?.sha ?? ""))
        throw new Error("Invalid GitHub budget write receipt");
      sha = updated.content.sha;
    },
  };
}
