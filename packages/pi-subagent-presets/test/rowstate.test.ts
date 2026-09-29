import { describe, expect, it } from "vitest";
import { agentCellText, classifyRow, detectBulkFlags, isEditable, isStruckThrough, rowSuffixOf, type RowContext } from "../src/rowstate.ts";
import { providerScopedHits, type UpstreamAgent } from "../src/upstream.ts";

/** 上游 `resolveAgentName` 的最小复刻：canonical → localName → aliases，返回 `{}` / `{error}`。 */
function resolveAgentName(name: string, agents: UpstreamAgent[]): { agent?: UpstreamAgent; error?: string } {
	const raw = name.trim();
	const canonical = agents.filter((agent) => agent.name === raw);
	if (canonical.length === 1) return { agent: canonical[0] };
	if (canonical.length > 1) return { error: `Ambiguous agent name '${name}'` };
	const local = agents.filter((agent) => agent.localName === raw);
	if (local.length === 1) return { agent: local[0] };
	if (local.length > 1) return { error: `Ambiguous local agent name '${name}'` };
	const aliases = agents.filter((agent) => agent.aliases?.includes(raw));
	if (aliases.length === 1) return { agent: aliases[0] };
	if (aliases.length > 1) return { error: `Ambiguous agent alias '${name}'` };
	return {};
}

const BUCKETS: UpstreamAgent[] = [
	{ name: "worker" },
	{ name: "scout" },
	{ name: "reviewer" },
	{ name: "oracle", aliases: ["advisor"] },
	{ name: "researcher", disabled: true },
	{ name: "delegate" },
	{ name: "evidence-auditor" },
];

function ctx(overrides: Partial<RowContext> = {}): RowContext {
	return {
		name: "reviewer",
		userProviderMap: {},
		fourBucketAgents: BUCKETS,
		resolveAgentName,
		...overrides,
	};
}

describe("providerScopedHits（§3.1 保护一的判据）", () => {
	it("任意 provider 键下存在即命中（不只当前父 provider）", () => {
		const map = { ino2api: { worker: { thinking: "high" } }, cline: { scout: { model: "c/m" } } };
		expect(providerScopedHits("worker", map)).toEqual(["ino2api"]);
		expect(providerScopedHits("scout", map)).toEqual(["cline"]);
		expect(providerScopedHits("reviewer", map)).toEqual([]);
	});

	it("空 map 不命中", () => {
		expect(providerScopedHits("worker", {})).toEqual([]);
	});
});

describe("classifyRow：行分类", () => {
	it("正常行：项目有条目 ⇒ project", () => {
		const result = classifyRow(ctx({ name: "reviewer", projectEntry: { model: "p/m" } }));
		expect(result.state).toBe("project");
		expect(result.isAlias).toBe(false);
		expect(result.disabledByOverride).toBe(false);
		expect(result.disabledUpstream).toBe(false);
	});

	it("正常行：项目无条目 ⇒ inherit", () => {
		expect(classifyRow(ctx({ name: "reviewer" })).state).toBe("inherit");
		expect(classifyRow(ctx({ name: "reviewer", projectEntry: {} })).state).toBe("inherit");
	});

	it("不可合并：任意 provider 下有 provider 条件层（优先于其余一切）", () => {
		const result = classifyRow(
			ctx({ name: "worker", projectEntry: { model: "p/m3" }, userProviderMap: { other: { worker: { thinking: "max" } } } }),
		);
		expect(result.state).toBe("unmerged");
		expect(result.providerHits).toEqual(["other"]);
		expect(isEditable(result.state, result.isAlias)).toBe(false);
	});

	it("不可合并：不是当前 provider 也要命中（不能只查 [ctx.model.provider]）", () => {
		const result = classifyRow(
			ctx({ name: "worker", userProviderMap: { a: { worker: {} }, b: { worker: {} } } }),
		);
		expect(result.state).toBe("unmerged");
		expect(result.providerHits.sort()).toEqual(["a", "b"]);
	});

	it("不可合并优先于别名：别名键写在本就无效，不进 keep existing 之外的处理", () => {
		const result = classifyRow(ctx({ name: "advisor", userProviderMap: { a: { advisor: {} } } }));
		expect(result.state).toBe("unmerged");
	});

	it("别名行：resolveAgentName 解析到别的 canonical name", () => {
		const result = classifyRow(ctx({ name: "advisor" }));
		expect(result.isAlias).toBe(true);
		expect(result.aliasOf).toBe("oracle");
		expect(isEditable(result.state, result.isAlias)).toBe(false);
	});

	it("别名行：解析到自身不算别名", () => {
		const result = classifyRow(ctx({ name: "oracle" }));
		expect(result.isAlias).toBe(false);
		expect(result.state).toBe("inherit");
	});

	it("灰行（MISSING）：四桶里都没有（resolveAgentName 返回 {}）", () => {
		const result = classifyRow(ctx({ name: "stale-agent", projectEntry: { model: "p/m" } }));
		expect(result.state).toBe("unresolved");
		expect(result.disabledUpstream).toBe(false);
		// 灰行要照算照显示，但不可改、不写盘
		expect(isEditable(result.state, result.isAlias)).toBe(false);
	});

	it("灰行：resolveAgentName 返回 {error}（歧义名）也是灰行，并带原因", () => {
		const result = classifyRow(ctx({ name: "reviewer", resolveAgentName: () => ({ error: "Ambiguous" }) }));
		expect(result.state).toBe("unresolved");
		expect(result.resolveError).toBe("Ambiguous");
	});

	it("灰行判定用四桶而非 effective 列表：禁用的 researcher 不因被过滤而判成『上游已无』", () => {
		// 四桶含 researcher（disabled），effective 列表会过滤掉它
		const effective = BUCKETS.filter((agent) => agent.disabled !== true).map((a) => a.name);
		expect(effective).not.toContain("researcher");
		// 但它既不是 MISSING（四桶里有），也不是可编辑的普通行
		const result = classifyRow(ctx({ name: "researcher" }));
		expect(result.disabledUpstream).toBe(true);
		expect(result.state).toBe("unresolved");
	});

	it("项目侧 provider 条件层只做提示，不阻止", () => {
		const result = classifyRow(ctx({ name: "reviewer", projectProviderMap: { cur: { reviewer: { thinking: "low" } } } }));
		expect(result.state).toBe("inherit");
		expect(result.projectProviderHits).toEqual(["cur"]);
	});
});

