/**
 * 🧬 RIBOSOME v0.1 — reads a genome, grows an organism.
 *
 *   npx tsx ribosome.ts postman.genome.yaml collection.yaml [--phenotype load_tester]
 *
 * Pipeline:  genome → invariants → chemistry (genes) → cells → organs → body → action → learning
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import YAML from "yaml";

// ─────────────────────────── utils ───────────────────────────
const get = (o: any, p: string) =>
  p.split(/\.|\[(\d+)\]/).filter(Boolean).reduce((x, k) => (x == null ? undefined : x[k]), o);
const typeOf = (v: any) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
const log = console.log;
const c = { g: (s: string) => `\x1b[32m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`,
            d: (s: string) => `\x1b[2m${s}\x1b[0m`, y: (s: string) => `\x1b[33m${s}\x1b[0m` };

// ─────────────── LAYER 0: MEMORY SUBSTRATE ───────────────
class Memory {
  scopes: Record<string, Record<string, any>> = { global: {}, env: {}, collection: {}, run: {} };
  write(k: string, v: any, scope = "run") { this.scopes[scope][k] = v; }
  read(k: string) {
    for (const s of ["run", "collection", "env", "global"]) if (k in this.scopes[s]) return this.scopes[s][k];
  }
  resolve<T>(x: T): T {
    if (typeof x === "string") return x.replace(/\{\{(\w+)\}\}/g, (m, k) => String(this.read(k) ?? m)) as any;
    if (Array.isArray(x)) return x.map((v) => this.resolve(v)) as any;
    if (x && typeof x === "object")
      return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, this.resolve(v)])) as any;
    return x;
  }
}

// ─────────────── LAYER 1: CHEMISTRY (what each gene can do) ───────────────
const KNOWN_GENES = ["signal", "memory", "sense", "transform", "trigger"];

function chemistry(mem: Memory, budget: number) {
  let spent = 0;
  return {
    signal: async ({ method = "GET", url, headers = {}, body }: any) => {
      if (++spent > budget) throw new Error(`⛔ action budget exhausted (${budget} requests)`);
      const t0 = performance.now();
      try {
        const h = body ? { "content-type": "application/json", ...headers } : headers;
        const res = await fetch(url, { method, headers: h, body: body ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json: any; try { json = JSON.parse(text); } catch { json = text; }
        return { event: "received", status: res.status, headers: Object.fromEntries(res.headers.entries()),
                 body: json, time: Math.round(performance.now() - t0) };
      } catch (e: any) { return { event: "failed", error: e.cause?.code ?? e.message }; }
    },
    memory: { write: (k: string, v: any, s?: string) => mem.write(k, v, s), read: (k: string) => mem.read(k) },
    sense: (subject: any, target: string, expect: any) => {
      const actual = get(subject, target);
      let pass: boolean;
      if (expect === "exists") pass = actual !== undefined;
      else if (typeof expect === "string" && expect.startsWith("type:")) pass = typeOf(actual) === expect.slice(5);
      else if (typeof expect === "string" && /^[<>]\d+$/.test(expect))
        pass = expect[0] === "<" ? actual < +expect.slice(1) : actual > +expect.slice(1);
      else pass = JSON.stringify(actual) === JSON.stringify(expect);
      return { pass, target, expect, actual };
    },
    transform: (input: any, expr: string) => get(input, expr),
    trigger: (on = "manual") => ({ on, at: Date.now() }),
  };
}
type Chem = ReturnType<typeof chemistry>;

// ─────────────── LAYER 2: CELLS (gene subset + state machine) ───────────────
type Lifecycle = Record<string, { on: string; to: string; else?: string }>;

class Cell {
  state: string;
  trail: string[];
  constructor(public type: string, private life: Lifecycle, public genes: Partial<Chem> & Record<string, any>) {
    this.state = Object.keys(life)[0];
    this.trail = [this.state];
  }
  send(event: string) {
    const t = this.life[this.state];
    if (!t) throw new Error(`${this.type}: '${this.state}' is terminal, got '${event}'`);
    const next = event === t.on ? t.to : t.else;
    if (!next) throw new Error(`${this.type}: no path for '${event}' from '${this.state}'`);
    this.state = next;
    this.trail.push(next);
  }
}

/** An organ may only grow the cell types its DNA declares. A cell only receives its declared genes. */
function grower(genome: any, chem: Chem, allowed: string[], owner: string) {
  return (type: string) => {
    if (!allowed.includes(type)) throw new Error(`⛔ organ '${owner}' tried to grow '${type}' — not in its DNA`);
    const def = genome.cells[type];
    const genes = Object.fromEntries(def.genes.map((g: string) => [g, (chem as any)[g]]));
    return new Cell(type, def.lifecycle, genes);
  };
}
type Grow = ReturnType<typeof grower>;

