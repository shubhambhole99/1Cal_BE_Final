// Tools the specialist agents can call — the ONLY code path a specialist may
// use to reach the DB. The LLM chooses which to call with what arguments; the
// executor validates, enforces scope, writes / reads, and returns a JSON blob
// back to the model. Nothing else in the agent runtime touches SQL directly.
//
// Contract: TOOL_SCHEMAS is the OpenAI-compatible tool list to pass to Together
// alongside the specialist's messages. runTool(name, args, ctx) is the single
// executor; ctx = { sql, userId, reportId, instanceId, chatId }. Every tool
// requires ctx.instanceId (a chat scoped to a report). Missing scope → error
// returned to the model, not a crash.
//
// Every per-item tool takes ONE OR MANY items in a single call (keys /
// changes / targets) and answers with results[], one entry per item. There is
// no separate single-item variant: asking for one thing is a batch of one.
//
// There is deliberately no tool that reads a sheet CELL. The BE stores only
// the raw value from the last save and has no formula engine; the live number
// exists only in the browser. Cell values reach the agent inlined in the user
// message (ChatPanel → 1cal:query-cells → RetemplateTwo's engine).
//
// One_time paywall, ownership check and broadcast fanout are handled by the
// same guardOneTimeInput / checkInstancePermission / broadcast helpers the
// HTTP handler uses, so an MI write from the LLM behaves exactly like a user
// edit in the sidebar.

import { broadcast } from "../lib/events.js";
import { guardOneTimeInput } from "../controller/entitlementsController.js";
import { checkInstancePermission, ensureOpenAccessCol } from "../controller/v3Controller.js";
import { newObjectId } from "../utils/objectId.js";

const SCHEMA = process.env.DB_SCHEMA ?? "prod";
const T = {
  master_input: `"${SCHEMA}"."v3_master_input"`,
  instance_mi: `"${SCHEMA}"."v3_instance_master_input"`,
  v3_instances: `"${SCHEMA}"."v3_instances"`,
  v3_templates: `"${SCHEMA}"."v3_templates"`,
};

const MAX_ROWS = 40;
const MAX_BATCH = 50;
const MAX_QUERY_LEN = 80;
const MAX_KEY_LEN = 200;
const MAX_VALUE_LEN = 2000;
const MAX_SHEET_LEN = 200;
const MAX_CELL_LEN = 16;

const A1_RE = /^[A-Z]+\d+$/;
const KIND_ENUM = ["cell", "mi"];

function err(message, extra = {}) {
  return { ok: false, error: String(message || "error"), ...extra };
}

function requireInstance(ctx) {
  if (!ctx || !ctx.instanceId) {
    return err("This tool requires an open report — no instance is bound to this chat.");
  }
  if (!ctx.sql) return err("Internal: SQL client missing.");
  return null;
}

// Resolve the composed instance version — mirrors resolveInstanceVersion in the
// v3 controller but read-only and inline (we only need it to filter MI rows by
// version_id, same as GET /v3/instances/:id/master-inputs).
async function loadInstanceVersion(sql, instanceId) {
  const [inst] = await sql.unsafe(
    `SELECT i.template_id, i.version_id, t.published_version_id
       FROM ${T.v3_instances} i
       LEFT JOIN ${T.v3_templates} t ON t.id = i.template_id
      WHERE i.id = $1 LIMIT 1`,
    [instanceId],
  );
  if (!inst) return null;
  return {
    templateId: inst.template_id,
    versionId: inst.version_id || inst.published_version_id || null,
  };
}

// One query for any number of keys: `keys` null → every MI on the instance.
async function fetchComposedRows(sql, instanceId, { keys = null } = {}) {
  const v = await loadInstanceVersion(sql, instanceId);
  if (!v) return { error: "Instance not found", rows: [] };
  const rows = await sql.unsafe(
    `SELECT tmi.id, tmi.id AS template_mi_id, tmi.template_id, tmi.key, tmi.display_name,
            tmi.ref, tmi.type, tmi.options, tmi.section, tmi.ord, tmi.kind,
            COALESCE(tmi.one_time, FALSE) AS one_time,
            (imi.value IS NOT NULL) AS has_instance_value,
            COALESCE(imi.value, tmi.default_value, tmi.value) AS value
       FROM ${T.master_input} tmi
       LEFT JOIN ${T.instance_mi} imi
         ON imi.instance_id = $1
        AND (imi.template_mi_key = tmi.key OR (imi.template_mi_key IS NULL AND imi.template_mi_id = tmi.id))
      WHERE tmi.template_id = $2
        AND ($3::text IS NULL OR tmi.version_id = $3)
        AND ($4::text[] IS NULL OR tmi.key = ANY($4::text[]))
      ORDER BY tmi.ord ASC`,
    [instanceId, v.templateId, v.versionId, keys],
  );
  return { rows, templateId: v.templateId, versionId: v.versionId };
}

