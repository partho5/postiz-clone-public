// AI video editing (ai.video-editing), tracing: prints the readable timeline of an AI edit job from the database, read only
// (one edit read and its trace rows read; nothing is written). It prints only what the stored trace payloads hold, so a
// `meta` trace gives counts and codes and a `full` trace gives its values; the served body is included in `--json` only when
// AI_EDIT_TRACE=full is set for this run.
//
// Usage (DATABASE_URL points at the database to read):
//   DATABASE_URL=postgres://... pnpm exec ts-node --transpile-only -O '{"module":"commonjs"}' scripts/ai-edit-trace.ts <editId> [--step=<step>] [--kind=<kind>] [--json]
import { PrismaClient } from '@prisma/client';
import { bundleOf, timelineOf } from '../libraries/nestjs-libraries/src/database/prisma/ai-video-edits/ai.video.edit.trace.bundle';

// The value of `--name=value` among the arguments.
const option = (args: string[], name: string) =>
  args.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3) || undefined;

// Prints the timeline (or, with `--json`, the whole bundle) of the edit named on the command line.
const main = async () => {
  const args = process.argv.slice(2);
  const editId = args.find((a) => !a.startsWith('--'));
  if (!editId) {
    console.error('usage: ai-edit-trace.ts <editId> [--step=<step>] [--kind=<kind>] [--json]');
    process.exitCode = 2;
    return;
  }
  const prisma = new PrismaClient();
  try {
    const edit = await prisma.aiVideoEdit.findUnique({ where: { id: editId } });
    if (!edit) {
      console.error('no such edit');
      process.exitCode = 1;
      return;
    }
    const rows = await prisma.aiVideoEditTrace.findMany({
      where: { editId, organizationId: edit.organizationId },
      orderBy: { seq: 'asc' },
    });
    const bundle = bundleOf(edit, rows, {
      step: option(args, 'step'),
      kind: option(args, 'kind'),
      full: (process.env.AI_EDIT_TRACE || '').trim().toLowerCase() === 'full',
    });
    console.log(args.includes('--json') ? JSON.stringify(bundle, null, 2) : timelineOf(bundle).join('\n'));
  } finally {
    await prisma.$disconnect();
  }
};

main().catch((err) => {
  console.error(`failed: ${(err as Error)?.name}`);
  process.exitCode = 1;
});
