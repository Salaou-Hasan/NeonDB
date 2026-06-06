// ============================================================================
// NeonDB TypeScript Client SDK — MessagePack Wire Protocol
//
// NeonDB uses rmp_serde (Rust MessagePack) with the following conventions:
//
//   Structs     → MessagePack ARRAY (positional, no field names)
//   Enums       → MessagePack MAP with one entry: { "VariantName": [fields…] }
//   Option<T>   → nil (null) or T
//   Vec<u8>     → MessagePack BIN
//
// Outgoing (client → server):
//   ClientMessage::ReducerCall(call)  → { "ReducerCall":  [call_id, name, args_bin] }
//   ClientMessage::Subscribe(…)       → { "Subscribe":    [sub_id, query] }
//   ClientMessage::Unsubscribe(…)     → { "Unsubscribe":  [sub_id] }
//
// Incoming (server → client):
//   ReducerResponse (bare struct)     → [call_id, success, result_bin|nil, error|nil]
//   ServerMessage::SubscriptionAck    → { "SubscriptionAck":    [sub_id, ok, msg|nil] }
//   ServerMessage::SubscriptionDiff   → { "SubscriptionDiff":   [sub_id, table, key, op, data|nil] }
//   ServerMessage::Error              → { "Error": [message] }
// ============================================================================

import { encode, decode, ExtensionCodec } from "@msgpack/msgpack";
import type { ReducerResult, SubscriptionAck, RowDiff } from "./types.js";

/** Codec that passes through Uint8Arrays so BIN data survives the round-trip. */
const codec = new ExtensionCodec();

// ── Encode helpers ────────────────────────────────────────────────────────────

/**
 * Encode a reducer call message.
 * `args` should already be MessagePack-encoded by the caller.
 */
export function encodeReducerCall(
  callId: number,
  reducerName: string,
  args: Uint8Array
): Uint8Array {
  // ClientMessage::ReducerCall(ReducerCall { call_id, reducer_name, args })
  // rmp_serde encodes the outer enum as: {"ReducerCall": [call_id, name, args]}
  // rmp_serde encodes the inner struct as array: [call_id, name, args]
  return encode({ ReducerCall: [callId, reducerName, args] });
}

/**
 * Encode a subscribe message.
 * `subscriptionId` is an arbitrary string chosen by the caller.
 * `query` is a NeonDB subscription query, e.g. `"players WHERE level > 5"`.
 */
export function encodeSubscribe(
  subscriptionId: string,
  query: string
): Uint8Array {
  // ClientMessage::Subscribe { subscription_id, query }
  // → {"Subscribe": [subscription_id, query]}
  return encode({ Subscribe: [subscriptionId, query] });
}

/**
 * Encode an unsubscribe message.
 */
export function encodeUnsubscribe(subscriptionId: string): Uint8Array {
  // ClientMessage::Unsubscribe { subscription_id }
  // → {"Unsubscribe": [subscription_id]}
  return encode({ Unsubscribe: [subscriptionId] });
}

/**
 * Encode arbitrary data as MessagePack for use as reducer args.
 *
 * For the built-in `increment` reducer the server expects a positional array:
 *   `encodeArgs(["myCounter", 5])` → positional array (matches rmp_serde struct)
 *
 * For JS reducers that accept objects:
 *   `encodeArgs({ name: "myCounter", delta: 5 })` → MessagePack map
 */
export function encodeArgs(args: unknown): Uint8Array {
  return encode(args);
}

// ── Decode helpers ────────────────────────────────────────────────────────────

export type DecodedMessage =
  | { type: "ReducerResponse"; data: ReducerResult }
  | { type: "SubscriptionAck"; data: SubscriptionAck }
  | { type: "SubscriptionDiff"; data: RowDiff }
  | { type: "Error"; message: string }
  | { type: "Unknown" };

/**
 * Decode a raw server WebSocket frame into a typed message.
 *
 * The server sends two different envelope formats:
 * - **Bare `ReducerResponse`**: encoded as a MessagePack ARRAY
 *   `[call_id, success, result_bin|nil, error_str|nil]`
 * - **`ServerMessage` variant**: encoded as a MessagePack MAP with one entry
 *   `{"VariantName": [fields…]}`
 */
export function decodeServerMessage(bytes: ArrayBuffer | Uint8Array): DecodedMessage {
  const buf = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let value: unknown;
  try {
    value = decode(buf);
  } catch {
    return { type: "Unknown" };
  }

  // ── Bare ReducerResponse: array [call_id, success, result|nil, error|nil]
  if (Array.isArray(value) && value.length >= 2) {
    const [rawCallId, success] = value;
    if ((typeof rawCallId === "number" || typeof rawCallId === "bigint") &&
        typeof success === "boolean") {
      const callId = typeof rawCallId === "bigint" ? Number(rawCallId) : rawCallId;
      const resultRaw = value[2];
      const errorRaw = value[3];
      return {
        type: "ReducerResponse",
        data: {
          callId,
          success,
          resultBytes: resultRaw instanceof Uint8Array ? resultRaw : null,
          error: typeof errorRaw === "string" ? errorRaw : null,
        },
      };
    }
  }

  // ── ServerMessage variant: { "VariantName": [fields…] }
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length === 1) {
      const [variant, content] = entries[0];
      const fields = Array.isArray(content) ? content : [content];

      switch (variant) {
        case "SubscriptionAck":
          return {
            type: "SubscriptionAck",
            data: {
              subscriptionId: String(fields[0] ?? ""),
              success: Boolean(fields[1]),
              message: fields[2] != null ? String(fields[2]) : null,
            },
          };

        case "SubscriptionDiff": {
          const rawData = fields[4];
          let rowData: Record<string, unknown> | null = null;
          if (rawData != null && typeof rawData === "object" && !Array.isArray(rawData)) {
            rowData = rawData as Record<string, unknown>;
          }
          return {
            type: "SubscriptionDiff",
            data: {
              subscriptionId: String(fields[0] ?? ""),
              tableName: String(fields[1] ?? ""),
              rowKey: String(fields[2] ?? ""),
              operation: String(fields[3] ?? ""),
              rowData,
            },
          };
        }

        case "ReducerResponse": {
          // ServerMessage::ReducerResponse (alternative wrapping)
          const inner = Array.isArray(content) ? content : [];
          const rawCallId = inner[0];
          const callId =
            typeof rawCallId === "bigint" ? Number(rawCallId) : Number(rawCallId ?? 0);
          return {
            type: "ReducerResponse",
            data: {
              callId,
              success: Boolean(inner[1]),
              resultBytes: inner[2] instanceof Uint8Array ? inner[2] : null,
              error: inner[3] != null ? String(inner[3]) : null,
            },
          };
        }

        case "Error":
          return {
            type: "Error",
            message: String(fields[0] ?? "Unknown error"),
          };

        default:
          return { type: "Unknown" };
      }
    }
  }

  return { type: "Unknown" };
}

/**
 * Decode MessagePack bytes into a JavaScript value.
 * Useful for decoding reducer result bytes returned in `ReducerResult.resultBytes`.
 */
export function decodeResult<T = unknown>(bytes: Uint8Array): T {
  return decode(bytes) as T;
}
