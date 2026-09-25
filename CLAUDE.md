# 🧬 Organism: software that grows itself

> Handoff doc for Claude Code sessions. Read this first.

## The goal

**We are not building Postman. We are building the thing that builds Postman.**

The deliverable is a real, usable Postman-class app, and it must *grow itself*. The system is closed, like a chicken and its egg:

```
F(genome, intent)  →  F′ + intent′  →  F″ + intent″  →  …
```

- `F` is the ribosome (kernel) plus a genome.
- The output of growth is a new genome, which is valid input to growth again.
- Cells compose: `cell a + cell b = cell ab`, and `ab` is itself a cell that can compose again.
- Postman is one intent along this path, not a special case.

## Repo layout

```
ribosome.ts           the kernel: generic interpreter + laws. No feature code, ever.
postman.genome.yaml   the seed DNA (the hand-written egg)
collection.yaml       an experience: variables, auth, mocks, steps (runs offline)
rehearsal.yaml        an experience where a mock plays the LLM, for offline mind tests
README.md             quick start for humans; ARCHITECTURE.md: full design
examples/
  hello/              hand-written starter (no LLM), the language in ~60 lines
  egg/                genes + mind only: grow any app from intents
  hub/                Zapier-like webhook hub the mind grew from egg/ (a second species)
.organism/            generated, gitignored:
  <exp>.lock.json       learned memory ("bones"), version, lineage
  genomes/*.yaml        genomes the organism grew (delete a file to undo it)
```

## Commands

```bash
npm run grow       # phenotype postman
npm run load       # phenotype load_tester (50 parallel calls per step)
npm run mock       # phenotype mock_server (keeps serving)
npm run strict     # grow, but first prove the kernel mentions no genome-defined name
npm run rehearse   # the mind grows a child genome offline (a mock plays the LLM)
npm run studio     # the grown UI at http://localhost:4000 (needs a genome with a `studio` phenotype)
npm run hello      # examples/hello (hello:studio → :4300)
npm run hub:test   # examples/hub self-test (hub:studio → :4101, webhooks on :4100)
npx tsx ribosome.ts --adopt .organism/genomes/<child>.yaml postman.genome.yaml   # make a child the seed
npm run evolve -- --with intent="add a history of every request"
npx tsx ribosome.ts .organism/genomes/postman-0.4.0.yaml collection.yaml   # run a grown child
```

To reset learning, delete `.organism/`.

## The model

### One recursive unit: the cell

```yaml
http_call:
  genes: [signal, sense]          # genes it may call
  cells: []                       # other cells it may call (composition, recursion)
  input: [request, expect]
  lifecycle:                      # ordered; first state is the entry
    idle:    { to: sending }
    sending: { do: { signal: $request }, as: response, on: { received: judging, failed: failed } }
    judging: { do: { sense: { subject: $response, expect: $expect } }, as: checks, on: { pass: healthy, fail: sick } }
  ends: [healthy, sick, failed]   # terminal states; the end reached is the caller's event
  fatal: []                       # ends that count as death (exit code 1 / stillborn child)
  output: { response: $response, checks: $checks }
```

- Each state does **one** call (a gene or a cell), binds the result with `as`, then either goes `to` the next state or follows `on: {event: state, "*": fallback}`.
- A gene's events are its `emits`. A cell's events are its `ends`.
- Fan-out: `for: { item: $list }` runs sequentially; `times: N` runs in parallel. The result is a list. The event is the shared event, or `mixed` / `none`.
- Organs, whole apps (`postman`, `mock_world`) and the `mind` are all ordinary cells.
- A phenotype names a root cell and its flags: `load_tester: { grow: postman, with: { parallel: 50 } }`.

### Wiring language (kernel)

| Form | Result |
|---|---|
| `"$a.b"` (the whole string) | the raw value |
| `"text ${a.b}"` | interpolated text |
| `\|filter:arg` | applies a filter: `default pad json yaml join len keys first last sum add map where all eq pct mark green red dim yellow` |
| `$$` | escape for a literal `$` |

`{{var}}` is **not** wiring. It is runtime templating, done by `memory: { fill: … }` using the `body.recall` chain.

### Genes (the chemistry in `CHEMISTRY` / `chemistry()`)

| Gene | Operations | Emits |
|---|---|---|
| `signal` | HTTP `method/url/headers/body`, or `log` | received, failed, sent |
| `memory` | `write`, `write_all`, `read`, `append` (+`keep`), `fill` | written, read, missing |
| `sense` | `subject` + `expect` (a map means all must pass) | pass, fail |
| `transform` | `get`, `pick`, `merge`, `find`/`where`, `render`/`with`, `value`, `shape`, `stable`, `parse` (YAML) | done, none |
| `trigger` | `on: http`, `port`, `cell`: grows `cell` once per inbound request. `on: ui`, `port`, `title`, `expose`, `with`: serves the skin | listening, failed |
| `grow` | `delta` (or `genome`), `phenotype`, `experience`: splices, checks the laws, saves, and births a child | grown, stillborn |

`grow` is the sixth gene, added on purpose: it is F handed back to the genome, which closes the loop.

### Memory

