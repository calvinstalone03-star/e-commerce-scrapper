export type ClassValue = string | false | null | undefined;

/**
 * Join class names, dropping the falsy ones.
 *
 * Deliberately not `tailwind-merge`: it is not a dependency here, so a class
 * passed by a caller does not override a conflicting default — CSS source order
 * decides. Every primitive keeps its defaults minimal for that reason, and the
 * ones most likely to be overridden (a table's height, a thumbnail's box) take
 * a prop instead of relying on a class winning.
 */
export function cn(...values: ClassValue[]): string {
  return values.filter(Boolean).join(' ');
}
