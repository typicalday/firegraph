#!/usr/bin/env node
/**
 * CLI wrapper around the firegraph editor's tRPC API.
 * Reads editor port from firegraph.config.ts, makes HTTP requests, outputs JSON.
 *
 * Usage:
 *   node query.mjs schema
 *   node query.mjs get <uid>
 *   node query.mjs find-nodes <type> [--limit N]
 *   node query.mjs find-edges [--aUid x] [--axbType y] [--bUid z] [--limit N]
 *   node query.mjs traverse '<JSON>'
 *   node query.mjs search <query>
 */

import { readFileSync } from 'node:fs';
import http from 'node:http';

// --- Config ---

function readEditorPort() {
  try {
    const config = readFileSync('firegraph.config.ts', 'utf8');
    // Match port inside editor block: editor: { port: 12345 }
    const editorBlock = config.match(/editor\s*:\s*\{[^}]*\}/s)?.[0] ?? '';
    const portMatch = editorBlock.match(/port\s*:\s*(\d+)/);
    if (portMatch) return parseInt(portMatch[1], 10);
  } catch {}
  try {
    const config = readFileSync('firegraph.config.js', 'utf8');
    const editorBlock = config.match(/editor\s*:\s*\{[^}]*\}/s)?.[0] ?? '';
    const portMatch = editorBlock.match(/port\s*:\s*(\d+)/);
    if (portMatch) return parseInt(portMatch[1], 10);
  } catch {}
  return 3884;
}

const EDITOR_PORT = readEditorPort();
const BASE = `http://localhost:${EDITOR_PORT}/api/trpc`;

// --- HTTP helpers ---

function trpcQuery(procedure, input) {
  const qs = input != null
    ? `?input=${encodeURIComponent(JSON.stringify(input))}`
    : '';
  const url = `${BASE}/${procedure}${qs}`;
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed.result?.data ?? parsed);
        } catch {
          reject(new Error(`Invalid JSON from ${procedure}: ${body.slice(0, 200)}`));
        }
      });
    }).on('error', reject);
  });
}

