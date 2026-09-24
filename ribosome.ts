/**
 * 🧬 RIBOSOME v0.3 — the kernel.   F(genome, intent) → organism
 *
 *   npx tsx ribosome.ts <genome.yaml> <experience.yaml> [--phenotype name] [--with key=value]... [--strict]
 *
 * The kernel knows physics only:
 *   - six genes (signal, memory, sense, transform, trigger, grow), each with real chemistry
 *   - one recursive unit, the cell: a lifecycle whose states call genes or other cells
 *   - a tiny expression language for wiring ($ref, ${interpolation}, |filters)
 *   - the laws, checked at every birth
 * `grow` is the kernel handed back to the genome: a cell can grow a new genome, which is
 * how the organism writes its own successor. `--strict` proves the kernel never mentions
 * anything the genome defines.
 */
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

// ─────────────────────────── utils ───────────────────────────
const get = (o: any, p: any): any =>
  p === undefined || p === null || p === ""
    ? o
    : String(p).split(/\.|\[(\d+)\]/).filter(Boolean).reduce((x, k) => (x == null ? undefined : x[k]), o);
const setPath = (o: any, p: string, v: any) => {
  const ks = String(p).split(".");
  const last = ks.pop()!;
  const parent = ks.reduce((x, k) => (x[k] = isMap(x[k]) ? x[k] : {}), o);
  parent[last] = v;
};
const typeOf = (v: any) => (Array.isArray(v) ? "array" : v === null ? "null" : typeof v);
const isMap = (v: any): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);
const literal = (s: string) => { try { return JSON.parse(s); } catch { return s; } };
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const c = { g: (s: string) => `\x1b[32m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`,
            d: (s: string) => `\x1b[2m${s}\x1b[0m`, y: (s: string) => `\x1b[33m${s}\x1b[0m` };
const MAX_DEPTH = 3;
const MAX_STEPS = 10_000;

// ─────────────── WIRING LANGUAGE ───────────────
//   "$a.b|filter:arg"        whole string → the raw value
//   "text ${a.b|filter} …"   interpolation → string
//   "$$…" / "$${"            escapes (a literal "$…" / "${")
const FILTERS: Record<string, (v: any, ...a: string[]) => any> = {
  default: (v, ...a) => v ?? literal(a.join(":")),
  pad: (v, n) => String(v ?? "").padEnd(+n),
  json: (v) => JSON.stringify(v),
  yaml: (v) => YAML.stringify(v),
  join: (v, ...s) => (Array.isArray(v) ? v.join(s.join(":")) : v),
  len: (v) => (Array.isArray(v) || typeof v === "string" ? v.length : isMap(v) ? Object.keys(v).length : 0),
  keys: (v) => (isMap(v) ? Object.keys(v) : []),
  first: (v) => (Array.isArray(v) ? v[0] : v),
  last: (v) => (Array.isArray(v) ? v[v.length - 1] : v),
  sum: (v) => (v ?? []).reduce((a: number, b: any) => a + (+b || 0), 0),
  add: (v, n) => (+v || 0) + +n,
  map: (v, p) => (v ?? []).map((i: any) => get(i, p)),
  where: (v, p, x) => (v ?? []).filter((i: any) => String(get(i, p)) === x),
  all: (v, p, x) => Array.isArray(v) && v.length > 0 && v.every((i: any) => String(get(i, p)) === x),
  eq: (v, x) => String(v) === x,
  pct: (v, n) => {
    const s = [...(v ?? [])].map(Number).sort((a, b) => a - b);
    return s[Math.min(s.length - 1, Math.floor((s.length * +n) / 100))];
  },
  mark: (v) => (v ? c.g("✔") : c.r("✘")),
  green: (v) => c.g(String(v ?? "")), red: (v) => c.r(String(v ?? "")),
  dim: (v) => c.d(String(v ?? "")), yellow: (v) => c.y(String(v ?? "")),
};
const WHOLE = /^\$([A-Za-z_][\w.]*)((?:\|[^|]*)*)$/;
const PIECE = /\$?\$\{([^}]*)\}/g;

