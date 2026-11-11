type Field = Record<string, unknown>;
type ExpenseType = 'office_space' | 'china_salary' | 'shared_admin';
type Amount = { units: bigint; scale: number };
type AmountLine = { field: Field | undefined; cells?: Field[] };
type ExpenseWarning = {
  code: 'EXPENSE_MONTH_UNRESOLVED' | 'APPLICATION_MONTH_UNRESOLVED' | 'EXPENSE_CURRENCY_UNSUPPORTED';
  expenseType: ExpenseType;
  processInstanceId: string;
  departmentNames: string[];
  month?: string;
};
const zero: Amount = { units: 0n, scale: 0 };

export const operatingExpenseFields = {
  management: '管理支出Gastos de operación',
  office: '办公场地总费用Gastos de local de oficinas',
  salary: '工资中国Salario en China',
  sharedAdmin: '平摊人事+财务管理费用',
};

const requestDateField = '申请日期Fecha de solicitud';
const expenseMonthField = '费用所属月份';
const descriptionFields = new Set(['事项说明', '事项说明Explicación de asuntos']);
const officeTableId = 'TableField_9KUR3Y1BQYW0';
const officeDepartmentId = '1089990115';
const officeDetailValues = new Set(['租金Alquiler', '电费Electricidad']);

export interface OperatingExpenseForm {
  processInstanceId: string;
  formComponentValues: unknown;
}

export interface ExpenseMonthRange {
  startMonth: string;
  endMonth: string;
}

function records(value: unknown): Field[] {
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch { return []; }
  }
  return Array.isArray(value)
    ? value.filter((item): item is Field => item !== null && typeof item === 'object' && !Array.isArray(item))
    : [];
}

function name(field: Field): string {
  return String(field.name || field.label || '').trim();
}

function findCell(cells: Field[], keywords: string[]) {
  return cells.find(cell => {
    const label = String(cell.label || cell.name || '').toLowerCase();
    return keywords.some(keyword => label.includes(keyword));
  });
}

function* detailRows(form: Field[]) {
  for (const table of form) {
    if (!/明细|detalle/i.test(String(table.label || table.name || ''))) continue;
    for (const row of records(table.value)) {
      if (!Array.isArray(row.rowValue)) continue;
      const cells = records(row.rowValue);
      const department = findCell(cells, ['部门名称', '部门', 'departamento']);
      const identity = records(department?.extendValue)[0];
      const value = department?.value;
      const departmentName = (typeof value === 'string' ? value.trim() : '')
        || String(identity?.name || identity?.label || '').trim();
      if (departmentName) yield { departmentName, cells };
    }
  }
}

function parseAmount(value: unknown, allowThousands = false): Amount | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let text = String(value).trim();
  if (allowThousands && /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  const digits = whole + fraction;
  if (!digits) return null;
  const scale = fraction.length - Number(exponent);
  // Keep resource use bounded even when a malformed approval contains a huge exponent.
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 100 || digits.length > 100
      || (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value))) {
    throw new Error('Unsupported operating expense amount precision');
  }
  const units = BigInt(sign === '-' ? '-' + digits : digits);
  return scale < 0 ? { units: units * 10n ** BigInt(-scale), scale: 0 } : { units, scale };
}

function add(a: Amount, b: Amount): Amount {
  const scale = Math.max(a.scale, b.scale);
  return { units: a.units * 10n ** BigInt(scale - a.scale) + b.units * 10n ** BigInt(scale - b.scale), scale };
}

function decimalString(amount: Amount): string {
  if (!amount.scale) return amount.units.toString();
  const negative = amount.units < 0;
  const digits = (negative ? -amount.units : amount.units).toString().padStart(amount.scale + 1, '0');
  return (negative ? '-' : '') + digits.slice(0, -amount.scale) + '.' + digits.slice(-amount.scale);
}

const foreignCurrency = /\b(?:MXN|USD|EUR|HKD|GBP|JPY|COP|PEN|CLP|BRL|VES|KRW|CAD|AUD|TWD|SGD|CHF|INR|THB|VND|IDR|MYR|AED|SAR|ZAR|RUB|ARS|NZD)\b|比索|美元|美金|欧元|港[币幣元]|英镑|日[元圆]|韩元|加元|澳元|台币|泰铢|日圓|peso|d[oó]lar|dollar|MX\$|US\$/i;
const cnyCurrency = /\b(?:CNY|RMB|CNH|yuan)\b|人民币|(?:^|[（(])元(?:[）)]|$)/i;
const currencyField = /^(?:(?:币种|货币(?:类型|种类)?)(?:currency|moneda|tipodemoneda)?|currency|moneda|tipodemoneda)$/i;

