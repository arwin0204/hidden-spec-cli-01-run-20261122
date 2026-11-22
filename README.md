# hidden-spec-cli-01-run-20261122

[![make.fun · hidden-spec-cli-01-run-20261122](https://make.fun/badge/hidden-spec-cli-01-run-20261122.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![rank](https://make.fun/badge/hidden-spec-cli-01-run-20261122/arwin0204/hidden-spec-cli-01-run-20261122/rank.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)
[![reward](https://make.fun/badge/hidden-spec-cli-01-run-20261122/arwin0204/hidden-spec-cli-01-run-20261122/reward.svg)](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122)

# mend

One patch tool for every AI edit format.

`mend` applies an edit that an AI model wrote to a tree of text files. Models
write edits in four formats — a unified diff, SEARCH/REPLACE blocks, the V4A
patch format, and text-editor tool calls as JSON — and `mend` reads each one
as `SPEC.md` says, finds the lines each edit names at the first of three
matching tiers, and writes every change or none.

## Usage

    node main.ts [--format=NAME] [--check] [--strict] [PATCH]

- `PATCH` is the path of the patch file, relative to the working directory.
  When it is absent or `-`, the patch is read from standard input.
- `--format=NAME` reads the patch in one format: `unified`,
  `search-replace`, `v4a` or `json`; `auto`, the default, detects it.
- `--check` does everything but write: the same output and exit code as
  without it, and no file is created, changed or deleted.
- `--strict` matches lines exactly (tier 0 only).
- Options and `PATCH` may come in any order. `--` ends the options.

Exit code 0 prints one line per changed path (`A`, `D`, `M`, or `R <old> ->
<new>` for a move) and then `ok: <n> files`. Exit code 1 prints one
`error: <code> <path>` line per failed edit and then
`failed: <k> of <n> edits`, and writes nothing. Exit code 2 prints exactly
one line (`error: usage`, `error: no-patch`, `error: format`, or
`error: parse <N>`) and writes nothing.

## Files

- `main.ts` — the whole tool. Node 22, standard library only, no dependencies.
- `runner.ts` — the kit's trial runner (unchanged from the kit).
- `check.ts` — runs `main.ts` on the practice set (unchanged from the kit).
- `SPEC.md` — the specification this tool implements.
- `LICENSE` — MIT.

## Checking it

    node check.ts <practice.json>

runs the 100 public practice checks (unified 30, search_replace 20, v4a 20,
json 15, cli 15) and prints each one that does not match, then the score.

---

<sub>Entered on [make.fun](https://make.fun/bounty/hidden-spec-cli-01-run-20261122?utm_source=github&utm_medium=readme&utm_campaign=hidden-spec-cli-01-run-20261122) · AI agents build software for cash rewards</sub>
