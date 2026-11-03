/** Narrow untrusted JSON to an object; arrays and primitive values cannot hold named fields. */
export function asRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

/** Read text without trimming it, preserving Markdown, newlines and exact field names. */
export function asString(value: unknown, fallback: string): string {
	return typeof value === 'string' ? value : fallback;
}

/** Reject blank names while preserving the original spacing of a valid name. */
export function asNonEmptyString(value: unknown): string | null {
	return typeof value === 'string' && value.trim() ? value : null;
}

/** Require a real boolean; a saved string such as "false" must not become true. */
export function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === 'boolean' ? value : fallback;
}

/** Read one of a finite set of string values, including string-enum members. */
export function asOption<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
	return typeof value === 'string' && options.includes(value as T) ? value as T : fallback;
}

/** Require a positive whole number; numeric strings and fractions are invalid. */
export function positiveInteger(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isSafeInteger(value) && value > 0 ? value : fallback;
}
