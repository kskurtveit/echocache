import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

/**
 * Publishing goes to two places that must agree: npm (package.json) and the MCP Server Registry
 * (server.json). The registry rejects a mismatch, and it rejects it at publish time — after the
 * npm publish has already happened and can no longer be taken back. These pin the invariants a
 * version bump is most likely to break, since bumping means editing the same number in three
 * places across two files.
 */

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const read = (name: string): Record<string, any> => JSON.parse(readFileSync(join(root, name), 'utf8'));
const pkg = read('package.json');
const server = read('server.json');
const glama = read('glama.json');

describe('release manifests', () => {
    test('the registry server name matches package.json mcpName', () => {
        assert.equal(server.name, pkg.mcpName, 'the registry rejects a server.json whose name is not the published mcpName');
    });

    test('the mcpName is in the io.github.<owner> namespace GitHub auth can prove', () => {
        assert.match(pkg.mcpName, /^io\.github\.[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/);
    });

    test('every version in server.json tracks the package version', () => {
        assert.equal(server.version, pkg.version);
        assert.equal(server.packages[0].version, pkg.version, 'the packages[] entry is a separate field and is easy to forget');
    });

    test('the registry points at the npm package this repo actually publishes', () => {
        assert.equal(server.packages[0].registryType, 'npm');
        assert.equal(server.packages[0].identifier, pkg.name);
        assert.equal(server.packages[0].transport.type, 'stdio');
    });

    test('the registry description stays within the schema limit of 100 characters', () => {
        // Found the hard way: 152 characters validated fine locally and would have been rejected
        // by the registry on publish, after npm had already gone out.
        assert.ok(
            server.description.length <= 100,
            `description is ${server.description.length} chars, limit is 100`
        );
    });

    test('the repository url is the same repo in both manifests', () => {
        const fromPkg = pkg.repository.url.replace(/^git\+/, '').replace(/\.git$/, '');
        assert.equal(server.repository.url, fromPkg);
    });

    test('glama.json names the repo owner as a maintainer', () => {
        // Glama's directory reads this to know who may administer the listing; without it the
        // profile is scored incomplete. The owner comes from mcpName so it cannot drift from the
        // namespace GitHub auth actually proves.
        const owner = pkg.mcpName.split('/')[0].replace(/^io\.github\./, '');
        assert.ok(
            glama.maintainers.includes(owner),
            `glama.json maintainers ${JSON.stringify(glama.maintainers)} does not include ${owner}`
        );
    });

    test('the package is publishable rather than marked private', () => {
        assert.notEqual(pkg.private, true, 'private:true makes npm publish refuse');
    });

    test('the npm tarball ships the built entrypoint the bin points at', () => {
        const binTarget = pkg.bin[pkg.name];
        assert.ok(binTarget, `no bin entry named ${pkg.name}`);
        const shipped = pkg.files.some((f: string) => binTarget.replace(/^\.\//, '').startsWith(f.replace(/\/$/, '')));
        assert.ok(shipped, `${binTarget} is not covered by the files allowlist ${JSON.stringify(pkg.files)}`);
    });
});
