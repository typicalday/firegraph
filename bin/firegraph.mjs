#!/usr/bin/env node
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const subcommand = process.argv[2];

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        args[key] = next;
        i++;
      } else {
        args[key] = true;
      }
    }
  }
  return args;
}

if (subcommand === 'editor') {
  process.env.NODE_ENV = 'production';
  // Pass remaining args through (strip 'editor' subcommand)
  process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];

  const editorEntry = path.join(__dirname, '..', 'dist', 'editor', 'server', 'index.mjs');
  if (!fs.existsSync(editorEntry)) {
    const { execSync } = await import('child_process');
    const pkgDir = path.join(__dirname, '..');
    console.log('Editor not built yet — building...');
    try {
      execSync('npm run build:editor', { cwd: pkgDir, stdio: 'inherit' });
    } catch {
      console.error('Failed to build editor. Run "npm run build:editor" manually in the firegraph package directory.');
      process.exit(1);
    }
  }

  await import(editorEntry);
} else if (subcommand === 'query') {
  const queryEntry = path.join(__dirname, '..', 'dist', 'query-client', 'index.js');
  if (!fs.existsSync(queryEntry)) {
    console.error('Query client not built. Run "npm run build" first.');
    process.exit(1);
  }
  const { runQueryCli } = await import(queryEntry);
  await runQueryCli(process.argv.slice(3));
} else if (subcommand === 'codegen') {
  const args = parseArgs(process.argv.slice(3));
  const entitiesDir = path.resolve(args.entities || './entities');
  const outPath = args.out || null;

  const { discoverEntities } = await import(path.join(__dirname, '..', 'dist', 'index.js'));
  const { generateTypes } = await import(path.join(__dirname, '..', 'dist', 'codegen', 'index.js'));

  try {
    const { result, warnings } = discoverEntities(entitiesDir);
    for (const w of warnings) {
      console.warn(`  warning: ${w.message}`);
    }

    const nodeCount = result.nodes.size;
    const edgeCount = result.edges.size;

    if (nodeCount === 0 && edgeCount === 0) {
      console.error(`No entities found in ${entitiesDir}`);
      process.exit(1);
    }

    const output = await generateTypes(result);

    if (outPath) {
      const resolved = path.resolve(outPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, output, 'utf-8');
      console.log(`Generated ${nodeCount} node type(s) + ${edgeCount} edge type(s) → ${resolved}`);
    } else {
      process.stdout.write(output);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
} else if (subcommand === 'indexes') {
  const args = parseArgs(process.argv.slice(3));
  const entitiesDir = args.entities ? path.resolve(args.entities) : null;
  const collection = args.collection || 'graph';
  const outPath = args.out || null;

  const distIndex = path.join(__dirname, '..', 'dist', 'index.js');
  const { generateIndexConfig, discoverEntities } = await import(distIndex);

  try {
    let entities = undefined;
    if (entitiesDir) {
      const { result, warnings } = discoverEntities(entitiesDir);
      for (const w of warnings) {
        console.warn(`  warning: ${w.message}`);
      }
      entities = result;
      const nodeCount = result.nodes.size;
      const edgeCount = result.edges.size;
      if (nodeCount > 0 || edgeCount > 0) {
        console.error(`Discovered ${nodeCount} node type(s) + ${edgeCount} edge type(s)`);
      }
    }

    const config = generateIndexConfig(collection, entities);
    const output = JSON.stringify(config, null, 2) + '\n';

    if (outPath) {
      const resolved = path.resolve(outPath);
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(resolved, output, 'utf-8');
      console.log(`Generated ${config.indexes.length} index(es) → ${resolved}`);
    } else {
      process.stdout.write(output);
    }
  } catch (err) {
    console.error(`Error: ${err.message}`);
    process.exit(1);
  }
} else if (subcommand === '--help' || subcommand === '-h' || !subcommand) {
  console.log('');
  console.log('  Usage: firegraph <command> [options]');
  console.log('');
  console.log('  Commands:');
  console.log('    editor         Launch the Firegraph Editor UI');
  console.log('    query          Query the graph via the editor API');
  console.log('    codegen        Generate TypeScript types from entity schemas');
  console.log('    indexes        Generate recommended Firestore index definitions');
  console.log('');
  console.log('  Editor options:');
  console.log('    --config <path>        Path to firegraph.config.ts (default: auto-discover in cwd)');
  console.log('    --entities <path>      Path to entities directory');
  console.log('    --project <id>         GCP project ID (default: auto-detect via ADC)');
  console.log('    --collection <path>    Firestore collection path (default: graph)');
  console.log('    --port <number>        Server port (default: 3883)');
  console.log('    --emulator [host:port] Use Firestore emulator');
  console.log('    --readonly             Force read-only mode');
  console.log('');
  console.log('  Query options:');
  console.log('    Run "firegraph query --help" for query-specific help');
  console.log('');
  console.log('  Codegen options:');
  console.log('    --entities <path>      Path to entities directory (default: ./entities)');
  console.log('    --out <path>           Output file path (default: stdout)');
  console.log('');
  console.log('  Indexes options:');
  console.log('    --entities <path>      Path to entities directory (adds per-entity data field indexes)');
  console.log('    --collection <name>    Firestore collection name (default: graph)');
  console.log('    --out <path>           Output file path (default: stdout)');
  console.log('');
  console.log('  Config file:');
  console.log('    Create a firegraph.config.ts in your project root to avoid passing');
  console.log('    flags every time. CLI flags override config file values.');
  console.log('');
  console.log('  Examples:');
  console.log('    npx firegraph editor                                  # uses firegraph.config.ts');
  console.log('    npx firegraph editor --config ./custom-config.ts      # explicit config file');
  console.log('    npx firegraph editor --entities ./entities            # per-entity convention');
  console.log('    npx firegraph codegen --entities ./entities           # types to stdout');
  console.log('    npx firegraph codegen --entities ./entities --out src/generated/types.ts');
  console.log('    npx firegraph indexes                                  # 4 base indexes to stdout');
  console.log('    npx firegraph indexes --entities ./entities --out firestore.indexes.json');
  console.log('');
} else {
  console.error(`Unknown command: ${subcommand}`);
  console.error('Run "firegraph --help" for usage information.');
  process.exit(1);
}
