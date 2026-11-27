// ai.video-captions (AC8): what the web page's reads and writes ask the database. Every question names the workspace
// and leaves out deleted rows, so another workspace's caption, text or post is never read, changed or named. Needs no
// database: the Prisma models are stand-ins that record what they are asked.
import { Prisma } from '@prisma/client';
import { AiCaptionsRepository } from '@gitroom/nestjs-libraries/database/prisma/ai-captions/ai.captions.repository';

const ORG = 'org-1';

// The repository over models that record their calls and answer with what the test gives them.
const build = (
  answers: { count?: number; rows?: any[]; updated?: number; posts?: any[] } = {}
) => {
  const caption = {
    count: jest.fn().mockResolvedValue(answers.count ?? 0),
    findMany: jest.fn().mockResolvedValue(answers.rows ?? []),
    findFirst: jest.fn().mockResolvedValue(null),
    updateMany: jest.fn().mockResolvedValue({ count: answers.updated ?? 0 }),
  };
  const post = { findMany: jest.fn().mockResolvedValue(answers.posts ?? []) };
  const repository = new AiCaptionsRepository(
    { model: { aiCaption: caption } } as any,
    { model: { aiCaptionOutput: {} } } as any,
    { model: { mobileUpload: {} } } as any,
    { model: { post } } as any,
    { model: {} } as any
  );
  return { repository, caption, post };
};

describe('ai.video-captions: AiCaptionsRepository (the web page)', () => {
  describe('the list', () => {
    it("counts and reads only the workspace's live captions, newest first, twenty to a page", async () => {
      const h = build({ count: 41, rows: [{ id: 'cap-1' }] });

      const { items, pages } = await h.repository.listCaptions(ORG, 2);

      expect(pages).toBe(3);
      expect(items).toEqual([{ id: 'cap-1' }]);
      expect(h.caption.count).toHaveBeenCalledWith({
        where: { organizationId: ORG, deletedAt: null },
      });
      expect(h.caption.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { organizationId: ORG, deletedAt: null },
          orderBy: { createdAt: 'desc' },
          skip: 20,
          take: 20,
        })
      );
    });

    it('never selects the transcript, the segments or the texts', async () => {
      const h = build();

      await h.repository.listCaptions(ORG, 1);

      const { select } = h.caption.findMany.mock.calls[0][0];
      // updatedAt is for the service to tell a job that stopped moving; the page is not sent it
      expect(Object.keys(select).sort()).toEqual(
        ['createdAt', 'id', 'integrationIds', 'status', 'title', 'updatedAt'].sort()
      );
    });

    it('takes a page that is not a positive number as the first', async () => {
      const h = build();

      await h.repository.listCaptions(ORG, 0);
      await h.repository.listCaptions(ORG, NaN);
      await h.repository.listCaptions(ORG, -3);

      expect(h.caption.findMany.mock.calls.map(([query]) => query.skip)).toEqual([0, 0, 0]);
    });
  });

  describe('one caption', () => {
    it("reads it by id for the workspace, live only, with its texts in the order they were written", async () => {
      const h = build();

      expect(await h.repository.getCaption(ORG, 'cap-1')).toBeNull();

      expect(h.caption.findFirst).toHaveBeenCalledWith({
        where: { id: 'cap-1', organizationId: ORG, deletedAt: null },
        include: { outputs: { orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] } },
      });
    });

    it("looks the posts up in the workspace only, and not the deleted ones", async () => {
      const h = build({ posts: [{ id: 'post-1', state: 'QUEUE', publishDate: new Date() }] });

      const posts = await h.repository.postStates(ORG, ['post-1', 'post-2']);

      expect(posts).toHaveLength(1);
      expect(h.post.findMany).toHaveBeenCalledWith({
        where: { organizationId: ORG, id: { in: ['post-1', 'post-2'] }, deletedAt: null },
        select: { id: true, state: true, publishDate: true },
      });
    });
  });

  describe('a job that stopped moving', () => {
    const BEFORE = new Date('2026-10-21T10:00:00Z');

    it('ends only a job of the workspace that is still in progress and has not changed since the cutoff', async () => {
      const h = build({ updated: 1 });

      const taken = await h.repository.closeStale(ORG, 'cap-1', BEFORE, {
        status: 'FAILED',
        error: 'It failed.',
      });

      expect(taken).toBe(true);
      expect(h.caption.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'cap-1',
          organizationId: ORG,
          status: { notIn: ['READY', 'NO_SPEECH', 'FAILED'] },
          updatedAt: { lt: BEFORE },
        },
        data: { status: 'FAILED', error: 'It failed.' },
      });
    });

    it("answers false when the job moved on or ended meanwhile, or is not the workspace's", async () => {
      const h = build({ updated: 0 });

      expect(
        await h.repository.closeStale('org-2', 'cap-1', BEFORE, {
          status: 'FAILED',
          error: null,
        })
      ).toBe(false);
    });
  });

  describe('delete', () => {
    it('hides a live caption of the workspace and drops the words of the recording', async () => {
      const h = build({ updated: 1 });

      expect(await h.repository.softDeleteCaption(ORG, 'cap-1')).toBe(true);

      const [{ where, data }] = h.caption.updateMany.mock.calls[0];
      expect(where).toEqual({ id: 'cap-1', organizationId: ORG, deletedAt: null });
      expect(data).toEqual({
        deletedAt: expect.any(Date),
        transcript: null,
        segments: Prisma.DbNull,
        userText: null,
      });
    });

    it('answers false when the workspace has no such live caption', async () => {
      const h = build({ updated: 0 });

      expect(await h.repository.softDeleteCaption(ORG, 'cap-9')).toBe(false);
    });
  });
});
