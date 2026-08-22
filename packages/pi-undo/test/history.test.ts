import { describe, it, expect } from "vitest";
import { extractText, findLastUserEntry, type BranchEntryLike } from "../src/history.ts";

describe("extractText", () => {
  it("string passthrough", () => {
    expect(extractText("hello")).toBe("hello");
  });
  it("TextContent array", () => {
    expect(
      extractText([
        { type: "text", text: "a" },
        { type: "image", text: "ignore" } as never,
        { type: "text", text: "b" },
      ]),
    ).toBe("ab");
  });
  it("empty/undefined", () => {
    expect(extractText(undefined)).toBe("");
    expect(extractText([])).toBe("");
  });
});

describe("findLastUserEntry", () => {
  const mk = (id: string, parentId: string | null, role: string, content: string): BranchEntryLike => ({
    type: "message",
    id,
    parentId,
    message: { role, content },
  });

  it("finds last user", () => {
    const branch: BranchEntryLike[] = [
      mk("1", null, "user", "first"),
      mk("2", "1", "assistant", "hi"),
      mk("3", "2", "user", "second"),
      mk("4", "3", "assistant", "hi2"),
    ];
    const r = findLastUserEntry(branch);
    expect(r?.entryId).toBe("3");
    expect(r?.text).toBe("second");
    expect(r?.parentId).toBe("2");
  });

  it("skips empty user", () => {
    const branch: BranchEntryLike[] = [
      mk("1", null, "user", "first"),
      mk("2", "1", "user", "   "),
      mk("3", "2", "assistant", "hi"),
    ];
    const r = findLastUserEntry(branch);
    expect(r?.entryId).toBe("1");
  });

  it("handles TextContent array", () => {
    const branch: BranchEntryLike[] = [
      {
        type: "message",
        id: "1",
        parentId: null,
        message: { role: "user", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }] },
      } as unknown as BranchEntryLike,
    ];
    expect(findLastUserEntry(branch)?.text).toBe("hello world");
  });

  it("no user returns null", () => {
    const branch: BranchEntryLike[] = [
      mk("1", null, "assistant", "hi"),
      { type: "compaction", id: "2", parentId: "1" } as unknown as BranchEntryLike,
    ];
    expect(findLastUserEntry(branch)).toBeNull();
  });

  it("branch with mixed types", () => {
    const branch: BranchEntryLike[] = [
      mk("1", null, "user", "a"),
      { type: "custom", id: "2", parentId: "1" } as unknown as BranchEntryLike,
      mk("3", "2", "assistant", "hi"),
      mk("4", "3", "user", "b"),
    ];
    expect(findLastUserEntry(branch)?.entryId).toBe("4");
  });

  it("undo 哨兵（custom）为分支末条时仍能定位到其前的 user 消息", () => {
    // pi-undo-pin 落盘后成为分支末条，findLastUserEntry 必须跳过它找到真正的 user 消息
    const branch: BranchEntryLike[] = [
      mk("1", null, "user", "a"),
      mk("2", "1", "assistant", "hi"),
      { type: "custom", id: "pin-1", parentId: "1", customType: "pi-undo-pin" } as unknown as BranchEntryLike,
    ];
    const r = findLastUserEntry(branch);
    expect(r?.entryId).toBe("1");
    expect(r?.parentId).toBeNull();
    expect(r?.text).toBe("a");
  });
});
