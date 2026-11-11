import { withReadOnlyTransaction } from '../read-only.js';
import { operatingExpenseFields, type OperatingExpenseForm } from '../../reporting/operating-expenses.js';

export async function readOperatingExpenseForms(corpId: string, processCode: string) {
  const { management, office, salary, sharedAdmin } = operatingExpenseFields;
  return withReadOnlyTransaction(async client => {
    const { rows: scope } = await client.query<{ known: boolean }>(
      `SELECT EXISTS (
         SELECT 1 FROM public.ding_process_template WHERE corp_id = $1 AND process_code = $2
         UNION ALL
         SELECT 1 FROM public.ding_approval_instance WHERE corp_id = $1 AND process_code = $2
       ) AS known`, [corpId, processCode],
    );
    if (!scope[0]?.known) throw new Error('Operating expense template is absent from the archive');
    return (await client.query<OperatingExpenseForm>(
      `SELECT i.process_instance_id AS "processInstanceId", i.form_component_values AS "formComponentValues"
       FROM public.ding_approval_instance i
      WHERE i.corp_id = $1 AND i.process_code = $2 AND i.deleted_at IS NULL
        AND UPPER(i.status) = 'COMPLETED'
        AND LOWER(i.result) IN ('agree', 'approved', '同意', '通过')
        AND EXISTS (
          SELECT 1 FROM jsonb_array_elements(
            CASE WHEN jsonb_typeof(i.form_component_values) = 'array'
                 THEN i.form_component_values ELSE '[]'::jsonb END
          ) f(field)
          WHERE (f.field->>'name' = $3 AND f.field->>'value' IN ($4, $5))
             OR BTRIM(COALESCE(NULLIF(f.field->>'name',''), f.field->>'label')) = $6
        )
      ORDER BY i.process_instance_id`,
      [corpId, processCode, management, office, salary, sharedAdmin],
    )).rows;
  });
}
