import { setTimeout as delay } from "node:timers/promises";

await Promise.all(
  process.argv.slice(2).map(async (url) => {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
      try {
        const response = await fetch(url, { signal: AbortSignal.timeout(1000) });
        if (response.ok) return;
      } catch {
        /* The container can be running before its HTTP server starts. */
      }
      await delay(200);
    }
    throw new Error(`Service was not ready within 30 seconds: ${url}`);
  }),
);
