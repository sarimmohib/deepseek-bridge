# Rules

Rules are short, model-facing instructions that the bridge prepends to every
request it forwards. They are the bridge's way of documenting the mistakes that
DeepSeek keeps making against this adapter, so the model is told about them
before it answers again. The store lives at
`~/.config/deepseek-bridge/rules.json` (`0600`, override with
`DS_BRIDGE_RULES_FILE`); the defaults below ship in `src/rules.js`.

## How rules are injected

The bridge prepends its own system message before the harness's own system
message (nothing is deduped or rewritten). With `systemRules` on (the default),
that message is `<preset>\n\n# Rules\n...`, capped at 2,400 characters. The
conversation key is computed from the harness messages *before* the bridge
message is added, so editing a rule never resets a stored conversation.

```jsonc
// ~/.config/deepseek-bridge/config.json
{
  "systemPrompt": "",          // exact text; wins over the preset
  "systemPreset": "dsh-agent", // dsh-agent | dsh-plan | dsh-tool | none
  "systemRules": true           // append the Rules section
}
```

## Sources

| Source | How it gets there | Notes |
| --- | --- | --- |
| `builtin` | Seeded from `src/rules.js` on first read | Deleting one is respected; it is not re-seeded |
| `user` | `deepseek rules add "..."` or the dashboard | 320 chars max, 24 rules total |
| `learned` | Recorded automatically when the bridge recovers from a repeatable failure | Deduped with a seen count; least-seen evicted past 12 |

## Builtin rules

These six ship with the bridge. Each one exists because the corresponding
failure has actually been observed against the web chat endpoint.

### Tool format

- A tool call is exactly one fenced block: a line with three backticks and the
  word `tool_call`, then a JSON array of `{"name", "arguments"}` objects, then a
  closing fence. No prose inside the block.
- Put every parallel call in the same JSON array. Do not emit one fenced block
  per call, and do not wrap the array in extra markup.
- Never emit partial or empty markup: no bare DSML/XML tags, no `calls` wrapper
  without an `invoke`, no truncated JSON. Every call must carry a name and
  complete arguments.

### Tool results

- After a tool result, either call the next tool or answer. Never echo,
  summarize, or invent a tool result as if you produced it.

### Edits

- When you edit a file, produce the complete new content. Do not abbreviate with
  ellipses or "unchanged" placeholders unless the tool itself takes a patch.

### Verify

- Verify a change with the project's own tests, build, or a direct check before
  claiming it works. Do not state that a command passed unless it ran.

## Learned rules

The bridge records a learned rule whenever it has to recover from one of these
repeatable failures. The rule is then present in the prompt for the next turn.

| Trigger | What the model is told |
| --- | --- |
| Tool markup arrived but contained no complete call, so it was stripped | Emit only complete `tool_call` blocks with a name and full arguments |
| A wall of empty DSML tags (the session was dropped and replayed) | Never emit empty DSML/XML tags; answer in prose or make one complete call |
| The turn produced no usable output | Always return a short answer or one complete tool call — never an empty turn |

## Commands

```bash
deepseek rules                        # table: id, source, seen count, text
deepseek rules --json                 # machine-readable, includes the preset
deepseek rules add "Always run the tests" --category verify
deepseek rules remove <id>
deepseek rules clear-learned          # drop learned, keep builtin/user
```

## API

All routes require the bridge API key, like the other `/v1/bridge/*` routes.

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/v1/bridge/rules` | Active preset, whether rules are on, and every rule |
| `POST` | `/v1/bridge/rules` | Add a user rule: `{"text": "...", "category": "..."}` |
| `DELETE` | `/v1/bridge/rules/:id` | Remove one rule (builtin included) |
| `DELETE` | `/v1/bridge/rules?learned=1` | Drop every learned rule |

## Design constraints

- Rules are prompt text, not enforcement. The parser (`src/prompt.js`) is the
  real guard; rules only reduce how often it has to fire.
- Keep every rule short and imperative. The section is bounded at 2,400
  characters, so a long rule evicts the others.
- Learned rules never evict user or builtin rules.
- A rule edit applies on the next request; the config and the store are re-read
  per request.
