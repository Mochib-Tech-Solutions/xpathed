---
name: graphify
description: Generate an interactive codebase map or explore source relationships using the local Graphify CLI.
---

# Graphify

Use the [official Graphify CLI](https://github.com/Graphify-Labs/graphify).
This plugin supplies a focused workflow; it does not bundle the Python package.

## Build a codebase view

Run from the requested repository root. If the CLI is missing, install the tested version:

```sh
rtk uv tool install graphifyy==0.9.77
```

Keep generated files under ignored `.artifacts/graphify/`:

```sh
rtk env GRAPHIFY_OUT=.artifacts/graphify graphify extract . --code-only
rtk env GRAPHIFY_OUT=.artifacts/graphify graphify cluster-only . --no-label
rtk env GRAPHIFY_OUT=.artifacts/graphify graphify export html
```

Open `.artifacts/graphify/graph.html` in the app's browser and provide links to it,
`GRAPH_REPORT.md` and `graph.json`. Report the source revision, whether the checkout
has local changes, mapped file/node/edge counts and extraction warnings.

Code-only extraction uses local parsing with no model calls. It respects Git ignores
and skips semantic analysis of docs, images and other non-code inputs. Treat the map
as structural evidence: inferred edges, unsupported files and cross-service HTTP
relationships need confirmation in source. Use semantic extraction only when requested.

## Explore a saved graph

```sh
rtk env GRAPHIFY_OUT=.artifacts/graphify graphify query "How does target verification work?"
```

Use the graph's symbol names in focused questions. Confirm relevant relationships
against source before proposing changes, and rebuild when the source has changed.
