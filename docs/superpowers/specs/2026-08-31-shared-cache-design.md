# Shared cache via git — design spec

**Status:** proposed, not yet implemented
**Date:** 2026-08-31

## Problem

echocache's real differentiator over Claude Code's own persistent memory (see `README.md`) is
sharing a derivation across projects or hosts that don't already share a memory store. That case
is currently unproven — not just untested, unbuilt — and the most obvious way to build it (point
two machines' `ECHOCACHE_DB_PATH` at the same file on a network drive) is unsafe: SQLite's own
maintainers state WAL mode — which `db.ts` sets unconditionally — requires a shared-memory segment
between processes, which processes on separate hosts cannot share, and that running SQLite over
NFS/SMB/CIFS is "neither recommended nor supported" regardless of journal mode.

The concrete case worth building for: two people (or their agents) working from the same cloned
repository, wanting to share an expensive derivation without standing up any new infrastructure.

## Non-goals

- Live/real-time sharing. That needs a hosted network service and a real auth model this project
  doesn't have (today's security posture is "local file, 0600, no auth layer" — see `CLAUDE.md`
  Security). Out of scope here; a different design if ever pursued.
- Sharing between users who don't share a git repository.
- Any git operation performed by echocache itself — no `git add`/`commit`/`push`. Sharing a file
  is a normal part of whatever commit the agent or user was already making.
- Automatic or implicit publishing. `cache_set` behaves exactly as it does today; sharing is a
  deliberate second step (see the "What's worth caching" precedent in `AGENTS.md` — not everything
  worth caching locally is worth a permanent, team-visible, git-tracked file).
- Conflict resolution beyond what git's own merge machinery already provides.
- Changes to the existing single-machine, multi-project sharing model (one `~/.echocache/cache.db`
  usable by every project that registers the server). This is additive to it.
- New runtime dependencies. `node:fs` and `node:path` are sufficient.

## Architecture

### Where files live

A `.echocache/` directory at the git root of the *project being worked on* — e.g. `dfos/.echocache/`,
not echocache's own repository (though echocache's own repo could use the same mechanism to
dogfood it). echocache is registered per-project today (local MCP scope), so the server process's
`cwd` at launch is that project's directory; the git root is found by walking up from `cwd` looking
for a `.git` entry (directory or file, so worktrees and submodules resolve correctly).

A `.echocache/README.md` is written alongside the first shared entry, briefly explaining what the
directory is — matching the project's existing convention of a one-line *why* wherever something
might otherwise look like clutter to someone encountering it cold in `git status`.

### File format

One JSON file per shared entry, named `<key_hash>.json` — the same `key_hash` `computeKeyHash`
already produces, content-addressed on purpose:

- Two people independently sharing the *same* conclusion produce the identical filename and
  content. Git sees no conflict; re-sharing an unchanged entry is a no-op write.
- Two people sharing *different* answers to the same question produce a real git merge conflict.
  A human resolves it during the normal pull/merge — this is the correct outcome, not something
  echocache should paper over.

```json
{
  "formatVersion": 1,
  "keyHash": "…",
  "model": "…",
  "prompt": "…",
  "params": {},
  "response": "…",
  "ttlSeconds": null,
  "staleWhileRevalidateSeconds": 0,
  "tags": [],
  "derivedFrom": ["<key_hash of parent>", "…"],
  "createdAt": 1788000000000,
  "sharedAt": 1788012345678
}
```

Two fields need explanation:

- **`derivedFrom` holds `key_hash`es, not local ids.** The local `edges` table references entries
  by their random local UUID, which isn't portable across machines. `key_hash` is a pure function
  of `(model, normalized prompt, params)` and is the same on every machine for an unencrypted
  entry — the only identifier that survives the trip.
- **`createdAt` is the entry's original creation time, not the share time.** Freshness has to
  travel with the entry the way HTTP `Cache-Control` semantics do elsewhere in this project: an
  entry that was already stale when shared must still be stale after import, not artificially
  refreshed because it's new to the importer. `sharedAt` is kept separately, for a human skimming
  `git log`, and plays no role in freshness.

### New tools

**`cache_share(id, force?)`**

