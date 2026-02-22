#!/usr/bin/env node
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const subcommand = process.argv[2];

if (subcommand === 'editor') {
  process.env.NODE_ENV = 'production';
  // Pass remaining args through (strip 'editor' subcommand)
  process.argv = [process.argv[0], process.argv[1], ...process.argv.slice(3)];
  await import(path.join(__dirname, '..', 'dist', 'editor', 'server', 'index.mjs'));
} else if (subcommand === '--help' || subcommand === '-h' || !subcommand) {
  console.log('');
  console.log('  Usage: firegraph <command> [options]');
  console.log('');
  console.log('  Commands:');
  console.log('    editor    Launch the Firegraph Editor UI');
  console.log('');
  console.log('  Editor options:');
  console.log('    --config <path>        Path to firegraph.config.ts (default: auto-discover in cwd)');
  console.log('    --registry <path>      Path to TypeScript file exporting a GraphRegistry');
  console.log('    --views <path>         Path to TypeScript file exporting views via defineViews()');
  console.log('    --project <id>         GCP project ID (default: auto-detect via ADC)');
  console.log('    --collection <path>    Firestore collection path (default: graph)');
  console.log('    --port <number>        Server port (default: 3883)');
  console.log('    --emulator [host:port] Use Firestore emulator');
  console.log('    --readonly             Force read-only mode');
  console.log('');
  console.log('  Config file:');
  console.log('    Create a firegraph.config.ts in your project root to avoid passing');
  console.log('    flags every time. CLI flags override config file values.');
  console.log('');
  console.log('  Examples:');
  console.log('    npx firegraph editor                                  # uses firegraph.config.ts');
  console.log('    npx firegraph editor --config ./custom-config.ts      # explicit config file');
  console.log('    npx firegraph editor --registry ./src/registry.ts     # CLI flags (no config file)');
  console.log('    npx firegraph editor --readonly                       # override config file setting');
  console.log('');
} else {
  console.error(`Unknown command: ${subcommand}`);
  console.error('Run "firegraph --help" for usage information.');
  process.exit(1);
}
