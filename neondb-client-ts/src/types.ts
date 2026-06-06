// ============================================================================
// NeonDB TypeScript Client SDK — Type Definitions
// ============================================================================

/** Options passed to NeonDBClient constructor. */
export interface NeonDBClientOptions {
  /** WebSocket URL, e.g. "ws://localhost:3000" or "wss://db.yourgame.com" */
  url: string;

  /**
   * Optional API key.  When set, sent as `Authorization: Bearer <key>` in the
   * WebSocket upgrade request headers (Node.js only — browsers cannot set
   * custom WebSocket headers).
   */
  apiKey?: string;

  /**
   * Milliseconds between automatic reconnect attempts after an unexpected
   * disconnect.  Set to 0 to disable auto-reconnect.  Default: 3000.
   */
  reconnectInterval?: number;

  /**
   * Milliseconds before a `call()` promise is rejected with a timeout error.
   * Default: 5000.
   */
  callTimeout?: number;
}

// ── Outgoing messages (client → server) ──────────────────────────────────────

/** Raw wire structure sent for every reducer call. */
export interface ReducerCallWire {
  call_id: number;
  reducer_name: string;
  /** MessagePack-encoded args (already encoded by the caller). */
  args: Uint8Array;
}

// ── Incoming messages (server → client) ──────────────────────────────────────

/** Outcome of a reducer call. */
export interface ReducerResult {
  callId: number;
  success: boolean;
  /** MessagePack-encoded result bytes, if any. */
  resultBytes: Uint8Array | null;
  error: string | null;
}

/** Acknowledgment of a Subscribe or Unsubscribe request. */
export interface SubscriptionAck {
  subscriptionId: string;
  success: boolean;
  message: string | null;
}

/**
 * A single row change delivered to a subscriber.
 * `rowData` is the decoded JSON value from the server; for `"delete"` events
 * it will be `null`.
 */
export interface RowDiff {
  /** Which subscription triggered this diff. */
  subscriptionId: string;
  tableName: string;
  rowKey: string;
  /** `"insert"`, `"update"`, `"delete"`, or `"initial_snapshot"` */
  operation: string;
  rowData: Record<string, unknown> | null;
}

/** Callback invoked for every matching row change. */
export type SubscriptionCallback = (diff: RowDiff) => void;

/** Returned by `subscribe()` — call `.unsubscribe()` to stop. */
export interface Subscription {
  id: string;
  unsubscribe: () => void;
}

/** Cached snapshot of a table's rows, indexed by row_key. */
export type RowCache = Map<string, Record<string, unknown>>;
