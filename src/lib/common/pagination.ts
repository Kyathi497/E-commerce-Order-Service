import { AppError } from "./errors.js";

// Cursor pagination (§9): ?limit=20&cursor=… → { items, nextCursor }.
// The cursor is opaque to clients: base64url JSON of the last row's sort keys.

export interface Page<T> {
  items: T[];
  nextCursor: string | null;
}

export function encodeCursor(value: Record<string, string | number>) {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeCursor<T extends Record<string, string | number>>(cursor: string | undefined): T | null {
  if (!cursor) return null;
  try {
    const value = JSON.parse(Buffer.from(cursor, "base64url").toString());
    if (value && typeof value === "object") return value as T;
  } catch {
    // fall through
  }
  throw new AppError(400, "BAD_CURSOR", "That page link has expired. Please start from the first page.");
}

// Fetch limit + 1 rows, then call this to split off the extra one.
export function toPage<T>(rows: T[], limit: number, cursorOf: (row: T) => Record<string, string | number>): Page<T> {
  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  return { items, nextCursor: hasMore ? encodeCursor(cursorOf(items[items.length - 1]!)) : null };
}
