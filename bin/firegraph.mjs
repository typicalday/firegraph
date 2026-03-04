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
} else if (subcommand === 'install-skill') {
  const args = parseArgs(process.argv.slice(3));
  const skillName = process.argv[3] && !process.argv[3].startsWith('--') ? process.argv[3] : 'firegraph-chat';
  const uninstall = args.uninstall || false;
  const project = args.project || false;

  const skillSource = path.join(__dirname, '..', 'skills', skillName);
  if (!fs.existsSync(skillSource)) {
    console.error(`Skill "${skillName}" not found in firegraph package.`);
    console.error(`Available skills: ${fs.readdirSync(path.join(__dirname, '..', 'skills')).join(', ')}`);
    process.exit(1);
  }

  // Determine target directory
  const targetBase = project
    ? path.join(process.cwd(), '.claude', 'skills')
    : path.join(process.env.HOME, '.claude', 'skills');
  const targetLink = path.join(targetBase, skillName);

  if (uninstall) {
    if (fs.existsSync(targetLink)) {
      const stat = fs.lstatSync(targetLink);
      if (stat.isSymbolicLink()) {
        fs.unlinkSync(targetLink);
        console.log(`Removed symlink: ${targetLink}`);
      } else {
        console.error(`${targetLink} exists but is not a symlink. Remove it manually if intended.`);
        process.exit(1);
      }
    } else {
      console.log(`Nothing to remove — ${targetLink} does not exist.`);
    }
    process.exit(0);
  }

  // Create target directory if needed
  fs.mkdirSync(targetBase, { recursive: true });

  // Check if already installed
  if (fs.existsSync(targetLink)) {
    const stat = fs.lstatSync(targetLink);
    if (stat.isSymbolicLink()) {
      const existing = fs.readlinkSync(targetLink);
      const resolvedExisting = path.resolve(path.dirname(targetLink), existing);
      const resolvedSource = path.resolve(skillSource);
      if (resolvedExisting === resolvedSource) {
        console.log(`Already installed: ${targetLink} -> ${skillSource}`);
        process.exit(0);
      }
      // Different target — replace
      fs.unlinkSync(targetLink);
    } else {
      console.error(`${targetLink} already exists and is not a symlink.`);
      console.error('Remove it manually or use a different install location.');
      process.exit(1);
    }
  }

  fs.symlinkSync(skillSource, targetLink);
  const scope = project ? 'project' : 'user';
  console.log(`Installed firegraph-chat skill (${scope}-level):`);
  console.log(`  ${targetLink} -> ${skillSource}`);
  console.log('');
  console.log('The skill will be available next time you start Claude Code' + (project ? ' in this project.' : '.'));

} else if (subcommand === '--help' || subcommand === '-h' || !subcommand) {
  console.log('');
  console.log('  Usage: firegraph <command> [options]');
  console.log('');
  console.log('  Commands:');
  console.log('    editor         Launch the Firegraph Editor UI');
  console.log('    query          Query the graph via the editor API');
  console.log('    codegen        Generate TypeScript types from entity schemas');
  console.log('    install-skill  Install the firegraph-chat Claude Code skill');
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
  console.log('  Skill options:');
  console.log('    --project              Install to .claude/skills/ in current project (default: ~/.claude/skills/)');
  console.log('    --uninstall            Remove the skill symlink');
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
  console.log('    npx firegraph install-skill                           # install skill globally');
  console.log('    npx firegraph install-skill --project                 # install skill for this project');
  console.log('');
} else {
  console.error(`Unknown command: ${subcommand}`);
  console.error('Run "firegraph --help" for usage information.');
  process.exit(1);
}