function pipe(expr: string, scope: any) {
  const [p, ...fs] = expr.split("|");
  return fs.reduce((v, f) => {
    const [name, ...args] = f.split(":");
    const fn = FILTERS[name.trim()];
    if (!fn) throw new Error(`unknown filter '${name}'`);
    return fn(v, ...args);
  }, get(scope, p.trim()));
}

function evaluate(x: any, scope: any): any {
  if (typeof x === "string") {
    if (x.startsWith("$$")) return x.slice(1);
    if (WHOLE.test(x)) return pipe(x.slice(1), scope);
    if (!x.includes("${")) return x;
    return x.replace(PIECE, (m, e) => {
      if (m.startsWith("$$")) return m.slice(1);
      const v = pipe(e, scope);
      return v == null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    });
  }
  if (Array.isArray(x)) return x.map((v) => evaluate(v, scope));
  if (isMap(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, evaluate(v, scope)]));
  return x;
}

/** Every scope name an expression reads (used by the laws to reject unbound wiring). */
function refs(x: any, out = new Set<string>()): Set<string> {
  const root = (e: string) => e.split("|")[0].trim().split(".")[0];
  if (typeof x === "string" && !x.startsWith("$$")) {
    if (WHOLE.test(x)) out.add(root(x.slice(1)));
    else for (const m of x.matchAll(PIECE)) if (!m[0].startsWith("$$")) out.add(root(m[1]));
  } else if (Array.isArray(x)) x.forEach((v) => refs(v, out));
  else if (isMap(x)) Object.values(x).forEach((v) => refs(v, out));
  return out;
}

/** Replace every string starting with "$" by a lookup in `w` (data, never genome). */
const render = (x: any, w: any): any =>
  typeof x === "string" && x.startsWith("$") ? get(w, x.slice(1))
  : Array.isArray(x) ? x.map((i) => render(i, w))
  : isMap(x) ? Object.fromEntries(Object.entries(x).map(([k, v]) => [k, render(v, w)]))
  : x;

// ─────────────── MEMORY SUBSTRATE ───────────────
class Memory {
  scopes: Record<string, any> = {};
  constructor(private recall: string[], seed: Record<string, any>) { Object.assign(this.scopes, seed); }
  private scope(s?: string) { return (this.scopes[s ?? this.recall[0] ?? "local"] ??= {}); }
  write(k: string, v: any, s?: string) { setPath(this.scope(s), k, v); }
  read(k: string, s?: string) {
    if (s) return get(this.scopes[s], k);
    for (const r of this.recall) { const v = get(this.scopes[r], k); if (v !== undefined) return v; }
  }
  fill<T>(x: T): T {
    if (typeof x === "string") return x.replace(/\{\{(\w+)\}\}/g, (m, k) => String(this.read(k) ?? m)) as any;
    if (Array.isArray(x)) return x.map((v) => this.fill(v)) as any;
    if (isMap(x)) return Object.fromEntries(Object.entries(x).map(([k, v]) => [k, this.fill(v)])) as any;
    return x;
  }
}

// ─────────────── CHEMISTRY: what each gene can physically do ───────────────
const CHEMISTRY: Record<string, { params: string[]; emits: string[] }> = {
  signal:    { params: ["method", "url", "headers", "body", "log"], emits: ["received", "failed", "sent"] },
  memory:    { params: ["write", "value", "scope", "write_all", "read", "fill", "append", "keep"], emits: ["written", "read", "missing"] },
  sense:     { params: ["subject", "target", "expect"], emits: ["pass", "fail"] },
  transform: { params: ["input", "get", "pick", "merge", "find", "where", "render", "with", "value", "shape", "prefix", "stable", "parse"], emits: ["done", "none"] },
  trigger:   { params: ["on", "port", "cell", "with"], emits: ["listening"] },
  grow:      { params: ["genome", "delta", "phenotype", "experience", "with"], emits: ["grown", "stillborn"] },
};
type Reaction = { event: string; output?: any };

