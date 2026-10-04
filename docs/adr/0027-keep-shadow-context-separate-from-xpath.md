# Keep open-shadow context separate from tree-local XPath

Dynamically inserted controls can be visible inside open shadow roots even when their host has zero area. Capture and verification now traverse those roots, preserving composed accessibility, naming, clipping, privacy and passive behavior under the existing aggregate budgets.

Each candidate and found target carries an optional ordered `shadowChain` of host XPaths and labels. A frame owner inside a root carries that context on its frame-chain entry. Enter each actual host root before evaluating the next XPath. Chromium evaluates standard XPath natively within a shadow tree using its first element as context; the `ShadowRoot` node itself is not a supported XPath context. Each expression must uniquely identify the original live node in its own tree. Slotted light-DOM targets keep their document XPath.

This extends [ADR-0012](0012-keep-frame-context-separate-from-xpath.md) without inventing compound XPath syntax or flattening a copied DOM, which would lose usable node identity. Dynamic membership, host-locator and root replacement changes invalidate retained captures. Closed roots remain unsupported and cannot be reliably identified; supported-tree completeness must not imply access to them.
