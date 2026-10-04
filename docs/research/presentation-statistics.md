# Verified presentation statistics — 4 October 2026

| System            | Saved-page exact-target selection | Browser action + targets |
| ----------------- | --------------------------------- | ------------------------ |
| Basic resolver    | 502/569 (88.2%)                   | 159/190 (83.7%)          |
| Improved resolver | 481/569 (84.5%)                   | 176/190 (92.6%)          |
| Stagehand         | Not applicable                    | 111/190 (58.4%)          |

These saved-page scores use the fresh complete run with zero spending-limit refusals. Browser scores use 190 shared cases; Stagehand has no saved-page arm.

| Model / pinned provider                              | Browser action + targets | Saved-page exact-target selection |
| ---------------------------------------------------- | ------------------------ | --------------------------------- |
| DeepSeek V4.1 Flash / Wafer                          | 176/190 (92.6%)          | 481/569 (84.5%)                   |
| GPT-6 Luna / OpenAI                                  | 183/190 (96.3%)          | 512/569 (90.0%)                   |
| Gemini 3.8 Flash / Google AI Studio (reasoning: low) | 190/190 (100.0%)         | 547/569 (96.1%)                   |

Controlled XPath verification: **180/180**, including **22/22** saved-locator mutations and **22/22** fresh resolutions after mutation. Categories have separate denominators.

The recorded comparison runtime and image identities are unchanged. The owner subsequently selected Gemini / Google AI Studio with low reasoning as the development default; these scores remain bound to the original measured runs. The [system report](clean-evaluation-comparison.md) and [model report](model-comparison-2026-10-04.md) bind original attempts, independent labels, costs, source/image hashes and limits. Earlier interrupted results remain separate and are not used as selection-accuracy scores.