/** Protein folding for the http_call cell: walk its lifecycle using only its genes. */
async function fire(cell: Cell, req: any, expect: Record<string, any>) {
  cell.send("fire");
  const res = await cell.genes.signal!(req);
  cell.send(res.event);
  if (res.event === "failed") return { res, checks: [] as any[] };
  const checks = Object.entries(expect).map(([t, e]) => cell.genes.sense!(res, t, e));
  cell.send(checks.every((x) => x.pass) ? "pass" : "fail");
  return { res, checks };
}

// ─────────────── LAYER 3: ORGAN FOLDS ───────────────
type Ctx = { grow: Grow; mem: Memory; col: any; pheno: any };

const ORGAN_FOLDS: Record<string, (x: Ctx) => any> = {
  environment: ({ grow, mem, col }) => {
    for (const [k, v] of Object.entries(col.variables ?? {})) {
      const cell = grow("variable");
      cell.genes.memory.write(k, v, "env");
      cell.send("written");
    }
    return { resolve: (x: any) => mem.resolve(x) };
  },

  auth: ({ grow, mem, col }) => ({
    async login() {
      if (!col.auth) return;
      const call = grow("http_call");
      const { res } = await fire(call, mem.resolve(col.auth.request), { status: 200 });
      if (call.state !== "healthy") throw new Error(`auth organ failed (${res.status ?? res.error})`);
      const ex = grow("extractor"); ex.send("input");
      const token = ex.genes.transform(res, col.auth.extract); ex.send("done");
      const v = grow("variable"); v.genes.memory.write("token", token, "collection"); v.send("written");
      log(c.d(`  🔑 auth organ: token acquired (${call.trail.join("→")})`));
    },
  }),

  runner: ({ grow, mem, pheno }) => ({
    async run(steps: any[]) {
      const clock = grow("clock"); clock.send("fire");
      const parallel = pheno["runner.parallel"] ?? 1;
      const report: any[] = [];
      for (const step of steps) {
        const req = mem.resolve({ method: step.method ?? "GET", url: step.url, headers: step.headers, body: step.body });
        const cells = Array.from({ length: parallel }, () => grow("http_call"));
        const results = await Promise.all(cells.map((cell) => fire(cell, req, step.expect ?? {})));
        if (step.extract && cells[0].state === "healthy")
          for (const [k, p] of Object.entries(step.extract)) {
            const ex = grow("extractor"); ex.send("input");
            ex.genes.memory.write(k, ex.genes.transform(results[0].res, p as string), "run"); ex.send("done");
          }
        report.push({ step, cells, results });
      }
      clock.send("done");
      return report;
    },
  }),

  mock: ({ grow, col }) => ({
    serve(port = col.mock_port ?? 4010): Promise<() => void> {
      const server = http.createServer((q, s) => {
        let raw = "";
        q.on("data", (d) => (raw += d));
        q.on("end", () => {
          const cell = grow("responder"); cell.send("request");
          let body: any; try { body = JSON.parse(raw); } catch { body = raw; }
          const reqObj = { method: q.method, path: q.url?.split("?")[0], headers: q.headers, body };
          const route = (col.mocks ?? []).find((r: any) => r.method === reqObj.method && r.path === reqObj.path);
          let status = 404, out: any = { error: "no such route" };
          if (route) {
            const ok = Object.entries(route.require ?? {}).every(([t, e]) => cell.genes.sense(reqObj, t, e).pass);
            if (!ok) { status = 401; out = { error: "unauthorized" }; }
            else {
              status = route.respond.status ?? 200;
              out = JSON.parse(JSON.stringify(route.respond.body ?? {}), (_k, v) =>
                typeof v === "string" && v.startsWith("$req.") ? cell.genes.transform(reqObj, v.slice(5)) : v);
            }
          }
          cell.send("done");
          s.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(out));
        });
      });
      return new Promise((ok) => server.listen(port, () => ok(() => server.close())));
    },
  }),
};

