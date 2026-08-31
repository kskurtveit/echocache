---
name: nowhereman-deps
description: Check a library API or upgrade a dependency in the nowhereman repo — which packages it depends on, where each one's real type surface lives, and the verification steps that caught actual bugs here. Use before writing or changing code that calls @modelcontextprotocol/server, better-sqlite3, zod, or a Node built-in, and before adopting an API that documentation calls current. Complements the context7-mcp skill: that one fetches docs, this one says what to do with them in this repo.
---

# Checking a dependency API in nowhereman

Use `context7-mcp` to fetch the docs. This skill covers what the docs alone won't tell you here.

## The dependencies

| package | range | purpose | real type surface |
|---|---|---|---|
| `@modelcontextprotocol/server` | `^2.0.0` | MCP server, tool registration, stdio transport | `node_modules/@modelcontextprotocol/server/dist/index.d.mts`, and `dist/stdio.d.mts` for the `./stdio` subpath |
| `better-sqlite3` | `^11.9.1` | the SQLite store | `node_modules/@types/better-sqlite3/index.d.ts` (separate `@types` package) |
| `zod` | `^4.0.0` | tool input schemas | `node_modules/zod/index.d.cts`; **imported as `zod/v4`** in `server.ts`, so check the `./v4` export, not the root |
| `typescript`, `tsx`, `@types/node` | dev | build, test runner, Node types | — |

`@modelcontextprotocol/client` is a **devDependency**, used only by `server.test.ts` to drive the real
server through a real client. Don't import it from `src/` outside tests.

## Three checks that caught real bugs

**1. Read the installed `.d.ts`, not just the docs.** Docs describe a library in general; the
version actually installed is what your code compiles against, and the two drift. `serveStdio`
returning a handle with `close()`, and accepting an `onerror` option, were both confirmed by
reading `dist/stdio.d.mts` — the code had been ignoring both. Caret ranges mean installed versions
already run ahead of what `package.json` declares (`better-sqlite3` 11.9.1 → 11.10.0, `zod`
4.0.0 → 4.4.3), so "what the docs say about v4" and "what's in `node_modules`" are different
questions.

**2. Check `engines` before adopting anything documentation calls current.** This project supports
**Node >= 20** and CI runs the suite on **20 and 22** (`.github/workflows/ci.yml`). Node's own docs
present `import.meta.main` as the current idiom for entry-point detection — it shipped in **24.2.0**,
so using it would have broken the stated support floor while passing locally. Verify the version a
feature landed in, then check it against `engines.node`, not against whatever Node you happen to be
running.

**3. Reproduce the failure before fixing, and mutate after.** Every finding worth acting on here has
been reproducible in isolation — a throwaway `npx tsx -e` or a scratch script. Two review findings
turned out to be non-issues under this repo's real call paths, and two "fixes" passed their own new
tests while testing nothing, because an unrelated query failed first for the same reason. After a
fix goes green, break it deliberately and confirm the test catches it.

## Local gotchas

- **A registered MCP server keeps running the code it started with.** After changing `src/`, an
  already-registered `nowhereman` serves the old build until the host restarts. Same for agent
  definitions and newly added MCP servers — they load at session start. See `CLAUDE.md`.
- **`createServer`'s factory is re-invoked per connection/request**, so a throw during server
  *construction* lands outside `guard()` and surfaces as a raw transport error rather than a clean
  `isError`. Keep construction cheap and unlikely to fail; see the note in `CLAUDE.md`.
- **Don't `claude mcp add context7` locally.** It's already registered at user scope against the
  hosted endpoint. A local stdio entry shadows it, and since OAuth tokens are stored per endpoint,
  the local one runs unauthenticated.

## After changing a dependency

`npm run check` (typecheck + the full test suite) must pass, and `npm run build` must still emit a runnable
`dist/index.js`. `npm audit` should stay clean. If the change touches the stored schema or the
embedding format, see the migration notes in `CLAUDE.md` — the embedding format is versioned and
migrates on open; table columns are not.
