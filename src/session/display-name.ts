/** Native IDs and their abbreviated forms are metadata, not session titles. */
export function namedSession(nativeId: string, ...names: (string | undefined)[]): string | undefined {
  return names.map(name => name?.trim()).find(name => name && name !== nativeId &&
    !/^[a-f0-9-]{16,}$/i.test(name) && !(name.length >= 8 && /^[a-f0-9-]+$/i.test(name) && nativeId.startsWith(name)));
}
