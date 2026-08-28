#!/usr/bin/env node

import { once } from 'node:events';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { CliArgsHandlerBase } from '@comunica/actor-init-query';
import type { QuerySourceUnidentified, QueryStringContext } from '@comunica/types';
import type { Bindings, Term } from '@rdfjs/types';
import { PathQueryCancelledError } from './errors.js';
import { QueryEngine } from './QueryEngine.js';
import type { PathResult } from './types.js';

const HELP = `Usage: comunica-paths [options] [query-file] [sources...]

Execute a PATHS query and stream one JSON object per matching path.
The query is read from stdin when query-file is omitted or is "-".
Sources may be URLs or Comunica type-prefixed values such as sparql@https://example.org/sparql.

Options:
  -s, --source <source>    Add a Comunica source, optionally as type@value (repeatable)
  -c, --context <json|file> Use a JSON query context string or file
  -f, --file <path>        Read a local RDF source (repeatable)
  -u, --url <url>          Query a remote RDF source (repeatable)
  -a, --algorithm <name>  Select a configured path actor (default: bfs)
  -h, --help               Show this help
  -V, --version            Show the package version

Examples:
  comunica-paths route.paths --file graph.ttl
  comunica-paths route.paths sparql@https://qlever.dev/api/wikidata
  comunica-paths route.paths --context sources.json
  cat route.paths | comunica-paths --source brtpf@https://example.org/data
`;

const MEDIA_TYPES: Readonly<Record<string, string>> = {
  '.json': 'application/ld+json',
  '.jsonld': 'application/ld+json',
  '.n3': 'text/n3',
  '.nq': 'application/n-quads',
  '.nquads': 'application/n-quads',
  '.nt': 'application/n-triples',
  '.ntriples': 'application/n-triples',
  '.owl': 'application/rdf+xml',
  '.rdf': 'application/rdf+xml',
  '.trig': 'application/trig',
  '.trix': 'application/trix',
  '.ttl': 'text/turtle',
  '.turtle': 'text/turtle',
  '.xml': 'application/rdf+xml',
};

interface CliArguments {
  algorithm?: string;
  context?: string;
  files: string[];
  help: boolean;
  queryFile?: string;
  sources: string[];
  urls: string[];
  version: boolean;
}

interface JsonTerm {
  termType: Term['termType'];
  value: string;
  language?: string;
  direction?: 'ltr' | 'rtl' | '' | null;
  datatype?: JsonTerm;
  subject?: JsonTerm;
  predicate?: JsonTerm;
  object?: JsonTerm;
  graph?: JsonTerm;
}

class CliError extends Error {}

async function main(args: string[]): Promise<void> {
  const options = parseCliArguments(args);
  if (options.help) {
    process.stdout.write(HELP);
    return;
  }
  if (options.version) {
    const packageJson = JSON.parse(await readFile(resolve(__dirname, '../package.json'), 'utf8')) as { version: string };
    process.stdout.write(`${packageJson.version}\n`);
    return;
  }

  const query = options.queryFile && options.queryFile !== '-' ?
    await readTextFile(options.queryFile, 'query') :
    await readStandardInput();
  if (!query.trim()) {
    throw new CliError('PATHS query input is empty');
  }

  const queryContext = await loadQueryContext(options.context);
  const localSources = await Promise.all(options.files.map(loadLocalSource));
  const sources: QuerySourceUnidentified[] = [
    ...(queryContext.sources ?? []),
    ...localSources,
    ...options.sources.map(parseSourceArgument),
    ...options.urls.map(parseRemoteSourceArgument),
  ];
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);

  try {
    const engine = new QueryEngine();
    for await (const path of await engine.queryPathString(
      query,
      { ...queryContext, sources, httpAbortSignal: controller.signal } as QueryStringContext,
      options.algorithm ? { algorithm: options.algorithm } : undefined,
    )) {
      await writeLine(JSON.stringify(pathToJson(path)));
    }
    if (controller.signal.aborted) {
      throw new PathQueryCancelledError();
    }
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
  }
}

function parseCliArguments(args: string[]): CliArguments {
  let parsed;
  try {
    parsed = parseArgs({
      args,
      allowPositionals: true,
      options: {
        algorithm: { type: 'string', short: 'a' },
        context: { type: 'string', short: 'c' },
        file: { type: 'string', short: 'f', multiple: true },
        help: { type: 'boolean', short: 'h' },
        source: { type: 'string', short: 's', multiple: true },
        url: { type: 'string', short: 'u', multiple: true },
        version: { type: 'boolean', short: 'V' },
      },
      strict: true,
    });
  } catch (error: unknown) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  for (const url of parsed.values.url ?? []) {
    parseRemoteSourceArgument(url);
  }

  return {
    files: parsed.values.file ?? [],
    urls: parsed.values.url ?? [],
    help: parsed.values.help ?? false,
    sources: [ ...parsed.positionals.slice(1), ...(parsed.values.source ?? []) ],
    version: parsed.values.version ?? false,
    ...(parsed.values.context === undefined ? {} : { context: parsed.values.context }),
    ...(parsed.positionals[0] === undefined ? {} : { queryFile: parsed.positionals[0] }),
    ...(parsed.values.algorithm === undefined ? {} : { algorithm: parsed.values.algorithm }),
  };
}

