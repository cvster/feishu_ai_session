/** Persist each successful action separately: a failed native archive must not
 * suppress independent group cleanup, and retries must not repeat a deletion. */
export interface LiveCleanupState { sessionArchived?: boolean; groupDissolved?: boolean }
export async function cleanupLiveArtifacts(input: {
  state: LiveCleanupState; hasGroup: boolean;
  archive(): Promise<void>; verifyArchive(): Promise<void>;
  dissolve(): Promise<void>; verifyDissolved(): Promise<void>;
  save(): Promise<void>;
}): Promise<void> {
  const errors: Error[] = [];
  const attempt = async (label: string, operation: () => Promise<void>) => {
    try { await operation(); }
    catch (error) { errors.push(new Error(`${label}: ${error instanceof Error ? error.message : 'failed'}`)); }
  };
  await attempt('archive autotest session', async () => {
    if (!input.state.sessionArchived) { await input.archive(); await input.verifyArchive(); input.state.sessionArchived = true; await input.save(); }
  });
  await attempt('dissolve autotest group', async () => {
    if (input.hasGroup && !input.state.groupDissolved) { await input.dissolve(); await input.verifyDissolved(); input.state.groupDissolved = true; await input.save(); }
  });
  if (errors.length) throw new AggregateError(errors, errors.map(error => error.message).join('; '));
}