describe("两种『禁用』（§4.1 重定）", () => {
	it("我们配的禁用：合并结果里有 disabled:true ⇒ 可编辑、名字后缀『已禁用』", () => {
		const result = classifyRow(ctx({ name: "reviewer", projectEntry: { disabled: true, model: "p/m" } }));
		expect(result.disabledByOverride).toBe(true);
		expect(result.disabledUpstream).toBe(false);
		expect(result.state).toBe("project");
		expect(isEditable(result.state, result.isAlias)).toBe(true);
		expect(rowSuffixOf(result)).toBe(" DISABLED");
		// 全局层的 disabled 同样算（合并结果里就有它）
		const fromGlobal = classifyRow(ctx({ name: "reviewer", userEntry: { disabled: true } }));
		expect(fromGlobal.disabledByOverride).toBe(true);
	});

	it("上游禁用：四桶有但合并结果里没有 disabled ⇒ 行为与 MISSING 完全一致，标记不同", () => {
		const upstream = classifyRow(ctx({ name: "researcher" }));
		const missing = classifyRow(ctx({ name: "stale-agent" }));

		// 行为一致
		expect(upstream.state).toBe(missing.state);
		expect(isEditable(upstream.state, upstream.isAlias)).toBe(false);
		expect(isEditable(missing.state, missing.isAlias)).toBe(false);

		// 标记可区分
		expect(rowSuffixOf(upstream)).toBe(" ⚠UPSTREAM DISABLED");
		expect(rowSuffixOf(missing)).toBe(" ⚠MISSING");
		expect(agentCellText("researcher", upstream)).toBe("researcher ⚠UPSTREAM DISABLED");
		// MISSING 才加删除线
		expect(isStruckThrough(upstream)).toBe(false);
		expect(isStruckThrough(missing)).toBe(true);
	});

	it("上游禁用 + 我们写了 disabled:false ⇒ 可编辑、无禁用标记（用户重新启用它的路径）", () => {
		const result = classifyRow(ctx({ name: "researcher", projectEntry: { disabled: false } }));
		expect(result.disabledByOverride).toBe(false);
		expect(result.disabledUpstream).toBe(false);
		expect(result.state).toBe("project");
		expect(isEditable(result.state, result.isAlias)).toBe(true);
		expect(rowSuffixOf(result)).toBe("");
	});

	it("上游禁用 + 我们写了 disabled:true ⇒ 走『我们配的禁用』（可编辑）", () => {
		const result = classifyRow(ctx({ name: "researcher", userEntry: { disabled: true } }));
		expect(result.disabledByOverride).toBe(true);
		expect(result.disabledUpstream).toBe(false);
		expect(isEditable(result.state, result.isAlias)).toBe(true);
	});
});

