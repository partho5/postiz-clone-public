# Content plan flow test

Run: 2026-11-23T06:20:54.130Z | model muse-spark-1.3-contributor | videosPerWeek 3 | setup rounds 3 | prompts read from /home/haku/projects/Next.js/Social-Media-Manager/to-build/tasks.md

## Calls
| # | Step | Prompt tokens | Cached | Completion | Seconds |
|---|---|---|---|---|---|
| 01 | setup-round-0 | 824 | 753 | 1353 | 11.2 |
| 02 | setup-round-1 | 1245 | 753 | 983 | 7.4 |
| 03 | setup-round-2 | 1623 | 1137 | 735 | 5.3 |
| 04 | proposal-structure | 1081 | 0 | 3397 | 17.9 |
| 05 | roadmap-ideas | 1470 | 241 | 4180 | 25.7 |
| 06 | outline-week-1 | 1035 | 241 | 1663 | 8.2 |
| 07 | outline-week-2 | 1038 | 881 | 1725 | 10.1 |
| 08 | outline-week-3 | 1037 | 881 | 2345 | 13.5 |
| 09 | outline-week-4 | 1041 | 881 | 970 | 6.1 |
| 10 | week-1 | 1740 | 0 | 8789 | 43.3 |

Total: prompt 12134, cached 5768, completion 26140.

## Checks
- [x] 12 weekly ideas, all different
- [x] exactly 3 videos on the SLOT_DAYS offsets [0,2,4]
- [x] every video has 4 beats (4,4,4)
- [x] every hook is at most 100 characters
- [x] outline titles were kept as the video titles (true,true,true)
- [x] no title was cut by the character limit (the model respected titleMaxChars)
- [x] no number appears that is not in the owner text (possible invention)
- [x] spoken text is near the 138-word estimate (whitespace count, only meaningful for languages written with spaces) (136, 134, 138 words)
- [x] later outline calls reuse the cached shared start (cached > 0) (241, 881, 881, 881)
- [x] same language as the owner text (NOT CHECKED BY CODE: read the output)
- [x] stories and examples are openly hypothetical (NOT CHECKED BY CODE: read the output)

## What the script had to choose itself
1. Setup in a non-interactive test: the script answers every question with its recommended option and stops at readyForPlan or after the round limit.
2. Previous ideas for the first 12 weeks are sent empty (tasks.md has them only for later top-ups).

## Files
Each call's exact messages and output: the numbered .json files. The plan: plan.json. What the phone reads: phone-json.json.
