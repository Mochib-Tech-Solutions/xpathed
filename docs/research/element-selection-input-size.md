# Compact selection JSON versus viewport DOM

Measured **6 October 2026**, at **1280 × 720**, in six fresh public-page Chromium contexts without login. Both inputs cover the same viewport. Every captured candidate remains in JSON and survives viewport-DOM serialization; **493 candidates** were retained. The same instruction is included in each input.

| Page               | Viewport DOM bytes | Original JSON bytes | Compact JSON bytes |
| ------------------ | ------------------ | ------------------- | ------------------ |
| Example Domain     | 1,516              | 2,840               | 2,232              |
| Sauce Demo         | 1,429              | 3,106               | 1,970              |
| Books to Scrape    | 9,070              | 15,100              | 7,747              |
| Hacker News        | 21,872             | 78,476              | 34,643             |
| MDN HTML reference | 15,426             | 22,404              | 11,329             |
| GitHub repository  | 49,229             | 88,400              | 69,592             |
| **Total**          | **98,542**         | **210,326**         | **127,513**        |

The compact JSON is **39.4% smaller than the original JSON**, but **29.4% larger than viewport DOM** in aggregate. Books and MDN JSON are smaller than their viewport markup; the other pages are larger. This is a small input-size sample, not evidence of better model accuracy or a universal DOM compression rate.

## Compaction

[CandidateInput](../../src/Resolver/Services/CandidateInput.cs) stores scope arrays, appearance observations and containing-frame metadata once in a shared `context` array. Candidate fields reference entries by zero-based index. Geometry becomes `[x,y,width,height]` with unchanged numbers. Default state, empty unknown appearance and redundant unlabelled capture-frame records are omitted. Existing empty-field and duplicate text/label suppression remain. IDs, names, full text, parent identities, spatial relationships, explicit state exceptions and appearance limitations are preserved. Expanding the shared values and defaults reproduced the original JSON values exactly on every measured input.

## Fair viewport baseline

The measurement reuses Browser capture's own accessibility exposure, native intersection observations, clipping, viewport and composed-parent helpers on all DOM elements. It removes off-screen descendants and text nodes, retains structural ancestors and original attributes, and serializes included open-shadow content as declarative shadow templates. Scripts, styles, noscript and ordinary templates are excluded; the baseline contains no document head. Partly visible text nodes retain their entire text rather than cropping characters. Editable content and current form values are excluded on both sides. Candidate names and scope can still contain derived reference or descendant text; JSON also supplies computed state, geometry and spatial context absent from raw markup.

A mutation observer covers the body and open roots from before candidate capture until viewport markup is serialized. Every pair had zero observed mutations; viewport/scroll stability and every candidate's membership in the serialized DOM were asserted. No sampled page had an included child frame; frame-bearing pairs are rejected by this harness. MDN and GitHub include 17 and 11 viewport shadow roots respectively. Chromium **153.0.8010.12** ran with its sandbox enabled.

The [measurement receipt](../assets/evaluation/element-selection-input-size.json) binds counts, input hashes, source hashes, the browser image and measurement scripts. Raw inputs and scripts remain under ignored `.artifacts/markup-measurement-20261006-viewport/`; earlier whole-document comparisons remain private and do not support the README claim. The capture source matches the complete-current-view implementation in main, identified by hash. The compact serializer hash binds the implementation measured here.

Local `o200k_base` proxy tokens fell from **57,871 to 35,114 (39.3%)**; viewport DOM was **29,086**. These were calculated using [tiktoken](https://github.com/openai/tiktoken) 0.9.0, and are not Gemini billing counts. System prompt, schema and protocol overhead are excluded. Model-specific billing requires the model's tokenizer, such as [Google's countTokens API](https://ai.google.dev/api/tokens). This size measurement made **zero model calls** and establishes no accuracy, latency or release-qualification claim.
