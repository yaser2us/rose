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
import { AsyncLocalStorage } from "node:async_hooks";
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
const list = (v: any): any[] => (Array.isArray(v) ? v : []);
const same = (a: any, b: any) => JSON.stringify(a) === JSON.stringify(b);
const c = { g: (s: string) => `\x1b[32m${s}\x1b[0m`, r: (s: string) => `\x1b[31m${s}\x1b[0m`,
            d: (s: string) => `\x1b[2m${s}\x1b[0m`, y: (s: string) => `\x1b[33m${s}\x1b[0m` };
const MAX_DEPTH = 3;
const VOICE = new AsyncLocalStorage<string[]>();
const LIVING = new Set<{ settle(): void }>();          // organisms whose bones must be saved before the process dies
for (const sig of ["SIGINT", "SIGTERM"] as const)
  process.on(sig, () => { LIVING.forEach((o) => o.settle()); process.exit(sig === "SIGINT" ? 130 : 143); });   // log lines of the UI action currently running
const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
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
  reverse: (v) => (Array.isArray(v) ? [...v].reverse() : v),
  sum: (v) => list(v).reduce((a: number, b: any) => a + (+b || 0), 0),
  add: (v, n) => (+v || 0) + +n,
  map: (v, p) => list(v).map((i: any) => get(i, p)),
  where: (v, p, x) => list(v).filter((i: any) => String(get(i, p)) === x),
  all: (v, p, x) => Array.isArray(v) && v.length > 0 && v.every((i: any) => String(get(i, p)) === x),
  eq: (v, x) => String(v) === x,
  pct: (v, n) => {
    const s = list(v).map(Number).sort((a, b) => a - b);
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
  trigger:   { params: ["on", "port", "cell", "with", "expose", "title"], emits: ["listening", "failed"] },
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
        let json: any;
        if (String(res.headers.get("content-type")).includes("text/event-stream"))   // SSE → [{event, data}]
          json = text.split(/\r?\n\r?\n/).filter((b) => b.trim()).map((b) => {
            const ev: any = {};
            for (const l of b.split(/\r?\n/)) { const i = l.indexOf(":"); if (i > 0) ev[l.slice(0, i)] = (ev[l.slice(0, i)] ?? "") + l.slice(i + 1).trimStart(); }
            try { ev.data = JSON.parse(ev.data); } catch {}
            return ev;
          });
        else { try { json = JSON.parse(text); } catch { json = text; } }
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
      if (a.on === "ui") return serveSkin(org, a).then(ok);
      if (a.on !== "http") return fail(new Error(`trigger: unknown source '${a.on}'`));
      const server = http.createServer((q, s) => {
        let raw = "";
        q.on("data", (d) => (raw += d));
        q.on("end", async () => {
          let body: any; try { body = JSON.parse(raw); } catch { body = raw; }
          const request = { method: q.method, path: q.url?.split("?")[0], headers: q.headers, body };
          try {
            const { output: o = {} } = await org.run(a.cell, { ...(a.with ?? {}), request });
            org.flushSoon();   // what a server learns survives the process (batched: servers can be busy)
            s.writeHead(o.status ?? 200, { "content-type": "application/json", ...(o.headers ?? {}) }).end(JSON.stringify(o.body ?? null));
          } catch (e: any) { s.writeHead(500, { "content-type": "application/json" }).end(JSON.stringify({ error: e.message })); }
        });
      });
      server.on("error", (e: any) => ok({ event: "failed", output: { error: e.code ?? e.message } }));
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
      for (const k of Object.keys(st)) if (!["do", "as", "to", "on"].includes(k))
        e.push(`${at(s)} has unknown key '${k}' (a state has only do, as, to, on${["for", "times"].includes(k) ? `; '${k}' belongs inside 'do'` : ""})`);
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
        if (isMap(args) && Array.isArray(args.expose))
          for (const x of args.expose) need(cells.includes(x), `${at(s)} exposes '${x}' but it is not in its cells`);
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
    if (d.skin !== undefined) e.push(...skinLaws(d.skin, d.input ?? []).map((m) => `${at()} skin: ${m}`));
  }

  for (const [p, d] of Object.entries<any>(g.phenotypes)) need(g.cells[d?.grow], `phenotype '${p}' grows unknown cell '${d?.grow}'`);
  if (g.active_phenotype) need(g.phenotypes[g.active_phenotype], `active_phenotype '${g.active_phenotype}' does not exist`);
  return e;
}

