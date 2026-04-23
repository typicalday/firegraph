# Data Modeling with Firegraph

> This guide assumes familiarity with firegraph basics — nodes, edges, `putNode`/`putEdge`, and registry configuration. See the [README](../README.md) for an introduction.

Firegraph is a graph data layer built on top of Firebase Cloud Firestore. This creates a hybrid that is neither a pure graph database nor a pure document database — it is both, and the modeling decisions you make should reflect that.

This guide is for developers and architects reasoning about how to structure data in firegraph. It covers the mental model, when to use each primitive, and the tradeoffs you will encounter.

---

## The Hybrid Mental Model

Traditional databases fall into camps:

**Graph databases** (Neo4j, Dgraph) are relationship-first. Traversals are cheap, pattern matching is native, but document richness is limited and they add operational complexity — another database to provision, connect to, and monitor alongside your existing stack.

**Document databases** (Firestore, MongoDB) are record-first. Individual documents are flexible and scale horizontally, but relationships are modeled awkwardly — nested arrays, denormalized copies, or separate join collections — and multi-hop traversals require application-level orchestration.

Firegraph gives you both. Nodes and edges are first-class Firestore documents with full JSON payloads. Relationships have their own identity, data, and timestamps. Traversals are explicit and budgeted. And because it runs on Firestore, you keep serverless scaling, real-time sync, offline support, and zero infrastructure to manage.

But this hybrid has its own shape. You cannot write Cypher queries or declarative pattern-matching. Each traversal hop is a Firestore query. There is no index-free adjacency. You are building on a document store that understands graph semantics, not on a native graph engine.

### Where Firegraph Fits

Not all relational data is a good fit for firegraph. The hop-by-hop traversal model, fan-out costs, and lack of declarative pattern matching mean that densely interconnected data with unpredictable access patterns — social network analysis, fraud detection rings, recommendation engines — will struggle here. Those workloads need a native graph database.

But firegraph also is not just Firestore with extra steps. Pure document CRUD with no meaningful relationships does not need a graph layer.

**Firegraph's sweet spot** is relational data where:

- **Relationships are important but not uniformly dense.** Entities connect to other entities, and those connections carry meaning and data. An agent might have millions of memories — that is fine if they are in a subgraph with scoped queries. The concern is not how many relationships exist, but whether you need to _traverse through_ high-cardinality nodes. A query for "this agent's recent memories" is cheap regardless of count. A traversal that fans out through a node with 10,000 outgoing edges to reach their targets is expensive.
- **Access patterns are predictable.** You know which relationships you will traverse and can model accordingly. "Get this agent's recent memories" is predictable. "Find the shortest path between any two users in a social network" is not.
- **Ownership and scoping are natural.** The data has clear hierarchies — things belong to other things. Projects own tasks. Agents own memories. These boundaries map directly to subgraphs, giving you isolation, cascade deletes, and scoped queries for free.
- **You are already on Firebase** (or want to be). Firegraph adds graph semantics without adding infrastructure. No separate database to provision, monitor, back up, or pay for. For startups, smaller teams, or projects where operational simplicity matters, this is significant — a dedicated graph database is another system to run, another connection to manage, another failure mode to handle.

### The Practical Picture

At its core, firegraph gives you join-like query capability on top of Firestore. You can ask "how does X relate to Y?" and follow that relationship to the connected entity, its data, and its own connections. This is something Firestore alone makes awkward — you would need denormalized copies, separate lookup collections, or application-level orchestration.

For direct relationships — "which agent is assigned to this task?", "what are this project's milestones?" — this is straightforward and cheap. One query, one hop. Even two hops away is usually fine: "which agents are assigned to tasks in this project?" is two hops and the cost depends on how many tasks the project has, not on total system size.

Think of it as a funnel. At the narrow end — the starting node and its immediate connections — queries are fast, predictable, and cheap. As you move outward through more hops, each level fans out and the query count multiplies. Near the narrow end, firegraph is excellent. As you approach the wide end — 4+ hops, hundreds of results per hop — costs grow quickly and you are fighting the model rather than working with it.

For most startups and smaller projects, the narrow end of the funnel is where all the work happens. Direct relationships, scoped queries within subgraphs, maybe a 2-hop traversal here and there. Firegraph handles this comfortably and you get graph semantics without adding infrastructure.

