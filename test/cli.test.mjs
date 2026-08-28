import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const repository = fileURLToPath(new URL('..', import.meta.url));
const cli = fileURLToPath(new URL('../dist/cli.js', import.meta.url));
const EX = 'https://example.org/';

function runCli(args, options = {}) {
  return spawnSync(process.execPath, [ cli, ...args ], {
    cwd: repository,
    encoding: 'utf8',
    ...options,
  });
}

describe('command-line interface', () => {
  it('executes a query file over multiple local RDF files as streaming JSON Lines', () => {
    const result = runCli([
      'test/fixtures/shortest.paths',
      '--file', 'test/fixtures/source-a.ttl',
      '--file', 'test/fixtures/source-b.ttl',
    ]);

    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, '');
    const paths = result.stdout.trim().split('\n').map(line => JSON.parse(line));
    assert.deepEqual(paths.map(path => path.steps.length), [ 2, 2 ]);
    assert.deepEqual(paths.map(path => path.nodes.map(node => node.value).join('-')), [
      `${EX}a-${EX}b-${EX}d`,
      `${EX}a-${EX}c-${EX}d`,
    ]);
    assert.deepEqual(Object.keys(paths[0]).sort(), [ 'endBindings', 'nodes', 'startBindings', 'steps' ]);
    assert.deepEqual(Object.keys(paths[0].steps[0]), [ 'bindings' ]);
    assert.deepEqual(Object.keys(paths[0].steps[0].bindings).sort(), [ 'from', 'to' ]);
  });

  it('prints help without reading stdin', () => {
    const result = runCli([ '--help' ]);

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /^Usage: comunica-paths/u);
    assert.match(result.stdout, /--file <path>/u);
    assert.match(result.stdout, /--url <url>/u);
  });

  it('reads a PATHS query from stdin when no query file is given', () => {
    const result = runCli([
      '--file', 'test/fixtures/source-a.ttl',
    ], {
      input: `
        PREFIX ex: <${EX}>
        PATHS SHORTEST
        START ?from = ex:a
        END ?to = ex:d
        VIA ex:edge
        LIMIT 1
      `,
    });

    assert.equal(result.status, 0, result.stderr);
    const path = JSON.parse(result.stdout.trim());
    assert.deepEqual(path.nodes.map(node => node.value), [ `${EX}a`, `${EX}b`, `${EX}d` ]);
  });

  it('reports unsupported algorithms as command errors', () => {
    const result = runCli([
      'test/fixtures/shortest.paths',
      '--file', 'test/fixtures/source-a.ttl',
      '--algorithm', 'not-installed',
    ]);

    assert.equal(result.status, 1);
    assert.match(result.stderr, /only supports the 'bfs' path algorithm/u);
    assert.equal(result.stdout, '');
  });
});