1. Look up the entry and resolve its `derived_from` parents to their `key_hash`es.
2. If the local store has an encryption key configured and `force` is not `true`, refuse. Two
   reasons, not one: exporting plaintext into a shared git repo defeats the reason encryption was
   turned on, *and* an encrypted store's `key_hash` is an HMAC keyed by the local encryption key
   (`crypto.ts`'s `digest()`), so it isn't even reproducible by a machine with a different key or
   no key — the filename itself wouldn't mean anything portable. When `force: true` is passed, the
   export recomputes the plain, unkeyed hash for the filename, since that's the only one a future
   importer could ever reproduce.
3. Find the git root; error clearly if the project isn't a git repository. Sharing without version
   control doesn't fit this design.
4. Write `.echocache/<key_hash>.json`. Identical content already present → no-op. Different
   content already present → overwrite (a legitimate "I refreshed this, re-share it" case; if a
   teammate shared something different at the same key, that's a git conflict on the next pull,
   by design).
5. Return `{ path, alreadyShared: boolean }`.

**`cache_sync(dryRun?)`**

1. Find the git root; no repo or no `.echocache/` directory → return an empty result, not an
   error. "Nothing to sync" is a normal outcome here, unlike `cache_share`'s stricter refusal.
2. Read every `*.json` file in `.echocache/`. A file that fails to parse (an unresolved git
   conflict marker left in place) or declares an unrecognized `formatVersion` is skipped and
   reported, never crashed on or silently imported.
3. **Pass 1:** upsert each valid entry into the local store via the existing `set()` path, with an
   explicit `createdAt` override so imported freshness matches the original rather than "now".
   This reuses the atomic `INSERT … ON CONFLICT(key_hash) DO UPDATE` path already in `store.ts` —
   no new write logic, just a new optional parameter.
4. **Pass 2:** for each imported entry's `derivedFrom` list, resolve each parent `key_hash` to
   whatever local id now holds it (present because it was in the same sync, or already local) and
   record the `derived-from` edge. A parent that can't be resolved is skipped and reported, not a
   hard failure — a derivation is still useful even if one ancestor link can't be verified this
   time.
5. Return `{ imported, updated, skipped: [{ file, reason }], edgesLinked }`. `dryRun: true` runs
   the same scan and reports the same shape without writing anything.

### Store-level additions (`store.ts`)

- `exportEntry(id): ExportedEntry | null` — the entry plus its `derived_from` parents resolved to
  their `key_hash`es.
- `set()` gains an internal-only optional `createdAt` override, used solely by the sync path — not
  exposed on the `cache_set` MCP tool schema, so a normal caller can't backdate an entry's
  freshness by accident.
- A small `key_hash -> local id` lookup, used by pass 2.

### New module: `src/share.ts`

Git-root detection and the `.echocache/*.json` file I/O don't fit any existing module — `store.ts`
is SQLite/graph logic, `db.ts` is schema, `server.ts` is tool registration. `share.ts` holds the
new, independently-testable logic (finding the root, reading/writing files, orchestrating the two
passes against a `CacheStore`); `server.ts` registers `cache_share`/`cache_sync` and delegates to
it, following the same `guard()`-wrapped pattern every other tool uses.

## Security

`.echocache/*.json` files are plaintext by design — that's the point, a teammate has to be able
to read them. This makes `AGENTS.md`'s existing "never cache_set credentials" rule doubly
important once sharing exists: the blast radius widens from one local disk to everyone who ever
clones the repo, permanently, in git history. `AGENTS.md`'s Secrets section should be updated once
this ships to say so explicitly, and to name `cache_share` alongside `cache_set`.

## Testing plan

- `share.ts` unit tests: git-root detection walks up correctly and fails cleanly outside a repo;
  writing identical content twice is a no-op; writing different content at the same key overwrites.
- **Round-trip test**, the one that actually validates the feature: store A shares an entry
  (including a `derived_from` parent), a separate store B (a fresh temp SQLite database,
  standing in for a teammate's machine) runs `cache_sync` against the same `.echocache/`
  directory, and: the entry is findable in B by `cache_query` with *different wording* than it
  was shared under (mirrors the existing pattern in `niche.test.ts`); the `derived-from` edge
  resolves to a correct local id in B; an entry that was already stale or expired when shared is
  still stale or expired after import, never reset to fresh.
- Malformed file in `.echocache/` (invalid JSON, simulating a leftover conflict marker) is
  skipped with a reported reason, not thrown on.
- Unrecognized `formatVersion` is skipped with a reported reason, not thrown on.
- `cache_share` on an entry from an encrypted store throws without `force`; succeeds with
  `force: true`, and the exported file's `keyHash` is the unkeyed hash, verified reproducible by
  computing it independently without the encryption key.
- `cache_sync` run twice with no new files in between reports zero imports the second time.

## Docs to update once implemented

- `AGENTS.md` — document `cache_share`/`cache_sync`, when to reach for them, and the sharpened
  secrets warning.
- `CLAUDE.md` — module reference entry for `share.ts`.
- `README.md` — deliberately **not** changed to claim this is proven. The existing line calling
  cross-project sharing "unproven, not just untested" should stay until this is actually measured
  the way everything else in that document was — same discipline as the rest of this project's
  history of correcting claims that got ahead of evidence.

## Open question for implementation time

Whether `echocache-cache` (the vendored skill) or a new skill should document this workflow for
an agent — not resolved here; a call for the implementation plan.