For larger-scale systems, firegraph can still work — but it needs to be designed deliberately. That means modeling your data so that hot-path queries stay near the narrow end: scoping data into subgraphs to bound fan-out, using `limit` on traversal hops, keeping cross-graph edges for the cases that genuinely need them, and pushing analytics-style queries to external systems like BigQuery rather than multi-hop traversals.

Remember that this is still a document database under the hood — denormalization is a legitimate tool for reducing hops. But where you put the denormalized data matters. Enterprise Firestore bills based on the amount of data read, so bloating graph nodes and edges with denormalized fields means every query that touches those documents pays for the extra bytes, even when it has nothing to do with the denormalized data.

A better approach is to put materialized or denormalized views in a **separate plain subcollection**. This keeps your graph documents lean — small nodes, small edges, fast queries — while the denormalized data lives in its own space and is read only when needed. For example, a task node stays slim in the graph, but a `task-Kj7v.../summary/` subcollection holds a pre-joined document with the task title, assigned agent name, project name, and whatever else a dashboard needs in a single read.

This is the same tradeoff you would make in traditional Firestore modeling to avoid extra collection lookups. The fan-out concerns here are not unique to firegraph — any Firestore architecture that queries across multiple collections faces the same cost structure.

**When firegraph is the wrong choice:**

- Your core operation is deep, wide traversal with large fan-out at every hop (graph analytics)
- You need declarative pattern matching or shortest-path algorithms (graph query languages)
- Your data is so densely connected that you cannot predict or bound traversal fan-out
- You have no use for Firestore's strengths (serverless scaling, real-time sync, offline support, Firebase Auth integration)

### Why Now

Firestore has been around since 2017. A graph layer on top of it would have been painful for most of that time. Standard Firestore requires a composite index for every query pattern — a graph model that queries on combinations of `aType`, `axbType`, `bUid`, and `data.*` fields would need dozens or hundreds of indexes just to function. Queries without matching indexes simply fail.

Enterprise Firestore changes this. The Pipeline API and advanced query engine can execute queries without composite indexes. The core firegraph fields (`aUid`, `axbType`, `aType`, `bType`) narrow the result set, and any remaining `data.*` filters scan over that small subset efficiently. You no longer need to predict and pre-create an index for every possible query shape.

This also changes modeling strategy. Traditional Firestore advice leans heavily on denormalization and duplicating data to avoid multi-collection reads — because the query model is rigid and every new access pattern needs a new index. With Enterprise, the query model is flexible enough that you can keep data normalized in a graph structure and query it from different angles without index overhead. Denormalization is still useful (and sometimes the right call), but it shifts from a necessity to an optimization.

The Pipeline API itself is still evolving. As Firestore's query engine gains capabilities — aggregations, more expressive filtering, server-side joins — firegraph can push more operations down to the database rather than handling them in application code. The graph layer benefits directly from any improvement to the underlying engine.

Firegraph is designed with Enterprise as the primary mode. It works on Standard, but the experience is materially different — index management becomes a real operational concern and some query patterns require workarounds. If you are evaluating firegraph for a new project, Enterprise Firestore is the recommended foundation.

---

## The Building Blocks

Here is what you have to work with.

### Root Graph

Every firegraph client is rooted at a Firestore collection. Within that collection, data is stored as **triples**:

```
(aType, aUid) -[axbType]-> (bType, bUid)
```

- **Nodes** are self-referencing triples with the relation `is`: a node of type `task` with UID `Kj7v...` is stored as `(task, Kj7v...) -[is]-> (task, Kj7v...)`.
- **Edges** are directed triples between two nodes: `(task, Kj7v...) -[assignedTo]-> (agent, Xp4n...)`.

Both live in the same collection. Nodes use their UID as the document ID. Edges use a sharded composite key (`shard:aUid:axbType:bUid`, where shard is a hex digit 0-f derived from a hash of the composite key) that distributes writes across 16 buckets to prevent Firestore hotspots. You never need to think about sharding — firegraph handles it transparently on every write and lookup.

