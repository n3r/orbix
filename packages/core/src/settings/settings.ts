export async function getSetting<T>(
  key: string,
  deps: { fallback: T; read: (k: string) => Promise<{ value: unknown } | null> },
): Promise<T> {
  const row = await deps.read(key);
  return row ? (row.value as T) : deps.fallback;
}

export async function setSetting(
  key: string,
  value: unknown,
  deps: { write: (k: string, v: unknown) => Promise<void> },
): Promise<void> {
  await deps.write(key, value);
}
