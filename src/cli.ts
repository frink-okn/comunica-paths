#!/usr/bin/env node

import { once } from 'node:events';
import { readFile } from 'node:fs/promises';
import { extname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { QuerySourceUnidentified } from '@comunica/types';
import type { Bindings, Term } from '@rdfjs/types';
import { PathQueryCancelledError } from './errors.js';
import { QueryEngine } from './QueryEngine.js';
import type { PathResult } from './types.js';

const HELP = `Usage: comunica-paths [options] [query-file]

Execute a PATHS query and stream one JSON object per matching path.
The query is read from stdin when query-file is omitted or is "-".

Options:
  -f, --file <path>       Read a local RDF source (repeatable)
  -u, --url <url>         Query a remote RDF source (repeatable)
  -a, --algorithm <name> Select a configured path actor (default: bfs)
  -h, --help              Show this help
  -V, --version           Show the package version

Examples:
  comunica-paths route.paths --file graph.ttl
  comunica-paths route.paths --file a.ttl --file b.nq
  cat route.paths | comunica-paths --url https://example.org/data
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
  files: string[];
  help: boolean;
  queryFile?: string;
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

  const localSources = await Promise.all(options.files.map(loadLocalSource));
  const sources: QuerySourceUnidentified[] = [ ...localSources, ...options.urls ];
  const controller = new AbortController();
  const abort = (): void => controller.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);

  try {
    const engine = new QueryEngine();
    for await (const path of engine.queryPathString(
      query,
      { sources, httpAbortSignal: controller.signal },
      { signal: controller.signal, ...(options.algorithm ? { algorithm: options.algorithm } : {}) },
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
        file: { type: 'string', short: 'f', multiple: true },
        help: { type: 'boolean', short: 'h' },
        url: { type: 'string', short: 'u', multiple: true },
        version: { type: 'boolean', short: 'V' },
      },
      strict: true,
    });
  } catch (error: unknown) {
    throw new CliError(error instanceof Error ? error.message : String(error));
  }

  if (parsed.positionals.length > 1) {
    throw new CliError(`Expected at most one query file, received ${parsed.positionals.length}`);
  }
  for (const url of parsed.values.url ?? []) {
    try {
      new URL(url);
    } catch {
      throw new CliError(`Invalid source URL: ${url}`);
    }
  }

  return {
    files: parsed.values.file ?? [],
    urls: parsed.values.url ?? [],
    help: parsed.values.help ?? false,
    version: parsed.values.version ?? false,
    ...(parsed.positionals[0] === undefined ? {} : { queryFile: parsed.positionals[0] }),
    ...(parsed.values.algorithm === undefined ? {} : { algorithm: parsed.values.algorithm }),
  };
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
    length: path.steps.length,
    nodes: path.nodes.map(termToJson),
    steps: path.steps.map(step => ({
      from: termToJson(step.from),
      to: termToJson(step.to),
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
