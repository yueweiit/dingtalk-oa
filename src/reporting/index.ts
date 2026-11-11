import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getConfig } from '../config/index.js';
import { readOperatingExpenseForms } from '../db/queries/operating-expenses.js';
import { summarizeOperatingExpenses } from './operating-expenses.js';

const month = z.string().regex(/^(?!0000)\d{4}-(0[1-9]|1[0-2])$/);
const querySchema = z.object({
  corpId: z.string().trim().min(1).max(64),
  startMonth: month,
  endMonth: month,
}).strict().refine(({ startMonth, endMonth }) => {
  const ordinal = (value: string) => Number(value.slice(0, 4)) * 12 + Number(value.slice(5));
  const span = ordinal(endMonth) - ordinal(startMonth);
  return span >= 0 && span < 12;
});

interface Dependencies {
  token?: string;
  corpId?: string;
  processCode: string;
  readForms: typeof readOperatingExpenseForms;
}

export function createOperatingExpenseRoutes(deps: Dependencies) {
  const digest = (value: string) => createHash('sha256').update(value).digest();
  const expected = deps.token ? digest(deps.token) : undefined;
  return async (fastify: FastifyInstance) => {
    fastify.get('/api/v1/reporting/operating-expenses', async (request, reply) => {
      reply.header('Cache-Control', 'no-store');
      if (!expected || !deps.corpId) {
        return reply.code(503).send({ success: false, code: 'OPERATING_EXPENSE_API_DISABLED' });
      }
      const token = /^Bearer ([A-Za-z0-9_-]{32,256})$/i.exec(request.headers.authorization ?? '')?.[1];
      if (!token || !timingSafeEqual(digest(token), expected)) {
        return reply.header('WWW-Authenticate', 'Bearer').code(401).send({ success: false, code: 'UNAUTHORIZED' });
      }
      const query = querySchema.safeParse(request.query);
      if (!query.success) return reply.code(400).send({ success: false, code: 'INVALID_REQUEST' });
      const { corpId, startMonth, endMonth } = query.data;
      if (corpId !== deps.corpId) return reply.code(403).send({ success: false, code: 'FORBIDDEN' });
      try {
        const forms = await deps.readForms(corpId, deps.processCode);
        return { success: true, corpId, startMonth, endMonth,
          ...summarizeOperatingExpenses(forms, { startMonth, endMonth }) };
      } catch {
        request.log.error({ resource: 'operating-expenses' }, 'Operating expense read failed');
        return reply.code(503).send({ success: false, code: 'OPERATING_EXPENSE_READ_UNAVAILABLE' });
      }
    });
  };
}

export async function operatingExpenseRoutes(fastify: FastifyInstance) {
  const config = getConfig();
  await createOperatingExpenseRoutes({
    token: config.OPERATING_EXPENSE_API_TOKEN,
    corpId: config.OPERATING_EXPENSE_API_CORP_ID,
    processCode: config.OPERATING_EXPENSE_API_PROCESS_CODE,
    readForms: readOperatingExpenseForms,
  })(fastify);
}