function trpcMutation(procedure, input) {
  const payload = JSON.stringify(input);
  const url = new URL(`${BASE}/${procedure}`);
  return new Promise((resolve, reject) => {
    const req = http.request({
      hostname: url.hostname,
      port: url.port,
      path: url.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(payload),
      },
    }, (res) => {
      let body = '';
      res.on('data', (c) => body += c);
      res.on('end', () => {
        try {
          const parsed = JSON.parse(body);
          resolve(parsed.result?.data ?? parsed);
        } catch {
          reject(new Error(`Invalid JSON from ${procedure}: ${body.slice(0, 200)}`));
        }
      });
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

// --- Commands ---

async function cmdSchema() {
  const data = await trpcQuery('getSchema');
  const out = {
    nodeTypes: (data.nodeTypes ?? []).map(t => t.type ?? t),
    edgeTypes: (data.edgeTypes ?? []).map(t => ({
      relation: t.axbType,
      from: t.aType,
      to: t.bType,
      inverseLabel: t.inverseLabel ?? null,
    })),
  };
  return out;
}

async function cmdGet(uid) {
  if (!uid) die('Usage: query.mjs get <uid>');
  const data = await trpcQuery('getNodeDetail', { uid });
  if (!data.node) return { error: `Node '${uid}' not found` };
  return {
    node: summarizeRecord(data.node),
    outEdges: (data.outEdges ?? []).map(summarizeEdge),
    inEdges: (data.inEdges ?? []).map(summarizeEdge),
  };
}

async function cmdFindNodes(type, limit) {
  if (!type) die('Usage: query.mjs find-nodes <type> [--limit N]');
  const data = await trpcQuery('getNodes', { type, limit: limit ?? 25 });
  return {
    nodes: (data.nodes ?? []).map(summarizeRecord),
    hasMore: data.hasMore ?? false,
  };
}

async function cmdFindEdges(flags) {
  const input = {};
  if (flags.aUid) input.aUid = flags.aUid;
  if (flags.axbType) input.axbType = flags.axbType;
  if (flags.bUid) input.bUid = flags.bUid;
  if (flags.aType) input.aType = flags.aType;
  if (flags.bType) input.bType = flags.bType;
  if (flags.limit) input.limit = parseInt(flags.limit, 10);
  const data = await trpcQuery('getEdges', input);
  return {
    edges: (data.edges ?? []).map(summarizeEdge),
    hasMore: data.hasMore ?? false,
  };
}

async function cmdTraverse(jsonStr) {
  if (!jsonStr) die(
    'Usage: query.mjs traverse \'<JSON>\'\n\n' +
    'JSON shape:\n' +
    '{\n' +
    '  "startUid": "nodeUid",\n' +
    '  "hops": [\n' +
    '    {\n' +
    '      "axbType": "relationName",\n' +
    '      "direction": "forward" | "reverse",  // default: forward\n' +
    '      "limit": 10,                         // per source node per hop\n' +
    '      "aType": "filterSourceType",          // optional\n' +
    '      "bType": "filterTargetType",          // optional\n' +
    '      "orderBy": { "field": "data.name", "direction": "asc" },  // optional\n' +
    '      "where": [{ "field": "data.status", "op": "==", "value": "active" }]  // optional\n' +
    '    }\n' +
    '  ],\n' +
    '  "maxReads": 100,    // budget limit, default 100\n' +
    '  "concurrency": 5    // parallel fanout, default 5\n' +
    '}'
  );
  let input;
  try {
    input = JSON.parse(jsonStr);
  } catch {
    die(`Invalid JSON: ${jsonStr.slice(0, 200)}`);
  }
  if (!input.startUid || !input.hops?.length) {
    die('traverse requires "startUid" and at least one hop in "hops"');
  }
  const data = await trpcMutation('traverse', input);
  return {
    hops: (data.hops ?? []).map(h => ({
      relation: h.axbType,
      direction: h.direction,
      depth: h.depth,
      edgeCount: h.edges?.length ?? 0,
      edges: (h.edges ?? []).map(summarizeEdge),
      truncated: h.truncated ?? false,
    })),
    totalReads: data.totalReads ?? 0,
    truncated: data.truncated ?? false,
  };
}

async function cmdSearch(q) {
  if (!q) die('Usage: query.mjs search <query>');
  const data = await trpcQuery('search', { q, limit: 20 });
  return {
    results: (data.results ?? []).map(r => ({
      ...summarizeRecord(r),
      matchType: r._matchType ?? null,
    })),
  };
}

// --- Helpers ---

function summarizeRecord(r) {
  if (!r) return null;
  const out = { type: r.aType, uid: r.aUid };
  if (r.data && Object.keys(r.data).length > 0) out.data = r.data;
  return out;
}

function summarizeEdge(r) {
  if (!r) return null;
  const out = {
    from: `${r.aType}:${r.aUid}`,
    relation: r.axbType,
    to: `${r.bType}:${r.bUid}`,
  };
  if (r.data && Object.keys(r.data).length > 0) out.data = r.data;
  return out;
}

function die(msg) {
  console.error(msg);
  process.exit(1);
}

// --- Argument parsing ---

function parseFlags(args) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i].startsWith('--')) {
      const key = args[i].slice(2);
      flags[key] = args[i + 1] ?? 'true';
      i++;
    } else {
      positional.push(args[i]);
    }
  }
  return { flags, positional };
}

// --- Main ---

async function main() {
  const args = process.argv.slice(2);
  const command = args[0];
  const rest = args.slice(1);

  try {
    let result;
    switch (command) {
      case 'schema':
        result = await cmdSchema();
        break;
      case 'get':
        result = await cmdGet(rest[0]);
        break;
      case 'find-nodes': {
        const { flags, positional } = parseFlags(rest);
        result = await cmdFindNodes(positional[0], flags.limit ? parseInt(flags.limit, 10) : undefined);
        break;
      }
      case 'find-edges': {
        const { flags } = parseFlags(rest);
        result = await cmdFindEdges(flags);
        break;
      }
      case 'traverse':
        result = await cmdTraverse(rest.join(' '));
        break;
      case 'search':
        result = await cmdSearch(rest.join(' '));
        break;
      default:
        die(`Unknown command: ${command}\nCommands: schema, get, find-nodes, find-edges, traverse, search`);
    }
    console.log(JSON.stringify(result, null, 2));
  } catch (err) {
    console.error(JSON.stringify({ error: err.message }));
    process.exit(1);
  }
}

main();
