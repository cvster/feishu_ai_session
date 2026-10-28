# Product terminology

- Use **Codex**, **Claude**, **Zcode**, **Kilo**, and **Dsh** as tool display names. Protocol IDs and executable names stay unchanged.
- Reply cards exclude reasoning and tool-call details entirely, including collapsed detail panels. Keep answer text, reasoning phase, tool-call count/status and controls. These summaries are plain text with no expand action; do not add an opt-in setting for details.
- Use **会话共享** for sharing an existing AI conversation with other groups, **辅助群** for groups using that shared conversation, and **AI助手** for the assistant available in those groups.
- Use these names in user-facing cards, messages, help and current documentation. Personal workgroups retain their one-to-one native-session binding; shared groups are additional access routes to the existing conversation.
- Reserve FF for legacy history and migration descriptions. Existing protocol names, callback IDs, `/aux`, and persisted `auxiliary` fields remain compatibility identifiers.

# Operational safety

- When the user requests a bridge deployment or restart, execute it directly on the requested local/remote hosts. Do not check whether Codex tasks are running, inspect task lists or active-run state as a restart gate, or ask for additional restart confirmation. This applies regardless of which conversations are active.
- Announce the deployment/restart and verify the bridge's service health afterward. Backups, artifact validation, and service-process checks are still allowed; they must not become active-task checks or confirmation gates.
- Restart only the bridge services. Do not interrupt Codex turns, delete queued input, or stop/restart Codex Desktop, the shared writer/app-server, or unrelated processes as part of a routine bridge deployment/restart.
- After completing and verifying a change that does not require a worker restart, deploy the bridge and bundled Web directly. The user has authorized this as the default delivery workflow; do not wait for another deployment request. Keep all workers running.

# Delivery workflow

- After completing each user-requested feature or bug fix in this project, run the relevant checks, commit the related changes, and push to all three remotes: `origin` (`ssh://git@code.tars-ai.com:2222/lennox/feishuaisession.git`), `codexfeishu` (`git@github.com:cvster/feishu_ai_session.git`), and `redgitlab` (`ssh://git@red-gitlab.tars-ai.com:2222/soft_platform/ai_native/feishu_ai_session.git`) without requiring another request. The current delivery branch is `main`.
- Keep unrelated user changes out of the commit. Do not force-push or silently resolve a remote divergence; report a blocked push or failed verification clearly. Automatic deployment is limited to the bridge and bundled Web changes covered by the operational safety rules above; it does not authorize worker or unrelated service restarts.
