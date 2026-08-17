# pi-at-words

Word and symbol autocomplete from `@`-attached files, for the
[pi coding agent](https://github.com/earendil-works/pi-coding-agent).

Attach files with `@` as usual, then type `?` + at least 2 characters anywhere in
the prompt to get fuzzy word suggestions from the contents of those files.
Accepting a suggestion replaces the `?query` placeholder with the word and
highlights it in pink while it stays in the input field.

## Features

- **File-content completion** — pi's built-in `@` completes file *names*;
  `pi-at-words` completes identifiers *inside* the attached files.
- **Fuzzy matching** — `?getSugg` suggests `getSuggestions`, `get_suggestions`, …
- **Multi-file** — all `@`-mentions in the editor are indexed and merged;
  each suggestion shows its source file and frequency.
- **Safe placeholder handling** — an unaccepted `?word` never reaches the model
  with its question mark intact; the `?` is stripped on submit (only when an
  `@`-mention is present in the same message, so prose questions are untouched).
- **Pink glow** — confirmed words render bold in neon pink (`#ff5fd7`) in the
  input editor. Terminals can't glow; this is the closest ANSI rite.
- **Zero cost when idle** — file contents are read only when a valid `?query`
  is typed; results are cached by mtime.

## Install

```bash
pi install npm:pi-at-words
```

Or from GitHub:

```bash
pi install git:github.com/<your-user>/pi-at-words
```

Or add to `settings.json`:

```json
{
	"packages": ["npm:pi-at-words"]
}
```

## Usage

1. Attach one or more files with `@` (`@src/foo.ts`, `@"path with spaces/my file.dxl"`).
2. Type `?` + 2+ characters, e.g. `?getSugg`.
3. Pick a suggestion — the placeholder `?getSugg` is replaced by the word.
4. If you ignore the popup and submit anyway, the `?` is stripped before the
   text reaches the model.

Notes:

- Minimum query length, word caps, and highlight color are constants at the
  top of [`src/index.ts`](src/index.ts) (`MIN_QUERY_LEN`, `MAX_WORDS`,
  `PINK`).
- Indexing covers ASCII identifiers of 3+ characters; files larger than 512 KB
  are skipped.
- The `?` trigger requires a word boundary before it, so `foo?bar` never fires.

## License

MIT