This means every `findEdges` or `findNodes` call queries one collection. When all three identifiers are known (`aUid`, `axbType`, `bUid`), firegraph computes the document ID and performs a direct `get` — the fastest possible Firestore operation. Otherwise, it builds filtered queries against composite indexes.

### Edges as First-Class Documents

Edges are not just pointers between nodes — they are Firestore documents with their own JSON data payloads, timestamps, and identity.

An edge's `data` field carries information **about the relationship itself**, not about the nodes it connects:

```typescript
// The "assignedTo" relationship has its own properties
await g.putEdge('task', taskId, 'assignedTo', 'agent', agentId, {
  role: 'lead',
  assignedAt: '2025-01-15',
  priority: 1,
});
```

Here `role`, `assignedAt`, and `priority` describe the assignment — not the task, and not the agent. If the same agent is assigned to a different task, those values would be different.

If the information belongs to a node, put it on the node — edge data should not duplicate node data. Some edges are pure relationships with no data at all, and that is fine:

```typescript
await g.putEdge('user', alice, 'follows', 'user', bob, {});
```

Edges are directional, but they can carry an `inverseLabel` for display purposes. An edge named `hasDeparture` might have `inverseLabel: 'departureOf'`. This does not create a real inverse edge — it is a cosmetic hint for the editor UI and for developers reading the schema.

### Subgraphs

`client.subgraph(parentNodeUid, name)` returns a new `GraphClient` scoped to a Firestore subcollection at `{collectionPath}/{parentNodeUid}/{name}`. That subcollection is a complete graph — it has its own nodes, its own edges, and it can have its own subgraphs in turn.

```
graph/                            <-- root collection
  task-Kj7v... (node doc)
  task-Kj7v.../
    workflow/                     <-- subgraph subcollection
      agent-Xp4n... (node doc)
      f:Kj7v:assignedTo:Xp4n...  (edge doc)
```

The parent and subgraph are **separate Firestore collections**. A query on the root does not see subgraph data. A query in the subgraph does not see root data. They are isolated by Firestore's collection boundaries.

### Cross-Graph Edges

Cross-graph edges connect nodes that live in different collections. The source node (aUid) is in an ancestor collection — typically the root — while the target node (bUid) and the edge document itself live in a subgraph.

Forward traversal uses `targetGraph` on the registry entry or hop definition to know which subgraph to query. Reverse traversal is free — the edge lives with the target, so it is local.

### Collection Group Queries

Firestore collection groups let you query all subcollections that share a name, across the entire database. `findEdgesGlobal('workflow')` queries every subcollection named `workflow` regardless of where it sits in the hierarchy. This bridges the isolation boundary when you need aggregate or cross-cutting queries.

### Traversal

The `createTraversal` API walks the graph hop by hop. Each hop issues one Firestore query per source node, fanning out from each source to its connected targets.

```
Hop 1: 1 source   -> 10 targets  (1 query)
Hop 2: 10 sources  -> 100 targets (10 queries)
Hop 3: 100 sources -> 1000 targets (100 queries)
Total: 111 queries
```

In a native graph database, this would be pointer follows in memory. In firegraph, each hop is a Firestore query with network latency and read cost. The query count grows multiplicatively with fan-out — narrow fan-out is cheap, wide fan-out is expensive. The number of hops matters less than how many results each hop produces.

Every traversal has a `maxReads` budget (default 100) that caps the total query count. Use `limit` on individual hops to control fan-out. Cross-graph hops add overhead — each creates a subgraph client per source node and issues queries to separate subcollections.

There is no Cypher or SPARQL. Complex graph patterns (shortest path, cycle detection, conditional branching) require application-level logic. All join operations are application-level — firegraph orchestrates the queries, but the join logic runs in your process, not on the server. Traversals are not transactional — each hop reads a separate snapshot, so the graph can change between hops. And traversals are one-shot operations with no real-time subscription.

---

## When Data Should Live at Root

The root collection is your **globally addressable namespace**. Entities that live here can be found by any query, referenced by any edge, and traversed from any starting point.

**Put data at root when:**

- **It has global identity.** Users, products, organizations, shared configurations — entities that exist independently and are referenced from many places. A user is not "owned" by any one part of the system. A product is browsed, purchased, reviewed, and recommended by unrelated subsystems. These need to be findable without knowing a parent context.

