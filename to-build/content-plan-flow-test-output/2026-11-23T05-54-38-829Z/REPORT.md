# Content plan flow test

Run: 2026-11-23T05:57:09.767Z | model muse-spark-1.3-contributor | videosPerWeek 3 | setup rounds 3 | prompts read from /home/haku/projects/Next.js/Social-Media-Manager/to-build/tasks.md

## Calls
| # | Step | Prompt tokens | Cached | Completion | Seconds |
|---|---|---|---|---|---|
| 01 | setup-round-0 | 729 | 0 | 1179 | 10.5 |
| 02 | setup-round-1 | 1268 | 625 | 1322 | 10.5 |
| 03 | setup-round-2 | 1633 | 1265 | 934 | 5.8 |
| 04 | proposal-structure | 855 | 0 | 5174 | 29.1 |
| 05 | roadmap-ideas | 1423 | 0 | 3120 | 19 |
| 06 | outline-week-1 | 998 | 0 | 1123 | 8.8 |
| 07 | outline-week-2 | 998 | 881 | 1132 | 7.5 |
| 08 | outline-week-3 | 993 | 881 | 1390 | 9.8 |
| 09 | outline-week-4 | 989 | 881 | 1259 | 10.1 |
| 10 | week-1 | 1590 | 0 | 7716 | 39.8 |

Total: prompt 11476, cached 4533, completion 24349.

## Checks
- [x] 12 weekly ideas, all different
- [x] exactly 3 videos on the SLOT_DAYS offsets [0,2,4]
- [x] every video has 4 beats (4,4,4)
- [x] every hook is at most 100 characters
- [x] outline titles were kept as the video titles (true,true,true)
- [x] no number appears that is not in the owner text (possible invention)
- [x] spoken text is near the 138-word estimate (whitespace count, only meaningful for languages written with spaces) (134, 133, 141 words)
- [x] later outline calls reuse the cached shared start (cached > 0) (0, 881, 881, 881)
- [x] same language as the owner text (NOT CHECKED BY CODE: read the output)
- [x] stories and examples are openly hypothetical (NOT CHECKED BY CODE: read the output)

## Where tasks.md was silent (the script had to choose)
1. The answer turn of a setup round. tasks.md B3 says the owner's answers are sent as question and option IDs (q1, o2), but the model never sees those IDs (they are made by code after the call). The script sends the question text and the chosen option text instead. tasks.md needs this fixed.
2. The LLM-facing JSON shape of every answer (questions with options and a recommended index, ideas, outline titles, the week) and the `.describe()` field hints. tasks.md only says the hints are "written with the schemas in B2".
3. The brand-context layout beyond the four labels (script: "Label: value" blocks, facts as JSON). Which brand context the proposal-time calls use (script: none during the structure chat, direction + proposed facts for ideas, outlines and the week).
4. How the ANGLE_HINTS text is appended to a frame (script: a blank line between them).
5. The key names inside each task message (script: slots[{angle}] for the outline; the week input keys follow B2 exactly).
6. Setup in a non-interactive test (script: answer every question with its recommended option, stop at readyForPlan or after the round limit).

## Files
Each call's exact messages and output: the numbered .json files. The plan: plan.json. What the phone reads: phone-json.json.
