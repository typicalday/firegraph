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
    super(
      `Unregistered triple: (${aType}) -[${axbType}]-> (${bType})`,
      'REGISTRY_VIOLATION',
    );
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
