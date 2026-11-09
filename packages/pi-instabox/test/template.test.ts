/**
 * @inobit/pi-instabox — `template.ts` 单测：**全部注入内存 fs / 假时钟 / 假 client**。
 *
 * 覆盖方案 §5.1 / T12 的验收点：per-box 命中、TTL 过期、**握手版本校验**（同版本命中不 `listTools`、
 * 版本变化重拉、显式 `serverVersion` 优先）、**两箱版本不同各自命中且互不失效**、
 * 写盘失败只 warn、`initialize` 失败保留旧缓存、`allowWake` 原样透传给 clientFactory、
 * 拉取过程**只**走 `initialize` + `listTools`（不唤醒箱、不动唤醒链）；
 * 以及 review 补的：原型键（`constructor` / `__proto__`）不误命中、
 * `templateId` / `templateVersion` 入参优先、失败结果带出旧缓存（`stale`）。
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createMemoryLogger, setLogger } from "../src/log.ts";
import {
	DEFAULT_TEMPLATE_TTL_MS,
	createEmptyTemplateCache,
	createTemplateStore,
	isStale,
	needsRefetch,
	nodeTemplateFileSystem,
	readCache,
	writeCache,
	type CachedTemplate,
	type ReadTextFn,
	type TemplateClientFactory,
	type TemplateClientOptions,
	type TemplateFileSystem,
	type TemplateStore,
	type WriteTextFn,
} from "../src/template.ts";
import type { CallToolResult, InitializeResult, RemoteClient, RemoteTool } from "../src/remote.ts";

const CACHE_FILE = "/agent/pi-instabox/templates.json";
const BOX_VERSION = "0.3.6-instabox.1";
const NOW = Date.parse("2026-01-01T00:00:00.000Z");

const LIST_APPS: RemoteTool = {
	name: "list_apps",
	description: "List running apps",
	inputSchema: { type: "object", properties: {} },
};

const SCREENSHOT: RemoteTool = {
	name: "screenshot",
	description: "Take a screenshot",
	inputSchema: { type: "object", properties: { format: { type: "string" } } },
};

/** 内存文件系统：记录读写、可注入写失败。 */
class MemoryFileSystem implements TemplateFileSystem {
	readonly files = new Map<string, string>();
	readonly writes: { file: string; text: string }[] = [];
	readonly reads: string[] = [];
	writeError: Error | undefined;

	readText: ReadTextFn = (file) => {
		this.reads.push(file);
		const text = this.files.get(file);
		if (text === undefined) throw new Error(`ENOENT: no such file, open '${file}'`);
		return text;
	};

	writeText: WriteTextFn = (file, text) => {
		this.writes.push({ file, text });
		if (this.writeError !== undefined) throw this.writeError;
		this.files.set(file, text);
	};
}

interface FakeClientBehaviour {
	initializeResult?: InitializeResult;
	initializeError?: Error;
	tools?: RemoteTool[];
	listToolsError?: Error;
	/** 握手返回前跑一段副作用（用于中途 abort） */
	beforeInitializeResolve?: () => void;
}

/** 假远端客户端：记录被调用的方法名（断言“只握手 + 拉列表”）。 */
class FakeRemoteClient implements RemoteClient {
	readonly calls: string[] = [];
	readonly listToolsSignals: (AbortSignal | undefined)[] = [];
	private readonly behaviour: FakeClientBehaviour;

	constructor(behaviour: FakeClientBehaviour = {}) {
		this.behaviour = behaviour;
	}

	async initialize(): Promise<InitializeResult> {
		this.calls.push("initialize");
		this.behaviour.beforeInitializeResolve?.();
		const error = this.behaviour.initializeError;
		if (error !== undefined) throw error;
		return this.behaviour.initializeResult ?? { serverInfo: { version: BOX_VERSION } };
	}

	async listTools(signal?: AbortSignal): Promise<RemoteTool[]> {
		this.calls.push("listTools");
		this.listToolsSignals.push(signal);
		const error = this.behaviour.listToolsError;
		if (error !== undefined) throw error;
		return this.behaviour.tools ?? [LIST_APPS, SCREENSHOT];
	}

	async callTool(): Promise<CallToolResult> {
		this.calls.push("callTool");
		throw new Error("template store must never call tools/call");
	}

	close(): void {
		this.calls.push("close");
	}

	isDead(): boolean {
		this.calls.push("isDead");
		return false;
	}
}