function senseOne(subject: any, target: string | undefined, expect: any) {
  const actual = target === undefined ? subject : get(subject, target);
  let pass: boolean;
  if (expect === "exists") pass = actual !== undefined && actual !== null;
  else if (typeof expect === "string" && expect.startsWith("type:")) pass = typeOf(actual) === expect.slice(5);
  else if (typeof expect === "string" && /^[<>]-?\d+(\.\d+)?$/.test(expect))
    pass = expect[0] === "<" ? actual < +expect.slice(1) : actual > +expect.slice(1);
  else pass = same(actual, expect);
  return { pass, target, expect, actual };
}

function chemistry(org: Organism): Record<string, (a: any) => Reaction | Promise<Reaction>> {
  const found = (v: any): Reaction => ({ event: v === undefined ? "none" : "done", output: v });
  return {
    signal: async (a) => {
      if ("log" in a) { org.say(String(a.log ?? "")); return { event: "sent" }; }
      if (++org.budget.spent > org.budget.max) throw new Error(`⛔ action budget exhausted (${org.budget.max} signals)`);
      const { method = "GET", url, headers = {}, body } = a;
      const t0 = performance.now();
      try {
        const h = body !== undefined ? { "content-type": "application/json", ...headers } : headers;
        const res = await fetch(url, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined });
        const text = await res.text();
        let json: any; try { json = JSON.parse(text); } catch { json = text; }
        return { event: "received", output: { status: res.status, headers: Object.fromEntries(res.headers.entries()),
                 body: json, time: Math.round(performance.now() - t0) } };
      } catch (e: any) { return { event: "failed", output: { error: e.cause?.code ?? e.message } }; }
    },

    memory: (a) => {
      const m = org.memory;
      if ("write_all" in a) { for (const [k, v] of Object.entries(a.write_all ?? {})) m.write(k, v, a.scope); return { event: "written", output: a.write_all }; }
      if ("append" in a) {
        const list = [...(m.read(a.append, a.scope) ?? []), a.value];
        if (a.keep) list.splice(0, Math.max(0, list.length - +a.keep));
        m.write(a.append, list, a.scope);
        return { event: "written", output: list };
      }
      if ("write" in a) { m.write(a.write, a.value, a.scope); return { event: "written", output: a.value }; }
      if ("fill" in a) return { event: "read", output: m.fill(a.fill) };
      if ("read" in a) { const v = m.read(a.read, a.scope); return { event: v === undefined ? "missing" : "read", output: v }; }
      throw new Error("memory: nothing to do");
    },

    sense: (a) => {
      const checks = a.target === undefined && isMap(a.expect)
        ? Object.entries(a.expect).map(([t, e]) => senseOne(a.subject, t, e))
        : a.expect === undefined ? [] : [senseOne(a.subject, a.target, a.expect)];
      return { event: checks.every((x) => x.pass) ? "pass" : "fail", output: checks };
    },

    transform: (a) => {
      if ("get" in a) return found(get(a.input, a.get));
      if ("pick" in a) return found(Object.fromEntries(Object.entries(a.pick ?? {}).map(([k, p]) => [k, get(a.input, p)])));
      if ("merge" in a) return found(Object.assign({}, ...(a.merge ?? []).filter(isMap)));
      if ("find" in a)
        return found((a.find ?? []).find((i: any) => Object.entries(a.where ?? {}).every(([k, v]) => same(get(i, k), v))));
      if ("render" in a) return found(render(a.render, a.with ?? {}));
      if ("value" in a) return found(a.value);
      if ("shape" in a)
        return found(isMap(a.shape)
          ? Object.fromEntries(Object.keys(a.shape).sort().map((k) => [`${a.prefix ?? ""}${k}`, `type:${typeOf(a.shape[k])}`]))
          : undefined);
      if ("stable" in a) {
        const n = +a.stable, last = (a.input ?? []).slice(-n);
        const ok = n > 0 && last.length === n && new Set(last.map((x: any) => JSON.stringify(x))).size === 1;
        return { event: ok ? "done" : "none", output: last[0] };
      }
      if ("parse" in a) {
        const raw = String(a.parse ?? "");
        const fenced = raw.match(/```(?:ya?ml)?\s*\n([\s\S]*?)```/);
        try { const v = YAML.parse(fenced ? fenced[1] : raw); return isMap(v) ? found(v) : { event: "none", output: { error: "not a map" } }; }
        catch (e: any) { return { event: "none", output: { error: e.message } }; }
      }
      throw new Error("transform: nothing to do");
    },

    trigger: (a) => new Promise((ok, fail) => {
      if (a.on !== "http") return fail(new Error(`trigger: unknown source '${a.on}'`));
      const server = http.createServer((q, s) => {
        let raw = "";
        q.on("data", (d) => (raw += d));
        q.on("end", async () => {
          let body: any; try { body = JSON.parse(raw); } catch { body = raw; }
          const request = { method: q.method, path: q.url?.split("?")[0], headers: q.headers, body };
          try {
            const { output: o = {} } = await org.run(a.cell, { ...(a.with ?? {}), request });
            s.writeHead(o.status ?? 200, { "content-type": "application/json", ...(o.headers ?? {}) }).end(JSON.stringify(o.body ?? null));
          } catch (e: any) { s.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: e.message })); }
        });
      });
      server.on("error", fail);
      server.listen(a.port, () => { org.listeners.push(() => server.close()); ok({ event: "listening", output: { port: a.port } }); });
    }),

    grow: (a) => org.growChild(a),
  };
}

