# Select an element before generating XPath

The primary resolver uses HTML and DOM context to ask a model to select a target element. Ordinary code then constructs XPath expressions and verifies that they resolve uniquely to that same element. This keeps XPath construction grounded in the page and separates locator validity from the model's semantic selection quality. The response represents one target and may provide alternative XPath expressions for that target; it does not present different candidate elements. Other resolution strategies remain possible for comparison.