interface FactoryHarness {
	factory: TemplateClientFactory;
	boxes: string[];
	clients: FakeRemoteClient[];
	/** 每次工厂调用的第二参原样记录（`undefined` 即“没传”） */
	options: (TemplateClientOptions | undefined)[];
}

function makeFactory(behaviour: FakeClientBehaviour | ((box: string) => FakeClientBehaviour) = {}): FactoryHarness {
	const boxes: string[] = [];
	const clients: FakeRemoteClient[] = [];
	const options: (TemplateClientOptions | undefined)[] = [];
	const factory: TemplateClientFactory = (box, clientOptions) => {
		boxes.push(box);
		options.push(clientOptions);
		const client = new FakeRemoteClient(typeof behaviour === "function" ? behaviour(box) : behaviour);
		clients.push(client);
		return client;
	};
	return { factory, boxes, clients, options };
}

function entry(overrides: Partial<CachedTemplate> = {}): CachedTemplate {
	return {
		serverInfoVersion: BOX_VERSION,
		fetchedAt: new Date(NOW).toISOString(),
		tools: [LIST_APPS],
		...overrides,
	};
}

function seedDisk(fsImpl: MemoryFileSystem, boxes: Record<string, CachedTemplate>): void {
	fsImpl.files.set(CACHE_FILE, JSON.stringify({ version: 1, boxes }));
}

describe("isStale", () => {
	it("TTL 内未过期，超过即过期，边界按过期计", () => {
		const cached = entry();
		expect(isStale(cached, NOW)).toBe(false);
		expect(isStale(cached, NOW + DEFAULT_TEMPLATE_TTL_MS - 1)).toBe(false);
		expect(isStale(cached, NOW + DEFAULT_TEMPLATE_TTL_MS)).toBe(true);
		expect(DEFAULT_TEMPLATE_TTL_MS).toBe(168 * 60 * 60 * 1_000);
	});

	it("支持自定义 ttlMs", () => {
		const cached = entry();
		expect(isStale(cached, NOW + 500, 1_000)).toBe(false);
		expect(isStale(cached, NOW + 1_000, 1_000)).toBe(true);
	});

	it("fetchedAt 无法解析判过期，未来时间戳判未过期", () => {
		expect(isStale(entry({ fetchedAt: "not-a-date" }), NOW)).toBe(true);
		expect(isStale(entry({ fetchedAt: new Date(NOW + 60_000).toISOString() }), NOW)).toBe(false);
	});
});

describe("needsRefetch", () => {
	it("无缓存或版本不同都需要重拉", () => {
		expect(needsRefetch(undefined, BOX_VERSION)).toBe(true);
		expect(needsRefetch(entry(), BOX_VERSION)).toBe(false);
		expect(needsRefetch(entry(), "0.3.7-instabox.1")).toBe(true);
	});
});

describe("readCache", () => {
	it("读失败/非法 JSON/结构版本不匹配都退化成空缓存", () => {
		const fsImpl = new MemoryFileSystem();
		expect(readCache(fsImpl.readText, CACHE_FILE)).toEqual(createEmptyTemplateCache());

		fsImpl.files.set(CACHE_FILE, "{ not json");
		expect(readCache(fsImpl.readText, CACHE_FILE)).toEqual(createEmptyTemplateCache());

		fsImpl.files.set(CACHE_FILE, JSON.stringify({ version: 2, boxes: {} }));
		expect(readCache(fsImpl.readText, CACHE_FILE)).toEqual(createEmptyTemplateCache());
	});

	it("保留合法条目与诊断字段，丢弃坏条目与空 box 键", () => {
		const fsImpl = new MemoryFileSystem();
		fsImpl.files.set(
			CACHE_FILE,
			JSON.stringify({
				version: 1,
				boxes: {
					general: entry({ templateId: "tpl-1", templateVersion: "2026-10-25.23" }),
					agent: { serverInfoVersion: BOX_VERSION, fetchedAt: new Date(NOW).toISOString() },
					"": entry(),
				},
			}),
		);
		const cache = readCache(fsImpl.readText, CACHE_FILE);
		expect(Object.keys(cache.boxes)).toEqual(["general"]);
		expect(cache.boxes["general"]).toEqual(
			entry({ templateId: "tpl-1", templateVersion: "2026-10-25.23" }),
		);
		expect(cache.version).toBe(1);
	});

	it("tools 缺 inputSchema 时补空骨架，缺 name 的条目被跳过", () => {
		const fsImpl = new MemoryFileSystem();
		fsImpl.files.set(
			CACHE_FILE,
			JSON.stringify({
				version: 1,
				boxes: {
					general: {
						serverInfoVersion: BOX_VERSION,
						fetchedAt: new Date(NOW).toISOString(),
						tools: [{ description: "no name" }, { name: "click" }],
					},
				},
			}),
		);
		const cache = readCache(fsImpl.readText, CACHE_FILE);
		expect(cache.boxes["general"]?.tools).toEqual([
			{ name: "click", description: undefined, inputSchema: { type: "object", properties: {} } },
		]);
	});

	it("boxes 索引是空原型：`__proto__` 条目能读到、能写回，且不污染原型", () => {
		const fsImpl = new MemoryFileSystem();
		const protoEntry = entry({ serverInfoVersion: "proto" });
		fsImpl.files.set(
			CACHE_FILE,
			JSON.stringify({ version: 1, boxes: { ["__proto__"]: protoEntry, general: entry() } }),
		);
		const cache = readCache(fsImpl.readText, CACHE_FILE);
		expect(Object.getPrototypeOf(cache.boxes)).toBeNull();
		expect(Object.keys(cache.boxes).sort()).toEqual(["__proto__", "general"]);
		expect(cache.boxes["__proto__"]).toEqual(protoEntry);
		expect(Object.prototype).not.toHaveProperty("serverInfoVersion");

		expect(writeCache(fsImpl.writeText, CACHE_FILE, cache)).toBe(true);
		expect(readCache(fsImpl.readText, CACHE_FILE).boxes["__proto__"]).toEqual(protoEntry);
	});
});