// Keys are not unique in the DB, so every requested key must resolve to
// exactly one row — 0 or >1 hits are reported per item, never guessed.
function indexByKey(rows) {
  const m = new Map();
  for (const r of rows) {
    const list = m.get(r.key);
    if (list) list.push(r);
    else m.set(r.key, [r]);
  }
  return m;
}

function resolveKey(byKey, key) {
  const hits = byKey.get(key) || [];
  if (!hits.length) return { error: `No master input with key "${key}" in this project. Call list_master_inputs first.` };
  if (hits.length > 1) return { error: `Ambiguous: ${hits.length} master inputs share key "${key}". Refusing to guess.` };
  return { row: hits[0] };
}

function coerceValueForType(type, raw) {
  // MI values are stored as TEXT regardless of `type` — the FE parses at read
  // time. We only sanity-check the shape here. Empty string is the "clear"
  // signal for every type — mirrors the FE's own MI editor: blanking a field
  // removes the instance override so the template default takes over.
  if (raw == null) return { ok: true, coerced: "" };
  const s = String(raw);
  if (s.length > MAX_VALUE_LEN) return { ok: false, why: `value exceeds ${MAX_VALUE_LEN} characters` };
  if (s === "") return { ok: true, coerced: "" };
  if (type === "number") {
    const n = Number(s);
    if (!Number.isFinite(n)) return { ok: false, why: `value "${s}" is not a valid number` };
    return { ok: true, coerced: String(n) };
  }
  if (type === "boolean") {
    const lower = s.trim().toLowerCase();
    if (["true", "yes", "on", "1"].includes(lower)) return { ok: true, coerced: "true" };
    if (["false", "no", "off", "0"].includes(lower)) return { ok: true, coerced: "false" };
    return { ok: false, why: `value "${s}" is not a boolean (expected true/false/yes/no)` };
  }
  return { ok: true, coerced: s };
}

// A select MI stores options as JSONB — sometimes it comes back as an array,
// sometimes as a stringified array (older rows). Normalise once here.
function parseOptions(raw) {
  if (Array.isArray(raw)) return raw.map((x) => String(x));
  if (raw == null || raw === "") return [];
  if (typeof raw === "string") {
    try { const p = JSON.parse(raw); return Array.isArray(p) ? p.map((x) => String(x)) : []; } catch { return []; }
  }
  return [];
}

// ── Argument collectors: one method, batch or single ─────────────────────────
// Each accepts the batch field (keys / changes / targets) and, because models
// sometimes send the single shape anyway, the bare single-item fields too.

function collectKeys(args) {
  const raw = Array.isArray(args?.keys) ? args.keys : (args?.key != null ? [args.key] : []);
  const out = [];
  const seen = new Set();
  for (const k of raw) {
    const key = String(k ?? "").trim().slice(0, MAX_KEY_LEN);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(key);
  }
  return out;
}

function collectChanges(args) {
  const has = (o, f) => !!o && typeof o === "object" && Object.prototype.hasOwnProperty.call(o, f);
  const raw = Array.isArray(args?.changes) ? args.changes : (has(args, "key") ? [args] : []);
  return raw.map((c) => ({
    key: String(c?.key ?? "").trim().slice(0, MAX_KEY_LEN),
    hasValue: has(c, "value"),
    value: c?.value,
  }));
}

function collectTargets(args) {
  if (Array.isArray(args?.targets)) return args.targets;
  if (args && args.kind) return [args];
  return [];
}

// ── Tool executors ──────────────────────────────────────────────────────────

