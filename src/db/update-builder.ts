export function buildUpdateSet<T extends Record<string, unknown>>(
  input: T,
  columnMap: Partial<Record<keyof T, string>>,
  parameterOffset = 0
) {
  const values: unknown[] = [];
  const assignments: string[] = [];

  for (const [rawKey, value] of Object.entries(input) as Array<[keyof T, unknown]>) {
    if (value === undefined) continue;
    const column = columnMap[rawKey];
    if (!column) continue;
    values.push(value);
    assignments.push(`${column} = $${parameterOffset + values.length}`);
  }

  return { assignments, values };
}
