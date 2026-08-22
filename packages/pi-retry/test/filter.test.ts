import { describe, it, expect } from "vitest";
import { RETRY_SENTINEL_TEXT, RETRY_SENTINEL_TYPE, isRetrySentinel, stripRetrySentinels } from "../src/filter.ts";

const sentinel = { role: "custom", customType: RETRY_SENTINEL_TYPE, content: [{ type: "text", text: RETRY_SENTINEL_TEXT }] };
const otherCustom = { role: "custom", customType: "pi-other", content: [] };
const user = { role: "user", content: [{ type: "text", text: "hello" }] };
// 失败的半截 assistant：必须原样保留（方案核心约束）
const partialAssistant = {
  role: "assistant",
  stopReason: "error",
  errorMessage: "connection lost",
  content: [{ type: "text", text: "half written respon" }],
};
const toolResult = { role: "toolResult", content: [] };

describe("isRetrySentinel", () => {
  it("matches only role=custom + customType=pi-retry", () => {
    expect(isRetrySentinel(sentinel)).toBe(true);
    expect(isRetrySentinel(otherCustom)).toBe(false);
    expect(isRetrySentinel(user)).toBe(false);
    expect(isRetrySentinel(partialAssistant)).toBe(false);
    expect(isRetrySentinel(null)).toBe(false);
    expect(isRetrySentinel(undefined)).toBe(false);
    expect(isRetrySentinel("custom")).toBe(false);
  });

  it("does not match by text content (no false positive on '.')", () => {
    expect(isRetrySentinel({ role: "user", content: [{ type: "text", text: "." }] })).toBe(false);
  });
});

describe("stripRetrySentinels", () => {
  it("removes sentinels and preserves order of everything else", () => {
    const input = [user, sentinel, partialAssistant, sentinel, toolResult];
    const out = stripRetrySentinels(input) as unknown[];
    expect(out).toEqual([user, partialAssistant, toolResult]);
  });

  it("keeps failed/aborted assistant messages untouched (保持原样约束)", () => {
    const out = stripRetrySentinels([partialAssistant]) as unknown[];
    expect(out).toHaveLength(1);
    expect(out[0]).toBe(partialAssistant);
  });

  it("keeps non-retry custom messages", () => {
    const out = stripRetrySentinels([otherCustom]) as unknown[];
    expect(out).toEqual([otherCustom]);
  });

  it("returns same reference when no sentinel present (零拷贝快路径)", () => {
    const input = [user, partialAssistant];
    expect(stripRetrySentinels(input)).toBe(input);
  });

  it("handles empty array and non-array input", () => {
    expect(stripRetrySentinels([])).toEqual([]);
    expect(stripRetrySentinels(null)).toBeNull();
    expect(stripRetrySentinels(undefined)).toBeUndefined();
  });
});

import { findLastAssistantStop, isRetryableStop, RETRYABLE_STOP_REASONS } from "../src/filter.ts";

const entry = (role: string, stopReason?: string) => ({
  type: "message",
  id: `e-${Math.random().toString(36).slice(2)}`,
  parentId: null,
  message: { role, stopReason },
});

describe("isRetryableStop", () => {
  it("allows only error/aborted", () => {
    expect(isRetryableStop("error")).toBe(true);
    expect(isRetryableStop("aborted")).toBe(true);
    expect(isRetryableStop("stop")).toBe(false);
    expect(isRetryableStop("length")).toBe(false);
    expect(isRetryableStop(undefined)).toBe(false);
  });
});

describe("findLastAssistantStop", () => {
  it("returns stopReason of the last assistant entry, skipping others", () => {
    const branch = [entry("user"), entry("assistant", "stop"), sentinel, entry("user"), entry("assistant", "error")];
    expect(findLastAssistantStop(branch)).toBe("error");
  });

  it("returns undefined for fresh session (no assistant)", () => {
    expect(findLastAssistantStop([entry("user"), sentinel])).toBeUndefined();
    expect(findLastAssistantStop([])).toBeUndefined();
  });

  it("skips malformed entries", () => {
    const branch = [{ type: "message" }, null, undefined, entry("assistant", "aborted")];
    expect(findLastAssistantStop(branch as never[])).toBe("aborted");
  });

  it("RETRYABLE_STOP_REASONS is exactly error+aborted", () => {
    expect([...RETRYABLE_STOP_REASONS].sort()).toEqual(["aborted", "error"]);
  });
});
