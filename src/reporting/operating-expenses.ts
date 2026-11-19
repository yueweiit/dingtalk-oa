type Field = Record<string, unknown>;
type PayrollSupplement = 'individual_income_tax' | 'employer_contributions';
type ExpenseType = 'office_space' | 'china_salary' | 'shared_admin' | PayrollSupplement;
type Amount = { units: bigint; scale: number };
type AmountLine = { field: Field | undefined; cells?: Field[]; currencies?: string[] };
type ExpenseWarning = {
  code: 'EXPENSE_MONTH_UNRESOLVED' | 'APPLICATION_MONTH_UNRESOLVED' | 'EXPENSE_CURRENCY_UNSUPPORTED' | 'PAYROLL_DETAIL_UNRESOLVED';
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
  submittedMonth?: string | null;
}

export interface ExpenseMonthRange {
  startMonth: string;
  endMonth: string;
}

function decode(value: unknown): unknown {
  if (typeof value !== 'string') return value;
  const text = value.trim();
  if (text.startsWith('[') || text.startsWith('{') || text.startsWith('"')) {
    try { return JSON.parse(text); } catch { /* Keep malformed input distinguishable from an empty field. */ }
  }
  return text;
}

function list(value: unknown): unknown[] {
  const parsed = decode(value);
  return Array.isArray(parsed) ? parsed : [];
}

