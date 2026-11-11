/** 空字符串不能阻断后备字段；ID 仅接受字符串或可精确表达的整数。 */
export function firstText(...values: unknown[]): string | null {
  for (const value of values) {
    const text = typeof value === 'string' ? value.trim()
      : typeof value === 'number' && Number.isSafeInteger(value) ? String(value) : '';
    if (text) return text;
  }
  return null;
}