- **It participates in many-to-many relationships.** When an entity connects to many other entities across the system — agents assigned to multiple projects, tags applied to many documents, users following other users — flat root placement keeps relationship queries simple.

- **You need it in cross-cutting queries.** "All pending tasks," "all active agents," "all products in category X." If a query that spans the entire domain is a normal operation (not an exceptional admin task), the data should be at root.

- **It has no clear lifecycle owner.** If deleting any single parent should not cascade-delete this entity, it does not belong in a subgraph. Reviews that outlive deleted users, audit logs that persist after project closure — these belong at root.

**The tradeoff:** Root collections grow without bound. At 10K documents, this is invisible. At 1M, migrations take longer and full-scan queries get expensive. At 10M+, operational concerns become real — backup granularity, scan costs, debugging difficulty. Firestore handles the throughput fine, but your workflow and billing feel it.

---

## When Data Should Live in a Subgraph

Subgraphs are for **contained, lifecycle-coupled data**. They create a natural boundary around data that belongs together.

**Put data in a subgraph when:**

- **There is a clear owner.** An agent's memories belong to that agent. A project's tasks belong to that project. A conversation's turns belong to that conversation. The lifecycle is coupled: when the owner is deleted, the contained data should be deleted.

- **Queries are naturally scoped.** You almost always query "this agent's memories" or "this project's tasks" — not "all memories across all agents." The common access pattern is scoped to one parent.

- **You want isolation.** Different projects should not interfere with each other's data. Different agents should not see each other's context. Subgraphs provide this at the Firestore collection level — no filtering needed, the data is physically separate.

- **You want to bound collection size.** Instead of one collection with 10M documents, you have 10K collections with 1K documents each. Each query only touches its relevant subset. Migrations can proceed parent-by-parent. Cascade deletes are localized.

- **Security rules should be scoped.** Firestore security rules can match on collection paths. A subcollection under a user's node naturally supports rules like "only this user can read their memories."

### The Clustering Analogy

If you are familiar with distributed graph databases, subgraphs may remind you of graph partitioning or sharding. The analogy is useful.

In a distributed graph database, data is split across partitions. Queries within a partition are cheap (local). Queries across partitions are expensive (network hops, coordination). The partitioning strategy determines which queries are fast and which are slow.

Firegraph subgraphs work the same way, but the partitioning is **explicit and semantic** rather than algorithmic:

- **You choose the boundaries.** A project's tasks go in the project's subgraph. An agent's memories go in the agent's subgraph. The boundaries reflect your domain, not a hash function.
- **Local queries are cheap.** Queries within a subgraph hit one Firestore subcollection. No cross-collection overhead.
- **Cross-partition queries are explicit and expensive.** Cross-graph edges require the traversal engine to create subgraph clients and issue separate queries. `findEdgesGlobal` requires collection group indexes. The cost is visible in your code and in your Firestore bill.
- **The cost structure is honest.** Unlike some distributed databases that hide partition-crossing behind a query optimizer, firegraph makes it explicit. You know when you are crossing a boundary because you wrote `targetGraph: 'workflow'` in your registry or called `findEdgesGlobal`.

The deepest value of subgraphs is **co-location**. When all of an agent's memories are in `agent-X/memories/`, a query for those memories touches a contiguous range of storage. There is no interleaving with other agents' data. No filtering needed. The query reads exactly the data it needs. This is the same principle behind database denormalization, table partitioning, and cache-line optimization: put things that are accessed together in the same place.

**The tradeoff:** Subgraph data is invisible to root queries. You cannot do `findNodes({ aType: 'memory' })` at the root level and get all memories — they are in separate subcollections. Collection group queries bridge this gap, but they require separate indexes and have their own constraints.

---

## Collection Groups: The Bridge

The tension between isolation and global queryability is real. Subgraphs give you isolation. Root gives you queryability. Collection groups let you have both.

When every agent has a subgraph named `memories`, Firestore can query all `memories` subcollections at once via `collectionGroup('memories')`. Firegraph exposes this as `findEdgesGlobal(params, collectionName)`.

This changes the calculus significantly:

| Operation                           | Root graph           | Subgraph                       | Subgraph + collection group |
| ----------------------------------- | -------------------- | ------------------------------ | --------------------------- |
| Scoped query (one agent's memories) | Must filter by owner | Native                         | Native                      |
| Cross-cutting query (all memories)  | Native               | Impossible                     | Via collection group        |
| Cascade delete                      | Must enumerate edges | Native                         | Native                      |
| Collection size                     | Unbounded            | Bounded per parent             | Bounded per parent          |
| Index management                    | One set              | One set per subcollection name | Two sets (single + group)   |

The operational cost is maintaining two sets of indexes — single-collection indexes for scoped queries and collection group indexes for cross-cutting queries. This is a manageable tradeoff for most applications.

**When to rely on collection groups:**

- Analytics and reporting across all subgraphs ("all overdue tasks across all projects")
- Admin tooling that needs system-wide visibility
- Background jobs that process data across parents (e.g., expiring old memories)
- Search indexing that needs to crawl all data of a type

**When NOT to rely on collection groups:**

- As a substitute for root placement. If an entity is queried cross-cutting in normal user-facing operations (not admin/background), it probably belongs at root.
- For real-time listeners on large datasets. Collection group queries can match many subcollections and generate significant read traffic.

---

## Beyond the Graph

Firegraph coexists with standard Firestore patterns. Not everything under a node needs to be a graph, and not every operation needs to go through firegraph.

### Plain Subcollections

Firestore subcollections can live alongside subgraphs under the same parent document. Use a plain subcollection instead of a subgraph for:

- **Simple key-value data.** User preferences, feature flags, cached aggregations — data with no relationships, no need for edges or traversals.
- **Data managed by Cloud Functions.** Trigger-driven workflows that write to a subcollection and expect standard Firestore documents, not graph triples.
- **Data that needs its own security rules.** A `secrets` subcollection with locked-down rules, separate from the graph data.
- **Data consumed by other Firebase services.** Firestore-triggered Cloud Functions, Firebase Extensions, or direct Firestore SDK reads from mobile clients that do not use firegraph.

A single parent node might have:

```
agent-Kj7v.../
  memories/        <-- firegraph subgraph (graph-structured)
  conversations/   <-- firegraph subgraph (graph-structured)
  config/          <-- plain Firestore subcollection (key-value docs)
  audit-log/       <-- plain Firestore subcollection (append-only log)
```

Firegraph does not claim or interfere with subcollections it did not create. The coexistence is natural because firegraph nodes are standard Firestore documents and subcollections are an orthogonal Firestore feature.

### Raw Firestore Queries

You can use the Firestore SDK directly alongside firegraph. Every firegraph node is a document at `{collectionPath}/{uid}`. Every edge is a document at `{collectionPath}/{shard:aUid:axbType:bUid}`. You can read, query, or listen to these documents with standard Firestore APIs — for aggregations, real-time listeners, or queries that firegraph does not support.

### BigQuery Export

Firestore supports export to BigQuery for analytics workloads. If you need complex aggregations, joins across entity types, or historical analysis, export your graph data to BigQuery and query it with SQL. This is particularly useful for the kinds of graph analytics that firegraph is not designed for.

### Cloud Functions and Triggers

Firestore triggers (`onCreate`, `onUpdate`, `onDelete`) work normally on firegraph documents. You can trigger Cloud Functions on edge creation, node updates, or cascade deletes. This is useful for maintaining denormalized views, sending notifications, or syncing with external systems.

---

## Real-World Scenarios

### AI Agent System

An AI agent has memories, conversations with turns, tool calls, and configuration.

```
graph/
  agent-A (root — global identity)
  agent-A/
    memories/          (subgraph)
      mem-1, mem-2...  (nodes with embedding, text, timestamps)
      (edges: mem-1 -relatedTo-> mem-2)
    conversations/     (subgraph)
      convo-X/
        turns/         (nested subgraph)
          turn-1, turn-2...
        tool-calls/    (nested subgraph)
          call-1...
    config/            (plain subcollection — not a graph)
      preferences (doc)
      api-keys (doc)
```

**Why this structure:**

- Agent at root: global identity, assignable to multiple projects via cross-graph edges.
- Memories as subgraph: scoped queries ("this agent's memories"), bounded collection size, cascade on agent deletion.
- Conversations nested: each conversation is a self-contained unit. Deleting a conversation cascades its turns and tool calls.
- Config as plain subcollection: no relationships, just key-value storage with its own security rules.

**Collection group queries:** "Find all memories containing keyword X across all agents" — rare, but possible via `findEdgesGlobal` on the `memories` collection.

### Multi-Tenant Project Management

Organizations have projects, projects have tasks, tasks are assigned to team members.

```
graph/
  org-1 (root)
  user-alice (root — global identity)
  user-bob (root)
  org-1/
    projects/          (subgraph)
      project-A
      project-A/
        workspace/     (subgraph)
          task-1
          task-2
          milestone-1
          (edge: task-1 -assignedTo-> user-alice)  <-- cross-graph, stored here
          (edge: task-1 -hasMilestone-> milestone-1)  <-- local edge
```

**Why this structure:**

- Users at root: they span organizations, have global profiles, and are referenced from many places.
- Projects in org subgraph: organization-scoped, cascade on org deletion, not visible to other orgs.
- Tasks in project workspace: project-scoped, cascade on project deletion.
- `assignedTo` as cross-graph edge: connects a scoped task to a root-level user. The edge lives in the workspace alongside the task. Forward traversal from a task finds the assigned user via `targetGraph`. Reverse traversal from within the workspace finds the task locally.

**Collection group queries:** "All overdue tasks across all projects" for an admin dashboard — uses `findEdgesGlobal` on `workspace` collections.

### Content Platform

Users create posts, posts have comments, users follow other users.

```
graph/
  user-alice (root)
  user-bob (root)
  post-123 (root — globally addressable)
  post-456 (root)
  (edge: alice -authored-> post-123)
  (edge: bob -liked-> post-123)
  (edge: bob -follows-> alice)
  post-123/
    comments/          (subgraph)
      comment-1
      comment-2
      (edge: comment-1 -replyTo-> comment-2)
```

**Why this structure:**

- Users and posts at root: social data is inherently cross-cutting. Feed algorithms, search, and discovery all need global access.
- Comments in post subgraph: scoped to a post, cascade on post deletion, bounded per post.
- Likes and follows as root edges: many-to-many relationships across global entities.

**Why not user subgraphs for posts?** Because posts are shared across the entire system. Bob's feed shows Alice's posts. Search indexes all posts. Putting posts in user subgraphs would require collection group queries for every feed render — too expensive for a hot path.

---

## Decision Framework

When deciding where an entity lives, ask these questions in order:

**1. Does it have global identity?**
Would this entity be referenced from multiple unrelated parts of the system? If yes: **root graph**.

**2. Does it have a single lifecycle owner?**
Is there one parent whose deletion should cascade to this entity? If yes: **subgraph under the owner**.

**3. Is it queried cross-cutting in normal operations?**
Not admin dashboards or background jobs — normal user-facing operations. If yes: **root graph**. If only occasionally: subgraph with **collection group queries** for the exceptional cases.

**4. Does it need relationship semantics?**
Does this data participate in edges, traversals, or graph queries? If yes: **firegraph subgraph**. If it is just key-value storage: **plain Firestore subcollection**.

**5. What are the access control boundaries?**
Should access be scoped to the parent? If yes: **subgraph** (natural Firestore rules boundary). If globally accessible: **root graph**.

### Quick Reference

| Entity Characteristic                       | Root Graph | Subgraph                | Plain Subcollection |
| ------------------------------------------- | ---------- | ----------------------- | ------------------- |
| Global identity                             | Yes        |                         |                     |
| Single lifecycle owner                      |            | Yes                     | Yes                 |
| Many-to-many relationships                  | Yes        |                         |                     |
| Naturally scoped queries                    |            | Yes                     | Yes                 |
| Needs graph semantics (edges, traversals)   | Yes        | Yes                     |                     |
| Simple key-value data                       |            |                         | Yes                 |
| Managed by Cloud Functions / triggers       |            |                         | Yes                 |
| Cross-cutting queries are normal operations | Yes        |                         |                     |
| Cross-cutting queries are rare/admin-only   |            | Yes (collection groups) |                     |

---

## Operational Considerations

Once your model is designed, these factors affect how it behaves in production.

### Collection Size

Firestore queries are O(result set), not O(collection size) — **for indexed queries**. A query returning 10 documents from a 10M-document collection costs the same as from a 10K collection, provided the query uses indexes.

But:

- **Full collection scans** are O(collection). On Enterprise edition, queries without matching indexes fall back to collection scans (expensive). On Standard edition, they fail outright. Firegraph's scan protection (`scanProtection: 'error'`) prevents accidental scans, but some operations (bulk deletes, migrations) require them.
- **Migrations** across large collections take proportionally longer. Updating a field across 10K documents takes seconds; across 10M takes hours.
- **Operational tooling** (Firestore console, debug queries, data exports) struggles with very large collections.

Subgraphs naturally bound collection size. Instead of 10M documents in one collection, you might have 10K parents with 1K documents each. Migrations can proceed parent-by-parent with progress tracking.

### Schema Evolution

Schemas change over time — new fields, renamed properties, restructured data. Firegraph supports automatic migration on read via schema versioning.

Each registry entry can declare a chain of `MigrationStep` functions. The schema version is derived automatically as `max(toVersion)` from the migrations array. When a record is read with a stored version (`v`) behind the derived version, migration functions run sequentially to bring the data up to date. The `v` field lives on the record envelope -- not inside `data` -- so schemas with `additionalProperties: false` work without special handling.

This is a **lazy migration** strategy. Records are migrated when accessed, not all at once. This has implications:

- **No downtime**: Deploy a new schema version and migrations immediately. Old records upgrade transparently on next read.
- **Gradual rollout**: Only actively-accessed records incur migration cost. Cold data stays untouched until needed.
- **Write-back**: Optionally persist migrated data back to Firestore (`migrationWriteBack: 'eager'` or `'background'`). Without write-back, migration runs on every read until the record is rewritten via `putNode`/`putEdge`.
- **Idempotent by design**: Migration functions should be idempotent. If a record is read multiple times before write-back completes, each read produces the same result.

For large-scale one-time migrations (restructuring millions of records), lazy migration avoids the need for batch scripts. But if you need every record upgraded immediately (for example, before a query that depends on the new field), run a batch script that reads and rewrites each record via `putNode` — this stamps the current version and persists the migrated data.

### Index Management

Each collection (root and each distinct subcollection name) needs its own composite indexes. Subgraphs that share a name (e.g., all `workflow` subcollections) share index definitions.

Collection group indexes are separate from single-collection indexes. If you use `findEdgesGlobal`, you need both sets.

On Enterprise Firestore, index management is lighter — Pipeline mode handles most queries without composite indexes. On Standard, `generateIndexConfig()` produces the index configuration for your entity schemas; deploy with `firebase deploy --only firestore:indexes`.

### Cascade Delete

`removeNodeCascade` deletes a node, all its edges, and (by default) recursively deletes all subcollections. This means deleting a parent node removes its entire subgraph hierarchy.

This is not atomic. If a batch fails mid-cascade, earlier batches remain committed and you can end up with orphaned edges or partially deleted subgraphs. For critical deletions, consider soft-delete patterns (mark as deleted, clean up asynchronously). The `CascadeResult` object reports errors so you can retry failed batches.

### Transactions

Firestore transactions scope to reads and writes within a single transaction callback. Transactions on a subgraph client work normally — they read and write within that subcollection.

A single Firestore transaction can span multiple collections, but firegraph's transaction API wraps a single collection context. Firegraph does not currently provide helpers for multi-subgraph atomic operations. For operations that need to modify both a parent and subgraph atomically, use Firestore's native transaction API directly, or design around eventual consistency.

### Firestore Edition Differences

Firegraph works with both Firestore Standard and Enterprise editions. The edition affects query capabilities and operational behavior:

| Aspect                           | Standard                             | Enterprise (Native mode)                                         |
| -------------------------------- | ------------------------------------ | ---------------------------------------------------------------- |
| Document size                    | 1 MiB                                | 1 MiB                                                            |
| Indexes                          | Required — queries fail without them | Optional — the advanced query engine can execute without indexes |
| Pipeline API                     | Not available                        | Available (firegraph's default `queryMode`)                      |
| `data.*` queries without indexes | Fails                                | Works (Pipeline handles it; standard mode scans)                 |
| Performance                      | Baseline                             | Up to 5x faster (SSD-backed, advanced engine)                    |
| Composite index limit            | 200 (free) / 1,000 (billing)         | 1,000                                                            |
| Subcollection depth              | 100 levels                           | 100 levels                                                       |

Firegraph defaults to Pipeline mode, which requires Enterprise. If you are on Standard, set `queryMode: 'standard'` and ensure you have composite indexes for all your query patterns.

### Firestore Limits

A few Firestore constraints to keep in mind:

- **Document size:** 1 MiB (1,048,576 bytes) per document for both Standard and Enterprise in Native mode. Your `data` payload plus firegraph's metadata fields must fit within this.
- **Batch size:** 500 field transformations per document per commit. Firegraph's bulk operations chunk automatically, but individual `batch().commit()` calls are bounded by this and by the 10 MiB API request size limit.
- **Path length:** Document and collection IDs have a maximum of 1,500 bytes each. Each subgraph level adds two path segments (parent UID + subgraph name). With 21-character UIDs, you can nest dozens of levels before hitting limits — far more than you should ever need.
- **Subcollection depth:** 100 levels maximum. Not a practical concern.
- **Transaction time limit:** 270 seconds, with 60-second idle expiration.

---

## Anti-Patterns

### Over-Nesting

```
org/team/project/sprint/task/subtask/comment
```

Six levels of nesting means six levels of subcollection indirection. Every query requires reconstructing the full path. Cross-cutting queries need deeply nested collection group indexes. Cascade deletes recurse through every level.

**Guideline:** Two to three levels of subgraph nesting is usually sufficient. If you need deeper hierarchy, consider flattening some levels into the same collection with edges representing the hierarchy.

### The Mega-Collection

Everything at root. Fifty million documents — users, posts, comments, likes, messages, notifications, configs — all in one collection.

Firestore handles the throughput, but your operational life suffers. Migrations are massive. The console is unusable for browsing. Scan protection fires on nearly every flexible query. Your read bill reflects queries touching far more data than they need.

**Guideline:** If your root collection is projected to exceed 100K documents, identify natural partition boundaries and use subgraphs.

### Cross-Graph Edges Everywhere

If every relationship in your system is a cross-graph edge, you have recreated the root collection problem with worse query performance. Each traversal hop now requires subgraph client creation and separate collection queries.

**Guideline:** Cross-graph edges should be the exception, not the rule. Most edges should be local — connecting nodes within the same collection. Cross-graph edges bridge containment boundaries for the cases where a relationship genuinely spans domains.

### Ignoring `allowedIn`

Without scope constraints, any node type can be written to any subgraph (or root). This makes structural mistakes silent — an agent node accidentally created at root, a memory node accidentally created in the wrong subgraph.

**Guideline:** Define `allowedIn` for all entity types. If using the entity folder convention, add it to `meta.json`:

```json
{ "description": "An agent memory", "allowedIn": ["**/memories"] }
```

Or in registry entries directly:

```typescript
{ aType: 'memory', axbType: 'is', bType: 'memory', allowedIn: ['**/memories'] }
{ aType: 'task', axbType: 'is', bType: 'task', allowedIn: ['**/workspace'] }
{ aType: 'user', axbType: 'is', bType: 'user', allowedIn: ['root'] }
```

---

## Summary

Firegraph gives you a graph database that runs on a document database. The modeling philosophy is:

1. **Start at root.** Entities with global identity, many-to-many relationships, and frequent cross-cutting queries belong in the root collection.

2. **Subgraph what has an owner.** Entities with clear lifecycle coupling, scoped access, and naturally scoped queries belong in subgraphs under their owner.

3. **Not everything is a graph.** Plain Firestore subcollections are the right choice for simple key-value data, Cloud Function triggers, and data managed outside firegraph.

4. **Bridge with collection groups.** When you need cross-cutting access to subgraph data, collection group queries provide the escape hatch without sacrificing isolation.

5. **Make the structure explicit.** Use `allowedIn` constraints to encode your modeling decisions in the registry. Use `targetGraph` to declare cross-graph relationships. Let the system enforce what you intended.

The hybrid model can be more powerful than either a pure graph database or a pure document database — but only if you model with intention. Put the right data in the right place, and the system works with you.