- Scopes are created on demand.
- `body.recall` sets the `{{var}}` lookup order.
- `body.bones` scopes persist in the lock file. `heritable` bones (`dna`) are DNA, so any change bumps the lock version.
- The kernel seeds two more scopes: `self` (the organism's own genome text) and `world` (only the env vars allowlisted in `action.world`).

### Skin (the UI is DNA too)

`trigger: { on: ui, expose: [cells], with: {...} }` serves one generic page from the kernel (`SKIN_HTML`):
- each exposed cell becomes a screen;
- the form comes from its `input`, shaped by `skin.fields`;
- the button runs the cell, with the UI's values plus `with` as its input;
- the panel renders its `output`, shaped by `skin.show` (tabs: `auto|json|table|text`, with `columns`);
- `summary` is wiring evaluated over the output; `badge` + `good` control the status pill;
- log lines a click produces show up in a Console tab;
- memory persists across clicks, and bones are flushed after every action.

`skinLaws()` rejects unknown keys, unknown widgets and fields that aren't inputs. The page knows cells, inputs and outputs, never what they mean. Deep links work as `/#<cell>`.

### Sense grammar

A literal (deep equality), `exists`, `type:string|number|boolean|object|array|null`, or `<N` / `>N`.

### The laws (`laws()`, checked at every birth, including children)

- Every gene has chemistry, and its params and emits are ones the kernel can express.
- A cell calls only genes and cells it declares.
- Gene arguments are declared params. Cell arguments are the callee's `input`.
- Every transition target is a state or an end.
- `on:` listens only for events the callee can actually emit.
- Every `$ref` is bound: by an input, an `as`, a `for` variable, or `state` / `trail`.
- `trigger` may only spawn declared cells.
- Every phenotype grows an existing cell.
- **Guardrails** (`guardrails()`) for children:
  - a child's budget may not exceed its parent's;
  - a child may not read env vars its parent can't;
  - growth depth is at most 3.

## Status

**Working (verified):**
- `grow`, `load` and `mock` give the same results as the old hand-coded engine.
- Learning (auto type-assertions after 3 stable runs) works.
- `--strict` passes: there is no `fire()`, no `ORGAN_FOLDS`, and no cell name in the kernel.
- **Second species:** `examples/hub` was grown from `examples/egg` (genes + mind only) in 5 intents. See ARCHITECTURE.md §13.
- **Isolated trials:** a trial birth gets its own port namespace (free ports, with its localhost traffic routed to them), so Evolve works inside a running app. The hub grew `0.4.3` from its own Evolve screen while live.
- Offline self-growth: `rehearse` grows `postman@0.4.0` with a new `history` cell. That child can run directly and can grow `0.5.0` itself.
- Broken DNA is rejected with precise errors, and the mind retries using those errors as feedback.
- **Real self-growth (verified 2026-09-24):** `npm run evolve` with a "history" intent got a valid delta from `claude-opus-5` on the first attempt, in about 30s. It added the `historian` and `record_exchange` cells, and changed `http_call` to expose its request. The child ran with real exchanges archived. No human wrote any YAML or TypeScript for it.
- **API key:** read from `ANTHROPIC_API_KEY`, falling back to `CLAUDE_API_KEY`. npm scripts load `.env` (gitignored) through Node's `--env-file-if-exists`.

- **The mind grew the Postman UI (2026-09-24):** an intent describing 5 screens (Request, Collection Runner, History, Environment, Evolve) produced `postman@0.5.0` with 6 new cells and a `studio` phenotype. Attempt 1 was stillborn (it broke its own `mind` cell; the laws caught it), attempt 2 grew. Every screen works, verified over the API and by screenshot.

**Not yet:**
1. **The mind has one successful run so far.** Harder intents will need primer tuning, since the primer lives in the `mind` cell's `system` text.
2. **Skin v1 is generic forms and panels.** There is no drag-and-drop collection editing, no tabs of open requests, no saved requests. Each would be grown as cells, plus possibly a few new widgets or `as:` renderers in the kernel.
3. **Fitness is only "born and didn't die".** Nothing yet decides whether a mutation is *better*.
4. **Adoption is a command, not automatic.** Use `--adopt`, which checks the child against the laws before it replaces the seed. The Evolve screen grows children but can't yet hot-swap the running app.
5. **Kernel vocabulary creep.** Filters and transform operations are the part of the kernel most likely to bloat. Add one only when no composition of existing ones can do the job.

## Roadmap

1. **Real mind**
   - Run `evolve` against the real API.
   - Harden the primer.
   - Add a `sense` step so the mind checks the child's *output* (e.g. coverage), not just survival.
2. **Richer skin**
   - Hot-swap: let Evolve adopt the child into the running studio.
   - Saved requests and collections as memory, edited from the UI.
3. **Fitness + selection**
   - Score children (coverage, failures found, noise, size of DNA).
   - Keep winners and archive losers.
   - Add a lineage view.
4. **Self-directed intents**
   - The mind proposes its own next intent (e.g. from failed runs or an OpenAPI spec), not only ones a human types.

## Design rules for contributors (human or AI)

- **Never put feature behaviour in `ribosome.ts`.** If the genome can't express something, add the smallest *generic* capability (a gene operation or a filter) that lets it, then write the feature in YAML.
- `npm run strict` must always pass.
- Every new YAML concept must be checked in `laws()`, so a hallucinated genome gets rejected with a clear error message.
- The gene set stays tiny. Six is the current count, and adding one needs a closure-level reason.
- Learning and evolution are reversible. Grown genomes and learned memory live in `.organism/`, never as silent edits to the seed genome.
- Zero-dependency spirit: only `yaml` and `tsx`.
- `npm run grow` and `npm run rehearse` must pass offline.
