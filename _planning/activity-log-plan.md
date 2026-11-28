# Activity log view (super admin) — plan

Goal: /super-admin/activity reads like a diary, in time order, grouped by date:

    27/11/2026
    8:12:03 AM | app opened (cold start)
    8:12:07 AM | menu bar on
    8:12:09 AM | clicked record
    8:13:55 AM | recording stopped (1 m 46 s)

Owner decisions (2026-11-27):
- The Activity tab opens straight on the log across all devices. Clicking a user filters the log to that device.
  The device page (/super-admin/activity/[deviceId]) shows the same log for that device.
- Newest day first; inside a day the lines run oldest to newest (story order). Load more adds older days.
- Time as `8:12:03 AM` in the user's phone clock (row startedAt shifted by its tz). Date as DD/MM/YYYY.
- Stat tiles, top features, top errors, drop-off, entry sources and the device table move into a closed "Summary".

App data check: every row has ms time, tz, session, screen, name, description, meta. A recording is one span row
(start + end), so "recording stopped" is drawn from its end time. Double tap is only logged as
`toggle — menu bar (on)`; recording the gesture needs an app change in MainActivity (recording screen, off-limits
now), left as a follow-up.

## Tasks
- [x] T1 Backend: `GET /admin/tracker/feed?deviceId&cursor&at&limit` (controller → service → repository).
      Newest first by (startedAt, seq, id); id cursor; `at` starts the page at that activity; returns
      `{ items, devices, device, nextCursor }` (devices = email/model/os of the devices on the page).
      Spec cases in tracker.service.spec.ts.
- [x] T2 Frontend hook `useTrackerFeed` + types in tracker.hooks.ts.
- [x] T3 `TrackerLog` component (tracker.log.tsx): day groups, story order, session divider with user + model
      (click filters), sentence per row, span end lines, red error lines that expand to the stack, Load more.
- [x] T4 Activity tab: log first; overview + device table inside a closed Summary. Filtering to one device = the
      user link on a session divider, which opens the device page (same log), so no `?device=` chip was needed.
- [x] T5 Device page: device header + TrackerLog for that device; `?at=` opens the log at that activity (Top errors).
      Remove the session list / per-session timeline UI it replaces.
- [x] T6 Translation keys, spec run, lint/typecheck of changed files, pattern check by a sub agent, commit.
      Review fixes: dayjs utc for time/date, one section per day (devices in other zones), `@@index([startedAt])`
      + migration for the all-devices log, 404 for an unknown `at`, the `at` screen row always shown, and the
      unused `/admin/tracker/sessions` + `/timeline` routes removed with their service/repository methods.