describe("writeCache", () => {
	it("写入后可原样读回", () => {
		const fsImpl = new MemoryFileSystem();
		const cache = { version: 1 as const, boxes: { general: entry() } };
		expect(writeCache(fsImpl.writeText, CACHE_FILE, cache)).toBe(true);
		expect(fsImpl.writes).toHaveLength(1);
		expect(fsImpl.writes[0]?.file).toBe(CACHE_FILE);
		expect(readCache(fsImpl.readText, CACHE_FILE)).toEqual(cache);
	});

	it("写盘失败只 warn，不 throw，返回 false", () => {
		const fsImpl = new MemoryFileSystem();
		fsImpl.writeError = new Error("EACCES: permission denied");
		const warnings: string[] = [];
		expect(() =>
			writeCache(fsImpl.writeText, CACHE_FILE, createEmptyTemplateCache(), (message) => warnings.push(message)),
		).not.toThrow();
		expect(warnings).toHaveLength(1);
		expect(warnings[0]).toContain("template cache write failed");
		expect(warnings[0]).toContain("EACCES");
	});
});

describe("nodeTemplateFileSystem", () => {
	it("mkdir -p + 原子替换：不留临时文件，可覆盖旧内容", () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-instabox-template-"));
		const file = path.join(dir, "nested", "templates.json");
		try {
			const cache = { version: 1 as const, boxes: { general: entry() } };
			writeCache(nodeTemplateFileSystem.writeText, file, cache);
			expect(readCache(nodeTemplateFileSystem.readText, file)).toEqual(cache);
			expect(fs.readdirSync(path.dirname(file))).toEqual(["templates.json"]);

			const replaced = { version: 1 as const, boxes: { general: entry({ serverInfoVersion: "next" }) } };
			writeCache(nodeTemplateFileSystem.writeText, file, replaced);
			expect(readCache(nodeTemplateFileSystem.readText, file)).toEqual(replaced);
			expect(fs.readdirSync(path.dirname(file))).toEqual(["templates.json"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("读不存在的文件抛错（由 readCache 兜住）", () => {
		expect(() => nodeTemplateFileSystem.readText("/definitely/missing/templates.json")).toThrow();
	});
});

/** 装配好的 store + 可推进的注入时钟 + 记录面（`fs` / `warnings` / 工厂调用的 box）。 */
class StoreHarness {
	readonly fs = new MemoryFileSystem();
	readonly warnings: string[] = [];
	readonly store: TemplateStore;
	nowMs = NOW;
	private readonly harness: FactoryHarness;

	constructor(behaviour: FakeClientBehaviour | ((box: string) => FakeClientBehaviour) = {}, ttlMs?: number) {
		this.harness = makeFactory(behaviour);
		this.store = createTemplateStore({
			paths: { templateCacheFile: CACHE_FILE },
			clientFactory: this.harness.factory,
			fs: this.fs,
			clock: () => this.nowMs,
			...(ttlMs === undefined ? {} : { ttlMs }),
			warn: (message) => this.warnings.push(message),
		});
	}

	get boxes(): string[] {
		return this.harness.boxes;
	}

	get clients(): FakeRemoteClient[] {
		return this.harness.clients;
	}

	get factoryOptions(): (TemplateClientOptions | undefined)[] {
		return this.harness.options;
	}

	advance(ms: number): void {
		this.nowMs += ms;
	}
}

describe("createTemplateStore — 命中与过期", () => {
	it("磁盘上有未过期缓存且握手版本相同 → 直接命中，只握手不 listTools", async () => {
		const harness = new StoreHarness();
		seedDisk(harness.fs, { general: entry() });
		const result = await harness.store.ensure("general");
		expect(result).toEqual({ ok: true, template: entry(), refetched: false });
		expect(harness.boxes).toEqual(["general"]);
		expect(harness.clients[0]?.calls).toEqual(["initialize"]);
		expect(harness.fs.writes).toEqual([]);
	});

	it("get 惰性读盘（构造时不碰文件系统）", () => {
		const harness = new StoreHarness();
		seedDisk(harness.fs, { agent: entry({ serverInfoVersion: "other" }) });
		expect(harness.fs.reads).toEqual([]);
		expect(harness.store.get("agent")).toEqual(entry({ serverInfoVersion: "other" }));
		expect(harness.fs.reads).toEqual([CACHE_FILE]);
		expect(harness.store.get("nope")).toBeUndefined();
	});

	it("get 不把 `Object.prototype` 上的成员当命中", () => {
		const harness = new StoreHarness();
		seedDisk(harness.fs, { general: entry() });
		expect(harness.store.get("constructor")).toBeUndefined();
		expect(harness.store.get("toString")).toBeUndefined();
		expect(harness.store.get("hasOwnProperty")).toBeUndefined();
		expect(harness.store.get("general")).toEqual(entry());
	});

	it("get 能读到 `__proto__` 条目（空原型索引 + hasOwn）", () => {
		const harness = new StoreHarness();
		const protoEntry = entry({ serverInfoVersion: "proto" });
		seedDisk(harness.fs, { ["__proto__"]: protoEntry });
		expect(harness.store.get("__proto__")).toEqual(protoEntry);
	});

	it("无缓存时拉一次远端并写盘，fetchedAt 用注入时钟", async () => {
		const harness = new StoreHarness();
		const result = await harness.store.ensure("general");
		expect(result).toMatchObject({ ok: true, refetched: true });
		const template = result.ok ? result.template : undefined;
		expect(template?.serverInfoVersion).toBe(BOX_VERSION);
		expect(template?.fetchedAt).toBe(new Date(NOW).toISOString());
		expect(template?.tools).toEqual([LIST_APPS, SCREENSHOT]);
		expect(harness.store.get("general")).toEqual(template);
		expect(harness.fs.writes).toHaveLength(1);
		expect(readCache(harness.fs.readText, CACHE_FILE).boxes["general"]).toEqual(template);
	});

	it("过期缓存重拉，并用新 tools 覆盖旧条目", async () => {
		const harness = new StoreHarness();
		seedDisk(harness.fs, { general: entry({ fetchedAt: new Date(NOW - DEFAULT_TEMPLATE_TTL_MS).toISOString() }) });
		const result = await harness.store.ensure("general", { serverVersion: BOX_VERSION });
		expect(result.ok).toBe(true);
		expect(result.ok && result.refetched).toBe(true);
		expect(harness.boxes).toEqual(["general"]);
		expect(harness.store.get("general")?.tools).toEqual([LIST_APPS, SCREENSHOT]);
		expect(harness.store.get("general")?.fetchedAt).toBe(new Date(NOW).toISOString());
	});

	it("时钟推进超过 TTL 后再 ensure → 重拉", async () => {
		const harness = new StoreHarness();
		const first = await harness.store.ensure("general");
		expect(first.ok && first.refetched).toBe(true);
		harness.advance(DEFAULT_TEMPLATE_TTL_MS);
		const second = await harness.store.ensure("general");
		expect(second.ok && second.refetched).toBe(true);
		expect(harness.boxes).toEqual(["general", "general"]);
	});

	it("未过期但调用方已知版本不同 → 重拉", async () => {
		const harness = new StoreHarness();
		seedDisk(harness.fs, { general: entry({ serverInfoVersion: "0.3.5-instabox.1" }) });
		const result = await harness.store.ensure("general", { serverVersion: BOX_VERSION });
		expect(result.ok && result.refetched).toBe(true);
		expect(harness.store.get("general")?.serverInfoVersion).toBe(BOX_VERSION);
	});

	it("重拉保留磁盘上的诊断字段（templateId/templateVersion）", async () => {
		const harness = new StoreHarness();
		seedDisk(harness.fs, {
			general: entry({
				templateId: "tpl-1",
				templateVersion: "2026-10-25.23",
				fetchedAt: new Date(NOW - DEFAULT_TEMPLATE_TTL_MS * 2).toISOString(),
			}),
		});
		await harness.store.ensure("general");
		expect(harness.store.get("general")).toMatchObject({
			templateId: "tpl-1",
			templateVersion: "2026-10-25.23",
			serverInfoVersion: BOX_VERSION,
		});
	});

	it("入参 templateId/templateVersion 优先于旧缓存值", async () => {
		const harness = new StoreHarness();
		seedDisk(harness.fs, {
			general: entry({
				templateId: "tpl-old",
				templateVersion: "2026-01-01.0",
				fetchedAt: new Date(NOW - DEFAULT_TEMPLATE_TTL_MS * 2).toISOString(),
			}),
		});
		const result = await harness.store.ensure("general", { templateId: "tpl-new", templateVersion: "2026-10-25.23" });
		expect(result.ok && result.template).toMatchObject({ templateId: "tpl-new", templateVersion: "2026-10-25.23" });
		expect(harness.store.get("general")).toMatchObject({ templateId: "tpl-new", templateVersion: "2026-10-25.23" });
		expect(readCache(harness.fs.readText, CACHE_FILE).boxes["general"]).toMatchObject({
			templateId: "tpl-new",
			templateVersion: "2026-10-25.23",
		});
	});

	it("只给 templateId 时 templateVersion 仍继承旧缓存值", async () => {
		const harness = new StoreHarness();
		seedDisk(harness.fs, {
			general: entry({
				templateId: "tpl-old",
				templateVersion: "2026-01-01.0",
				fetchedAt: new Date(NOW - DEFAULT_TEMPLATE_TTL_MS * 2).toISOString(),
			}),
		});
		await harness.store.ensure("general", { templateId: "tpl-new" });
		expect(harness.store.get("general")).toMatchObject({
			templateId: "tpl-new",
			templateVersion: "2026-01-01.0",
		});
	});

	it("新旧都没有诊断字段时不凭空造出来", async () => {
		const harness = new StoreHarness();
		await harness.store.ensure("general");
		expect(harness.store.get("general")?.templateId).toBeUndefined();
		expect(harness.store.get("general")?.templateVersion).toBeUndefined();
	});

	it("远端不报 serverInfo.version 时记空串（只靠 TTL 刷新）", async () => {
		const harness = new StoreHarness({ initializeResult: {} });
		const result = await harness.store.ensure("general");
		expect(result.ok && result.template.serverInfoVersion).toBe("");
	});
});

describe("createTemplateStore — per-box 隔离", () => {
	it("两箱版本不同，各自命中、互不失效", async () => {
		const harness = new StoreHarness((box) => ({
			initializeResult: { serverInfo: { version: box === "general" ? "0.3.6" : "0.3.8" } },
			tools: box === "general" ? [LIST_APPS] : [SCREENSHOT],
		}));
		const first = await harness.store.ensure("general", { serverVersion: "0.3.6" });
		const second = await harness.store.ensure("agent", { serverVersion: "0.3.8" });
		expect(first.ok && first.refetched).toBe(true);
		expect(second.ok && second.refetched).toBe(true);
		expect(harness.boxes).toEqual(["general", "agent"]);

		// 各自的版本号各自命中：另一个箱的版本不会让这一箱失效
		const againGeneral = await harness.store.ensure("general", { serverVersion: "0.3.6" });
		const againAgent = await harness.store.ensure("agent", { serverVersion: "0.3.8" });
		expect(againGeneral.ok && againGeneral.refetched).toBe(false);
		expect(againAgent.ok && againAgent.refetched).toBe(false);
		// 命中路径仍各握手一次（版本校验），但都不再 listTools
		expect(harness.boxes).toEqual(["general", "agent", "general", "agent"]);
		expect(harness.clients[0]?.calls).toEqual(["initialize", "listTools"]);
		expect(harness.clients[1]?.calls).toEqual(["initialize", "listTools"]);
		expect(harness.clients[2]?.calls).toEqual(["initialize"]);
		expect(harness.clients[3]?.calls).toEqual(["initialize"]);
		expect(harness.store.get("general")?.tools).toEqual([LIST_APPS]);
		expect(harness.store.get("agent")?.tools).toEqual([SCREENSHOT]);
		expect(Object.keys(readCache(harness.fs.readText, CACHE_FILE).boxes).sort()).toEqual(["agent", "general"]);
	});
});

describe("createTemplateStore — 版本校验来自握手", () => {
	it("第二次 ensure 不传参：握手版本相同 → 命中且不调用 listTools", async () => {
		const harness = new StoreHarness();
		const first = await harness.store.ensure("general");
		expect(first.ok && first.refetched).toBe(true);
		expect(harness.clients[0]?.calls).toEqual(["initialize", "listTools"]);
		const cached = harness.store.get("general");
		const writesAfterFirst = harness.fs.writes.length;

		const second = await harness.store.ensure("general");
		expect(second.ok && second.refetched).toBe(false);
		expect(second.ok && second.template).toBe(cached);
		expect(harness.clients[1]?.calls).toEqual(["initialize"]);
		expect(harness.fs.writes).toHaveLength(writesAfterFirst);
	});

	it("远端升版（握手版本 ≠ 缓存版本）→ 未过期也重拉并更新缓存", async () => {
		let remoteVersion = BOX_VERSION;
		const harness = new StoreHarness(() => ({
			initializeResult: { serverInfo: { version: remoteVersion } },
			tools: remoteVersion === BOX_VERSION ? [LIST_APPS] : [LIST_APPS, SCREENSHOT],
		}));
		const first = await harness.store.ensure("general");
		expect(first.ok && first.refetched).toBe(true);
		expect(harness.store.get("general")?.tools).toEqual([LIST_APPS]);

		remoteVersion = "0.3.7-instabox.1";
		const second = await harness.store.ensure("general");
		expect(second.ok && second.refetched).toBe(true);
		expect(harness.clients[1]?.calls).toEqual(["initialize", "listTools"]);
		expect(harness.store.get("general")).toMatchObject({
			serverInfoVersion: "0.3.7-instabox.1",
			tools: [LIST_APPS, SCREENSHOT],
		});
		expect(readCache(harness.fs.readText, CACHE_FILE).boxes["general"]).toMatchObject({
			serverInfoVersion: "0.3.7-instabox.1",
			tools: [LIST_APPS, SCREENSHOT],
		});
	});

	it("显式 serverVersion 优先于握手值：显式相同即命中", async () => {
		const harness = new StoreHarness({ initializeResult: { serverInfo: { version: "0.3.9-instabox.1" } } });
		seedDisk(harness.fs, { general: entry() });
		const result = await harness.store.ensure("general", { serverVersion: BOX_VERSION });
		expect(result.ok && result.refetched).toBe(false);
		expect(harness.clients[0]?.calls).toEqual(["initialize"]);
		expect(harness.store.get("general")).toEqual(entry());
	});

	it("显式 serverVersion 优先于握手值：显式不同即重拉，缓存里记的仍是握手版本", async () => {
		const harness = new StoreHarness();
		seedDisk(harness.fs, { general: entry() });
		const result = await harness.store.ensure("general", { serverVersion: "9.9.9" });
		expect(result.ok && result.refetched).toBe(true);
		expect(harness.clients[0]?.calls).toEqual(["initialize", "listTools"]);
		expect(harness.store.get("general")?.serverInfoVersion).toBe(BOX_VERSION);
	});

	it("未过期缓存 + 握手失败 → ok:false + stale，内存与磁盘都不变", async () => {
		const harness = new StoreHarness({ initializeError: new Error("remote process closed (code=255)") });
		seedDisk(harness.fs, { general: entry() });
		const result = await harness.store.ensure("general");
		expect(result).toEqual({
			ok: false,
			error: expect.stringContaining("failed to fetch remote template for general"),
			stale: entry(),
		});
		expect(harness.store.get("general")).toEqual(entry());
		expect(harness.fs.writes).toEqual([]);
	});
});

describe("createTemplateStore — allowWake 透传", () => {
	it("allowWake: true → 工厂收到 { allowWake: true }", async () => {
		const harness = new StoreHarness();
		await harness.store.ensure("general", { allowWake: true });
		expect(harness.factoryOptions).toEqual([{ allowWake: true }]);
	});

	it("allowWake: false → 工厂收到 { allowWake: false }", async () => {
		const harness = new StoreHarness();
		await harness.store.ensure("general", { allowWake: false });
		expect(harness.factoryOptions).toEqual([{ allowWake: false }]);
	});

	it("不传 allowWake → 工厂第二参为 undefined（由工厂走默认策略）", async () => {
		const harness = new StoreHarness();
		await harness.store.ensure("general");
		await harness.store.ensure("general", { allowWake: undefined });
		expect(harness.factoryOptions).toEqual([undefined, undefined]);
	});

	it("命中路径同样透传：版本相同也把 allowWake 交给工厂", async () => {
		const harness = new StoreHarness();
		seedDisk(harness.fs, { general: entry() });
		const result = await harness.store.ensure("general", { allowWake: false });
		expect(result.ok && result.refetched).toBe(false);
		expect(harness.factoryOptions).toEqual([{ allowWake: false }]);
		expect(harness.clients[0]?.calls).toEqual(["initialize"]);
	});

	it("每箱每次 ensure 一次工厂调用（不缓存客户端，也不复用上次的 allowWake）", async () => {
		const harness = new StoreHarness();
		await harness.store.ensure("general", { allowWake: false });
		await harness.store.ensure("general", { allowWake: true });
		expect(harness.factoryOptions).toEqual([{ allowWake: false }, { allowWake: true }]);
	});

	it("旧实现（只接 box 一个参数）仍可赋值，且照常工作", async () => {
		const legacy: TemplateClientFactory = (box) => {
			expect(box).toBe("general");
			return new FakeRemoteClient();
		};
		const store = createTemplateStore({
			paths: { templateCacheFile: CACHE_FILE },
			clientFactory: legacy,
			fs: new MemoryFileSystem(),
			clock: () => NOW,
		});
		const result = await store.ensure("general", { allowWake: true });
		expect(result.ok && result.refetched).toBe(true);
		expect(result.ok && result.template.tools).toEqual([LIST_APPS, SCREENSHOT]);
	});

	it("allowWake: false + 握手失败 → 仍返回 ok:false 与 stale（现状不变）", async () => {
		const harness = new StoreHarness({ initializeError: new Error("box is not running") });
		const cached = entry();
		seedDisk(harness.fs, { general: cached });
		const result = await harness.store.ensure("general", { allowWake: false });
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.stale).toEqual(cached);
		expect(harness.factoryOptions).toEqual([{ allowWake: false }]);
		expect(harness.fs.writes).toEqual([]);
	});
});

describe("createTemplateStore — 失败降级", () => {
	it("initialize 失败：返回 ok:false，保留旧缓存且不写盘", async () => {
		const harness = new StoreHarness({ initializeError: new Error("remote process closed (code=255)") });
		const stale = entry({ fetchedAt: new Date(NOW - DEFAULT_TEMPLATE_TTL_MS * 2).toISOString() });
		seedDisk(harness.fs, { general: stale });
		const result = await harness.store.ensure("general");
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("failed to fetch remote template for general");
		expect(result.ok === false && result.error).toContain("code=255");
		expect(harness.store.get("general")).toEqual(stale);
		expect(harness.fs.writes).toEqual([]);
		expect(readCache(harness.fs.readText, CACHE_FILE).boxes["general"]).toEqual(stale);
		expect(harness.warnings).toHaveLength(1);
	});

	it("listTools 失败：同样保留旧缓存", async () => {
		const harness = new StoreHarness({ listToolsError: new Error("tools/list timed out after 20000ms") });
		const stale = entry({ fetchedAt: new Date(NOW - DEFAULT_TEMPLATE_TTL_MS * 2).toISOString() });
		seedDisk(harness.fs, { general: stale });
		const result = await harness.store.ensure("general", { serverVersion: "0.9.9" });
		expect(result.ok).toBe(false);
		expect(harness.store.get("general")).toEqual(stale);
		expect(harness.fs.writes).toEqual([]);
	});

	it("失败结果带 stale：旧缓存随 `ok:false` 一起返回", async () => {
		const harness = new StoreHarness({ initializeError: new Error("remote process closed (code=255)") });
		const stale = entry({ fetchedAt: new Date(NOW - DEFAULT_TEMPLATE_TTL_MS * 2).toISOString() });
		seedDisk(harness.fs, { general: stale });
		const result = await harness.store.ensure("general");
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.stale).toEqual(stale);
	});

	it("无旧缓存时失败结果不带 stale 键", async () => {
		const harness = new StoreHarness({ initializeError: new Error("boom") });
		const result = await harness.store.ensure("general");
		expect(result.ok).toBe(false);
		expect(result).not.toHaveProperty("stale");
	});

	it("写盘失败：本次仍返回新缓存，只 warn", async () => {
		const harness = new StoreHarness();
		harness.fs.writeError = new Error("EROFS: read-only file system");
		const result = await harness.store.ensure("general");
		expect(result.ok).toBe(true);
		expect(result.ok && result.refetched).toBe(true);
		expect(harness.store.get("general")?.tools).toEqual([LIST_APPS, SCREENSHOT]);
		expect(harness.warnings).toHaveLength(1);
		expect(harness.warnings[0]).toContain("template cache write failed");
		expect(harness.fs.files.has(CACHE_FILE)).toBe(false);
	});
});

describe("createTemplateStore — 不唤醒、可取消", () => {
	it("拉取只走 initialize + listTools：不 tools/call、不 close、不碰唤醒链", async () => {
		const harness = new StoreHarness();
		const result = await harness.store.ensure("general");
		expect(result.ok).toBe(true);
		expect(harness.boxes).toEqual(["general"]);
		expect(harness.clients).toHaveLength(1);
		expect(harness.clients[0]?.calls).toEqual(["initialize", "listTools"]);
	});

	it("signal 透传给 tools/list", async () => {
		const harness = new StoreHarness();
		const controller = new AbortController();
		await harness.store.ensure("general", { signal: controller.signal });
		expect(harness.clients[0]?.listToolsSignals).toEqual([controller.signal]);
	});

	it("进入拉取前已 abort：直接失败，不建 client", async () => {
		const harness = new StoreHarness();
		const controller = new AbortController();
		controller.abort();
		const result = await harness.store.ensure("general", { signal: controller.signal });
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.error).toContain("aborted");
		expect(harness.boxes).toEqual([]);
	});

	it("握手期间 abort：失败且不写盘", async () => {
		const controller = new AbortController();
		const harness = new StoreHarness({ beforeInitializeResolve: () => controller.abort() });
		const result = await harness.store.ensure("general", { signal: controller.signal });
		expect(result.ok).toBe(false);
		expect(result).not.toHaveProperty("stale");
		expect(harness.fs.writes).toEqual([]);
		expect(harness.store.get("general")).toBeUndefined();
	});

	it("abort 失败同样带出旧缓存（stale）", async () => {
		const controller = new AbortController();
		const harness = new StoreHarness({ beforeInitializeResolve: () => controller.abort() });
		const stale = entry({ fetchedAt: new Date(NOW - DEFAULT_TEMPLATE_TTL_MS * 2).toISOString() });
		seedDisk(harness.fs, { general: stale });
		const result = await harness.store.ensure("general", { signal: controller.signal });
		expect(result.ok).toBe(false);
		expect(result.ok === false && result.stale).toEqual(stale);
		expect(harness.store.get("general")).toEqual(stale);
	});
});

describe("埋点：template.hit / template.refetch / template.fail", () => {
	it("命中、重拉、失败各落一条事件（级别与字段按契约）", async () => {
		const logger = createMemoryLogger();
		const hit = new StoreHarness();
		seedDisk(hit.fs, { general: entry() });
		const refetch = new StoreHarness();
		const failing = new StoreHarness({ initializeError: new Error("remote process closed (code=255)") });
		seedDisk(failing.fs, { general: entry() });

		setLogger(logger);
		try {
			await hit.store.ensure("general");
			await refetch.store.ensure("general");
			await failing.store.ensure("general");
		} finally {
			setLogger(undefined);
		}

		const hits = logger.records.filter((record) => record.event === "template.hit");
		expect(hits).toHaveLength(1);
		expect(hits[0]?.level).toBe("debug");
		expect(hits[0]?.fields).toEqual({ box: "general", serverInfoVersion: BOX_VERSION, stale: false });

		const refetches = logger.records.filter((record) => record.event === "template.refetch");
		expect(refetches).toHaveLength(1);
		expect(refetches[0]?.level).toBe("info");
		expect(refetches[0]?.fields).toMatchObject({ box: "general", reason: "no-cache", tools: 2 });
		expect(typeof refetches[0]?.fields?.["ms"]).toBe("number");

		// 握手失败：warn 级，`stale: true` 说明降级还有旧缓存可用（调用方仍拿到 stale）
		const failures = logger.records.filter((record) => record.event === "template.fail");
		expect(failures).toHaveLength(1);
		expect(failures[0]?.level).toBe("warn");
		expect(failures[0]?.fields).toMatchObject({ box: "general", stale: true });
		expect(String(failures[0]?.fields?.["error"])).toContain("remote process closed");
	});
});
