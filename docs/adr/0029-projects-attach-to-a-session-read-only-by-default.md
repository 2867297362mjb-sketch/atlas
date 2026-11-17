# ADR-0029: Projects attach to a session, read-only by default, and an agent may ask for one

**Status:** Accepted (2026-10-24). Adds `request_project_access` to the code tool server of ADR-0015 and ADR-0021.

## Context

A session runs in one folder. Mentioning another project or repo in the composer used to put its path into that one prompt and nothing more: the agent's sandbox still ended at the session's own folder, the next message had forgotten the project, and nothing on the session said it was working across two repositories. Work that spans a client and its server, or an app and its design package, hit this every time.

## Decision

- **An attached project belongs to the session**, not to a message. It is kept on the session's row, restored on resume, and shown wherever the session is listed.
- **Each has an access level, and read-only is the default.** Read and write is a deliberate second step. Mentioning a project must never widen what an agent can change.
- **Three ways to attach:** an `@` project or repo mention, a repo cloned from the composer, or the agent asking.
- **The agent asks through a tool**, `request_project_access` on the code tool server. The host validates the path and raises an approval card through the ordinary permission flow: grant read and write, grant read-only, or deny. The wait is bounded (ADR-0008); an approval that arrives late still attaches the folder.
- **Some paths can never be attached:** the filesystem root, the home folder or anything above it, a system folder, and a home settings folder. One validator decides, and every path goes through it.
- **Atlas's own grants are the authority.** They are what the client handlers check for an agent's file and terminal requests, and a change applies at once. What each agent is told is as much as it can take: an ACP agent gets the read-and-write roots as `additionalDirectories` when the session is opened, and the native agent gets them as writable roots from its next turn.

`docs/architecture.md` ("Attached projects") has the mechanics.

## Considered options

- **Keep paths per message.** Rejected: the sandbox never widened, so the agent was told about a folder it could not use.
- **Attach read and write by default.** Rejected: a mention is a cheap gesture, and it should not be a write grant.
- **Let the agent widen its own roots.** Rejected: every widening is the user's decision, shown as a card.

## Consequences

- ACP has no request to change an open session's directories, so a change to an ACP agent's roots reaches the agent the next time the session is opened. Atlas's own grants cover the gap, and the command's answer says the change was not applied live.
- Read-only roots are not sent to ACP agents, because the protocol's list implies edit rights.
- The native agent reads the whole disk, so read-only attachment constrains it through Atlas's grants and the prompt, not through its sandbox.
- The code tool server is no longer read-only or search-only: it carries one tool that asks the user for something.
