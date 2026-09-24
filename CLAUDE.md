# 🧬 Organism — software that grows from a genome

> Handoff doc. Place at the repo root as `CLAUDE.md` so Claude Code loads it automatically.

## The idea

Instead of hand-building an app like Postman, we write a **genome**: a tiny set of primitives in YAML. A runtime called the **ribosome** then *grows* the app from it, layer by layer, the way DNA grows a body:

```
genes → cells → organs → body → phenotype → mind → action → learning → evolution
```

**The one law:** every layer may only be built from the layer below it. Nothing exists unless it can be traced back to genes.

The first target organism is **Postman**. The goal is not to clone Postman. It is to prove the genome approach can grow a Postman-class tool, and that the *same DNA* can grow other species (load tester, mock server, contract guard) by changing expression flags.

## Repo layout

```
ribosome.ts           the runtime: reads genome, enforces invariants, grows organism
postman.genome.yaml   the DNA (v0.2, executable)
collection.yaml       an "experience": variables, auth, mocks, steps
.organism/            generated: <collection>.lock.json (version, lineage, learned mutations)
package.json          deps: tsx, yaml (zero other deps, on purpose)
```

Run it:

```bash
npm i
npm run grow      # phenotype: postman
npm run load      # phenotype: load_tester (50 parallel cells per step)
npx tsx ribosome.ts postman.genome.yaml collection.yaml --phenotype mock_server
```

Delete `.organism/` to reset learning.

## Layer model (what each layer is, and where it lives today)

| Layer | Meaning | Implementation today |
|---|---|---|
| **Genes** | 5 primitives: `signal`, `memory`, `sense`, `transform`, `trigger` | `chemistry()` in ribosome: real behaviour per gene |
| **Cells** | a gene subset + lifecycle state machine | `Cell` class; lifecycle comes from YAML. A cell receives *only* its declared genes |
| **Organs** | cells wired together | `ORGAN_FOLDS`: **hand-written TS per organ** (see gaps) |
| **Body** | organs + skin (UI) + bones (storage) | skin = CLI report; bones = `.organism/*.lock.json` |
| **Phenotype** | which organs are expressed + flags | `phenotypes:` in genome; `--phenotype` flag |
| **Mind** | planner (LLM) deciding what to explore | **dormant** |
| **Action** | execution under budget/guardrails | runner organ + `action.budget.max_requests` enforced in `signal` gene |
| **Learning** | organism mutates its own DNA | `response_shape_stable` → auto-adds `type:` senses after N identical response shapes; bumps version, records lineage |
| **Evolution** | fitness-gated selection of genomes | **not built** |

### Invariants enforced at birth (`checkInvariants`)

A violation means the organism is "stillborn" and the process exits. These are checked:

- Every gene in the genome has known chemistry.
- Every cell uses only declared genes.
- Every organ uses only declared cells, and its `wiring` references only its own cells.
- Every organ has a fold.
- Every phenotype expresses only existing organs.

At runtime, `grower()` also throws if an organ tries to grow a cell type outside its DNA.

### Sense grammar (assertions)

`expect: { target: value }`, where the target is a path like `status`, `time`, `headers.x`, or `body.a.b[0].c`. The value can be:

- a literal, checked by deep equality;
- `exists`;
- `type:string|number|boolean|object|array|null`;
- `<500` or `>0`.

### Mock responder

Mock routes can declare `require:` senses on the request, which return 401 when they fail. A response string starting with `$req.` is replaced with a value from the request, e.g. `$req.body.type`.

## Honest status

**What it is:** a headless Postman *engine*, roughly the equivalent of the Collection Runner or Newman. It covers requests, `{{variables}}`, the login → token chain, assertions, collection runs, a mock server, load testing, and self-learned assertions. All of it has been verified working.

**What it is not (yet):**

