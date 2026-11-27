-- Moves the setups that are still in progress onto the planning engine: a plan in SETUP or PROPOSED that has rounds becomes
-- one open PlanSession of kind 'plan', and its rounds become PlanSessionRound rows. Data only: ContentPlan and
-- ContentPlanRound are read, never changed, so nothing is lost and an older release still finds its own rows.
-- The session id is the plan id (a plan has at most one setup), which makes the move safe to run again: a plan that has its
-- session already is skipped. The round ids are kept, so a browser tab that still holds a round id keeps working.
-- With no plan in setup, or an empty table, both statements insert nothing.

-- Copy the setups. SETUP becomes ASKING and PROPOSED stays PROPOSED; a plan whose proposal job is running (busy = 'proposal',
-- a first proposal or a revise) becomes PROPOSING with the same busy value, so the job queued before the deploy finishes it.
-- A busy = 'round' belonged to a request that cannot outlive the deploy, so the session starts free. direction is the
-- owner's latest summary (the latest round's when the plan has none), and the videos a week move into the options.
INSERT INTO "PlanSession" (
    "id", "organizationId", "planId", "kind", "status", "sourceText", "summary", "options", "proposal",
    "proposalVersion", "proposalTurns", "busy", "notice", "confirmedAt", "createdAt", "updatedAt"
)
SELECT
    p."id",
    p."organizationId",
    p."id",
    'plan',
    CASE
        WHEN p."busy" = 'proposal' THEN 'PROPOSING'
        WHEN p."status" = 'PROPOSED' THEN 'PROPOSED'
        ELSE 'ASKING'
    END,
    p."sourceText",
    COALESCE(
        p."direction",
        (SELECT r."direction" FROM "ContentPlanRound" r WHERE r."planId" = p."id" ORDER BY r."index" DESC LIMIT 1)
    ),
    jsonb_build_object('videosPerWeek', p."videosPerWeek"),
    p."proposal",
    p."proposalVersion",
    p."proposalTurns",
    CASE WHEN p."busy" = 'proposal' THEN 'proposal' ELSE NULL END,
    p."notice",
    NULL,
    p."createdAt",
    p."updatedAt"
FROM "ContentPlan" p
WHERE p."status" IN ('SETUP', 'PROPOSED')
  AND EXISTS (SELECT 1 FROM "ContentPlanRound" r WHERE r."planId" = p."id")
  AND NOT EXISTS (SELECT 1 FROM "PlanSession" s WHERE s."id" = p."id");

-- Copy the rounds of those sessions, keeping their ids, indexes and the exact chat texts (the next round re-sends them byte
-- for byte). direction becomes summary.
INSERT INTO "PlanSessionRound" (
    "id", "sessionId", "index", "summary", "questions", "answers", "readyForPlan", "userTurn", "assistantTurn", "createdAt"
)
SELECT
    r."id",
    r."planId",
    r."index",
    r."direction",
    r."questions",
    r."answers",
    r."readyForPlan",
    r."userTurn",
    r."assistantTurn",
    r."createdAt"
FROM "ContentPlanRound" r
JOIN "PlanSession" s ON s."id" = r."planId" AND s."planId" = r."planId" AND s."kind" = 'plan'
ON CONFLICT DO NOTHING;