// ─────────────── THE LAWS (checked at every birth) ───────────────
function laws(g: any): string[] {
  const e: string[] = [];
  const need = (ok: any, msg: string) => { if (!ok) e.push(msg); };
  need(isMap(g) && isMap(g.genome) && g.genome.name && g.genome.version, "genome needs genome.name and genome.version");
  for (const sec of ["genes", "cells", "phenotypes"]) need(isMap(g?.[sec]), `genome needs a '${sec}' map`);
  if (e.length) return e;

  for (const [n, d] of Object.entries<any>(g.genes)) {
    const k = CHEMISTRY[n];
    if (!k) { e.push(`gene '${n}' has no chemistry`); continue; }
    for (const p of d?.params ?? []) need(k.params.includes(p), `gene '${n}' declares param '${p}' it cannot express`);
    for (const ev of d?.emits ?? []) need(k.emits.includes(ev), `gene '${n}' declares event '${ev}' it cannot emit`);
  }

  for (const [name, d] of Object.entries<any>(g.cells)) {
    const at = (s?: string) => `cell '${name}'${s ? ` state '${s}'` : ""}`;
    if (!isMap(d) || !isMap(d.lifecycle) || !Object.keys(d.lifecycle).length) { e.push(`${at()} has no lifecycle`); continue; }
    const genes: string[] = d.genes ?? [], cells: string[] = d.cells ?? [], ends: string[] = d.ends ?? [];
    for (const x of genes) need(g.genes[x], `${at()} uses undeclared gene '${x}'`);
    for (const x of cells) need(g.cells[x], `${at()} uses undeclared cell '${x}'`);
    need(ends.length, `${at()} declares no ends`);
    for (const s of ends) need(!(s in d.lifecycle), `${at()} end '${s}' is also a live state`);
    for (const s of d.fatal ?? []) need(ends.includes(s), `${at()} fatal '${s}' is not an end`);
    const bound = new Set<string>(["state", "trail", ...(d.input ?? [])]);
    for (const st of Object.values<any>(d.lifecycle)) if (st?.as) bound.add(st.as);
    for (const x of d.input ?? []) need(!["state", "trail"].includes(x), `${at()} input '${x}' is reserved`);

    for (const [s, st] of Object.entries<any>(d.lifecycle)) {
      if (!isMap(st)) { e.push(`${at(s)} is not a map`); continue; }
      need(!(st.to && st.on), `${at(s)} has both 'to' and 'on'`);
      const targets = [st.to, ...Object.values(st.on ?? {})].filter((t) => t !== undefined);
      need(targets.length, `${at(s)} leads nowhere`);
      for (const t of targets) need(t in d.lifecycle || ends.includes(t), `${at(s)} → unknown state '${t}'`);
      if (!st.do) { need(!st.on, `${at(s)} waits for events but does nothing`); continue; }

      const { for: loop, times, ...rest } = st.do;
      const callees = Object.keys(rest);
      if (callees.length !== 1) { e.push(`${at(s)} must do exactly one thing (does: ${callees.join(", ") || "nothing"})`); continue; }
      const [callee] = callees, args = rest[callee];
      const local = new Set(bound);
      if (loop !== undefined) {
        need(isMap(loop) && Object.keys(loop).length === 1, `${at(s)} 'for' needs exactly one {name: list}`);
        if (isMap(loop)) Object.keys(loop).forEach((k) => local.add(k));
      }
      let emits: string[] = [];
      if (genes.includes(callee)) {
        emits = CHEMISTRY[callee]?.emits ?? [];
        const allowed = g.genes[callee]?.params ?? CHEMISTRY[callee]?.params ?? [];
        if (isMap(args)) for (const k of Object.keys(args)) need(allowed.includes(k), `${at(s)} passes unknown param '${k}' to gene '${callee}'`);
        if (isMap(args) && typeof args.cell === "string") need(cells.includes(args.cell), `${at(s)} hands '${args.cell}' to '${callee}' but it is not in its cells`);
      } else if (cells.includes(callee)) {
        const cd = g.cells[callee];
        emits = cd?.ends ?? [];
        if (isMap(args)) for (const k of Object.keys(args)) need((cd?.input ?? []).includes(k), `${at(s)} passes '${k}' but cell '${callee}' has no such input`);
      } else { e.push(`${at(s)} calls '${callee}', which is not in its genes or cells`); continue; }
      if (loop !== undefined || times !== undefined) emits = [...emits, "mixed", "none"];
      for (const ev of Object.keys(st.on ?? {})) need(ev === "*" || emits.includes(ev), `${at(s)} listens for '${ev}' but '${callee}' never emits it`);
      for (const r of refs(st.do)) need(local.has(r), `${at(s)} reads '$${r}', which is never bound`);
    }
    for (const r of refs(d.output)) need(bound.has(r), `${at()} output reads '$${r}', which is never bound`);
  }

  for (const [p, d] of Object.entries<any>(g.phenotypes)) need(g.cells[d?.grow], `phenotype '${p}' grows unknown cell '${d?.grow}'`);
  if (g.active_phenotype) need(g.phenotypes[g.active_phenotype], `active_phenotype '${g.active_phenotype}' does not exist`);
  return e;
}

