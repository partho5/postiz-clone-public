// ai.video-editing (L1): the trace repository. An append takes the next `seq` and tries again when another writer
// took it, a read always carries the workspace, the purge cuts by creation time. Runs on hand-made Prisma models; needs
// no database.
import { Prisma } from '@prisma/client';
import { AiVideoEditTraceRepository } from '@gitroom/nestjs-libraries/database/prisma/ai-video-edits/ai.video.edit.trace.repository';

const taken = () =>
  new Prisma.PrismaClientKnownRequestError('Unique constraint failed', { code: 'P2002', clientVersion: 'test' });

const ROW = {
  editId: 'edit-1',
  organizationId: 'org-1',
  step: 'write',
  kind: 'output',
  payload: {},
  payloadBytes: 2,
  payloadSha256: 'a'.repeat(64),
};

// A repository on a stand-in trace model.
const build = (model: Record<string, jest.Mock>) =>
  new AiVideoEditTraceRepository(
    { model: { aiVideoEditTrace: model } } as any,
    { model: { aiVideoEdit: { findUnique: jest.fn() } } } as any
  );

describe('ai.video-editing: AiVideoEditTraceRepository', () => {
  it('appends with the seq after the last one, starting at 1', async () => {
    const model = {
      findFirst: jest.fn().mockResolvedValueOnce(null).mockResolvedValueOnce({ seq: 1 }),
      create: jest.fn().mockResolvedValue({}),
    };
    const repository = build(model as any);
    await repository.append(ROW);
    await repository.append(ROW);
    expect(model.create.mock.calls.map((call) => call[0].data.seq)).toEqual([1, 2]);
  });

  it('reads the last seq again and tries once more when another writer took the number', async () => {
    const model = {
      findFirst: jest.fn().mockResolvedValueOnce({ seq: 4 }).mockResolvedValueOnce({ seq: 5 }),
      create: jest.fn().mockRejectedValueOnce(taken()).mockResolvedValueOnce({}),
    };
    await build(model as any).append(ROW);
    expect(model.create.mock.calls.map((call) => call[0].data.seq)).toEqual([5, 6]);
  });

  it('gives up with an error after five lost races, and throws any other error at once', async () => {
    const lost = { findFirst: jest.fn().mockResolvedValue({ seq: 1 }), create: jest.fn().mockRejectedValue(taken()) };
    await expect(build(lost as any).append(ROW)).rejects.toThrow('trace seq taken');
    expect(lost.create).toHaveBeenCalledTimes(5);
    const broken = { findFirst: jest.fn().mockResolvedValue(null), create: jest.fn().mockRejectedValue(new Error('down')) };
    await expect(build(broken as any).append(ROW)).rejects.toThrow('down');
    expect(broken.create).toHaveBeenCalledTimes(1);
  });

  it('reads only rows of the workspace, in seq order, narrowed by step and kind', async () => {
    const model = { findMany: jest.fn().mockResolvedValue([]) };
    const repository = build(model as any);
    await repository.list('org-1', 'edit-1');
    await repository.list('org-1', 'edit-1', { step: 'write', kind: 'output' });
    expect(model.findMany.mock.calls[0][0].where).toEqual({ editId: 'edit-1', organizationId: 'org-1' });
    expect(model.findMany.mock.calls[1][0].where).toEqual({ editId: 'edit-1', organizationId: 'org-1', step: 'write', kind: 'output' });
    expect(model.findMany.mock.calls[0][0].orderBy).toEqual({ seq: 'asc' });
  });

  it('deletes the rows created before the cutoff and answers how many', async () => {
    const model = { deleteMany: jest.fn().mockResolvedValue({ count: 7 }) };
    const cutoff = new Date('2026-11-08T00:00:00Z');
    await expect(build(model as any).deleteCreatedBefore(cutoff)).resolves.toBe(7);
    expect(model.deleteMany).toHaveBeenCalledWith({ where: { createdAt: { lt: cutoff } } });
  });
});
