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
 * atomicity cannot be honoured by any of the underlying drivers (D1, DO
 * SQLite, Firestore), so firegraph surfaces this as a typed error instead
 * of silently confining the write to the base backend.
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
