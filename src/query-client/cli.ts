import { QueryClient, QueryClientError } from './client.js';
import type { TraverseInput } from './types.js';

// --- Argument parsing ---

interface ParsedArgs {
  flags: Record<string, string>;
  positional: string[];
}

function parseFlags(args: string[]): ParsedArgs {
  const flags: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      const next = args[i + 1];
      if (next && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

// --- CLI runner ---

export async function runQueryCli(argv: string[]): Promise<void> {
  const command = argv[0];
  const rest = argv.slice(1);
  const { flags, positional } = parseFlags(rest);

  const port = flags.port ? parseInt(flags.port, 10) : undefined;
  const host = flags.host ?? undefined;
  const client = new QueryClient({ port, host });

  try {
    let result: unknown;

    switch (command) {
      case 'schema':
        result = await client.getSchema();
        break;

      case 'get':
        if (!positional[0]) {
          die('Usage: firegraph query get <uid>');
        }
        result = await client.getNodeDetail({ uid: positional[0] });
        break;

      case 'find-nodes': {
        if (!positional[0]) {
          die('Usage: firegraph query find-nodes <type> [--limit N]');
        }
        result = await client.getNodes({
          type: positional[0],
          limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
        });
        break;
      }

      case 'find-edges': {
        result = await client.getEdges({
          aType: flags.aType,
          aUid: flags.aUid,
          axbType: flags.axbType,
          bType: flags.bType,
          bUid: flags.bUid,
          limit: flags.limit ? parseInt(flags.limit, 10) : undefined,
        });
        break;
      }

      case 'traverse': {
        const jsonStr = positional.join(' ');
        if (!jsonStr) {
          die(
            'Usage: firegraph query traverse \'<JSON>\'\n\n' +
            'JSON shape:\n' +
            '{\n' +
            '  "startUid": "nodeUid",\n' +
            '  "hops": [\n' +
            '    {\n' +
            '      "axbType": "relationName",\n' +
            '      "direction": "forward" | "reverse",\n' +
            '      "limit": 10,\n' +
            '      "aType": "filterSourceType",\n' +
            '      "bType": "filterTargetType",\n' +
            '      "orderBy": { "field": "data.name", "direction": "asc" },\n' +
            '      "where": [{ "field": "data.status", "op": "==", "value": "active" }]\n' +
            '    }\n' +
            '  ],\n' +
            '  "maxReads": 100,\n' +
            '  "concurrency": 5\n' +
            '}',
          );
        }
        let input: TraverseInput;
        try {
          input = JSON.parse(jsonStr) as TraverseInput;
        } catch {
          die(`Invalid JSON: ${jsonStr.slice(0, 200)}`);
        }
        result = await client.traverse(input!);
        break;
      }

      case 'search':
        if (!positional[0]) {
          die('Usage: firegraph query search <query>');
        }
        result = await client.search({ q: positional.join(' ') });
        break;

      case '--help':
      case '-h':
      case undefined:
        printHelp();
        return;

      default:
        die(
          `Unknown query command: ${command}\n` +
          'Commands: schema, get, find-nodes, find-edges, traverse, search',
        );
    }

    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    if (err instanceof QueryClientError) {
      console.error(JSON.stringify({ error: err.message, code: err.code }));
    } else {
      console.error(JSON.stringify({ error: (err as Error).message }));
    }
    process.exit(1);
  }
}

function printHelp(): void {
  console.log('');
  console.log('  Usage: firegraph query <command> [options]');
  console.log('');
  console.log('  Commands:');
  console.log('    schema                          Get graph schema (node types + edge types)');
  console.log('    get <uid>                       Get node detail with edges');
  console.log('    find-nodes <type> [--limit N]   List nodes of a type');
  console.log('    find-edges [filters]            List edges matching filters');
  console.log('    traverse \'<JSON>\'               Multi-hop graph traversal');
  console.log('    search <query>                  Search nodes by text');
  console.log('');
  console.log('  Global options:');
  console.log('    --port <number>   Editor server port (default: auto-detect from config)');
  console.log('    --host <string>   Editor server host (default: localhost)');
  console.log('');
  console.log('  find-edges filters:');
  console.log('    --aType <type>    Filter by source type');
  console.log('    --aUid <uid>      Filter by source UID');
  console.log('    --axbType <rel>   Filter by relation type');
  console.log('    --bType <type>    Filter by target type');
  console.log('    --bUid <uid>      Filter by target UID');
  console.log('    --limit <N>       Max results (1-200, default 25)');
  console.log('');
  console.log('  Examples:');
  console.log('    npx firegraph query schema');
  console.log('    npx firegraph query get user123');
  console.log('    npx firegraph query find-nodes task --limit 10');
  console.log('    npx firegraph query find-edges --aUid user1 --axbType hasTask');
  console.log('    npx firegraph query search "John Doe"');
  console.log('');
}

function die(msg: string): never {
  console.error(msg);
  process.exit(1);
}
