// Feature: media-publish-url. One-off command that moves the media URLs stored in the database from an
// old public base URL to the current CLOUDFLARE_BUCKET_URL after the media host changed. A dry run
// unless --apply is given; run it again after a change of host, it only touches rows still on `from`.
import { Command, Option } from 'nestjs-command';
import { Injectable } from '@nestjs/common';
import { PrismaRepository } from '@gitroom/nestjs-libraries/database/prisma/prisma.service';
import {
  mediaBaseUrl,
  rebaseMediaUrls,
} from '@gitroom/helpers/utils/media.base.url';

// How many rows are read, and rewritten one by one, per round trip.
const BATCH = 200;

// Every column that holds an absolute media URL (or a JSON text with such URLs) written by the media,
// post (image and provider settings such as the YouTube thumbnail), channel-picture, brand avatar,
// clipping and set code.
const TARGETS = [
  { model: 'media', fields: ['path', 'thumbnail'] },
  { model: 'post', fields: ['image', 'settings'] },
  { model: 'integration', fields: ['picture'] },
  { model: 'clipping', fields: ['thumbnail'] },
  { model: 'clippingClip', fields: ['path', 'thumbnail'] },
  { model: 'organization', fields: ['avatarUrl'] },
  { model: 'sets', fields: ['content'] },
] as const;

@Injectable()
export class RebaseMediaUrls {
  constructor(
    private _db: PrismaRepository<
      | 'media'
      | 'post'
      | 'integration'
      | 'clipping'
      | 'clippingClip'
      | 'organization'
      | 'sets'
    >
  ) {}

  @Command({
    command: 'media:rebase-urls',
    describe:
      'Moves stored media URLs from an old base URL to CLOUDFLARE_BUCKET_URL (dry run unless --apply)',
  })
  async rebase(
    @Option({
      name: 'from',
      describe: 'Old base URL; several separated by commas',
      type: 'string',
      demandOption: true,
    })
    from: string,
    @Option({
      name: 'apply',
      describe: 'Write the changes; without it nothing is written',
      type: 'boolean',
      default: false,
    })
    apply: boolean,
    @Option({
      name: 'to',
      describe: 'New base URL, default CLOUDFLARE_BUCKET_URL',
      type: 'string',
    })
    to?: string
  ) {
    const target = (to || mediaBaseUrl()).replace(/\/+$/, '');
    const froms = from
      .split(',')
      .map((f) => f.trim().replace(/\/+$/, ''))
      .filter((f) => f && f !== target);

    if (!target || !froms.length) {
      console.error(
        'Nothing to do: --from is empty or equals the new base URL.'
      );
      return false;
    }

    console.log(
      `${apply ? 'APPLY' : 'DRY RUN'}: ${froms.join(', ')} -> ${target}`
    );
    for (const { model, fields } of TARGETS) {
      const rows = await this.rebaseModel(
        model,
        [...fields],
        froms,
        target,
        apply
      );
      console.log(`${model}.${fields.join('/')}: ${rows} row(s)`);
    }

    console.log(apply ? 'Done.' : 'Dry run only, run again with --apply.');
    return true;
  }

  // Rebases the given columns of every row of a model that still holds a `from` URL, in id order;
  // returns the number of rows changed (or that would change). updatedAt is kept as it was.
  private async rebaseModel(
    model: (typeof TARGETS)[number]['model'],
    fields: string[],
    froms: string[],
    to: string,
    apply: boolean
  ) {
    const delegate = this._db.model[model] as any;
    const where = {
      OR: froms.flatMap((from) =>
        fields.map((field) => ({ [field]: { contains: `${from}/` } }))
      ),
    };
    const select = {
      id: true,
      updatedAt: true,
      ...Object.fromEntries(fields.map((field) => [field, true])),
    };

    let cursor: string | undefined;
    let changed = 0;
    for (;;) {
      const rows = await delegate.findMany({
        where,
        select,
        orderBy: { id: 'asc' },
        take: BATCH,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (!rows.length) {
        return changed;
      }

      for (const row of rows) {
        const data: Record<string, string> = {};
        for (const field of fields) {
          if (typeof row[field] !== 'string') {
            continue;
          }
          const next = rebaseMediaUrls(row[field], froms, to);
          if (next !== row[field]) {
            data[field] = next;
          }
        }

        if (!Object.keys(data).length) {
          continue;
        }
        changed += 1;
        if (apply) {
          await delegate.update({
            where: { id: row.id },
            data: { ...data, updatedAt: row.updatedAt },
          });
        }
      }

      cursor = rows[rows.length - 1].id;
    }
  }
}