/** A child may never hold more power than its parent. */
function guardrails(parent: any, child: any): string[] {
  const e: string[] = [];
  const pMax = parent.action?.budget?.max_requests ?? Infinity, cMax = child.action?.budget?.max_requests ?? Infinity;
  if (cMax > pMax) e.push(`child budget ${cMax} exceeds parent budget ${pMax}`);
  const pWorld: string[] = parent.action?.world ?? [];
  for (const w of child.action?.world ?? []) if (!pWorld.includes(w)) e.push(`child reaches for '${w}', which its parent cannot see`);
  return e;
}

/** --strict: the kernel must not know any name the genome defines. */
function purity(g: any): string[] {
  const src = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  return [...Object.keys(g.cells ?? {}), ...Object.keys(g.phenotypes ?? {})]
    .filter((n) => new RegExp(`\\b${n}\\b`).test(src))
    .map((n) => `kernel mentions '${n}', a name only the genome may define`);
}

/** DNA as text: one line per state / gene / phenotype when it fits, blocks otherwise. */
function dnaText(g: any) {
  const doc = new YAML.Document(g);
  YAML.visit(doc, {
    Seq(_, n) { if (n.items.every((i) => YAML.isScalar(i))) n.flow = true; },
    Pair(_, pair, path) {
      const k = [...path.filter(YAML.isPair).map((p: any) => p.key?.value), (pair.key as any)?.value];
      const small = JSON.stringify((pair.value as any)?.toJSON?.() ?? "").length <= 240;
      const line = k.length === 1 ? k[0] === "genome"
        : k.length === 2 ? ["genes", "phenotypes"].includes(k[0])
        : k[0] === "cells" && ((k.length === 4 && k[2] === "lifecycle") || (k.length === 5 && k[2] === "skin"));
      if (line && small && YAML.isMap(pair.value)) pair.value.flow = true;
    },
  });
  return doc.toString({ lineWidth: 0 });
}

