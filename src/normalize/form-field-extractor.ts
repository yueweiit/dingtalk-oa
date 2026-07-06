import type { FormComponentValue } from '../dingtalk/types.js';
import { upsertFormField } from '../db/queries/form-field.js';
import type pg from 'pg';

export interface ExtractedField {
  field_id: string;
  field_name: string;
  field_type: string | null;
  raw_payload: any;
}

/**
 * 从 formComponentValues 提取字段元数据
 */
export function extractFormFields(formComponentValues: FormComponentValue[]): ExtractedField[] {
  const fields: ExtractedField[] = [];

  for (const component of formComponentValues) {
    if (component.id) {
      fields.push({
        field_id: component.id,
        field_name: component.name || '',
        field_type: component.componentType ?? null,
        raw_payload: component,
      });
    }
  }

  return fields;
}

/**
 * 批量保存表单字段元数据
 * 使用 SAVEPOINT 隔离每个字段的错误，避免单个字段失败导致整个事务回滚
 */
export async function saveFormFields(
  corp_id: string,
  process_code: string,
  formComponentValues: FormComponentValue[],
  client?: pg.PoolClient
): Promise<void> {
  const fields = extractFormFields(formComponentValues);

  for (let i = 0; i < fields.length; i++) {
    const field = fields[i];
    const savepoint = `sp_field_${i}`;
    try {
      if (client) {
        await client.query(`SAVEPOINT ${savepoint}`);
      }
      await upsertFormField({
        corp_id,
        process_code,
        field_id: field.field_id,
        field_name: field.field_name,
        field_type: field.field_type,
        raw_payload: field.raw_payload,
      }, client);
    } catch (error) {
      console.error(`[FormFieldExtractor] 保存表单字段失败: ${field.field_id}`, error);
      if (client) {
        await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
      }
    }
  }
}
