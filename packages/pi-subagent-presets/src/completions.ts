/** 选项 value 的补全：pi 用 `value` 整体替换参数前缀，所以必须带 `--from`。 */
export interface CompletionItem {
	value: string;
	label: string;
}

/**
 * `--from` 的补全项。
 *
 * ⚠️ `value` 必须是完整的 `--from <name>`：pi 会用 `value` **整体替换参数前缀**
 * （`--from` 那一段）。只回 profile 名会把命令行变成 `/subagent-presets default`
 * ⇒ `--from` 丢失 ⇒ 静默退化成纯命令（用户以为加载了模板，其实没有）。
 */
export function buildCompletions(prefix: string, names: readonly string[]): CompletionItem[] | null {
	if (!prefix.startsWith("--from")) return null;
	const usesEquals = prefix.startsWith("--from=");
	const lead = usesEquals ? "--from=" : "--from ";
	const typed = usesEquals ? prefix.slice("--from=".length) : "";
	return names.filter((name) => name.startsWith(typed)).map((name) => ({ value: `${lead}${name}`, label: name }));
}