/** A skin only describes; it may not invent inputs or widgets the renderer lacks. */
const SKIN_KEYS = ["title", "icon", "about", "action", "auto", "fields", "show", "summary", "badge", "good"];
const FIELD_KEYS = ["widget", "options", "default", "placeholder", "span", "label"];
const WIDGETS = ["text", "textarea", "json", "number", "choose"];
const SHOW_AS = ["auto", "json", "table", "text"];
function skinLaws(k: any, input: string[]): string[] {
  const e: string[] = [];
  if (!isMap(k)) return ["must be a map"];
  for (const key of Object.keys(k)) if (!SKIN_KEYS.includes(key)) e.push(`unknown key '${key}' (known: ${SKIN_KEYS.join(", ")})`);
  if (k.fields !== undefined && !isMap(k.fields)) e.push("fields must be a map");
  for (const [f, spec] of Object.entries<any>(isMap(k.fields) ? k.fields : {})) {
    if (!input.includes(f)) e.push(`field '${f}' is not an input`);
    const w = typeof spec === "string" ? spec : spec?.widget ?? "text";
    if (!WIDGETS.includes(w)) e.push(`field '${f}' uses unknown widget '${w}' (known: ${WIDGETS.join(", ")})`);
    if (isMap(spec)) for (const key of Object.keys(spec)) if (!FIELD_KEYS.includes(key)) e.push(`field '${f}' has unknown key '${key}'`);
    if (w === "choose" && !Array.isArray(spec?.options)) e.push(`field '${f}' is a choose without options`);
  }
  if (k.show !== undefined && !Array.isArray(k.show)) e.push("show must be a list");
  for (const s of Array.isArray(k.show) ? k.show : []) {
    if (!isMap(s)) { e.push("each show entry must be a map"); continue; }
    if (s.as !== undefined && !SHOW_AS.includes(s.as)) e.push(`show '${s.label ?? s.path}' uses unknown 'as: ${s.as}' (known: ${SHOW_AS.join(", ")})`);
    if (s.columns !== undefined && !isMap(s.columns)) e.push(`show '${s.label ?? s.path}' columns must map label → path`);
  }
  if (k.good !== undefined && !Array.isArray(k.good)) e.push("good must be a list");
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

  flush = () => {};
  private pending?: NodeJS.Timeout;
  flushSoon() {
    if (this.pending) return;
    this.pending = setTimeout(() => { this.pending = undefined; this.flush(); }, 250);
  }
  settle() { if (this.pending) { clearTimeout(this.pending); this.pending = undefined; } this.flush(); }
  say(s: string) {
    VOICE.getStore()?.push(...s.split("\n"));
    console.log(s.split("\n").map((l) => this.prefix + l).join("\n"));
  }
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
    if (errors.length) {   // keep the rejected DNA so failures can be read, not guessed
      const dir = path.join(this.dir, "genomes");
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `${child.genome.name}-${child.genome.version}.rejected.yaml`);
      fs.writeFileSync(file, `# rejected — ${errors.length} law(s) violated:\n${errors.map((x) => `#   ${x}`).join("\n")}\n` + dnaText(child));
      return stillborn(errors, file);
    }

    const dir = path.join(this.dir, "genomes");
    fs.mkdirSync(dir, { recursive: true });
    const taken = (v: string) => [".yaml", ".stillborn.yaml"].some((x) => fs.existsSync(path.join(dir, `${child.genome.name}-${v}${x}`)));
    while (taken(child.genome.version)) {   // growth never overwrites an earlier child
      const [x, y] = String(child.genome.version).split(".").map(Number);
      child.genome.version = `${x}.${(y || 0) + 1}.0`;
    }
    const file = path.join(dir, `${child.genome.name}-${child.genome.version}.yaml`);
    fs.writeFileSync(file, `# grown by ${me.name}@${me.version} — reversible: delete this file to undo\n` + dnaText(child));
    this.say(c.d(`  🥚 ${child.genome.name}@${child.genome.version} laid at ${file}`));

    try {
      const r = await birth(child, {
        phenotype: a.phenotype, experience: a.experience, with: a.with, depth: this.depth + 1,
        prefix: this.prefix + c.d("  │ "), budget: { spent: 0, max: this.budget.max - this.budget.spent }, trial: true,
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

// ─────────────── SKIN: the body rendered from the genome ───────────────
// `trigger: { on: ui, expose: [cells] }` serves one generic page. For each exposed cell it draws
// a form from the cell's inputs (shaped by `skin.fields`) and renders the cell's output
// (shaped by `skin.show`). The page knows cells, inputs and outputs — never what they mean.
function serveSkin(org: Organism, a: any): Promise<Reaction> {
  const expose: string[] = a.expose ?? [];
  const meta = () => ({
    title: a.title ?? org.genome.genome.name,
    genome: { name: org.genome.genome.name, version: org.genome.genome.version, parent: org.genome.genome.parent },
    cells: expose.map((n) => {
      const d = org.genome.cells[n];
      return { name: n, input: d.input ?? [], ends: d.ends ?? [], fatal: d.fatal ?? [], skin: d.skin ?? {} };
    }),
  });
  return new Promise((ok) => {
    const server = http.createServer((q, s) => {
      const send = (code: number, body: any, type = "application/json") =>
        s.writeHead(code, { "content-type": type, "cache-control": "no-store" }).end(typeof body === "string" ? body : JSON.stringify(body));
      let raw = "";
      q.on("data", (d) => (raw += d));
      q.on("end", async () => {
        const url = q.url?.split("?")[0] ?? "/";
        if (q.method === "GET" && url === "/")
          return send(200, SKIN_HTML.replace("__TITLE__", String(a.title ?? org.genome.genome.name).replace(/[<&>"]/g, "")), "text/html; charset=utf-8");
        if (q.method === "GET" && url === "/api/body") return send(200, meta());
        const m = url.match(/^\/api\/run\/([\w.-]+)$/);
        if (q.method === "POST" && m) {
          // only this page may act: JSON bodies force a CORS preflight, and foreign origins are refused
          const origin = q.headers.origin;
          if (!String(q.headers["content-type"] ?? "").includes("application/json") || (origin && new URL(origin).host !== q.headers.host))
            return send(403, { error: "forbidden" });
          if (!expose.includes(m[1])) return send(404, { error: `'${m[1]}' is not exposed` });
          const def = org.genome.cells[m[1]];
          let given: any;
          try { given = raw ? JSON.parse(raw) : {}; } catch { return send(400, { error: "body is not JSON" }); }
          const inputs = Object.fromEntries(Object.entries(isMap(given) ? given : {}).filter(([k]) => (def.input ?? []).includes(k)));
          const log: string[] = [];
          try {
            const r = await VOICE.run(log, () => org.run(m[1], { ...(a.with ?? {}), ...inputs }));
            org.flush();
            const view = { ...(isMap(r.output) ? r.output : { output: r.output }), state: r.state, trail: r.trail };
            const summary = def.skin?.summary !== undefined ? evaluate(def.skin.summary, view) : undefined;
            return send(200, { state: r.state, trail: r.trail, output: r.output, summary, log: log.map(strip), genome: meta().genome });
          } catch (e: any) { return send(500, { error: e.message, log: log.map(strip) }); }
        }
        send(404, { error: "no such route" });
      });
    });
    server.on("error", (e: any) => ok({ event: "failed", output: { error: e.code ?? e.message } }));
    server.listen(a.port, "127.0.0.1", () => { org.listeners.push(() => server.close()); ok({ event: "listening", output: { port: a.port } }); });
  });
}

const SKIN_HTML = String.raw`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>__TITLE__</title>
<style>
:root{--bg:#f6f6f7;--panel:#fff;--ink:#212121;--dim:#6b6b6b;--line:#e2e2e4;--accent:#ff6c37;--accent-ink:#fff;--good:#0a8a4a;--bad:#d63b2f;--code:#f3f3f5;--sel:#fff1eb;color-scheme:light}
@media (prefers-color-scheme:dark){:root{--bg:#1c1c1c;--panel:#252526;--ink:#e8e8e8;--dim:#9a9a9a;--line:#3a3a3a;--code:#1e1e1e;--sel:#3a2a22;--good:#3ecf7c;--bad:#ff6b5e;color-scheme:dark}}
*{box-sizing:border-box}body{margin:0;min-height:100vh;display:flex;flex-direction:column;background:var(--bg);color:var(--ink);font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif}
header{display:flex;align-items:center;gap:10px;padding:10px 16px;background:var(--panel);border-bottom:1px solid var(--line)}
header b{font-size:15px}header .ver{color:var(--dim);font-size:12px}header .grow{margin-left:auto;color:var(--dim);font-size:12px}
.shell{display:grid;grid-template-columns:220px 1fr;flex:1}
nav{background:var(--panel);border-right:1px solid var(--line);padding:8px}
nav button{display:flex;gap:10px;align-items:center;width:100%;padding:8px 10px;border:0;border-radius:6px;background:none;color:var(--ink);font:inherit;text-align:left;cursor:pointer}
nav button:hover{background:var(--bg)}nav button.on{background:var(--sel);color:var(--accent);font-weight:600}
nav .ic{width:20px;text-align:center}
main{padding:20px 24px;min-width:0}
h1{font-size:18px;margin:0 0 4px}.about{color:var(--dim);margin:0 0 16px;max-width:70ch}
.form{display:grid;grid-template-columns:repeat(12,1fr);gap:10px;background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}
.f{display:flex;flex-direction:column;gap:4px;min-width:0}.f label{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim)}
input,select,textarea{font:inherit;color:var(--ink);background:var(--bg);border:1px solid var(--line);border-radius:6px;padding:7px 9px;width:100%}
textarea{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12.5px;min-height:84px;resize:vertical}
input:focus,select:focus,textarea:focus{outline:2px solid var(--accent);outline-offset:-1px}.bad-in{border-color:var(--bad)}
.act{grid-column:1/-1;display:flex;gap:10px;align-items:center}
.go{background:var(--accent);color:var(--accent-ink);border:0;border-radius:6px;padding:8px 18px;font:inherit;font-weight:600;cursor:pointer}.go:disabled{opacity:.6;cursor:wait}
.hint{color:var(--dim);font-size:12px}
.result{margin-top:16px;background:var(--panel);border:1px solid var(--line);border-radius:8px;overflow:hidden}
.rhead{display:flex;flex-wrap:wrap;gap:10px;align-items:center;padding:10px 14px;border-bottom:1px solid var(--line)}
.badge{font-weight:700;font-size:12px;padding:2px 8px;border-radius:99px;border:1px solid currentColor}.badge.good{color:var(--good)}.badge.bad{color:var(--bad)}
.trail{color:var(--dim);font-size:12px;font-family:ui-monospace,Menlo,monospace}
.tabs{display:flex;gap:2px;padding:0 10px;border-bottom:1px solid var(--line);overflow-x:auto}
.tabs button{border:0;background:none;color:var(--dim);font:inherit;padding:8px 10px;cursor:pointer;border-bottom:2px solid transparent;white-space:nowrap}
.tabs button.on{color:var(--ink);border-bottom-color:var(--accent)}
.pane{padding:12px 14px;overflow-x:auto}
pre{margin:0;font:12.5px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word}
.k{color:#a3508e}.s{color:#0b7d6e}.n{color:#b35c00}.b{color:#2b6cc4}.z{color:var(--dim)}
@media (prefers-color-scheme:dark){.k{color:#e39ed3}.s{color:#6fd3c1}.n{color:#f2a65a}.b{color:#7fb0ff}}
table{border-collapse:collapse;width:100%;font-size:13px}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:var(--dim);font-weight:600}
tbody tr.row{cursor:pointer}tbody tr.row:hover{background:var(--bg)}td.more{background:var(--code)}
.yes{color:var(--good);font-weight:700}.no{color:var(--bad);font-weight:700}
dl{display:grid;grid-template-columns:max-content 1fr;gap:4px 14px;margin:0}dt{color:var(--dim)}dd{margin:0;min-width:0}
details summary{cursor:pointer;color:var(--dim)}
.err{color:var(--bad);padding:12px 14px;white-space:pre-wrap}.empty{color:var(--dim)}
@media (max-width:720px){.shell{grid-template-columns:1fr}nav{display:flex;overflow-x:auto;border-right:0;border-bottom:1px solid var(--line)}nav button{width:auto;white-space:nowrap}.f{grid-column:1/-1!important}}
</style></head><body>
<header><span>🧬</span><b id="title"></b><span class="ver" id="ver"></span><span class="grow">grown from DNA · nothing here is hand-built</span></header>
<div class="shell"><nav id="nav"></nav><main id="main"></main></div>
<script>
const h=(t,a={},...kids)=>{const e=document.createElement(t);for(const[k,v]of Object.entries(a)){if(v==null)continue;if(k==="class")e.className=v;else if(k.startsWith("on"))e.addEventListener(k.slice(2),v);else e.setAttribute(k,v)}for(const c of kids.flat()){if(c!=null&&c!==false)e.append(c instanceof Node?c:String(c))}return e};
const get=(o,p)=>p==null||p===""?o:String(p).split(/\.|\[(\d+)\]/).filter(Boolean).reduce((x,k)=>x==null?undefined:x[k],o);
const isObj=v=>v!==null&&typeof v==="object"&&!Array.isArray(v);
const keep={get(k){try{return JSON.parse(localStorage.getItem(k))}catch{return null}},set(k,v){try{localStorage.setItem(k,JSON.stringify(v))}catch{}}};
let BODY;
const esc=s=>String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"}[c]));
function jsonView(v){const t=esc(JSON.stringify(v,null,2)??"undefined");const p=h("pre");p.innerHTML=t.replace(/("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false)\b|\bnull\b|-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/g,(m,str,colon,bool)=>str?(colon?'<span class="k">'+str+'</span>'+colon:'<span class="s">'+str+'</span>'):bool?'<span class="b">'+m+'</span>':m==="null"?'<span class="z">null</span>':'<span class="n">'+m+'</span>');return p}
function scalar(v){if(v===true)return h("span",{class:"yes"},"✔");if(v===false)return h("span",{class:"no"},"✘");if(v==null)return h("span",{class:"empty"},"—");if(typeof v==="object"){const s=JSON.stringify(v);return h("code",{title:s},s.length>80?s.slice(0,80)+"…":s)}return String(v)}
function table(rows,columns){if(!Array.isArray(rows))return auto(rows);if(!rows.length)return h("div",{class:"empty"},"nothing yet");
 let cols=columns?Object.entries(columns):[...new Set(rows.slice(0,20).flatMap(r=>isObj(r)?Object.keys(r):[]))].slice(0,8).map(k=>[k,k]);
 if(!cols.length)cols=[["value",""]];
 const body=h("tbody");
 for(const r of rows){const tr=h("tr",{class:"row"},cols.map(([,p])=>h("td",{},scalar(get(r,p)))));let open=null;
  tr.onclick=()=>{if(open){open.remove();open=null;return}open=h("tr",{},h("td",{class:"more",colspan:cols.length},jsonView(r)));tr.after(open)};body.append(tr)}
 return h("table",{},h("thead",{},h("tr",{},cols.map(([l])=>h("th",{},l)))),body)}
function auto(v){if(Array.isArray(v))return v.length&&v.every(isObj)?table(v):jsonView(v);
 if(isObj(v)){const keys=Object.keys(v);if(!keys.length)return h("div",{class:"empty"},"empty");
  return h("dl",{},keys.flatMap(k=>[h("dt",{},k),h("dd",{},isObj(v[k])||Array.isArray(v[k])?h("details",{},h("summary",{},Array.isArray(v[k])?v[k].length+" items":Object.keys(v[k]).length+" keys"),auto(v[k])):scalar(v[k]))]))}
 return h("pre",{},v==null?"—":String(v))}
function view(v,as,columns){return as==="json"?jsonView(v):as==="text"?h("pre",{},v==null?"":typeof v==="string"?v:JSON.stringify(v,null,2)):as==="table"?table(v,columns):auto(v)}
function fieldsOf(c){const f=c.skin.fields;return f?Object.entries(f).map(([n,s])=>({name:n,...(typeof s==="string"?{widget:s}:s)})):c.input.map(n=>({name:n}))}
function widget(f,saved){const v=saved??(f.default==null?"":typeof f.default==="object"?JSON.stringify(f.default,null,2):String(f.default));const w=f.widget||"text";
 if(w==="choose"){const s=h("select",{},(f.options||[]).map(o=>h("option",{value:o},o)));s.value=v||String((f.options||[])[0]??"");return s}
 if(w==="json"||w==="textarea"){const t=h("textarea",{placeholder:f.placeholder??(w==="json"?"{ }":""),spellcheck:"false"});t.value=v;return t}
 const i=h("input",{type:w==="number"?"number":"text",placeholder:f.placeholder??""});i.value=v;return i}
async function boot(){BODY=await(await fetch("/api/body")).json();document.getElementById("title").textContent=BODY.title;
 document.getElementById("ver").textContent=BODY.genome.name+" v"+BODY.genome.version+(BODY.genome.parent?" · from "+BODY.genome.parent:"");
 const nav=document.getElementById("nav");
 for(const c of BODY.cells)nav.append(h("button",{"data-cell":c.name,onclick:()=>{location.hash=c.name}},h("span",{class:"ic"},c.skin.icon||"◆"),c.skin.title||c.name));
 const want=decodeURIComponent(location.hash.slice(1))||keep.get("cell");open(BODY.cells.some(c=>c.name===want)?want:BODY.cells[0]?.name)}
window.addEventListener("hashchange",()=>BODY&&open(decodeURIComponent(location.hash.slice(1))));
function open(name){const c=BODY.cells.find(x=>x.name===name);if(!c)return;keep.set("cell",name);if(location.hash.slice(1)!==name)history.replaceState(null,"","#"+name);
 document.querySelectorAll("nav button").forEach(b=>b.classList.toggle("on",b.dataset.cell===name));
 const saved=keep.get("in:"+name)||{};const fields=fieldsOf(c);const els={};
 const form=h("form",{class:"form"});
 for(const f of fields){els[f.name]=widget(f,saved[f.name]);form.append(h("div",{class:"f",style:"grid-column:span "+Math.min(12,Math.max(1,+f.span||12))},h("label",{},f.label||f.name),els[f.name]))}
 const go=h("button",{class:"go",type:"submit"},c.skin.action||"Run");const hint=h("span",{class:"hint"},fields.length?"⌘/Ctrl + Enter":"");
 form.append(h("div",{class:"act"},go,hint));const out=h("div");
 async function run(){const values={},raw={};let bad=false;
  for(const f of fields){const el=els[f.name];const t=el.value;raw[f.name]=t;el.classList.remove("bad-in");if(t==="")continue;
   if(f.widget==="json"){try{values[f.name]=JSON.parse(t)}catch{el.classList.add("bad-in");bad=true}}else if(f.widget==="number")values[f.name]=Number(t);else values[f.name]=t}
  if(bad){hint.textContent="fix the highlighted JSON";return}
  keep.set("in:"+name,raw);go.disabled=true;const t0=Date.now();const tick=setInterval(()=>hint.textContent="growing… "+((Date.now()-t0)/1000).toFixed(1)+"s",100);
  try{const r=await(await fetch("/api/run/"+name,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(values)})).json();out.replaceChildren(result(c,r))}
  catch(e){out.replaceChildren(h("div",{class:"result"},h("div",{class:"err"},String(e))))}
  finally{clearInterval(tick);go.disabled=false;hint.textContent=fields.length?"⌘/Ctrl + Enter":""}}
 form.onsubmit=e=>{e.preventDefault();run()};form.onkeydown=e=>{if(e.key==="Enter"&&(e.metaKey||e.ctrlKey)){e.preventDefault();run()}};
 document.getElementById("main").replaceChildren(h("h1",{},(c.skin.icon?c.skin.icon+" ":"")+(c.skin.title||c.name)),c.skin.about?h("p",{class:"about"},c.skin.about):null,form,out);
 if(c.skin.auto)run()}
function result(c,r){const box=h("div",{class:"result"});
 if(r.error){box.append(h("div",{class:"err"},r.error));if(r.log?.length)box.append(h("div",{class:"pane"},h("pre",{},r.log.join("\n"))));return box}
 const val=c.skin.badge?get(r.output,c.skin.badge):r.state;const good=c.skin.good?c.skin.good.includes(val):!c.fatal.includes(r.state);
 box.append(h("div",{class:"rhead"},h("span",{class:"badge "+(good?"good":"bad")},val??r.state),r.summary?h("span",{},r.summary):null,h("span",{class:"trail"},(r.trail||[]).join(" → "))));
 const sections=(c.skin.show||[{label:"Output",path:""}]).map(s=>({label:s.label||s.path||"Output",make:()=>view(get(r.output,s.path),s.as,s.columns)}));
 const log=(r.log||[]).filter(l=>l.trim());if(log.length)sections.push({label:"Console",make:()=>h("pre",{},log.join("\n"))});
 const tabs=h("div",{class:"tabs"}),pane=h("div",{class:"pane"});
 sections.forEach((s,i)=>{const b=h("button",{onclick:()=>{tabs.querySelectorAll("button").forEach(x=>x.classList.remove("on"));b.classList.add("on");pane.replaceChildren(s.make())}},s.label);tabs.append(b);if(i===0){b.classList.add("on");pane.append(s.make())}});
 box.append(tabs,pane);return box}
boot();
</script></body></html>`;

// ─────────────── BIRTH ───────────────
type BirthOpts = { phenotype?: string; experience?: any; with?: Record<string, any>;
                   depth: number; prefix: string; budget?: Budget; trial?: boolean };

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
    self: { genome: dnaText(genome), name: genome.genome.name, version: v,   // the organism may read its DNA and its physics
            physics: { genes: CHEMISTRY, filters: Object.keys(FILTERS), state_keys: ["do", "as", "to", "on"],
                       skin: { keys: SKIN_KEYS, field_keys: FIELD_KEYS, widgets: WIDGETS, show_as: SHOW_AS } } },
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

  let heritage = before;
  org.flush = () => {   // bones outlive the run: saved after the root settles and after every UI action
    const now = JSON.stringify(Object.keys(bones).filter((b) => bones[b] === "heritable").map((b) => org.memory.scopes[b]));
    lock.bones = Object.fromEntries(Object.keys(bones).map((b) => [b, org.memory.scopes[b]]));
    if (now !== heritage) {
      heritage = now;
      lock.lineage.push(lock.version);
      const [x, y, p] = lock.version.split(".").map(Number);
      lock.version = `${x}.${y}.${p + 1}`;
      org.say(c.y(`  🧬 heritable memory changed → v${lock.version}`));
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(lockPath, JSON.stringify(lock, null, 2));
  };

  LIVING.add(org);
  let r;
  try { r = await org.run(pheno.grow, { ...(pheno.with ?? {}), ...(o.with ?? {}), experience }); }
  finally { if (!pheno.persist || o.trial) { org.close(); LIVING.delete(org); } }   // a trial never outlives its judgement
  org.settle();
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
