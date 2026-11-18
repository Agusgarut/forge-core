# forge-core

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Agusgarut/forge-core/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Agusgarut/forge-core/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

Standalone GitHub-compatible git forge: one process, no UI — git smart HTTP (upload-pack v2, receive-pack v0), REST v3, GraphQL v4, and MCP, from its own in-memory store. Built for make.fun's "Build a GitHub-compatible git forge" bounty.

## Run it

```sh
node main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips TypeScript types on its own. There is nothing to install: the program imports `node:http` and its own modules only, and the trial has no package manager and no internet.

## What it serves

- Git smart HTTP at `/{owner}/{repo}.git` — clone, fetch and push (protocol v2 upload-pack, v0 receive-pack, fast-forward only)
- REST v3 under `/api/v3` — repositories, branches, contents, labels, issues and pull requests
- GraphQL v4 at `/api/graphql` — the documents `gh` and `github-mcp-server` send, with introspection
- MCP at `/mcp` — JSON-RPC 2.0 tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) on the same store as REST

## Lifecycle

1. **Bind an ephemeral port.** `server.listen(0)` lets the kernel pick one. Never bind 8080: that is the env's port.
2. **Register.** `POST $MAKEFUN_ENV_URL/register` with `{"port": <the port you bound>}`, as JSON.
3. **Wait for done.** `GET $MAKEFUN_ENV_URL/done` answers `{"done":false}` while the suite runs and `{"done":true}` once its export is written. Poll it with a short backoff; never exit before it says `true`.
4. **Exit 0** when it does.

The store is deterministic: two runs on the same instance leave the same state export, byte for byte — no wall clock or unseeded randomness reaches anything stored.

---

<sub>Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
