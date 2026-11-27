// Balance header: the query string of GET /credits/reservations goes through the backend's
// ValidationPipe (transform on), so `limit` arrives as text and must become a number or be refused with 400.
import { ValidationPipe } from '@nestjs/common';
import { ReservationsQueryDto } from '@gitroom/nestjs-libraries/database/prisma/credits/balance/credit.reservations.query.dto';

// Runs a query object through the pipe as the backend's `main.ts` configures it.
const parse = (query: Record<string, unknown>) =>
  new ValidationPipe({ transform: true }).transform(query, {
    type: 'query',
    metatype: ReservationsQueryDto,
  });

describe('ReservationsQueryDto', () => {
  it('turns a text limit into a number and keeps the cursor', async () => {
    const parsed = (await parse({ limit: '5', cursor: 'abc' })) as ReservationsQueryDto;

    expect(parsed.limit).toBe(5);
    expect(parsed.cursor).toBe('abc');
  });

  it('accepts no query at all', async () => {
    const parsed = (await parse({})) as ReservationsQueryDto;

    expect(parsed.limit).toBeUndefined();
    expect(parsed.cursor).toBeUndefined();
  });

  it.each(['1', '50'])('accepts the limit %s at the edge of the range', async (limit) => {
    const parsed = (await parse({ limit })) as ReservationsQueryDto;

    expect(parsed.limit).toBe(Number(limit));
  });

  it.each(['0', '51', '-1', '1.5', 'abc'])(
    'refuses the limit %s with 400',
    async (limit) => {
      await expect(parse({ limit })).rejects.toMatchObject({ status: 400 });
    }
  );
});
