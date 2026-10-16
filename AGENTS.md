# Operational safety

- When the user requests a bridge deployment or restart, execute it directly on the requested local/remote hosts. Do not check whether Codex tasks are running, inspect task lists or active-run state as a restart gate, or ask for additional restart confirmation. This applies regardless of which conversations are active.
- Announce the deployment/restart and verify the bridge's service health afterward. Backups, artifact validation, and service-process checks are still allowed; they must not become active-task checks or confirmation gates.
- Restart only the bridge services. Do not interrupt Codex turns, delete queued input, or stop/restart Codex Desktop, the shared writer/app-server, or unrelated processes as part of a routine bridge deployment/restart.

# Delivery workflow

- After completing each user-requested feature or bug fix in this project, run the relevant checks, commit the related changes, and push to `codexfeishu` (`git@github.com:cvster/CodexFeishu.git`) without requiring another request. The current delivery branch is `main`.
- Keep unrelated user changes out of the commit. Do not force-push or silently resolve a remote divergence; report a blocked push or failed verification clearly. This standing authorization does not authorize additional deployments or service restarts beyond the operational safety rules above.
