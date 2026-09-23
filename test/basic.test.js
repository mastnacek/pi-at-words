import test from "node:test";
import assert from "node:assert/strict";

test("word extraction regex logic", () => {
	const text = "function extractMentionedPaths(lines, cwd) { return lines; }";
	const matches = [...text.matchAll(/[A-Za-z_][A-Za-z0-9_]{2,}/g)].map(m => m[0]);
	assert.ok(matches.includes("extractMentionedPaths"));
	assert.ok(matches.includes("function"));
	assert.ok(matches.includes("lines"));
});