1. **Not truly generative.** Organ behaviour is hand-coded in `ORGAN_FOLDS`. The genome *selects, wires and validates* but doesn't *produce* behaviour. Cell behaviour is also partly hand-coded: the `fire()` function is the "folding" of `http_call`. In other words, it is currently a well-policed plugin architecture in a biology costume.
2. **No real skin.** There is no GUI, request builder, history or workspaces, which is most of what Postman actually is.
3. **The mind is dormant.** Evolution and fitness scoring are not built. The `endpoint_flaky` mutation is declared but not implemented.

## The acceptance test (north star)

> **Add a brand-new feature (e.g. a `history` organ that records every request/response) by editing YAML only, with zero TypeScript changes.**

When this passes, the genome is real. Every roadmap item serves it.

## Roadmap

### Step 1: generic cells
Remove per-type folding like `fire()`. A cell's behaviour should be derived from its lifecycle alone. Each state declares which gene to call on entry and how that gene's emitted event maps to the next transition. A sketch:

```yaml
http_call:
  genes: [signal, sense]
  lifecycle:
    idle:    { on: fire, to: sending }
    sending: { do: signal(input.request), on: received, to: judging, else: failed }
    judging: { do: sense*(output, input.expect), on: pass, to: healthy, else: sick }
```

The ribosome then becomes a generic interpreter of this. `sense*` means "sense for each expectation, all must pass".

### Step 2: organs as executable wiring (the heart)
Today `wiring` lines are only validated. Make the ribosome *execute* them as an event bus between cells:

```yaml
auth:
  cells: [http_call, extractor, variable]
  inputs: [request, extract]
  wiring:
    - self.start           -> http_call.fire(request)
    - http_call.healthy    -> extractor.input(output, extract)
    - extractor.stored     -> variable.write(token, output)
  exposes:
    token: variable.value
```

Once this works, delete `ORGAN_FOLDS`. Open design questions:
- **Fan-out:** how does `runner` express "for each step" and "×N parallel"? Candidate syntax: `http_call[*]` and `http_call[n] -> http_call[n+1]`.
- **Payloads:** how does data flow along a wire? Candidate: every event carries `output`, and wires can `transform` it.
- **Long-lived vs one-shot cells:** a `responder` lives per request, a `variable` lives per run.

### Step 3: generated skin
Each organ declares `exposes` (inputs, outputs, actions). The body auto-renders a UI from that: a request editor from `http_call` inputs, a results panel from outputs, and an environment panel from `variable` cells. The stack preference is React; XState can replace the hand-rolled `Cell` machine if useful. This is the step where it starts to *look* like Postman.

### Step 4: mind
An LLM reads an OpenAPI spec plus past runs and failures, then **writes `collection.yaml`** (the experience). Hard constraint: the mind can only plan with cells and organs that exist in the genome. The ribosome must reject plans that reference anything else.

### Step 5: evolution
Keep versioned genomes and lock files. A fitness function (coverage, bugs found, noise) decides which mutations survive. Mutations must stay versioned and reversible.

## Design rules for contributors (human or AI)

- **Never add behaviour outside the layer model.** If something needs new capability, first ask whether it is a new gene. The gene set should stay tiny; five is the target and adding one needs a strong reason.
- **Every new YAML concept must be validated in `checkInvariants`.**
- **Prefer moving code into YAML over adding code.** Progress is measured by how much of `ribosome.ts` becomes generic.
- **Zero-dependency spirit.** Only `yaml` and `tsx` for now.
- **Learning must be reversible.** Learned state lives in `.organism/`, never by silently rewriting the user's genome.
- **Keep the self-contained demo working.** `collection.yaml` grows its own mock world, so `npm run grow` must pass offline.

## Suggested first prompt for Claude Code

> Read CLAUDE.md. Implement Step 1 (generic cells) so that `fire()` is deleted and `http_call` behaviour comes entirely from its lifecycle YAML. Keep `npm run grow` and `npm run load` producing the same results. Add a `--strict` flag that fails if any hand-written folding remains.