/** a + b = ab : splice a delta into a genome, section by section (null deletes). */
function splice(g: any, delta: any) {
  const out = structuredClone(g);
  for (const [sec, v] of Object.entries<any>(delta)) {
    if (isMap(v) && isMap(out[sec])) for (const [k, x] of Object.entries(v)) x === null ? delete out[sec][k] : (out[sec][k] = x);
    else out[sec] = v;
  }
  return out;
}
const newer = (a: string, b: string) => {
  const [x, y] = [a, b].map((v) => String(v).split(".").map(Number));
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) > (y[i] || 0);
  return false;
};

// ─────────────── THE ORGANISM (a running genome) ───────────────
type Budget = { spent: number; max: number };

class Organism {
  chem = chemistry(this);
  listeners: (() => void)[] = [];
  constructor(public genome: any, public memory: Memory, public budget: Budget,
              public depth: number, public prefix: string, public dir: string) {}

  say(s: string) { console.log(s.split("\n").map((l) => this.prefix + l).join("\n")); }
  close() { this.listeners.splice(0).forEach((f) => f()); }

  /** Run one cell to a terminal state. Its behaviour comes only from its lifecycle. */
  async run(name: string, input: Record<string, any>) {
    const def = this.genome.cells[name];
    if (!def) throw new Error(`no cell '${name}' in this genome`);
    const scope: any = { ...input };
    let state = Object.keys(def.lifecycle)[0];
    const trail = [state];
    for (let i = 0; Object.hasOwn(def.lifecycle, state); i++) {
      if (i > MAX_STEPS) throw new Error(`cell '${name}' never settles`);
      const st = def.lifecycle[state];
      let event: string | undefined;
      if (st.do) {
        const r = await this.invoke(name, def, st.do, scope);
        event = r.event;
        if (st.as) scope[st.as] = r.output;
      }
      const next = st.to ?? st.on?.[event!] ?? st.on?.["*"];
      if (!next) throw new Error(`cell '${name}': no path for '${event}' from '${state}'`);
      state = next;
      trail.push(state);
    }
    scope.state = state;
    scope.trail = trail;
    return { state, trail, output: def.output === undefined ? { state, trail } : evaluate(def.output, scope) };
  }

  /** One state's action: a gene or a cell, optionally fanned out (for = sequential, times = parallel). */
  private async invoke(owner: string, def: any, spec: any, scope: any): Promise<Reaction> {
    const { for: loop, times, ...rest } = spec;
    const [callee] = Object.keys(rest);
    const call = async (s: any): Promise<Reaction> => {
      const args = evaluate(rest[callee], s);
      if ((def.genes ?? []).includes(callee)) {
        if (isMap(args) && args.cell !== undefined && !(def.cells ?? []).includes(args.cell))
          throw new Error(`⛔ cell '${owner}' handed '${args.cell}' to '${callee}' — not in its DNA`);
        return this.chem[callee](isMap(args) ? args : {});
      }
      if ((def.cells ?? []).includes(callee)) {
        const r = await this.run(callee, isMap(args) ? args : {});
        return { event: r.state, output: r.output };
      }
      throw new Error(`⛔ cell '${owner}' tried to use '${callee}' — not in its DNA`);
    };
    const fan = (rs: Reaction[]): Reaction => ({
      event: rs.length === 0 ? "none" : rs.every((r) => r.event === rs[0].event) ? rs[0].event : "mixed",
      output: rs.map((r) => r.output),
    });
    if (loop !== undefined) {
      const [v, listExpr] = Object.entries<any>(loop)[0];
      const out: Reaction[] = [];
      for (const item of evaluate(listExpr, scope) ?? []) out.push(await call({ ...scope, [v]: item }));
      return fan(out);
    }
    if (times !== undefined) {
      const n = Math.max(1, Math.floor(+evaluate(times, scope) || 1));
      return fan(await Promise.all(Array.from({ length: n }, () => call(scope))));
    }
    return call(scope);
  }

