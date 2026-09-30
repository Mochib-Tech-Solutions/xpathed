# check=error=true
FROM node:24.16.0-bookworm-slim@sha256:2c87ef9bd3c6a3bd4b472b4bec2ce9d16354b0c574f736c476489d09f560a203 AS node
WORKDIR /adapter
COPY evaluation/stagehand/package*.json ./
RUN npm ci --omit=dev --ignore-scripts

FROM mcr.microsoft.com/playwright/dotnet:v1.63.0-noble@sha256:aa3eaf29a65df8c93fc32ab20cf9359f4d8ecc53e6e89f79378647ace87b46b3
COPY --from=node /usr/local/bin/node /usr/local/bin/node
WORKDIR /adapter
COPY --from=node /adapter/ ./stagehand/
COPY evaluation/stagehand*.mjs ./
USER pwuser
ENTRYPOINT ["xvfb-run", "-a", "--server-args=-screen 0 1280x800x24", "node", "stagehand-server.mjs"]
