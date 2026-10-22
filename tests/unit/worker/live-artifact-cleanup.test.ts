import { expect, it, vi } from 'vitest';
import { cleanupLiveArtifacts, type LiveCleanupState } from '../../helpers/live-artifact-cleanup';

it('attempts group cleanup after an archive failure, then resumes only the unfinished cleanup after restart', async () => {
  let state: LiveCleanupState = {}, persisted = '';
  const archive = vi.fn(async () => {}), dissolve = vi.fn(async () => {});
  const verifyArchive = vi.fn(async () => {}), verifyDissolved = vi.fn(async () => {});
  const save = async () => { persisted = JSON.stringify(state); };
  const cleanup = () => cleanupLiveArtifacts({ state, hasGroup: true, archive, dissolve, verifyArchive, verifyDissolved, save });
  archive.mockRejectedValueOnce(new Error('native unavailable'));
  await expect(cleanup()).rejects.toThrow('archive autotest session: native unavailable');
  expect(dissolve).toHaveBeenCalledOnce(); expect(state).toEqual({ groupDissolved: true });
  state = JSON.parse(persisted);
  await cleanup(); await cleanup();
  expect(archive).toHaveBeenCalledTimes(2); expect(dissolve).toHaveBeenCalledOnce();
  expect(state).toEqual({ sessionArchived: true, groupDissolved: true });
});

it('does not mark unverified cleanup as complete and records both independent failures', async () => {
  const state: LiveCleanupState = {};
  const input = { state, hasGroup: true, archive: vi.fn(async () => {}), dissolve: vi.fn(async () => {}),
    verifyArchive: vi.fn(async () => { throw new Error('still active'); }),
    verifyDissolved: vi.fn(async () => { throw new Error('still exists'); }), save: vi.fn(async () => {}) };
  await expect(cleanupLiveArtifacts(input)).rejects.toThrow('archive autotest session: still active; dissolve autotest group: still exists');
  expect(state).toEqual({}); expect(input.save).not.toHaveBeenCalled();
});
