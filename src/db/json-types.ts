/**
 * Recursive JSON-compatible type — replaces `any` for raw payloads stored in JSONB columns.
 */
export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };
