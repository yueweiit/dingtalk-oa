export function alertMarkdownParams(content: string, atUserIds: readonly string[] = [], title = '统一预警'): string {
  const mentions = atUserIds.map(id => `@${id}`).join(' ');
  const text = mentions ? `${mentions}\n\n${content}` : content;
  return JSON.stringify({ title, text });
}
