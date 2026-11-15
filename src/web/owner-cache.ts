/** Local Web identity only; never grants Feishu/admin permissions. */
export interface WebOwnerCache { version: 1; profile: string; appId: string; ownerId: string; verifiedAt: number }
export function validWebOwner(value: unknown, profile: string, appId: string): value is WebOwnerCache {
  const c = value as WebOwnerCache | undefined;
  return !!c && c.version === 1 && c.profile === profile && c.appId === appId &&
    /^ou_[a-zA-Z0-9]+$/.test(c.ownerId ?? '') && Number.isFinite(c.verifiedAt) && c.verifiedAt > 0 && c.verifiedAt <= Date.now();
}
export function ownerApiUnavailable(error?: string): boolean {
  return !!error && /429|99991403|quota|timeout|timed out|ECONN|ENOTFOUND|fetch failed|status code 5\d\d|socket|network/i.test(error);
}
export function migrateWebOwner(receipts: Record<string, { owner: string; sessionId: string; enqueued?: boolean; createdAt: number }>,
  sessionIds: Set<string>, profile: string, appId: string): WebOwnerCache | undefined {
  // Old receipts were written only after a verified owner check. Bind their
  // session hash back to the current profile/app/tool/source/native identity.
  const confirmed = Object.values(receipts).filter(r => r.enqueued === true);
  const owners = new Set(confirmed.map(r => r.owner));
  if (owners.size !== 1) return;
  const matches = confirmed.filter(r => sessionIds.has(r.sessionId));
  if (!matches.length) return;
  const result: WebOwnerCache = { version: 1, profile, appId, ownerId: matches[0]!.owner,
    verifiedAt: Math.max(...matches.map(r => r.createdAt)) };
  return validWebOwner(result, profile, appId) ? result : undefined;
}
