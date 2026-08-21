/**
 * 纯函数：从会话分支提取最近 user 文本，供 doUndo 使用与单测
 */

/** pi 侧 content 形态的最小子集 */
export type TextContentLike = { type: string; text?: string };
export type ContentLike = string | TextContentLike[];

/** 会话分支条目的最小形态（仅调研用到的字段） */
export interface BranchEntryLike {
  type: string;
  id: string;
  parentId: string | null;
  message?: {
    role: string;
    content?: ContentLike;
  };
}

/** 抽取文本：string 原样，数组拼接 type===text */
export function extractText(content: ContentLike | undefined): string {
  if (content === undefined || content === null) return "";
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  let out = "";
  for (const part of content) {
    if (part && part.type === "text" && typeof part.text === "string") out += part.text;
  }
  return out;
}

export interface LastUserResult {
  entryId: string;
  parentId: string | null;
  text: string;
}

/**
 * 倒序扫描分支，找最近一条 role===user 的 message
 * 文本需非空（trim 后），否则继续向前
 */
export function findLastUserEntry(branch: readonly BranchEntryLike[]): LastUserResult | null {
  for (let i = branch.length - 1; i >= 0; i--) {
    const e = branch[i];
    if (!e || e.type !== "message" || !e.message) continue;
    if (e.message.role !== "user") continue;
    const text = extractText(e.message.content);
    if (text.trim() === "") continue;
    return { entryId: e.id, parentId: e.parentId, text };
  }
  return null;
}