// Master-input names are written freely — "Rent(Residential Rs/Sqft)", "Land
// Cost (₹ lakhs)" — while people ask for "rent per sqft" or "land rate". So a
// query is matched word by word on a normalised form, and the rows that match
// the most words come first. A whole-query substring hit still ranks highest.
const MATCH_STOPWORDS = new Set(["per", "the", "a", "an", "of", "to", "in", "for", "on", "and", "value", "input", "inputs"]);
function normaliseForMatch(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/₹/g, " rs ")
    .replace(/\brs\.?/g, " rs ")
    .replace(/square\s*f(ee|oo)t|sq\.?\s*f(ee|oo)?t|sq\.?\s*ft/g, " sqft ")
    .replace(/square\s*met(er|re)s?|sq\.?\s*m\b|sqm/g, " sqm ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
function matchScore(row, qNorm, qWords) {
  const hay = normaliseForMatch(`${row.key || ""} ${row.display_name || ""} ${row.section || ""} ${row.ref || ""}`);
  const hayWords = hay.split(" ");
  let score = 0;
  for (const w of qWords) {
    if (hayWords.some((h) => h === w || (w.length >= 3 && h.startsWith(w)))) score += 1;
  }
  if (qNorm && hay.includes(qNorm)) score += qWords.length + 1; // the whole phrase, verbatim
  return score;
}

// Monthly-series inputs ("…_m1" … "…_m168": one per month per cost head) are
// 98% of all inputs. On equal scores they go after the real inputs, otherwise
// a one-word query like "rent" returns 40 "Rent — Predicted % (Month N)" rows
// and the input the user meant never reaches the model.
const isMonthlySeries = (r) => /_m\d+$/.test(String(r.key || ""));

async function list_master_inputs({ sql, instanceId }, args) {
  const q = String(args?.query || "").trim().slice(0, MAX_QUERY_LEN);
  const { rows, error } = await fetchComposedRows(sql, instanceId);
  if (error) return err(error);
  const qNorm = normaliseForMatch(q);
  const qWords = [...new Set(qNorm.split(" ").filter((w) => w && !MATCH_STOPWORDS.has(w)))];
  const filtered = (qWords.length
    ? rows.map((r) => ({ r, score: matchScore(r, qNorm, qWords) })).filter((x) => x.score > 0)
    : rows.map((r) => ({ r, score: 0 })))
    .sort((a, b) => b.score - a.score || isMonthlySeries(a.r) - isMonthlySeries(b.r))
    .map((x) => x.r);
  const truncated = filtered.length > MAX_ROWS;
  const shown = filtered.slice(0, MAX_ROWS).map((r) => ({
    key: r.key,
    display_name: r.display_name,
    section: r.section,
    type: r.type,
    ref: r.ref,
    value: r.value,
    has_instance_value: !!r.has_instance_value,
    one_time: !!r.one_time,
  }));
  return { ok: true, total: filtered.length, shown_count: shown.length, truncated, items: shown };
}

async function get_master_inputs({ sql, instanceId }, args) {
  const keys = collectKeys(args);
  if (!keys.length) return err("`keys` is required — put every key you need in one call (a single key is fine).");
  if (keys.length > MAX_BATCH) return err(`Too many keys (${keys.length}); at most ${MAX_BATCH} per call.`);
  const { rows, error } = await fetchComposedRows(sql, instanceId, { keys });
  if (error) return err(error);
  const byKey = indexByKey(rows);
  const results = keys.map((key) => {
    const { row, error: e } = resolveKey(byKey, key);
    if (e) return { key, ok: false, error: e };
    return {
      key: row.key,
      ok: true,
      display_name: row.display_name,
      section: row.section,
      type: row.type,
      ref: row.ref,
      value: row.value,
      has_instance_value: !!row.has_instance_value,
      one_time: !!row.one_time,
    };
  });
  const found = results.filter((r) => r.ok).length;
  return { ok: found > 0, requested: keys.length, found, results };
}

// Apply one change of a set_master_inputs batch. Returns a result item; never
// throws for expected failures so one bad change can't sink the others.
async function applyChange(sql, instanceId, templateId, byKey, dupes, c) {
  if (!c.key) return { key: "", ok: false, error: "`key` is required on every change." };
  if (dupes.has(c.key)) return { key: c.key, ok: false, error: `"${c.key}" appears more than once in this batch — send each key once.` };
  // The schema says string; a null / missing value would silently become "".
  if (!c.hasValue || c.value === null || c.value === undefined) {
    return { key: c.key, ok: false, error: '`value` is required; send an explicit string ("" clears the override).' };
  }
  const { row: tmi, error } = resolveKey(byKey, c.key);
  if (error) return { key: c.key, ok: false, error };

  const coerced = coerceValueForType(tmi.type, c.value);
  if (!coerced.ok) return { key: tmi.key, ok: false, error: coerced.why };
  const nextValue = coerced.coerced;

  if (tmi.type === "select" && nextValue !== "") {
    const opts = parseOptions(tmi.options);
    if (opts.length && !opts.includes(nextValue)) {
      return { key: tmi.key, ok: false, error: `value "${nextValue}" is not one of the allowed options: ${opts.join(", ")}` };
    }
  }

  // Paywall: one_time inputs are free once, then charged. The guard reads the
  // stored value; applying changes one at a time keeps that read honest.
  const gate = await guardOneTimeInput(sql, null, instanceId, { key: tmi.key, one_time: tmi.one_time }, nextValue);
  if (!gate.ok) {
    return {
      key: tmi.key,
      ok: false,
      error: gate.body?.error || "This input needs an upgrade before it can be changed again.",
      code: gate.body?.code,
      current_value: gate.body?.current_value,
    };
  }

  // UPSERT — same query as patchInstanceMasterInput.
  await sql.unsafe(
    `INSERT INTO ${T.instance_mi} (id, instance_id, template_mi_id, template_mi_key, value)
     VALUES ($1, $2, $3, $4, $5)
     ON CONFLICT (instance_id, template_mi_key)
     DO UPDATE SET value = EXCLUDED.value, template_mi_id = EXCLUDED.template_mi_id`,
    [newObjectId(), instanceId, tmi.template_mi_id, tmi.key, nextValue],
  );

  broadcast({
    type: "masterInput.updated",
    scope: "instance",
    instanceId,
    templateId,
    key: tmi.key,
    ref: tmi.ref,
    value: nextValue,
    clientId: null,
  });

  return {
    key: tmi.key,
    ok: true,
    display_name: tmi.display_name,
    ref: tmi.ref,
    section: tmi.section,
    type: tmi.type,
    previous_value: tmi.value,
    new_value: nextValue,
  };
}

async function set_master_inputs(ctx, args) {
  const { sql, instanceId, userId } = ctx;
  const changes = collectChanges(args);
  if (!changes.length) return err('`changes` is required — e.g. [{"key":"Plot Area","value":"1000"}]. One change is fine.');
  if (changes.length > MAX_BATCH) return err(`Too many changes (${changes.length}); at most ${MAX_BATCH} per call.`);

  // Permission once for the whole batch — the canonical check the HTTP handler
  // uses (collaborator shapes, open_access enum).
  await ensureOpenAccessCol(sql);
  const perm = await checkInstancePermission(sql, instanceId, userId);
  if (!perm.ok) return err(perm.error || "You are not authorised to change values on this report.");
  const uid = userId == null ? null : String(userId);
  // First authenticated edit of an owner-less instance claims ownership.
  if (perm.inst && !perm.inst.user_id && uid) {
    try { await sql.unsafe(`UPDATE ${T.v3_instances} SET user_id = $1 WHERE id = $2 AND user_id IS NULL`, [uid, instanceId]); } catch { /* non-fatal */ }
  }

  const keys = [...new Set(changes.map((c) => c.key).filter(Boolean))];
  const { rows, error, templateId } = await fetchComposedRows(sql, instanceId, { keys });
  if (error) return err(error);
  const byKey = indexByKey(rows);

  // A key named twice in one batch is ambiguous intent — refuse every copy.
  const seen = new Set();
  const dupes = new Set();
  for (const c of changes) {
    if (!c.key) continue;
    if (seen.has(c.key)) dupes.add(c.key);
    seen.add(c.key);
  }

  const results = [];
  for (const c of changes) {
    results.push(await applyChange(sql, instanceId, templateId, byKey, dupes, c));
  }
  const written = results.filter((r) => r.ok).length;
  return { ok: written > 0, requested: changes.length, written, instance_id: instanceId, results };
}

function checkTarget(t) {
  const kind = String(t?.kind || "").trim().toLowerCase();
  if (!KIND_ENUM.includes(kind)) return { ok: false, kind, error: `\`kind\` must be one of ${KIND_ENUM.join(", ")}; got "${kind}".` };
  if (kind === "cell") {
    const sheet = String(t?.sheet || "").trim().slice(0, MAX_SHEET_LEN);
    const cell = String(t?.cell || "").trim().toUpperCase().slice(0, MAX_CELL_LEN);
    if (!sheet) return { ok: false, kind, error: "For a cell highlight, `sheet` is required." };
    if (!A1_RE.test(cell)) return { ok: false, kind, sheet, error: `\`cell\` must be A1 like "F17"; got "${cell}".` };
    return { ok: true, kind, sheet, cell };
  }
  const key = String(t?.key || "").trim().slice(0, MAX_KEY_LEN);
  if (!key) return { ok: false, kind, error: "For an input highlight, `key` is required." };
  return { ok: true, kind, key };
}

async function highlight({ instanceId }, args) {
  const targets = collectTargets(args);
  if (!targets.length) return err('`targets` is required — e.g. [{"kind":"cell","sheet":"Area","cell":"G30"}]. One target is fine.');
  if (targets.length > MAX_BATCH) return err(`Too many targets (${targets.length}); at most ${MAX_BATCH} per call.`);
  const results = targets.map(checkTarget);
  return { ok: results.some((r) => r.ok), instance_id: instanceId, results };
}

const EXECUTORS = {
  list_master_inputs,
  get_master_inputs,
  set_master_inputs,
  highlight,
};

export const TOOL_NAMES = Object.keys(EXECUTORS);

// OpenAI-compatible tool descriptors — passed to Together's chat/completions
// as the `tools` array. Descriptions read as user-visible tool docs; the model
// picks tools by their description as much as by name.
export const TOOL_SCHEMAS = {
  list_master_inputs: {
    type: "function",
    function: {
      name: "list_master_inputs",
      description:
        "List the user-facing master inputs on this project (or a filtered subset). Use this to find exact keys before reading or changing inputs. Returns up to " + MAX_ROWS + " rows; if truncated=true, narrow your query.",
      parameters: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Optional search words, e.g. \"rent sqft\" or \"land cost\". Matched word by word (case-insensitive, ₹/Rs and sqft spellings normalised) against key, display_name, section and cell ref; best matches first. Leave blank to list all.",
          },
        },
      },
    },
  },
  get_master_inputs: {
    type: "function",
    function: {
      name: "get_master_inputs",
      description:
        "Read the current value of one or more master inputs in ONE call. Put EVERY key you need into `keys` — never call this once per key. Returns results[] with { key, ok, value, display_name, type, ref, section } per key, or { key, ok:false, error } for a key that doesn't exist. Never invent a key — use list_master_inputs to find it.",
      parameters: {
        type: "object",
        properties: {
          keys: {
            type: "array",
            items: { type: "string" },
            description: `The exact master-input keys, e.g. ["Plot Area", "Road Width"]. One key is fine; up to ${MAX_BATCH}.`,
          },
        },
        required: ["keys"],
      },
    },
  },
  set_master_inputs: {
    type: "function",
    function: {
      name: "set_master_inputs",
      description:
        "Change one or more master inputs in ONE call — put every change into `changes`. Writes to the database and the user's sheet recomputes. Use ONLY when the user explicitly asked for the change; never guess a value. Each change succeeds or fails on its own (results[].ok). ONE_TIME_INPUT_LOCKED means that input needs an upgrade — tell the user, don't retry.",
      parameters: {
        type: "object",
        properties: {
          changes: {
            type: "array",
            description: `One entry per input to change; up to ${MAX_BATCH}. Each key at most once.`,
            items: {
              type: "object",
              properties: {
                key: { type: "string", description: "The exact master-input key." },
                value: { type: "string", description: "The new value as a string: numbers like \"1000\", booleans \"true\"/\"false\". Empty string clears the override." },
              },
              required: ["key", "value"],
            },
          },
        },
        required: ["changes"],
      },
    },
  },
  highlight: {
    type: "function",
    function: {
      name: "highlight",
      description:
        "Flash-highlight one or more cells or master-input rows in the user's browser so their eye lands on what you're explaining. UI cue only — no DB write. Put every target into `targets` in ONE call.",
      parameters: {
        type: "object",
        properties: {
          targets: {
            type: "array",
            description: `Up to ${MAX_BATCH} targets.`,
            items: {
              type: "object",
              properties: {
                kind: { type: "string", enum: KIND_ENUM, description: "\"cell\" for a page cell; \"mi\" for a master-input row." },
                sheet: { type: "string", description: "kind=\"cell\" only: the page name or a unique prefix." },
                cell: { type: "string", description: "kind=\"cell\" only: A1 address, e.g. \"G30\"." },
                key: { type: "string", description: "kind=\"mi\" only: the master-input key." },
              },
              required: ["kind"],
            },
          },
        },
        required: ["targets"],
      },
    },
  },
};

// runTool(name, args, ctx) — the single executor. Returns a plain JSON-serialisable
// object; the orchestrator JSON.stringifies it into the tool-role message.
// Never throws for expected failures (bad key, missing scope, permission) — those
// come back as { ok: false, error } (per item inside results[] for batches).
// Unexpected exceptions (DB down) are caught once and returned as an error too,
// so the model always gets a reply.
export async function runTool(name, args, ctx) {
  const fn = EXECUTORS[name];
  if (!fn) return err(`Unknown tool "${name}".`);
  const missing = requireInstance(ctx);
  if (missing) return missing;
  const t0 = Date.now();
  try {
    const out = await fn(ctx, args || {});
    return { ...out, ms: Date.now() - t0 };
  } catch (e) {
    console.error(`[agents.tools] ${name} failed:`, e?.message || e);
    return { ok: false, error: `Tool "${name}" failed: ${e?.message || e}`, ms: Date.now() - t0 };
  }
}