// ─────────────── INVARIANTS (laws of physics) ───────────────
function checkInvariants(g: any) {
  const errs: string[] = [];
  for (const gene of Object.keys(g.genes)) if (!KNOWN_GENES.includes(gene)) errs.push(`gene '${gene}' has no chemistry`);
  for (const [cell, d] of Object.entries<any>(g.cells))
    for (const gene of d.genes) if (!g.genes[gene]) errs.push(`cell '${cell}' uses undeclared gene '${gene}'`);
  for (const [organ, d] of Object.entries<any>(g.organs)) {
    for (const cell of d.cells) if (!g.cells[cell]) errs.push(`organ '${organ}' uses undeclared cell '${cell}'`);
    for (const w of d.wiring ?? [])
      for (const ref of w.split("->").map((s: string) => s.trim().split(/[.[(]/)[0]))
        if (!d.cells.includes(ref)) errs.push(`organ '${organ}' wires foreign cell '${ref}'`);
    if (!ORGAN_FOLDS[organ]) errs.push(`organ '${organ}' has no known fold`);
  }
  for (const [p, d] of Object.entries<any>(g.phenotypes))
    for (const o of d.express) if (!g.organs[o]) errs.push(`phenotype '${p}' expresses unknown organ '${o}'`);
  if (errs.length) throw new Error("💀 stillborn — invariants violated:\n  " + errs.join("\n  "));
}

// ─────────────── LAYER 8: LEARNING ───────────────
function learn(genome: any, report: any[], lock: any) {
  const rule = (genome.learning?.mutations ?? []).find((m: any) => m.when === "response_shape_stable");
  if (!rule) return [];
  const born: string[] = [];
  for (const { step, cells, results } of report) {
    const body = results[0].res.body;
    if (cells[0].state !== "healthy" || typeOf(body) !== "object") continue;
    const sig = Object.entries(body).map(([k, v]) => `${k}:${typeOf(v)}`).sort().join(",");
    const hist = (lock.shapes[step.name] ??= []);
    hist.push(sig); if (hist.length > 10) hist.shift();
    const lastN = hist.slice(-rule.runs);
    if (lastN.length === rule.runs && new Set(lastN).size === 1 && !lock.mutations[step.name]) {
      lock.mutations[step.name] = Object.fromEntries(Object.entries(body).map(([k, v]) => [`body.${k}`, `type:${typeOf(v)}`]));
      born.push(step.name);
    }
  }
  if (born.length) {
    lock.lineage.push(lock.version);
    const [a, b, p] = lock.version.split(".").map(Number);
    lock.version = `${a}.${b}.${p + 1}`;
  }
  return born;
}

// ─────────────── LAYER 4: BODY (birth + skin) ───────────────
function skin(report: any[], parallel: number) {
  let healthy = 0, senses = 0;
  for (const { step, cells, results } of report) {
    const ok = cells.every((x: Cell) => x.state === "healthy");
    if (ok) healthy++;
    const r = results[0];
    senses += r.checks.length;
    const times = results.map((x: any) => x.res.time ?? 0).sort((a: number, b: number) => a - b);
    const timing = parallel > 1
      ? `p50 ${times[Math.floor(times.length * 0.5)]}ms p95 ${times[Math.floor(times.length * 0.95)]}ms ×${parallel}`
      : `${r.res.time ?? "-"}ms`;
    log(`  ${ok ? c.g("✔") : c.r("✘")} ${step.name.padEnd(22)} ${String(r.res.status ?? r.res.error).padEnd(5)} ${timing.padEnd(8)} ${c.d(cells[0].trail.join("→"))}`);
    for (const ch of r.checks.filter((x: any) => !x.pass))
      log(c.r(`      ↳ ${ch.target}: expected ${JSON.stringify(ch.expect)}, got ${JSON.stringify(ch.actual)}`));
  }
  log(`\n  📊 coverage ${healthy}/${report.length} healthy · ${senses} senses fired`);
}

async function main() {
  const args = process.argv.slice(2);
  const pi = args.indexOf("--phenotype");
  const phenoArg = pi >= 0 ? args.splice(pi, 2)[1] : undefined;
  const [genomePath = "postman.genome.yaml", colPath = "collection.yaml"] = args;

  const genome = YAML.parse(fs.readFileSync(genomePath, "utf8"));
  const col = YAML.parse(fs.readFileSync(colPath, "utf8"));
  const lockDir = path.join(path.dirname(colPath), ".organism");
  const lockPath = path.join(lockDir, `${col.name}.lock.json`);
  const lock = fs.existsSync(lockPath)
    ? JSON.parse(fs.readFileSync(lockPath, "utf8"))
    : { version: genome.genome.version, lineage: [], shapes: {}, mutations: {} };

  const phenoName = phenoArg ?? genome.active_phenotype;
  const pheno = genome.phenotypes[phenoName];
  if (!pheno) throw new Error(`unknown phenotype '${phenoName}'`);

  log(`\n🧬 genome ${genome.genome.name} v${lock.version}  →  phenotype ${c.y(phenoName)}`);
  checkInvariants(genome);
  log(c.d("  ✔ laws of physics hold"));

  // Birth: express only the organs this phenotype declares
  const mem = new Memory();
  const chem = chemistry(mem, genome.action?.budget?.max_requests ?? Infinity);
  const organs: Record<string, any> = {};
  for (const o of pheno.express)
    organs[o] = ORGAN_FOLDS[o]({ grow: grower(genome, chem, genome.organs[o].cells, o), mem, col, pheno });
  log(c.d(`  🫀 organs grown: ${Object.keys(organs).join(", ")}`));
  log(c.d(`  💭 mind: dormant`));

  const stop = organs.mock ? await organs.mock.serve() : null;
  if (!organs.runner) { log(`  🪞 ${phenoName}: serving mocks on :${col.mock_port ?? 4010} (Ctrl+C to stop)`); return; }

  try {
    if (organs.auth) await organs.auth.login();
    // Inherited mutations become extra senses
    const steps = col.steps.map((s: any) => ({ ...s, expect: { ...(lock.mutations[s.name] ?? {}), ...(s.expect ?? {}) } }));
    log("");
    const report = await organs.runner.run(steps);
    skin(report, pheno["runner.parallel"] ?? 1);

    const born = learn(genome, report, lock);
    for (const name of born) log(c.y(`  🧪 mutation: '${name}' grew ${Object.keys(lock.mutations[name]).length} type senses → v${lock.version}`));
    if (!born.length) log(c.d(`  📚 learning: observing (${Object.keys(lock.mutations).length} mutations inherited)`));
    fs.mkdirSync(lockDir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  } finally {
    stop?.();
  }
}

main().catch((e) => { console.error(c.r(e.message)); process.exit(1); });
