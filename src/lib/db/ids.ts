/** RFC 4122 v4 UUID from the platform CSPRNG. */
export function newId(): string {
  return crypto.randomUUID();
}

export function nowIso(): string {
  return new Date().toISOString();
}
