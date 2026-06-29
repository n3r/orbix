export const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 30; // 30 days

export function isSessionValid(session: { expiresAt: Date }, now: Date = new Date()): boolean {
  return session.expiresAt.getTime() > now.getTime();
}

export async function createSession(
  accountId: string,
  deps: { insert: (s: { accountId: string; expiresAt: Date }) => Promise<{ id: string; expiresAt: Date }>; now?: Date }
): Promise<{ id: string; expiresAt: Date }> {
  const expiresAt = new Date((deps.now ?? new Date()).getTime() + SESSION_TTL_MS);
  return deps.insert({ accountId, expiresAt });
}
