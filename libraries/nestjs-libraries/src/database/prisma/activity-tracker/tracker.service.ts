// Activity tracker (api.activity-tracker): checks an uploaded batch activity by activity and stores what is valid.
import { HttpException, Injectable } from '@nestjs/common';
import { TrackerBatchDto } from '@gitroom/nestjs-libraries/dtos/activity-tracker/tracker.batch.dto';
import {
  CleanActivity,
  cleanActivity,
  cleanEnvelope,
} from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.clean';
import { TrackerRepository } from '@gitroom/nestjs-libraries/database/prisma/activity-tracker/tracker.repository';

// The key of a session in the database: its device and the session id the app made.
const sessionKeyOf = (deviceId: string, session: string) =>
  `${deviceId}:${session}`;

// Whether an activity was cleaned to a row, as opposed to dropped.
const isClean = (a: CleanActivity | null): a is CleanActivity => a !== null;

// Receives the repository that stores devices, sessions and activities.
@Injectable()
export class TrackerService {
  constructor(private _tracker: TrackerRepository) {}

  // Stores a batch: its valid activities, the device and session rollups, and the device's user when the token gave one.
  async store(body: TrackerBatchDto, userId?: string) {
    const now = Date.now();
    const ok = body.activities
      .map((raw) => cleanActivity(raw, now))
      .filter(isClean);
    if (!ok.length) {
      throw new HttpException({ msg: 'No valid activities' }, 400);
    }
    const { deviceId } = body;
    const rows = ok.map(({ session, ...activity }) => ({
      ...activity,
      deviceId,
      userId: userId ?? null,
      sessionKey: sessionKeyOf(deviceId, session),
    }));
    const accepted = await this._tracker.insertActivities(rows);
    // createMany does not say which rows it skipped, and a retried batch is skipped in full. So the rollups add
    // the share of the valid rows that were new: nothing for a full retry, all of them for a first upload.
    const share = (n: number) => Math.round((n * accepted) / ok.length);
    const errors = ok.filter((a) => a.kind === 'error').length;
    await this._tracker.upsertDevice(
      deviceId,
      cleanEnvelope(body.app, body.device),
      new Date(now),
      share(ok.length),
      share(errors)
    );
    const bySession = new Map<string, CleanActivity[]>();
    for (const activity of ok) {
      const list = bySession.get(activity.session) ?? [];
      list.push(activity);
      bySession.set(activity.session, list);
    }
    for (const [session, activities] of bySession) {
      await this.mergeSession(deviceId, session, activities, userId, share);
    }
    if (userId) {
      const email = await this._tracker.userEmail(userId);
      await this._tracker.linkDevice(deviceId, userId, email);
      await this._tracker.claimDevice(deviceId, userId);
    }
    return {
      accepted,
      duplicates: ok.length - accepted,
      dropped: body.activities.length - ok.length,
    };
  }

  // Adds one batch's activities of a session to the session's stored rollup: its time span, first and last screen, entry source and counts.
  private async mergeSession(
    deviceId: string,
    session: string,
    activities: CleanActivity[],
    userId: string | undefined,
    share: (n: number) => number
  ) {
    const bySeq = [...activities].sort((a, b) => a.seq - b.seq);
    const withScreen = bySeq.filter((a) => a.screen !== null);
    const withBuild = bySeq.filter((a) => a.appBuild !== null);
    const entry = bySeq.find(
      (a) => a.name === 'app_open' || a.name === 'app_foreground'
    );
    const startedAt = new Date(
      Math.min(...activities.map((a) => a.startedAt.getTime()))
    );
    const endedAt = new Date(
      Math.max(...activities.map((a) => (a.endedAt ?? a.startedAt).getTime()))
    );
    const existing = await this._tracker.findSession(
      sessionKeyOf(deviceId, session)
    );
    // The schema keeps no last seq, so the last screen moves only when this batch ends at or after the stored end.
    const isLater =
      !existing || endedAt.getTime() >= existing.endedAt.getTime();
    await this._tracker.upsertSession({
      key: sessionKeyOf(deviceId, session),
      deviceId,
      userId: existing?.userId ?? userId ?? null,
      session,
      startedAt:
        existing && existing.startedAt.getTime() < startedAt.getTime()
          ? existing.startedAt
          : startedAt,
      endedAt:
        existing && existing.endedAt.getTime() > endedAt.getTime()
          ? existing.endedAt
          : endedAt,
      entrySource: existing?.entrySource ?? entry?.source ?? null,
      firstScreen: existing?.firstScreen ?? withScreen[0]?.screen ?? null,
      lastScreen:
        (isLater ? withScreen[withScreen.length - 1]?.screen : undefined) ??
        existing?.lastScreen ??
        null,
      activityCount:
        (existing?.activityCount ?? 0) + share(activities.length),
      errorCount:
        (existing?.errorCount ?? 0) +
        share(activities.filter((a) => a.kind === 'error').length),
      appBuild:
        withBuild[withBuild.length - 1]?.appBuild ?? existing?.appBuild ?? null,
    });
  }
}
