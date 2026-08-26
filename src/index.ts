// pi-at-words — word/symbol autocomplete from files mentioned with @ in the editor.
// Type `?foo` (min 2 chars) after attaching files with @ to get fuzzy word
// suggestions from those files. Confirmed words glow pink in the input field.
// Delegates everything else (paths, slash commands) to the built-in provider.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { CustomEditor } from "@earendil-works/pi-coding-agent";
import {
	type AutocompleteProvider,
	type AutocompleteItem,
	fuzzyFilter,
} from "@earendil-works/pi-tui";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute, join } from "node:path";

const MAX_FILE_BYTES = 512 * 1024; // skip files > 512 KB
const MAX_WORDS = 5000;
const MAX_SUGGESTIONS = 20;

// --- @ mention parsing -----------------------------------------------------

/** Extract @-mention file paths from the whole editor buffer (quoted and bare forms). */
function extractMentionedPaths(lines: string[], cwd: string): string[] {
	const paths: string[] = [];
	const mention = /@"([^"\n]+)"|@([^\s"(){}[\],;:!?]+)/g;
	for (const line of lines) {
		for (const m of line.matchAll(mention)) {
			const raw = m[1] ?? m[2];
			if (!raw) continue;
			// Ignore when still typing the token at the end of a line? No —
			// partial mentions still resolve as prefixes; keep as-is, missing files are skipped.
			paths.push(isAbsolute(raw) ? raw : join(cwd, raw));
		}
	}
	return [...new Set(paths)];
}

// --- word index with mtime cache --------------------------------------------

type WordEntry = { word: string; count: number; file: string };

const wordCache = new Map<string, { mtimeMs: number; words: WordEntry[] }>();

function tokenize(text: string, file: string): Map<string, number> {
	const counts = new Map<string, number>();
	for (const m of text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)) {
		const w = m[0];
		counts.set(w, (counts.get(w) ?? 0) + 1);
	}
	return counts;
}

async function loadWords(
	absPath: string,
	signal: AbortSignal,
): Promise<WordEntry[]> {
	let mtimeMs: number;
	try {
		const st = await stat(absPath);
		mtimeMs = st.mtimeMs;
	} catch {
		return []; // file gone / not yet a valid path
	}

	const cached = wordCache.get(absPath);
	if (cached && cached.mtimeMs === mtimeMs) return cached.words;

	let text: string;
	try {
		const handle = await stat(absPath);
		if (handle.size > MAX_FILE_BYTES) return [];
		text = await readFile(absPath, "utf8");
	} catch {
		return [];
	}
	if (signal.aborted) return [];

	const counts = tokenize(text, absPath);
	const words: WordEntry[] = [...counts.entries()]
		.sort((a, b) => b[1] - a[1]) // most frequent first
		.slice(0, MAX_WORDS)
		.map(([word, count]) => ({ word, count, file: absPath }));

	wordCache.set(absPath, { mtimeMs, words });
	return words;
}

// --- completed-word highlight ("eldritch glow" ≈ bold neon pink) ----------------

const MAX_HIGHLIGHT_WORDS = 100;
const highlightWords = new Set<string>();
let highlightVersion = 0;
let highlightRe: RegExp | null = null;
let builtVersion = -1;

/** Eldritch pink: bold + truecolor #ff5fd7. Terminals can't glow; this is the rite. */
const PINK = "\x1b[1m\x1b[38;2;255;95;215m";
const PINK_OFF = "\x1b[22m\x1b[39m";
/** Signal green for @-mentions: bold + truecolor #00ff66. */
const GREEN = "\x1b[1m\x1b[38;2;0;255;102m";
const GREEN_OFF = "\x1b[22m\x1b[39m";

/** Entry used to persist recorded words across restarts (display-only). */
const WORDS_ENTRY_TYPE = "at-words:words";

function buildHighlightRe(): RegExp {
	if (highlightRe === null || builtVersion !== highlightVersion) {
		// Longest first so overlapping identifiers style as one unit.
		const alts = [...highlightWords]
			.sort((a, b) => b.length - a.length)
			.join("|");
		highlightRe = new RegExp(`(?<![A-Za-z0-9_])(?:${alts})(?![A-Za-z0-9_])`, "g");
		builtVersion = highlightVersion;
	}
	return highlightRe;
}

/** @-mention paths (`@src/foo.ts`, `@"quoted path"`) — greened wherever they render. */
const MENTION_SRC = String.raw`@"[^"\n]+"|@[\w][\w./-]*`;

/** Style recorded words (pink) + @-mentions (green) in any plain text. */
export function styleText(text: string): string {
	if (highlightWords.size === 0 && !text.includes("@")) return text;
	// Single combined pass: a word match inside a styled path can never corrupt
	// the mention's color span (no nesting). Mentions start with @, words never do.
	const wordAlts = [...highlightWords]
		.sort((a, b) => b.length - a.length)
		.join("|");
	const wordPart = highlightWords.size
		? `|(?<![A-Za-z0-9_])(?:${wordAlts})(?![A-Za-z0-9_])`
		: "";
	const re = new RegExp(`(?:${MENTION_SRC})${wordPart}`, "g");
	return text.replace(re, (m) =>
		m.startsWith("@") ? `${GREEN}${m}${GREEN_OFF}` : `${PINK}${m}${PINK_OFF}`,
	);
}