function declaredCurrencies(fields: Field[]): string[] {
  return fields.filter(field => currencyField.test(name(field).replace(/\s+/g, '')))
    .map(field => typeof field.value === 'string' ? field.value.trim() : '').filter(Boolean);
}

function hasValue(field: Field | undefined): field is Field {
  return !!field && (typeof field.value === 'number' || (typeof field.value === 'string' && !!field.value.trim()));
}

function cnySubtotal(lines: Iterable<AmountLine>, formCurrencies: string[], allowThousands = false) {
  let amount = zero;
  let hasAmount = false;
  let currencyUnresolved = false;
  for (const { field, cells } of lines) {
    if (!hasValue(field)) continue;
    const explicit = [field.currency, field.currencyCode, ...declaredCurrencies(cells ?? [])]
      .filter((value): value is string => typeof value === 'string' && !!value.trim());
    const hints = [field.label, field.name, field.unit, field.value]
      .filter((value): value is string => typeof value === 'string'
        && (foreignCurrency.test(value) || cnyCurrency.test(value)));
    // Row/component metadata describes the selected amount. A form-level currency can describe a different payment amount.
    const evidence = [...explicit, ...hints];
    if ((evidence.length ? evidence : formCurrencies)
      .some(value => foreignCurrency.test(value) || !cnyCurrency.test(value.trim()))) {
      currencyUnresolved = true;
      continue;
    }
    const parsed = parseAmount(field.value, allowThousands);
    if (parsed) {
      amount = add(amount, parsed);
      hasAmount = true;
    }
  }
  return { amount, hasAmount, currencyUnresolved };
}

function* officeLines(form: Field[]): Generator<AmountLine> {
  for (const table of form) {
    if (table.id !== officeTableId) continue;
    for (const row of records(table.value)) {
      if (!Array.isArray(row.rowValue)) continue;
      const cells = records(row.rowValue);
      const department = cells.find(cell => cell.label === '部门');
      const identity = records(department?.extendValue)[0];
      const detail = cells.find(cell => cell.label === '费用明细Detalle de gastos')?.value;
      if (String(identity?.id || identity?.itemId || '').trim() !== officeDepartmentId
          || typeof detail !== 'string' || !officeDetailValues.has(detail)) continue;
      yield { field: cells.find(cell => cell.label === '金额（元）Monto (yuan)'), cells };
    }
  }
}

