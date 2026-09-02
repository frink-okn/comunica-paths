import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

const require = createRequire(import.meta.url);
const pathsEnginePath = fileURLToPath(
  new URL('../engine-default.cjs', import.meta.url),
);
const sparqlEnginePath = require.resolve(
  '@comunica/query-sparql/engine-default.js',
);

function requiredComunicaPackages(engineSource) {
  return new Set(
    [ ...engineSource.matchAll(/require\(['"](@comunica\/[^'"]+)['"]\)/gu) ]
      .map(match => match[1]),
  );
}

function defaultComponentIds(engineSource) {
  return new Set(
    engineSource.match(/urn:comunica:default:[A-Za-z0-9_./#?=-]+/gu) ?? [],
  );
}

function missingFrom(expected, actual) {
  return [ ...expected ].filter(value => !actual.has(value)).sort();
}

describe('compiled engine configuration', () => {
  it('contains the complete stock Comunica SPARQL configuration', async () => {
    const [ pathsEngine, sparqlEngine ] = await Promise.all([
      readFile(pathsEnginePath, 'utf8'),
      readFile(sparqlEnginePath, 'utf8'),
    ]);

    assert.deepEqual(
      missingFrom(
        requiredComunicaPackages(sparqlEngine),
        requiredComunicaPackages(pathsEngine),
      ),
      [],
      'PATHS engine must load every Comunica package used by the stock engine',
    );
    assert.deepEqual(
      missingFrom(
        defaultComponentIds(sparqlEngine),
        defaultComponentIds(pathsEngine),
      ),
      [],
      'PATHS engine must contain every stock default component',
    );
    assert.match(pathsEngine, /urn:comunica:paths:init/u);
  });
});
