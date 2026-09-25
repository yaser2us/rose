# Examples

Each example is a **genome** (the DNA) and an **experience** (the data it runs and is tested against). Run any of them from the repo root:

```bash
npx tsx ribosome.ts examples/<name>/genome.yaml examples/<name>/experience.yaml [--phenotype <p>]
```

| Example | Written by | Phenotypes | Needs an LLM? |
|---|---|---|---|
| [`hello/`](hello) | A human, about 60 commented lines | `hello` (CLI), `studio` (UI :4300) | No |
| [`egg/`](egg) | A human: only the genes and the mind | `evolve` | Yes, to grow anything |
| [`hub/`](hub) | **The mind**, from `egg/`, in 5 intents | `serve`, `selftest`, `studio` (UI :4101, webhooks :4100), `evolve` | Only for `evolve` |

## How `hub` was grown

Every step was one intent passed to `--phenotype evolve`. Each child had to pass its own `selftest` before it counted.

| Version | Intent (abridged) | Cells |
|---|---|---|
| 0.1.0 | (the egg) | 1 |
| 0.2.0 | "Grow into a webhook inspector" | 6 |
| 0.3.0 | "Add automations that transform and forward webhooks" | 9 |
| 0.4.0 | "Give yourself a web UI" (Inbox, Automations, Test webhook, Deliveries) | 17 |
| 0.4.1 | "Newest first is wrong; use `\|reverse`" | 15 |
| 0.4.2 | "Add an Evolve screen" | 16 |

Try it:

```bash
npm run hub:studio          # http://localhost:4101
curl -XPOST localhost:4100/hooks/github -H 'content-type: application/json' \
  -d '{"action":"opened","pull_request":{"title":"hello","user":{"login":"you"}}}'
```

Then open **Deliveries** to see the transformed payload the hub forwarded. Add your own automation on the **Automations** screen; that needs no LLM.
