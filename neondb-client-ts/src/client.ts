// ============================================================================
// NeonDB TypeScript Client SDK — NeonDBClient
// ============================================================================

import {
  encodeReducerCall,
  encodeSubscribe,
  encodeUnsubscribe,
  encodeArgs,
  decodeServerMessage,
  decodeResult,
} from "./protocol.js";
import type {
  NeonDBClientOptions,
  ReducerResult,
  SubscriptionCallback,
  Subscription,
  RowCache,
} from "./types.js";

// Use native WebSocket in browsers; dynamically require 'ws' in Node.js.
// `ws` supports custom HTTP headers (required for API key auth).
function getWebSocketClass(): typeof WebSocket {
  if (typeof globalThis.WebSocket !== "undefined") {
    return globalThis.WebSocket;
  }
  // Node.js path — `ws` must be installed
  try {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    return require("ws");
  } catch {
    throw new Error(
      "WebSocket is not available. In Node.js, install the 'ws' package: npm install ws"
    );
  }
}

interface PendingCall {
  resolve: (result: ReducerResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export class NeonDBClient {
  private readonly opts: Required<NeonDBClientOptions>;
  private ws: WebSocket | null = null;
  private pendingCalls = new Map<number, PendingCall>();
  private subscriptions = new Map<string, SubscriptionCallback>();
  private rowCache = new Map<string, RowCache>(); // tableName → { rowKey → rowData }
  private nextCallId = 1;
  private nextSubId = 1;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  // ── Connection lifecycle events ───────────────────────────────────────────
  /** Fired when the WebSocket connection is opened (or re-opened). */
  onConnected?: () => void;
  /** Fired when the connection is closed. */
  onDisconnected?: () => void;
  /** Fired when an unhandled server error message arrives. */
  onError?: (message: string) => void;

  constructor(options: NeonDBClientOptions) {
    this.opts = {
      reconnectInterval: 3_000,
      callTimeout: 5_000,
      apiKey: "",
      ...options,
    };
  }

  // ── Connection ────────────────────────────────────────────────────────────

  /**
   * Open the WebSocket connection.
   * Resolves when the connection is ready to use.
   *
   * In Node.js the API key is sent as an HTTP header.
   * In browsers the API key cannot be sent as a header — connect to a server
   * without an API key, or route through a proxy that adds the header.
   */
  connect(): Promise<void> {
    if (this.ws?.readyState === WebSocket.OPEN) {
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      this.closed = false;
      this.openSocket(resolve, reject);
    });
  }

  /** Close the connection and stop auto-reconnect. */
  disconnect(): void {
    this.closed = true;
    if (this.reconnectTimer != null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.ws?.close();
    this.ws = null;
    this.rejectAllPending(new Error("Client disconnected"));
  }

  // ── Reducer calls ─────────────────────────────────────────────────────────

  /**
   * Call a reducer and return the raw result bytes.
   *
   * For the built-in `increment` reducer, pass args as a positional array
   * matching the Rust struct field order:
   * ```ts
   * const bytes = await client.call("increment", ["score", 1]);
   * const result = client.decodeResult(bytes!); // { new_value: 5, timestamp: … }
   * ```
   *
   * For JS/WASM reducers that accept an object:
   * ```ts
   * await client.call("myReducer", { key: "value" });
   * ```
   *
   * @returns Raw result bytes (MessagePack-encoded), or `null` if the call
   *          succeeded with no result.
   * @throws if the reducer returned an error or the call timed out.
   */
  call(reducerName: string, args: unknown = []): Promise<Uint8Array | null> {
    return new Promise((resolve, reject) => {
      if (!this.isConnected()) {
        reject(new Error("Not connected"));
        return;
      }

      const callId = this.nextCallId++;
      const encodedArgs = encodeArgs(args);
      const frame = encodeReducerCall(callId, reducerName, encodedArgs);

      const timer = setTimeout(() => {
        this.pendingCalls.delete(callId);
        reject(new Error(`call "${reducerName}" timed out after ${this.opts.callTimeout}ms`));
      }, this.opts.callTimeout);

      this.pendingCalls.set(callId, {
        resolve: (result) => {
          clearTimeout(timer);
          if (result.success) {
            resolve(result.resultBytes);
          } else {
            reject(new Error(result.error ?? "Reducer returned an error"));
          }
        },
        reject: (err) => {
          clearTimeout(timer);
          reject(err);
        },
        timer,
      });

      this.send(frame);
    });
  }

  /**
   * Decode MessagePack result bytes into a JavaScript value.
   * Convenience wrapper around the protocol `decodeResult` helper.
   */
  decodeResult<T = unknown>(bytes: Uint8Array): T {
    return decodeResult<T>(bytes);
  }

  // ── Subscriptions ─────────────────────────────────────────────────────────

  /**
   * Subscribe to a NeonDB table (with an optional WHERE predicate).
   *
   * ```ts
   * const sub = client.subscribe("players WHERE level > 5", (diff) => {
   *   console.log(diff.operation, diff.rowKey, diff.rowData);
   * });
   *
   * // Later:
   * sub.unsubscribe();
   * ```
   *
   * Supported predicates:
   *   - Single field:  `WHERE score >= 100`
   *   - IN operator:   `WHERE status IN ('active', 'pending')`
   *   - AND compound:  `WHERE score > 100 AND level > 5`
   *
   * The `"initial_snapshot"` operation is delivered for each row that
   * already exists in the table at subscription time.
   */
  subscribe(query: string, callback: SubscriptionCallback): Subscription {
    const subId = `sub_${this.nextSubId++}_${Date.now()}`;
    this.subscriptions.set(subId, callback);

    const frame = encodeSubscribe(subId, query);
    if (this.isConnected()) {
      this.send(frame);
    }

    return {
      id: subId,
      unsubscribe: () => {
        this.subscriptions.delete(subId);
        if (this.isConnected()) {
          this.send(encodeUnsubscribe(subId));
        }
      },
    };
  }

  // ── Row cache ─────────────────────────────────────────────────────────────

  /**
   * Return the client-side row cache for a table.
   * The cache is populated by subscription diffs (including initial snapshots).
   *
   * @returns A `Map<rowKey, rowData>` snapshot.  Returns an empty map if no
   *          subscription has delivered data for this table yet.
   */
  getRows(tableName: string): RowCache {
    return this.rowCache.get(tableName) ?? new Map();
  }

  /** Return a single cached row, or `undefined` if not present. */
  getRow(tableName: string, rowKey: string): Record<string, unknown> | undefined {
    return this.rowCache.get(tableName)?.get(rowKey);
  }

  // ── Status ────────────────────────────────────────────────────────────────

  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  private openSocket(
    onOpen?: () => void,
    onError?: (e: Error) => void
  ): void {
    const WS = getWebSocketClass();

    // In Node.js, pass headers option for API key auth.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let ws: any;
    if (this.opts.apiKey) {
      // Node.js `ws` library supports options object with headers.
      // In a browser environment, this constructor form is not supported —
      // users must proxy the API key or leave it unset.
      try {
        ws = new (WS as any)(this.opts.url, {
          headers: { Authorization: `Bearer ${this.opts.apiKey}` },
        });
      } catch {
        ws = new WS(this.opts.url);
      }
    } else {
      ws = new WS(this.opts.url);
    }

    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.onopen = () => {
      onOpen?.();
      this.onConnected?.();
      // Re-subscribe after reconnect
      for (const [subId] of this.subscriptions) {
        // Re-send subscriptions — but we don't have the original query stored.
        // Subscriptions created before connect() is called are re-sent here;
        // the query is not retained, so callers should re-subscribe manually.
        // TODO: store (subId → query) map to enable transparent re-subscription.
      }
    };

    ws.onclose = () => {
      this.onDisconnected?.();
      this.rejectAllPending(new Error("Connection closed"));
      if (!this.closed && this.opts.reconnectInterval > 0) {
        this.reconnectTimer = setTimeout(() => {
          this.openSocket();
        }, this.opts.reconnectInterval);
      }
    };

    ws.onerror = (evt: Event) => {
      const msg = "WebSocket error";
      onError?.(new Error(msg));
    };

    ws.onmessage = (evt: MessageEvent<ArrayBuffer | string>) => {
      if (evt.data instanceof ArrayBuffer || evt.data instanceof Uint8Array) {
        this.handleFrame(evt.data as ArrayBuffer);
      }
    };
  }

  private handleFrame(data: ArrayBuffer): void {
    const msg = decodeServerMessage(data);

    switch (msg.type) {
      case "ReducerResponse": {
        const pending = this.pendingCalls.get(msg.data.callId);
        if (pending) {
          this.pendingCalls.delete(msg.data.callId);
          pending.resolve(msg.data);
        }
        break;
      }

      case "SubscriptionAck":
        // No user callback — acks just confirm subscription registration.
        // Errors are logged if the subscription failed.
        if (!msg.data.success) {
          console.warn(
            `[NeonDB] Subscription "${msg.data.subscriptionId}" failed: ${msg.data.message}`
          );
        }
        break;

      case "SubscriptionDiff": {
        const diff = msg.data;
        // Update local row cache
        this.applyToCache(diff.tableName, diff.rowKey, diff.operation, diff.rowData);
        // Notify subscriber
        const cb = this.subscriptions.get(diff.subscriptionId);
        cb?.(diff);
        break;
      }

      case "Error":
        this.onError?.(msg.message);
        break;

      case "Unknown":
        // Ignore unrecognised frames (forward-compat)
        break;
    }
  }

  private applyToCache(
    tableName: string,
    rowKey: string,
    operation: string,
    rowData: Record<string, unknown> | null
  ): void {
    if (!this.rowCache.has(tableName)) {
      this.rowCache.set(tableName, new Map());
    }
    const table = this.rowCache.get(tableName)!;
    if (operation === "delete") {
      table.delete(rowKey);
    } else if (rowData != null) {
      table.set(rowKey, rowData);
    }
  }

  private send(frame: Uint8Array): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(frame);
    }
  }

  private rejectAllPending(err: Error): void {
    for (const pending of this.pendingCalls.values()) {
      clearTimeout(pending.timer);
      pending.reject(err);
    }
    this.pendingCalls.clear();
  }
}