function parseSourceArgument(sourceString: string): QuerySourceUnidentified {
  const source = CliArgsHandlerBase.getSourceObjectFromString(sourceString);
  if (typeof source.value !== 'string' || source.value.length === 0) {
    throw new CliError(`Invalid source: ${sourceString}`);
  }
  return source as QuerySourceUnidentified;
}

function parseRemoteSourceArgument(sourceString: string): QuerySourceUnidentified {
  const source = parseSourceArgument(sourceString) as { value: string };
  try {
    new URL(source.value);
  } catch {
    throw new CliError(`Invalid source URL: ${sourceString}`);
  }
  return source as QuerySourceUnidentified;
}

async function loadQueryContext(contextInput: string | undefined): Promise<Partial<QueryStringContext>> {
  if (contextInput === undefined) {
    return {};
  }
  const fromFile = existsSync(contextInput);
  const input = fromFile ? await readTextFile(contextInput, 'context') : contextInput;
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Could not parse ${fromFile ? `context file ${contextInput}` : 'context JSON'}: ${message}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new CliError('Query context must be a JSON object');
  }
  const context = parsed as Record<string, unknown>;
  if (context.sources !== undefined && !Array.isArray(context.sources)) {
    throw new CliError('Query context "sources" must be an array');
  }
  return context as Partial<QueryStringContext>;
}

async function loadLocalSource(file: string): Promise<QuerySourceUnidentified> {
  const absolutePath = resolve(file);
  const mediaType = MEDIA_TYPES[extname(absolutePath).toLowerCase()];
  if (!mediaType) {
    throw new CliError(`Cannot infer the RDF media type for local source: ${file}`);
  }
  return {
    type: 'serialized',
    value: await readTextFile(absolutePath, 'RDF source'),
    mediaType,
    baseIRI: pathToFileURL(absolutePath).href,
  };
}

async function readTextFile(file: string, label: string): Promise<string> {
  try {
    return await readFile(resolve(file), 'utf8');
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    throw new CliError(`Could not read ${label} ${file}: ${message}`);
  }
}

async function readStandardInput(): Promise<string> {
  process.stdin.setEncoding('utf8');
  let input = '';
  for await (const chunk of process.stdin) {
    input += chunk;
  }
  return input;
}

function pathToJson(path: PathResult): Record<string, unknown> {
  return {
    nodes: path.nodes.map(termToJson),
    steps: path.steps.map(step => ({
      bindings: bindingsToJson(step.bindings),
    })),
    ...(path.startBindings ? { startBindings: bindingsToJson(path.startBindings) } : {}),
    ...(path.endBindings ? { endBindings: bindingsToJson(path.endBindings) } : {}),
  };
}

function bindingsToJson(bindings: Bindings): Record<string, JsonTerm> {
  return Object.fromEntries([ ...bindings ].map(([ variable, term ]) => [ variable.value, termToJson(term) ]));
}

function termToJson(term: Term): JsonTerm {
  if (term.termType === 'Literal') {
    return {
      termType: term.termType,
      value: term.value,
      language: term.language,
      ...(term.direction === undefined ? {} : { direction: term.direction }),
      datatype: termToJson(term.datatype),
    };
  }
  if (term.termType === 'Quad') {
    return {
      termType: term.termType,
      value: term.value,
      subject: termToJson(term.subject),
      predicate: termToJson(term.predicate),
      object: termToJson(term.object),
      graph: termToJson(term.graph),
    };
  }
  return { termType: term.termType, value: term.value };
}

async function writeLine(line: string): Promise<void> {
  if (!process.stdout.write(`${line}\n`)) {
    await once(process.stdout, 'drain');
  }
}

process.stdout.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EPIPE') {
    process.exit(0);
  }
  throw error;
});

void main(process.argv.slice(2)).catch((error: unknown) => {
  if (error instanceof PathQueryCancelledError) {
    process.stderr.write('comunica-paths: query cancelled\n');
    process.exitCode = 130;
    return;
  }
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`comunica-paths: ${message}\nRun comunica-paths --help for usage.\n`);
  process.exitCode = 1;
});
