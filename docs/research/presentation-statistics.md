# Verified presentation statistics for the Gemini default

The application uses **Gemini 3.8 Flash / Google AI Studio with native low reasoning**. The three-system comparison uses that profile for every arm. Improved is the enhanced implementation used by the app. We first compared model accuracy using the enhanced Resolver, selected Gemini, then compared Basic, Improved and Stagehand with Gemini held constant. The approach results below come from complete original runs against runtime `1cc50794c3269ab395640ecb829863d4434531b0`. The earlier model-selection evidence retains its measured source `d444176cd2351d85336167cd3b9e7b60114bf77e`.

| System            | Saved-page exact-target selection | Browser action + targets |
| ----------------- | --------------------------------- | ------------------------ |
| Basic resolver    | 532/569 (93.5%)                   | 182/190 (95.8%)          |
| Improved resolver | 551/569 (96.8%)                   | 190/190 (100.0%)         |
| Stagehand         | Not applicable                    | 123/190 (64.7%)          |

![System comparison using the default Gemini model](../assets/evaluation/clean-comparison.svg)

## Earlier model-selection evidence

| Model / pinned provider                              | Browser action + targets | Saved-page exact-target selection |
| ---------------------------------------------------- | ------------------------ | --------------------------------- |
| DeepSeek V4.1 Flash / Wafer                          | 176/190 (92.6%)          | 481/569 (84.5%)                   |
| GPT-6 Luna / OpenAI                                  | 183/190 (96.3%)          | 512/569 (90.0%)                   |
| Gemini 3.8 Flash / Google AI Studio (reasoning: low) | 190/190 (100.0%)         | 547/569 (96.1%)                   |

![Model-selection accuracy with the enhanced Resolver](../assets/evaluation/model-comparison.svg)

## Duration

| Category / system             | Cohort                     | Measured / attempts | Median | p95    |
| ----------------------------- | -------------------------- | ------------------- | ------ | ------ |
| browser / Basic resolver      | parallel                   | 190/190             | 1.427s | 2.676s |
| browser / Improved resolver   | parallel                   | 190/190             | 1.449s | 2.045s |
| browser / Stagehand           | parallel                   | 190/190             | 1.175s | 2.161s |
| savedPage / Basic resolver    | gemini-systems-saved-fresh | 569/569             | 1.767s | 3.775s |
| savedPage / Improved resolver | gemini-systems-saved-fresh | 569/569             | 1.763s | 3.065s |

![System duration](../assets/evaluation/system-duration.svg)

The [model-selection report](model-comparison-2026-10-04.md#accounting-and-timing) retains its earlier measured durations separately; no additional model run is included in this refresh.

Browser and saved-page duration measure different boundaries; execution cohorts remain explicit and do not establish a fastest model. Failed attempts are retained. Controlled XPath verification: **180/180**, including **22/22** saved-locator mutations and **22/22** fresh resolutions after mutation. Categories have separate denominators. Stagehand has no saved-page arm.

The [system report](clean-evaluation-comparison.md) and [model report](model-comparison-2026-10-04.md) bind original attempts, paired gains/losses, independent labels, durations, costs and actual source/image identities. Earlier completed and interrupted measurements remain historical. These are descriptive first-attempt results on an audited evaluation set, with no retries. Authored browser cases and historical saved pages have separate measurement boundaries. They do not establish unseen-site accuracy, isolate the causal effect of a prompt or model, or qualify a release. Every lost pass remains recorded.