function monthFromDate(value: string): string | null {
  if (!/^(?!0000)\d{4}-(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(value)) return null;
  const date = new Date(value + 'T00:00:00Z');
  return Number.isFinite(date.getTime()) && date.toISOString().slice(0, 10) === value ? value.slice(0, 7) : null;
}

const chineseMonth = /(?<!\d)(\d{4})\s*年\s*(\d{1,2})\s*月(?:份)?/g;

function parseExpenseMonth(value: string): string | null {
  const chinese = /^(\d{4})\s*年\s*(\d{1,2})\s*月(?:份)?$/.exec(value);
  const iso = chinese ? chinese[1] + '-' + chinese[2].padStart(2, '0') : value;
  return monthFromDate(iso.length === 7 ? iso + '-01' : iso);
}

function sharedAdminMonth(form: Field[]): string | null {
  const explicit = form.filter(field => name(field) === expenseMonthField)
    .map(field => typeof field.value === 'string' ? field.value.trim() : '').filter(Boolean);
  const descriptions = form.flatMap(field => descriptionFields.has(name(field)) && typeof field.value === 'string'
    ? [...field.value.matchAll(chineseMonth)].map(match => match[0]) : []);
  const months = new Set((explicit.length ? explicit : descriptions).map(parseExpenseMonth));
  return months.size === 1 ? [...months][0] : null;
}

function applicationMonth(form: Field[], inRange: (month: string) => boolean) {
  const values = form.filter(field => field.name === requestDateField)
    .map(field => typeof field.value === 'string' ? field.value.trim() : '').filter(Boolean);
  const isoDates = values.map(value => value.replace(/^(\d{4})(\d{2})(\d{2})$/, '$1-$2-$3'));
  const months = new Set(isoDates.map(monthFromDate));
  const outOfRange = isoDates.length > 0 && isoDates.every(value => {
    const prefix = /^(?!0000)(\d{4})-(0?[1-9]|1[0-2])(?:-|$)/.exec(value);
    return prefix !== null && !inRange(prefix[1] + '-' + prefix[2].padStart(2, '0'));
  });
  return { month: months.size === 1 ? [...months][0] : null, outOfRange };
}

export function summarizeOperatingExpenses(forms: OperatingExpenseForm[], range: ExpenseMonthRange) {
  const totals = new Map<string, {
    expenseType: ExpenseType; month: string; departmentName: string | null; amount: Amount; approvalCount: number;
  }>();
  const warnings: ExpenseWarning[] = [];
  const inRange = (month: string) => month >= range.startMonth && month <= range.endMonth;

  function accumulate(expenseType: ExpenseType, month: string, departmentName: string | null, amount: Amount) {
    const key = JSON.stringify([expenseType, month, departmentName]);
    const total = totals.get(key);
    if (total) {
      total.amount = add(total.amount, amount);
      total.approvalCount++;
    } else {
      totals.set(key, { expenseType, month, departmentName, amount, approvalCount: 1 });
    }
  }

  for (const row of forms) {
    const form = records(row.formComponentValues);
    const formCurrencies = declaredCurrencies(form);
    const warn = (code: ExpenseWarning['code'], expenseType: ExpenseType, departmentNames: string[], month?: string) => {
      warnings.push({ code, expenseType, processInstanceId: row.processInstanceId, departmentNames,
        ...(month ? { month } : {}) });
    };
    const kinds = new Set(form.filter(field => field.name === operatingExpenseFields.management).map(field => field.value));
    if (kinds.has(operatingExpenseFields.office) || kinds.has(operatingExpenseFields.salary)) {
      const { month, outOfRange } = applicationMonth(form, inRange);
      if (!outOfRange) {
        if (kinds.has(operatingExpenseFields.office)) {
          const lines = [...officeLines(form)].filter(line => hasValue(line.field));
          if (lines.length && !month) {
            warn('APPLICATION_MONTH_UNRESOLVED', 'office_space', []);
          } else if (month) {
            const subtotal = cnySubtotal(lines, formCurrencies);
            if (subtotal.amount.units !== 0n) accumulate('office_space', month, null, subtotal.amount);
            if (subtotal.currencyUnresolved) warn('EXPENSE_CURRENCY_UNSUPPORTED', 'office_space', [], month);
          }
        }
        if (kinds.has(operatingExpenseFields.salary)) {
          const salaries = new Map<string, AmountLine[]>();
          for (const { departmentName, cells } of detailRows(form)) {
            const field = findCell(cells, ['金额', 'monto', 'importe']);
            if (!hasValue(field)) continue;
            const lines = salaries.get(departmentName) ?? [];
            lines.push({ field, cells });
            salaries.set(departmentName, lines);
          }
          if (!month && salaries.size) {
            warn('APPLICATION_MONTH_UNRESOLVED', 'china_salary', [...salaries.keys()].sort());
          } else if (month) {
            const unknownCurrencies = [];
            for (const [departmentName, lines] of salaries) {
              const subtotal = cnySubtotal(lines, formCurrencies);
              if (subtotal.hasAmount) accumulate('china_salary', month, departmentName, subtotal.amount);
              if (subtotal.currencyUnresolved) unknownCurrencies.push(departmentName);
            }
            if (unknownCurrencies.length) warn('EXPENSE_CURRENCY_UNSUPPORTED', 'china_salary', unknownCurrencies.sort(), month);
          }
        }
      }
    }

    const sharedLines = form.filter(field => name(field) === operatingExpenseFields.sharedAdmin && hasValue(field));
    if (!sharedLines.length) continue;
    const month = sharedAdminMonth(form);
    if (month && !inRange(month)) continue;
    const shared = cnySubtotal(sharedLines.map(field => ({ field })), formCurrencies, true);
    if (shared.amount.units === 0n && !shared.currencyUnresolved) continue;
    const departments = [...new Set([...detailRows(form)].map(row => row.departmentName))].sort();
    if (!departments.length) continue;
    if (month) {
      if (shared.amount.units !== 0n) {
        for (const department of departments) accumulate('shared_admin', month, department, shared.amount);
      }
      if (shared.currencyUnresolved) warn('EXPENSE_CURRENCY_UNSUPPORTED', 'shared_admin', departments, month);
    } else {
      warn('EXPENSE_MONTH_UNRESOLVED', 'shared_admin', departments);
    }
  }

  return {
    data: [...totals.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([, item]) => ({
      ...item, amount: decimalString(item.amount), currency: 'CNY' as const,
    })),
    warnings,
  };
}
