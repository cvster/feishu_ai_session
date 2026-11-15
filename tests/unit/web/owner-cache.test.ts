import { describe, expect, it } from 'vitest';
import { migrateWebOwner, ownerApiUnavailable, validWebOwner } from '../../../src/web/owner-cache';
describe('local Web verified owner', () => {
  const receipt = { owner:'ou_owner', sessionId:'app-scoped-hash', enqueued:true, createdAt:Date.now()-1000 };
  it('migrates only confirmed receipts matching current account-bound session hashes', () => {
    const c = migrateWebOwner({one:receipt},new Set(['app-scoped-hash']),'profile','cli_one');
    expect(validWebOwner(c,'profile','cli_one')).toBe(true);
    expect(validWebOwner(c,'profile','cli_other')).toBe(false);
    expect(validWebOwner(c,'other','cli_one')).toBe(false);
    expect(migrateWebOwner({one:receipt},new Set(['other-app-hash']),'profile','cli_other')).toBeUndefined();
  });
  it('rejects unconfirmed or ambiguous legacy ownership', () => {
    expect(migrateWebOwner({one:{...receipt,enqueued:false}},new Set([receipt.sessionId]),'p','a')).toBeUndefined();
    expect(migrateWebOwner({one:receipt,two:{...receipt,owner:'ou_other'}},new Set([receipt.sessionId]),'p','a')).toBeUndefined();
  });
  it('permits availability failures but not authentication/permission revocations', () => {
    for(const e of ['Request failed with status code 429','99991403 quota exceeded','ECONNRESET','Request failed with status code 503']) expect(ownerApiUnavailable(e)).toBe(true);
    for(const e of [undefined,'permission denied','Request failed with status code 401','application owner missing from API response']) expect(ownerApiUnavailable(e)).toBe(false);
  });
});
