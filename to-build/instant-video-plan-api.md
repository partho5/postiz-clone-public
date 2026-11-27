# Instant video plan: session API (built in IV2, web 60731462)

Every route below is under `/content-plan`. Any member may read; the other routes are admin only and answer 403
`ADMIN_REQUIRED` to anyone else. Exact types are in `libraries/nestjs-libraries/src/dtos/content-plan/content.plan.schema.ts`.

## PlanSessionView
```
{ id, kind: 'video_set', status: 'ASKING'|'PROPOSING'|'PROPOSED'|'DONE'|'DISCARDED', canEdit: boolean,
  sourceText: string|null, summary: string|null,
  options: { date: 'YYYY-MM-DD', count: number, countSet: boolean } | null,
  busy: string|null, notice: string|null ('proposal_failed'),
  round: PlanSessionRoundView|null, rounds: PlanSessionRoundView[],
  proposalVersion: number,
  proposal: { videos: { ref, title, why, beats: {hook, say}[], closingLine, date }[] } | null }
```
- `PlanSessionRoundView` is `{ id, index, summary, questions: PlanQuestion[], answers: PlanAnswer[]|null, readyForPlan }`.
- `PlanQuestion` is `{ id, text, options: {id, label}[], recommendedOptionId, multiple?, recommendedOptionIds? }`.
- `proposal` is set only while the status is PROPOSED, with the videos in date order.

## Routes
| Route | Request | Response |
|---|---|---|
| `GET /sessions/open?kind=video_set` | query `kind` | 200 the latest open session (ASKING, PROPOSING or PROPOSED), or `null` |
| `GET /sessions/:id` | none | 200 view; 404 `SESSION_NOT_FOUND` |
| `POST /sessions` | `{ kind: 'video_set', sourceText (1..8000), options?: { date?: 'YYYY-MM-DD', count?: 1..7 } }` | 200 view, ASKING. For a clear idea, `round.questions` is `[]` and `readyForPlan` is true. |
| `POST /sessions/:id/answer` | `{ roundId, summary (1..6000), answers: { questionId, optionId: string\|null, optionIds?: string[], other: string\|null }[] }` | 200 view with the next round. An earlier `roundId` rewinds. |
| `POST /sessions/:id/propose` | `{ summary, answers?: as above }` | 202 view, PROPOSING. Poll GET until PROPOSED. If it is back to ASKING with notice `proposal_failed`, the proposal failed. |
| `POST /sessions/:id/revise` | `{ proposalVersion, feedback (1..2000) }` | 202 view, PROPOSING. Poll; on failure it is back to PROPOSED with notice `proposal_failed`. |
| `POST /sessions/:id/confirm` | `{ proposalVersion, edits?: { dates?: { ref, date }[] } }` | 200 view, DONE. The videos are now PLANNED instant ideas in This week and on the phone. |
| `POST /sessions/:id/discard` | none | 200 view, DISCARDED. 409 `SESSION_CLOSED` if it is already DONE. |

**Count rule:** send `options.count` only when the owner changed it in the folded Options. If it's always sent, the AI
never asks for a count and a broad idea never becomes a set.

## Errors
The body is `{ statusCode, code, ... }`. A validation error is 400 `INVALID_PLAN` with `fields: [{ path, message }]`.
The paths are `date` and `count` on start, and `dates.N.ref` and `videos.N.date` on confirm.

Other codes:
- 409 `PLAN_BUSY`, `ROUND_STALE`, `PROPOSAL_STALE`, `SESSION_CLOSED`, `PLAN_NOT_ACTIVE`
- 404 `PLAN_NOT_FOUND`, `SESSION_NOT_FOUND`
- 502 `PLAN_AI_FAILED`
- 503 `PLAN_NOT_AVAILABLE`
