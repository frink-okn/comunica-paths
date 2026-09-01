import assert from 'node:assert/strict';
import { QueryEngine } from '../dist/index.js';

const endpoint = 'https://apps.okn.us/ldf/wikidata';
const controller = new AbortController();
const timeout = setTimeout(() => controller.abort(), 30_000);

try {
  const engine = new QueryEngine();
  const paths = [];
  for await (const path of await engine.queryPathString(`
    PREFIX wd: <http://www.wikidata.org/entity/>
    PREFIX wdt: <http://www.wikidata.org/prop/direct/>
    PATHS SHORTEST
    START ?from = wd:Q42
    END ?to = wd:Q145
    VIA { VALUES ?predicate { wdt:P19 wdt:P17 } ?from ?predicate ?to }
    MAX LENGTH 2
    LIMIT 2
  `, {
    sources: [ endpoint ],
    httpAbortSignal: controller.signal,
  }, {
    signal: controller.signal,
  })) {
    paths.push(path);
  }

  assert.ok(paths.some(path =>
    path.nodes.map(term => term.value).join(' ') === [
      'http://www.wikidata.org/entity/Q42',
      'http://www.wikidata.org/entity/Q350',
      'http://www.wikidata.org/entity/Q145',
    ].join(' ')));
  console.log(`Live LDF smoke test passed (${paths.length} path${paths.length === 1 ? '' : 's'}).`);
} finally {
  clearTimeout(timeout);
}