  /** The `grow` gene: F applied to a new genome. The output of growth is valid input to growth. */
  async growChild(a: any): Promise<Reaction> {
    const stillborn = (errors: string[], file?: string): Reaction => ({ event: "stillborn", output: { errors, file } });
    if (this.depth >= MAX_DEPTH) return stillborn([`growth deeper than ${MAX_DEPTH} generations is forbidden`]);
    if (a.genome !== undefined && !isMap(a.genome)) return stillborn(["genome must be a map"]);
    if (a.delta !== undefined && !isMap(a.delta)) return stillborn(["delta must be a map"]);

    const me = this.genome.genome;
    let child = structuredClone(isMap(a.genome) ? a.genome : this.genome);
    if (isMap(a.delta)) child = splice(child, a.delta);
    child.genome = { ...(child.genome ?? {}), name: child.genome?.name ?? me.name, parent: `${me.name}@${me.version}` };
    if (!newer(child.genome.version, me.version)) {
      const [x, y] = String(me.version).split(".").map(Number);
      child.genome.version = `${x}.${(y || 0) + 1}.0`;
    }
    const errors = [...laws(child), ...guardrails(this.genome, child)];
    if (errors.length) return stillborn(errors);

    const dir = path.join(this.dir, "genomes");
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${child.genome.name}-${child.genome.version}.yaml`);
    fs.writeFileSync(file, `# grown by ${me.name}@${me.version} — reversible: delete this file to undo\n` + dnaText(child));
    this.say(c.d(`  🥚 ${child.genome.name}@${child.genome.version} laid at ${file}`));

    try {
      const r = await birth(child, {
        phenotype: a.phenotype, experience: a.experience, with: a.with, depth: this.depth + 1,
        prefix: this.prefix + c.d("  │ "), budget: { spent: 0, max: this.budget.max - this.budget.spent },
      });
      this.budget.spent += r.spent;
      if (r.fatal) { fs.renameSync(file, file.replace(/\.yaml$/, ".stillborn.yaml")); return stillborn([`child died in state '${r.state}'`], file); }
      return { event: "grown", output: { version: child.genome.version, file, state: r.state, output: r.output } };
    } catch (e: any) {
      fs.renameSync(file, file.replace(/\.yaml$/, ".stillborn.yaml"));
      return stillborn([e.message], file);
    }
  }
}

// ─────────────── BIRTH ───────────────
type BirthOpts = { phenotype?: string; experience?: any; with?: Record<string, any>;
                   depth: number; prefix: string; budget?: Budget };