function records(value: unknown): Field[] {
  return list(value).filter((item): item is Field => item !== null && typeof item === 'object' && !Array.isArray(item));
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

// null is an empty selector; an empty string is a filled but unresolved selector.
function departmentName(department?: Field): string | null {
  const names = new Set<string>();
  const ids = new Set<string>();
  const displayValues = new Set<string>();
  for (const source of [department?.value, department?.extendValue, department?.extValue]) {
    const parsed = decode(source);
    if (Array.isArray(parsed) && parsed.length > 1) return '';
    const entry = Array.isArray(parsed) ? parsed[0] : parsed;
    if (entry == null || entry === '') continue;
    if (typeof entry === 'string') {
      const text = entry.trim();
      if (text.startsWith('[') || text.startsWith('{') || text.startsWith('"')) return '';
      if (text) displayValues.add(text);
    } else if (typeof entry === 'number') {
      ids.add(String(entry));
    } else if (typeof entry === 'object' && !Array.isArray(entry)) {
      const record = entry as Field;
      if (!Object.keys(record).length) continue;
      const rawId = record.id ?? record.itemId ?? record.deptId ?? record.dept_id ?? '';
      const rawName = record.name || record.label || '';
      if (typeof rawName !== 'string' || (typeof rawId !== 'string' && typeof rawId !== 'number')) return '';
      const id = String(rawId).trim();
      const label = rawName.trim();
      if (!id && !label) return '';
      if (id) ids.add(id);
      if (label) names.add(label);
    } else return '';
  }
  for (const display of displayValues) {
    if (ids.has(display)) continue;
    if (!names.has(display) && /^\d+$/.test(display)) ids.add(display);
    else names.add(display);
  }
  if (!ids.size && !names.size) return null;
  return ids.size <= 1 && names.size === 1 ? [...names][0] : '';
}

function* detailRows(form: Field[]) {
  for (const table of form) {
    if (!/明细|detalle/i.test(String(table.label || table.name || ''))) continue;
    for (const row of records(table.value)) {
      if (!Array.isArray(row.rowValue)) continue;
      const cells = records(row.rowValue);
      const department = findCell(cells, ['部门名称', '部门', 'departamento']);
      const shop = departmentName(department);
      if (shop) yield { departmentName: shop, cells };
    }
  }
}

type AmountOptions = { allowThousands?: boolean; reviewInvalidPrecision?: boolean };

function parseAmount(value: unknown, options: AmountOptions): Amount | null {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  let text = String(value).trim();
  if (options.allowThousands && /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/.test(text)) text = text.replace(/,/g, '');
  const match = /^([+-]?)(\d*)(?:\.(\d*))?(?:e([+-]?\d+))?$/i.exec(text);
  if (!match) return null;
  const [, sign, whole, fraction = '', exponent = '0'] = match;
  const digits = whole + fraction;
  if (!digits) return null;
  const scale = fraction.length - Number(exponent);
  // Keep resource use bounded even when a malformed approval contains a huge exponent.
  if (!Number.isSafeInteger(scale) || Math.abs(scale) > 100 || digits.length > 100
      || (typeof value === 'number' && Number.isInteger(value) && !Number.isSafeInteger(value))) {
    if (options.reviewInvalidPrecision) return null;
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

function hasValue(field: Field | undefined): field is Field & { value: string | number } {
  return !!field && (typeof field.value === 'number' || (typeof field.value === 'string' && !!field.value.trim()));
}

function amountCurrencies(field: Field, cells: Field[]): string[] {
  const explicit = [field.currency, field.currencyCode, ...declaredCurrencies(cells)]
    .filter((value): value is string => typeof value === 'string' && !!value.trim());
  const hints = [field.label, field.name, field.unit, field.value]
    .filter((value): value is string => typeof value === 'string' && (foreignCurrency.test(value) || cnyCurrency.test(value)));
  return [...explicit, ...hints];
}

function cnySubtotal(lines: Iterable<AmountLine>, formCurrencies: string[], options: AmountOptions = {}) {
  let amount = zero;
  let hasAmount = false;
  let currencyUnresolved = false;
  let invalidAmount = false;
  for (const { field, cells, currencies } of lines) {
    if (!hasValue(field)) { invalidAmount = true; continue; }
    // Row/component metadata describes the selected amount. A form-level currency can describe a different payment amount.
    const evidence = currencies ?? amountCurrencies(field, cells ?? []);
    if ((evidence.length ? evidence : formCurrencies)
      .some(value => foreignCurrency.test(value) || !cnyCurrency.test(value.trim()))) {
      currencyUnresolved = true;
      continue;
    }
    const parsed = parseAmount(field.value, options);
    if (parsed) {
      amount = add(amount, parsed);
      hasAmount = true;
    } else invalidAmount = true;
  }
  return { amount, hasAmount, currencyUnresolved, invalidAmount };
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
const payrollTerm = /薪资|工资|薪酬|月薪|\bsalario\b|\bnómina\b/i;
const payrollReference = /参考|参照|比照|对照|沿用|详见|参见|工资标准|薪资标准|(?:按|以|依据)\s*(?=\d{4}\s*年)|\breferencia\b/i;
const payrollAsReference = /(?:作为|用作|仅作|仅供|供)\s*(?:本月|本期|本次)?\s*(?:参考|参照|比照|对照)/;
const payrollMonthLabel = /^(?:(?:本次|本期)\s*)?(?:工资|薪资|薪酬|月薪|费用)\s*(?:所属|归属)?\s*(?:年月|月份)\s*(?:[:：]|为|是)?$/;
const payrollPaymentLead = /^(?:(?:本次|本期)\s*)?(?:申请(?:发放)?|发放|补发|支付|计提|核算)?$/;

function parseExpenseMonth(value: string): string | null {
  const chinese = /^(\d{4})\s*年\s*(\d{1,2})\s*月(?:份)?$/.exec(value);
  const iso = chinese ? chinese[1] + '-' + chinese[2].padStart(2, '0') : value;
  return monthFromDate(iso.length === 7 ? iso + '-01' : iso);
}

function salaryMonthsInDescription(description: string): string[] {
  return description.split(/[。！？；;，,\r\n]+/).flatMap(clause => {
    const statement = clause.trim().replace(/^(?:[（(]\d+[)）]|\d+[.．、)）])\s*/, '');
    const matches = [...statement.matchAll(chineseMonth)];
    if (!matches.length) return [];
    const first = matches[0];
    const lead = statement.slice(0, first.index).trim();
    const detailStart = first.index + first[0].length;
    const detail = statement.slice(detailStart);
    const reference = detail.search(payrollReference);
    const asReference = detail.search(payrollAsReference);
    if (asReference >= 0 && asReference < reference) return [];
    const payroll = detail.search(payrollTerm);
    const cutoff = reference < 0 ? statement.length : detailStart + reference;
    if (!payrollMonthLabel.test(lead)
        && (!payrollPaymentLead.test(lead) || payroll < 0 || detailStart + payroll >= cutoff)) return [];
    return matches.filter(match => match.index < cutoff).map(match => match[0]);
  });
}

function expensePeriod(form: Field[], isSalary: boolean, inRange: (month: string) => boolean) {
  const explicit = form.filter(field => name(field) === expenseMonthField)
    .map(field => typeof field.value === 'string' ? field.value.trim() : '').filter(Boolean);
  const candidates = explicit.length ? explicit : form.flatMap(field => {
    if (!descriptionFields.has(name(field)) || typeof field.value !== 'string') return [];
    return isSalary ? salaryMonthsInDescription(field.value)
      : [...field.value.matchAll(chineseMonth)].map(match => match[0]);
  });
  if (!candidates.length) return undefined;
  const months = [...new Set(candidates.map(parseExpenseMonth))];
  return {
    month: months.length === 1 ? months[0] : null,
    outOfRange: months.every(month => month !== null && !inRange(month)),
  };
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

function choice(value: unknown): string {
  if (typeof value === 'string' && !value.trim().startsWith('[')) return value.trim();
  const options = list(value);
  return options.length === 1 && typeof options[0] === 'string' ? options[0].trim() : '';
}

function payrollSelection(form: Field[]): PayrollSupplement | null {
  const option = (pattern: RegExp) => choice(form.find(field => pattern.test(name(field)))?.value);
  const management = option(/^管理支出(?:\s*Gastos de operaci[oó]n)?$/i);
  const tax = option(/^税费(?:\s*Impuestos)?$/i);
  if ((!management || management.startsWith('税费')) && /^(?:薪资税\/个税|个人所得税|个税)(?:$|[ (（A-Za-z])/.test(tax)) {
    return 'individual_income_tax';
  }
  return /^社保\s*[+＋]?\s*公积金/.test(management) ? 'employer_contributions' : null;
}

function tableRows(value: unknown) {
  const table = decode(value) as Field | null;
  const rows = Array.isArray(table) ? table
    : [table?.rows, table?.details, table?.value].map(list).find(items => items.length) ?? [];
  return rows.map(raw => {
    const row = decode(raw) as Field | null;
    const cells = Array.isArray(row) ? records(row)
      : [row?.rowValue, row?.values, row?.value].map(records).find(items => items.length) ?? [];
    return { cells, number: String(row?.rowNumber ?? '').trim() };
  });
}

type PayrollLine = { number: string; shop: string | null; amounts: Field[]; currencies: string[] };
const fieldKey = (cell: Field) => String(cell.id || cell.key || '');
const zeroAmount = /^[+-]?(?:0+(?:,000)*(?:\.0*)?|\.0+)(?:e[+-]?\d+)?$/i;

function payrollRows(table: Field, kind: PayrollSupplement): PayrollLine[] {
  function lines(value: unknown): PayrollLine[] {
    return tableRows(value).flatMap(({ cells, number }) => {
      const department = findCell(cells, ['部门', 'departamento']) ?? cells.find(c => fieldKey(c).startsWith('DepartmentField_'));
      const shop = departmentName(department);
      const money = cells.filter(c => fieldKey(c).startsWith('MoneyField_') || /金额|monto|importe/i.test(name(c)) ||
        /^社保\s*[+＋]?\s*公积金/.test(name(c))).filter(hasValue);
      // A hidden table can serialize a default zero without any department.
      if (shop === null && money.every(c => zeroAmount.test(String(c.value).trim()))) return [];
      const amounts = kind === 'individual_income_tax' ? money : money.filter(c =>
        fieldKey(c) === 'MoneyField_IR71DYOSO8O0' || /^社保\s*[+＋]\s*公积金\s*[（(]公司[）)]/.test(name(c)));
      const currencies = amountCurrencies(amounts.length === 1 ? amounts[0] : {}, cells);
      return [{ number, shop, amounts, currencies }];
    });
  }
  const current = lines(table.details);
  if (!current.length) return lines(table.value);
  const archived = lines(table.value);
  if (!archived.length) return current;
  const key = current.every(r => r.number) && archived.every(r => r.number) ? 'number' : 'shop';
  function uniqueRows(rows: PayrollLine[]) {
    const index = new Map<string, PayrollLine | null>();
    for (const row of rows) {
      const id = row[key];
      if (id) index.set(id, index.has(id) ? null : row);
    }
    return index;
  }
  const originals = uniqueRows(current);
  const mirrors = uniqueRows(archived);
  return current.map(row => {
    if (row.shop === '' || row.amounts.length > 1) return row;
    const id = row[key];
    let other = id && originals.get(id) === row ? mirrors.get(id) : undefined;
    if (!id && key === 'shop' && current.length === 1 && archived.length === 1) other = archived[0];
    if (!other?.shop || other.amounts.length !== 1 || (row.shop && row.shop !== other.shop)) return row;
    if (row.amounts.length && String(row.amounts[0].value) !== String(other.amounts[0].value)) return row;
    // Both representations describe one row; either can carry its explicit currency.
    const base = row.shop && row.amounts.length ? row : other;
    return { ...base, currencies: [...row.currencies, ...other.currencies] };
  });
}

function payrollLines(form: Field[], kind: PayrollSupplement) {
  const tax = kind === 'individual_income_tax';
  const generic = (field: Field) => field.id === 'TableField_1T6MS9XEQUE80' || /^明细(?:detalle)?$/i.test(name(field).replace(/\s/g, ''));
  const dedicated = (field: Field) => tax ? name(field).startsWith('薪酬税费总支出')
    : field.id === 'TableField_G2ELEALN0S80' || /^社保\s*[+＋]?\s*公积金/.test(name(field));
  const preferred = form.filter(dedicated).flatMap(table => payrollRows(table, kind));
  const rows = tax && !preferred.length ? form.filter(generic).flatMap(table => payrollRows(table, kind)) : preferred;
  const byStore = new Map<string, AmountLine[]>();
  const unresolved = new Set<string>();
  if (!rows.length) unresolved.add('');
  for (const { shop, amounts, currencies } of rows) {
    if (!shop || amounts.length !== 1) { unresolved.add(shop || ''); continue; }
    const lines = byStore.get(shop) ?? [];
    lines.push({ field: amounts[0], currencies });
    byStore.set(shop, lines);
  }
  return { byStore, unresolved };
}

function payrollMonth(submitted: string | null | undefined, kind: PayrollSupplement) {
  if (!submitted || !parseExpenseMonth(submitted)) return null;
  if (kind === 'employer_contributions') return submitted;
  const first = new Date(submitted + '-01T00:00:00Z');
  first.setUTCDate(0);
  return first.toISOString().slice(0, 7);
}

export function summarizeOperatingExpenses(forms: OperatingExpenseForm[], range: ExpenseMonthRange, includePayroll = false) {
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
    const kind = includePayroll && payrollSelection(form);
    if (kind) {
      const month = payrollMonth(row.submittedMonth, kind);
      if (!month || inRange(month)) {
        const { byStore, unresolved } = payrollLines(form, kind);
        if (!month) {
          const shops = new Set([...byStore.keys(), ...unresolved]);
          if (shops.size) warn('APPLICATION_MONTH_UNRESOLVED', kind, shops.has('') ? [] : [...shops].sort());
        } else {
          const foreign: string[] = [];
          for (const [shop, lines] of byStore) {
            const subtotal = cnySubtotal(lines, formCurrencies, { allowThousands: true, reviewInvalidPrecision: true });
            if (subtotal.hasAmount) accumulate(kind, month, shop, subtotal.amount);
            if (subtotal.currencyUnresolved) foreign.push(shop);
            if (subtotal.invalidAmount) unresolved.add(shop);
          }
          if (foreign.length) warn('EXPENSE_CURRENCY_UNSUPPORTED', kind, foreign.sort(), month);
          if (unresolved.size) warn('PAYROLL_DETAIL_UNRESOLVED', kind, unresolved.has('') ? [] : [...unresolved].sort(), month);
        }
      }
    }
    const kinds = new Set(form.filter(field => field.name === operatingExpenseFields.management).map(field => field.value));
    const isSalary = kinds.has(operatingExpenseFields.salary);
    const sharedLines = form.filter(field => name(field) === operatingExpenseFields.sharedAdmin && hasValue(field));
    const statedPeriod = isSalary || sharedLines.length ? expensePeriod(form, isSalary, inRange) : undefined;
    if (kinds.has(operatingExpenseFields.office) || isSalary) {
      const application = applicationMonth(form, inRange);
      if (kinds.has(operatingExpenseFields.office) && !application.outOfRange) {
        const { month } = application;
        const lines = [...officeLines(form)].filter(line => hasValue(line.field));
        if (lines.length && !month) {
          warn('APPLICATION_MONTH_UNRESOLVED', 'office_space', []);
        } else if (month) {
          const subtotal = cnySubtotal(lines, formCurrencies);
          if (subtotal.amount.units !== 0n) accumulate('office_space', month, null, subtotal.amount);
          if (subtotal.currencyUnresolved) warn('EXPENSE_CURRENCY_UNSUPPORTED', 'office_space', [], month);
        }
      }
      if (isSalary) {
        const { month, outOfRange } = statedPeriod ?? application;
        if (!outOfRange) {
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
              const subtotal = cnySubtotal(lines, formCurrencies, { allowThousands: true });
              if (subtotal.hasAmount) accumulate('china_salary', month, departmentName, subtotal.amount);
              if (subtotal.currencyUnresolved) unknownCurrencies.push(departmentName);
            }
            if (unknownCurrencies.length) warn('EXPENSE_CURRENCY_UNSUPPORTED', 'china_salary', unknownCurrencies.sort(), month);
          }
        }
      }
    }

    if (!sharedLines.length || statedPeriod?.outOfRange) continue;
    const month = statedPeriod?.month;
    const shared = cnySubtotal(sharedLines.map(field => ({ field })), formCurrencies, { allowThousands: true });
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