describe("L0 降级（无 upstream）", () => {
	const l0 = (overrides: Partial<RowContext> = {}): RowContext =>
		ctx({ fourBucketAgents: undefined, resolveAgentName: undefined, ...overrides });

	it("不判灰、不判上游禁用、不判别名：全部当正常行", () => {
		expect(classifyRow(l0({ name: "stale-agent" })).state).toBe("inherit");
		expect(classifyRow(l0({ name: "researcher" })).state).toBe("inherit");
		expect(classifyRow(l0({ name: "researcher" })).disabledUpstream).toBe(false);
		const alias = classifyRow(l0({ name: "advisor" }));
		expect(alias.isAlias).toBe(false);
		expect(alias.state).toBe("inherit");
	});

	it("有四桶但没有 resolveAgentName（上游更老）时退化为按 canonical name 找", () => {
		expect(classifyRow(ctx({ name: "stale-agent", resolveAgentName: undefined })).state).toBe("unresolved");
		expect(classifyRow(ctx({ name: "reviewer", resolveAgentName: undefined })).state).toBe("inherit");
		// 退化路径下 disabled 信息仍在四桶里 ⇒ 照判（与 `resolveAgentName` 是否存在无关）
		expect(classifyRow(ctx({ name: "researcher", resolveAgentName: undefined })).disabledUpstream).toBe(true);
	});

	it("§3.1 保护一在 L0 仍然生效（判据只需 settings 裸 JSON）", () => {
		const result = classifyRow(l0({ name: "worker", userProviderMap: { x: { worker: {} } } }));
		expect(result.state).toBe("unmerged");
	});

	it("§3.1 保护二在 L0 仍然生效（由 settings 裸 JSON 判定）", () => {
		const flags = detectBulkFlags({ disableThinking: true, disableBuiltins: false }, { disableThinking: false, disableBuiltins: true });
		expect(flags).toEqual([
			{ key: "disableThinking", scope: "project" },
			{ key: "disableBuiltins", scope: "user" },
		]);
	});
});

describe("detectBulkFlags（§3.1 保护二）", () => {
	const none = { disableThinking: false, disableBuiltins: false };

	it("两个开关都无 ⇒ 空", () => {
		expect(detectBulkFlags(none, none)).toEqual([]);
	});

	it("项目与全局各自独立判定，文案带 scope", () => {
		expect(detectBulkFlags({ ...none, disableThinking: true }, none)).toEqual([{ key: "disableThinking", scope: "project" }]);
		expect(detectBulkFlags(none, { ...none, disableThinking: true })).toEqual([{ key: "disableThinking", scope: "user" }]);
	});

	it("两侧同开 ⇒ 两条都在（project 先于 user）", () => {
		expect(detectBulkFlags({ ...none, disableBuiltins: true }, { ...none, disableBuiltins: true })).toEqual([
			{ key: "disableBuiltins", scope: "project" },
			{ key: "disableBuiltins", scope: "user" },
		]);
	});

	it("非布尔真值不算（上游只认 === true）", () => {
		const truthy = { disableThinking: "yes", disableBuiltins: 1 } as unknown as { disableThinking: boolean; disableBuiltins: boolean };
		expect(detectBulkFlags(truthy, none)).toEqual([]);
	});
});

describe("agent 名标记（行级特殊态就地表达，不进 state 列）", () => {
	it("四种标记各不相同", () => {
		expect(rowSuffixOf({ state: "unmerged", disabledByOverride: false })).toBe(" 🔒");
		expect(rowSuffixOf({ state: "unresolved", disabledByOverride: false, disabledUpstream: true })).toBe(" ⚠UPSTREAM DISABLED");
		expect(rowSuffixOf({ state: "unresolved", disabledByOverride: false })).toBe(" ⚠MISSING");
		expect(rowSuffixOf({ state: "inherit", disabledByOverride: false, isAlias: true, aliasOf: "oracle" })).toBe(" =oracle");
		expect(rowSuffixOf({ state: "inherit", disabledByOverride: true })).toBe(" DISABLED");
		expect(rowSuffixOf({ state: "inherit", disabledByOverride: false })).toBe("");
	});

	it("agent 单元格 = 名字 + 标记（列宽按它的长度分配）", () => {
		expect(agentCellText("evidence-auditor", { state: "inherit", disabledByOverride: false })).toBe("evidence-auditor");
		expect(agentCellText("advisor", { state: "unresolved", disabledByOverride: false })).toBe("advisor ⚠MISSING");
	});
});
