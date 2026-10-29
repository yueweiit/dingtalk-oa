import { z } from 'zod';

const identifiers = z.array(z.string().trim().min(1).max(128)).min(1).max(500)
  .refine(values => new Set(values).size === values.length, 'duplicate identifiers');

export const readApiClientSchema = z.object({
  clientId: z.string().regex(/^[a-zA-Z0-9_-]{1,64}$/),
  tokenSha256: z.string().regex(/^[a-fA-F0-9]{64}$/).transform(value => value.toLowerCase()),
  corpIds: identifiers,
  processCodes: identifiers.optional(),
}).strict();

export type ReadApiClient = z.infer<typeof readApiClientSchema>;

export const readApiClientsSchema = z.string().default('[]').transform((value, context) => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a JSON client array' });
    return z.NEVER;
  }
  const result = z.array(readApiClientSchema).max(100).safeParse(parsed);
  if (!result.success) {
    // Never echo config values: this field contains credential digests and access policy.
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'invalid read API client configuration' });
    return z.NEVER;
  }
  const clients = result.data;
  if (new Set(clients.map(client => client.clientId)).size !== clients.length
    || new Set(clients.map(client => client.tokenSha256)).size !== clients.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: 'duplicate read API client or token digest' });
    return z.NEVER;
  }
  return clients;
});
