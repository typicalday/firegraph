export class FiregraphError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'FiregraphError';
  }
}

export class NodeNotFoundError extends FiregraphError {
  constructor(uid: string) {
    super(`Node not found: ${uid}`, 'NODE_NOT_FOUND');
    this.name = 'NodeNotFoundError';
  }
}

export class EdgeNotFoundError extends FiregraphError {
  constructor(aUid: string, axbType: string, bUid: string) {
    super(`Edge not found: ${aUid} -[${axbType}]-> ${bUid}`, 'EDGE_NOT_FOUND');
    this.name = 'EdgeNotFoundError';
  }
}

export class ValidationError extends FiregraphError {
  constructor(
    message: string,
    public readonly details?: unknown,
  ) {
    super(message, 'VALIDATION_ERROR');
    this.name = 'ValidationError';
  }
}

export class RegistryViolationError extends FiregraphError {
  constructor(aType: string, axbType: string, bType: string) {
    super(`Unregistered triple: (${aType}) -[${axbType}]-> (${bType})`, 'REGISTRY_VIOLATION');
    this.name = 'RegistryViolationError';
  }
}

export class InvalidQueryError extends FiregraphError {
  constructor(message: string) {
    super(message, 'INVALID_QUERY');
    this.name = 'InvalidQueryError';
  }
}

export class TraversalError extends FiregraphError {
  constructor(message: string) {
    super(message, 'TRAVERSAL_ERROR');
    this.name = 'TraversalError';
  }
}

export class DynamicRegistryError extends FiregraphError {
  constructor(message: string) {
    super(message, 'DYNAMIC_REGISTRY_ERROR');
    this.name = 'DynamicRegistryError';
  }
}

export class QuerySafetyError extends FiregraphError {
  constructor(message: string) {
    super(message, 'QUERY_SAFETY');
    this.name = 'QuerySafetyError';
  }
}

export class RegistryScopeError extends FiregraphError {
  constructor(
    aType: string,
    axbType: string,
    bType: string,
    scopePath: string,
    allowedIn: string[],
  ) {
    super(
      `Type (${aType}) -[${axbType}]-> (${bType}) is not allowed at scope "${scopePath || 'root'}". ` +
        `Allowed in: [${allowedIn.join(', ')}]`,
      'REGISTRY_SCOPE',
    );
    this.name = 'RegistryScopeError';
  }
}

export class MigrationError extends FiregraphError {
  constructor(message: string) {
    super(message, 'MIGRATION_ERROR');
    this.name = 'MigrationError';
  }
}

/**
 * Thrown when a caller tries to perform an operation that would require
 * atomicity across two physical storage backends — e.g. opening a routed
 * subgraph client from inside a transaction callback. Cross-backend
 * atomicity cannot be honoured by real-world storage engines (Firestore,
 * SQLite drivers over D1/DO/better-sqlite3, etc.), so firegraph surfaces
 * this as a typed error instead of silently confining the write to the
 * base backend.
 *
 * Normally `TransactionBackend` and `BatchBackend` don't expose `subgraph()`
 * at the type level, so this error is unreachable through well-typed code.
 * It exists as a public catchable type for app code that needs to tolerate
 * this case deliberately (e.g. dynamic code paths that bypass the type
 * system) and as future-proofing if the interface ever grows a way to
 * request a sub-scope inside a transaction.
 */
export class CrossBackendTransactionError extends FiregraphError {
  constructor(message: string) {
    super(message, 'CROSS_BACKEND_TRANSACTION');
    this.name = 'CrossBackendTransactionError';
  }
}

/**
 * Thrown when a caller invokes a capability-gated operation on a backend
 * that does not declare the required capability. Capability gating is
 * primarily a compile-time concern (see `BackendCapabilities` and the
 * type-level extension surfaces in `GraphClient<C>`), but this runtime
 * error covers the cases where the type system is bypassed — dynamic
 * registries, `as any` casts, or callers explicitly downcasting through
 * the generic-erased `StorageBackend` shape.
 *
 * The error code is `CAPABILITY_NOT_SUPPORTED`. The message names the
 * missing capability and the backend that was asked, so app code can
 * diagnose without inspecting the cap set itself.
 */
export class CapabilityNotSupportedError extends FiregraphError {
  constructor(
    public readonly capability: string,
    backendDescription: string,
  ) {
    super(
      `Capability "${capability}" is not supported by ${backendDescription}.`,
      'CAPABILITY_NOT_SUPPORTED',
    );
    this.name = 'CapabilityNotSupportedError';
  }
}
