# Release checklist

Everything that can be verified without credentials is verified and committed. What remains needs
your npm login and a GitHub device-code auth, so it has to be run by you.

Run the steps in order — each one depends on the last. Stop if any step fails; nothing after it
will work.

## Before you start

```sh
cd /home/skuk/nowhereman     # directory is still named nowhereman; the project is echocache
git pull
npm run check                # expect: 151 passing, 0 failing
```

## 1. Make the repository public

The registry verifies ownership through GitHub and needs the repo reachable. Also the README is
the first thing anyone reads after the npm page.

```sh
gh repo edit kskurtveit/echocache --visibility public --accept-visibility-change-consequences
```

Verify: <https://github.com/kskurtveit/echocache> loads while signed out.

## 2. Publish to npm

`prepublishOnly` runs `check` + `build` automatically, so a broken tree cannot go out.

```sh
npm login
npm publish --access public
```

Verify:

```sh
npm view echocache version        # expect 0.1.0
```

Then confirm the published artifact actually runs, from a scratch directory — this is the check
that caught the entrypoint bug, and it is worth repeating against the real registry copy:

```sh
cd $(mktemp -d) && npm init -y >/dev/null && npm install echocache
ECHOCACHE_DB_PATH=$(mktemp -d)/cache.db ./node_modules/.bin/echocache
# expect on stderr: [echocache] MCP cache server on stdio — db: ...
# then Ctrl-C
```

If that prints nothing and exits, **do not continue** — that is the symlink/entrypoint failure
mode returning, and the registry entry would point at a package that does nothing.

## 3. Publish to the MCP Registry

Registry metadata points at the npm package, so npm must be done first.

```sh
brew install mcp-publisher
# or:
curl -L "https://github.com/modelcontextprotocol/registry/releases/latest/download/mcp-publisher_$(uname -s | tr '[:upper:]' '[:lower:]')_$(uname -m | sed 's/x86_64/amd64/;s/aarch64/arm64/').tar.gz" | tar xz mcp-publisher && sudo mv mcp-publisher /usr/local/bin/

mcp-publisher login github     # device code — opens a GitHub prompt
mcp-publisher publish
```

Verify:

```sh
curl "https://registry.modelcontextprotocol.io/v0.1/servers?search=io.github.kskurtveit/echocache"
```

`server.json` already validates against the published schema, and `release.test.ts` pins the
fields the registry rejects on, so this step should be mechanical.

## 4. Submit to awesome-mcp-servers

`modelcontextprotocol/servers` no longer accepts community entries — it defers to the registry
(step 3). The still-active community list is `punkpeye/awesome-mcp-servers`.

Add one line under **🧠 Knowledge & Memory**, keeping the section alphabetical:

```markdown
- [echocache](https://github.com/kskurtveit/echocache) 📇 🏠 🍎 🪟 🐧 - Cache expensive LLM results — HTTP-style freshness (TTL / stale-while-revalidate) plus semantic recall of related past answers
```

```sh
gh repo fork punkpeye/awesome-mcp-servers --clone --remote
# edit README.md, then:
git checkout -b add-echocache
git commit -am "Add echocache to Knowledge & Memory"
git push -u origin add-echocache
gh pr create --repo punkpeye/awesome-mcp-servers \
  --title "Add echocache to Knowledge & Memory" \
  --body "echocache is an MCP server that caches expensive LLM results — exact-match lookup with HTTP-style freshness, plus a similarity graph for semantic recall of related past answers. MIT, TypeScript, stdio, published on npm and the MCP registry."
```

## 5. Re-register your own install under the new name

The local server is still registered as `nowhereman` pointing at the working tree. Switch it to
the published package so you are running what everyone else runs:

```sh
claude mcp remove nowhereman
claude mcp add echocache -- npx -y echocache
```

Your accumulated cache carries over: `~/.nowhereman/cache.db` was copied to
`~/.echocache/cache.db`, which is the new default path. The old directory is untouched and can be
deleted once you have confirmed the new one works.

## After a version bump, later

Three version fields must move together — `package.json` `version`, and `server.json`'s `version`
and `packages[0].version`. `release.test.ts` fails if they drift, so `npm run check` catches it
before publish. Then re-run steps 2 and 3.