async function birth(genome: any, o: BirthOpts) {
  const errs = laws(genome);
  if (errs.length) throw new Error("💀 stillborn — laws violated:\n  " + errs.join("\n  "));
  const phenoName = o.phenotype ?? genome.active_phenotype;
  const pheno = genome.phenotypes[phenoName];
  if (!pheno) throw new Error(`unknown phenotype '${phenoName}'`);

  const expPath = typeof o.experience === "string" ? o.experience : undefined;
  const experience = expPath ? YAML.parse(fs.readFileSync(expPath, "utf8")) : (o.experience ?? {});
  const dir = path.join(path.dirname(expPath ?? "."), ".organism");
  const v = genome.genome.version;
  const lockPath = path.join(dir, `${experience.name ?? "experience"}${o.depth ? `@${v}` : ""}.lock.json`);
  let lock = fs.existsSync(lockPath) ? JSON.parse(fs.readFileSync(lockPath, "utf8")) : {};
  if (lock.born_from !== v)
    lock = { born_from: v, version: v, lineage: lock.version ? [...(lock.lineage ?? []), lock.version] : [], bones: lock.bones ?? {} };

  // bones: memory scopes that outlive the run. "heritable" ones are DNA: changing them is a mutation.
  const bones: Record<string, string> = genome.body?.bones ?? {};
  const seed: Record<string, any> = {
    self: { genome: dnaText(genome), name: genome.genome.name, version: v },
    world: Object.fromEntries((genome.action?.world ?? []).map((k: string) => [k, process.env[k]]).filter(([, x]: any) => x !== undefined)),
  };
  for (const b of Object.keys(bones)) seed[b] = structuredClone(lock.bones?.[b] ?? {});
  const before = JSON.stringify(Object.keys(bones).filter((b) => bones[b] === "heritable").map((b) => seed[b]));

  const budget = o.budget ?? { spent: 0, max: Infinity };
  budget.max = Math.min(budget.max, genome.action?.budget?.max_requests ?? Infinity);
  const org = new Organism(genome, new Memory(genome.body?.recall ?? [], seed), budget, o.depth, o.prefix, dir);

  org.say(`\n🧬 genome ${genome.genome.name} v${lock.version}  →  phenotype ${c.y(phenoName)}`);
  org.say(c.d(`  ✔ laws of physics hold (${Object.keys(genome.genes).length} genes · ${Object.keys(genome.cells).length} cells)`));
  org.say(c.d(`  🌱 growing ${pheno.grow}`));

  let r;
  try { r = await org.run(pheno.grow, { ...(pheno.with ?? {}), ...(o.with ?? {}), experience }); }
  finally { if (!pheno.persist) org.close(); }

  const after = JSON.stringify(Object.keys(bones).filter((b) => bones[b] === "heritable").map((b) => org.memory.scopes[b]));
  lock.bones = Object.fromEntries(Object.keys(bones).map((b) => [b, org.memory.scopes[b]]));
  if (before !== after) {
    lock.lineage.push(lock.version);
    const [x, y, p] = lock.version.split(".").map(Number);
    lock.version = `${x}.${y}.${p + 1}`;
    org.say(c.y(`  🧬 heritable memory changed → v${lock.version}`));
  }
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  return { ...r, fatal: (genome.cells[pheno.grow].fatal ?? []).includes(r.state), spent: budget.spent };
}

// ─────────────── ENTRY ───────────────
async function main() {
  const args = process.argv.slice(2);
  const take = (flag: string) => { const i = args.indexOf(flag); return i >= 0 ? args.splice(i, 2)[1] : undefined; };
  const phenotype = take("--phenotype");
  const withArgs: Record<string, any> = {};
  for (let w; (w = take("--with")) !== undefined; ) { const i = w.indexOf("="); withArgs[w.slice(0, i)] = literal(w.slice(i + 1)); }
  const adopt = take("--adopt");
  if (adopt) {   // --adopt <grown.yaml> <seed.yaml>: a child becomes the new seed (git is the undo)
    const seedPath = args[0];
    if (!seedPath) throw new Error("usage: ribosome.ts --adopt <grown.yaml> <seed.yaml>");
    const child = YAML.parse(fs.readFileSync(adopt, "utf8"));
    const errs = laws(child);
    if (errs.length) throw new Error("💀 refusing to adopt — laws violated:\n  " + errs.join("\n  "));
    fs.writeFileSync(seedPath, `# 🧬 seed genome — adopted from ${adopt} (lineage: ${child.genome.parent ?? "none"})\n` + dnaText(child));
    console.log(c.y(`  🧬 adopted ${child.genome.name}@${child.genome.version} as ${seedPath}`));
    return;
  }
  const strict = args.includes("--strict") && !!args.splice(args.indexOf("--strict"), 1);
  const [genomePath, experiencePath] = args;
  if (!genomePath || !experiencePath) throw new Error("usage: ribosome.ts <genome.yaml> <experience.yaml> [--phenotype p] [--with k=v] [--strict]");

  const genome = YAML.parse(fs.readFileSync(genomePath, "utf8"));
  if (strict) {
    const impure = purity(genome);
    if (impure.length) throw new Error("⛔ strict — the kernel knows too much:\n  " + impure.join("\n  "));
    console.log(c.d("  ✔ strict: the kernel mentions nothing the genome defines"));
  }
  const r = await birth(genome, { phenotype, experience: experiencePath, with: withArgs, depth: 0, prefix: "" });
  if (r.fatal) process.exitCode = 1;
}

main().catch((e) => { console.error(c.r(e.message)); process.exit(1); });
