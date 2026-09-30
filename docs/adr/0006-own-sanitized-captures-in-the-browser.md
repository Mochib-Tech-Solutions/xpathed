# Keep sanitized captures and node identity in the browser

Browser retains one temporary candidate-to-node map per managed page and exposes only serialized sanitized records. Native semantic snapshots can contain form values and do not guarantee this product's candidate coverage, so the initial strategy uses an explicit DOM representation with separate capture and model-input coverage. Selection is verified against the retained nodes before XPath is returned; incomplete processing is an operational error, and navigation invalidates the capture instead of triggering automatic recovery.