function recordHighlight(pi: ExtensionAPI, word: string): void {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(word)) return;
	if (highlightWords.has(word)) return;
	highlightWords.add(word);
	if (highlightWords.size > MAX_HIGHLIGHT_WORDS) {
		const first = highlightWords.values().next().value;
		if (first !== undefined) highlightWords.delete(first);
	}
	highlightVersion++;
	// Persist for restarts and broadcast for other extensions (e.g. translate plugins).
	pi.appendEntry(WORDS_ENTRY_TYPE, { words: [...highlightWords] });
	pi.events.emit("at-words:words-updated", { words: [...highlightWords] });
}

function highlightRenderedLines(lines: string[]): string[] {
	if (highlightWords.size === 0) return lines;
	const re = buildHighlightRe();
	return lines.map((line) => {
		// Skip borders / scroll indicators (─ runs) and letter-less lines.
		if (line.includes("─") || !/[A-Za-z]/.test(line)) return line;
		return line.replace(re, (m) => `${PINK}${m}${PINK_OFF}`);
	});
}

class EldritchEditor extends CustomEditor {
	override render(width: number): string[] {
		return highlightRenderedLines(super.render(width));
	}
}

// --- provider ----------------------------------------------------------------

/** `?query` trigger: boundary, `?`, then identifier chars (length checked separately). */
const MIN_QUERY_LEN = 2;
const QUERY_RE = /(?:^|[ \t([{])\?([A-Za-z0-9_]*)$/;

function displayName(absPath: string): string {
	return absPath.replace(/\\/g, "/").split("/").pop() ?? absPath;
}

function toItems(words: WordEntry[], query: string): AutocompleteItem[] {
	return fuzzyFilter(words, query, (w) => w.word)
		.slice(0, MAX_SUGGESTIONS)
		.map((w) => ({
			value: w.word,
			label: w.word,
			description: `${displayName(w.file)} (×${w.count})`,
		}));
}

export default function (pi: ExtensionAPI): void {
	// Safety net: strip `?` from unaccepted query tokens before they reach the model.
	// Only when an @-mention is in the same message (plugin-usage heuristic), so prose
	// questions ("is it? ok") and discussing the syntax itself stay intact.
	const ORPHAN_QUERY_RE = /\B\?([A-Za-z0-9_]{2,})\b/g;
	pi.on("input", (event) => {
		if (!event.text.includes("?") || !/@[\w."-]/.test(event.text)) return;
		const text = event.text.replace(ORPHAN_QUERY_RE, "$1");
		if (text !== event.text) return { action: "transform", text };
	});

	// Pink recorded words + @-mentions in transcript user messages (translated
	// messages included). Markdown transformers run for user text and restored
	// sessions, so highlights survive restarts once words are restored below.
	pi.registerMarkdownTransformer((markdown, { messageType, isStreaming }) => {
		if (isStreaming || messageType !== "user") return markdown;
		return styleText(markdown);
	});

	pi.on("session_start", (_event, ctx) => {
		// Restore persisted words (last entry wins) so highlights survive restarts.
		for (const entry of ctx.sessionManager.getEntries()) {
			if (entry.type === "custom" && entry.customType === WORDS_ENTRY_TYPE) {
				const data = entry.data as { words?: string[] } | undefined;
				if (Array.isArray(data?.words)) {
					highlightWords.clear();
					for (const w of data.words.slice(-MAX_HIGHLIGHT_WORDS)) {
						if (typeof w === "string") highlightWords.add(w);
					}
					highlightVersion++;
				}
			}
		}
		// Broadcast restored set so dependent extensions (e.g. translate) style too.
		if (highlightWords.size > 0) {
			pi.events.emit("at-words:words-updated", { words: [...highlightWords] });
		}

		ctx.ui.addAutocompleteProvider(
			(current: AutocompleteProvider): AutocompleteProvider => ({
				triggerCharacters: ["?"],
				async getSuggestions(lines, cursorLine, cursorCol, options) {
					const line = lines[cursorLine] ?? "";
					const beforeCursor = line.slice(0, cursorCol);
					const match = beforeCursor.match(QUERY_RE);
					if (!match) {
						return current.getSuggestions(lines, cursorLine, cursorCol, options);
					}

					const query = match[1] ?? "";
					if (query.length < MIN_QUERY_LEN) {
						// Not enough typed yet — fall through to built-in behavior.
						return current.getSuggestions(lines, cursorLine, cursorCol, options);
					}
					const paths = extractMentionedPaths(lines, ctx.cwd);
					if (paths.length === 0) {
						// No @ files in buffer yet — fall through to built-in behavior.
						return current.getSuggestions(lines, cursorLine, cursorCol, options);
					}

					const perFile = await Promise.all(
						paths.map((p) => loadWords(p, options.signal)),
					);
					if (options.signal.aborted) {
						return current.getSuggestions(lines, cursorLine, cursorCol, options);
					}

					// Merge across files: keep best count, prefer words from more files.
					const merged = new Map<string, WordEntry>();
					for (const words of perFile) {
						for (const w of words) {
							const prev = merged.get(w.word);
							if (!prev || w.count > prev.count) merged.set(w.word, w);
						}
					}
					const items = toItems([...merged.values()], query);
					if (items.length === 0) {
						return current.getSuggestions(lines, cursorLine, cursorCol, options);
					}

					return {
						items,
						prefix: `?${query}`,
					};
				},

				applyCompletion(lines, cursorLine, cursorCol, item, prefix) {
					// Our token accepted: remember the word so the editor glows it.
					if (prefix.startsWith("?")) recordHighlight(pi, item.value);
					// Replaces `?query` with the chosen word — placeholder disappears.
					return current.applyCompletion(lines, cursorLine, cursorCol, item, prefix);
				},

				shouldTriggerFileCompletion(lines, cursorLine, cursorCol) {
					return (
						current.shouldTriggerFileCompletion?.(lines, cursorLine, cursorCol) ??
						true
					);
				},
			}),
		);

		// Wrap the editor so confirmed words render in pink. Replace any earlier
		// wrap of ours (reload) instead of stacking; keep other extensions' factories.
		const existing = ctx.ui.getEditorComponent() as
			| ((...a: never[]) => unknown)
			| undefined;
		const base =
			(existing as { __atWordsBase?: typeof existing } | undefined)
				?.__atWordsBase ?? existing;
		const factory = (
			tui: ConstructorParameters<typeof CustomEditor>[0],
			theme: ConstructorParameters<typeof CustomEditor>[1],
			keybindings: ConstructorParameters<typeof CustomEditor>[2],
		) => new EldritchEditor(tui, theme, keybindings);
		(factory as { __atWordsBase?: typeof base }).__atWordsBase = base;
		ctx.ui.setEditorComponent(factory as never);
	});

	const AT_WORDS_DOCS: Record<string, string> = {
		status:
			"zobrazí počet zaindexovaných souborů, slov v cache a zvýrazněných slov",
		clear: "vymaže historii růžově svítících slov",
		help: "zobrazí podrobnou nápovědu a použití @file a ?symbol autocomplete",
	};

	const showAtWordsHelp = (ctx: {
		ui: { notify: (msg: string, type: "info" | "warning" | "error") => void };
	}) => {
		let totalCachedWords = 0;
		for (const entry of wordCache.values()) {
			totalCachedWords += entry.words.length;
		}
		ctx.ui.notify(
			[
				`pi-at-words — fuzzy doplňování slov/symbolů z připojených @souborů`,
				"Našeptává identifikátory a symboly ze souborů zmíněných přes @, potvrzená slova svítí růžově (eldritch pink).",
				"",
				"Použití:",
				"1. Připojte soubor v editoru: @src/index.ts",
				"2. Napište otazník a prefix slova (min 2 znaky): ?myFunc",
				"3. Vyberte z nabídky — slovo se vloží a v editoru i chatu svítí růžově",
				"",
				"Příkazy:",
				"/at-words               — tato nápověda + stav cache",
				"/at-words status        — zobrazí statistiky cache a zvýraznění",
				"/at-words clear         — vymaže uložená růžová slova",
				"",
				`Stav: cache=${wordCache.size} souborů (${totalCachedWords} slov) | zvýrazněno=${highlightWords.size} slov`,
			].join("\n"),
			"info",
		);
	};

	pi.registerCommand("at-words", {
		description:
			"pi-at-words: nápověda a správa doplňování symbolů ze souborů připojených přes @",
		getArgumentCompletions: (prefix: string) => {
			const tokens = prefix.split(/\s+/).filter(Boolean);
			const typed = (tokens[0] ?? "").toLowerCase();
			const items = Object.entries(AT_WORDS_DOCS)
				.filter(([key]) => key.startsWith(typed))
				.map(([value, description]) => ({ value, label: value, description }));
			return items.length > 0 ? items : null;
		},
		handler: async (args, ctx) => {
			const [subRaw] = args.trim().split(/\s+/).filter(Boolean);
			const sub = subRaw?.toLowerCase();
			if (!sub || sub === "help" || sub === "status") {
				showAtWordsHelp(ctx);
				return;
			}
			if (sub === "clear") {
				highlightWords.clear();
				highlightVersion++;
				pi.appendEntry(WORDS_ENTRY_TYPE, { words: [] });
				pi.events.emit("at-words:words-updated", { words: [] });
				ctx.ui.notify("Zvýrazněná slova byla vymazána", "info");
				return;
			}
			ctx.ui.notify(
				"Neznámý příkaz. Použijte: /at-words [status|clear|help]",
				"warning",
			);
		},
	});
}
