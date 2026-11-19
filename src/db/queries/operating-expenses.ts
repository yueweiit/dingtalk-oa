import { withReadOnlyTransaction } from '../read-only.js';
import { operatingExpenseFields, type ExpenseMonthRange, type OperatingExpenseForm } from '../../reporting/operating-expenses.js';

export async function readOperatingExpenseForms(corpId: string, processCode: string, payrollRange?: ExpenseMonthRange) {
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
      `SELECT i.process_instance_id AS "processInstanceId", i.form_component_values AS "formComponentValues",
              to_char(i.create_time AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM') AS "submittedMonth"
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
             OR ($7::date IS NOT NULL AND (
                   i.create_time IS NULL OR (
                     i.create_time >= ($7::date::timestamp AT TIME ZONE 'Asia/Shanghai')
                     AND i.create_time < (($8::date + interval '2 months') AT TIME ZONE 'Asia/Shanghai')
                   )
                 ) AND BTRIM(COALESCE(NULLIF(f.field->>'name',''), f.field->>'label')) ~ '^(税费|管理支出)'
                 AND (f.field->>'value') ~ '(个税|个人所得税|公积金)')
        )
      ORDER BY i.process_instance_id`,
      [corpId, processCode, management, office, salary, sharedAdmin,
        payrollRange ? payrollRange.startMonth + '-01' : null, payrollRange ? payrollRange.endMonth + '-01' : null],
    )).rows;
  });
}
