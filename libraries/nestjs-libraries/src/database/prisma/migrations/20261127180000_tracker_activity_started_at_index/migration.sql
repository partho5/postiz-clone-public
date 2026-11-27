-- Activity log of every device (GET /admin/tracker/feed) reads the activities newest first with no device filter.
-- CreateIndex
CREATE INDEX "TrackerActivity_startedAt_idx" ON "TrackerActivity"("startedAt");
