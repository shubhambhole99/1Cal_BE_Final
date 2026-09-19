// HTTP handlers for /v3/agents. See README.md — "HTTP".
//
// Every handler awaits ready() (ensure tables + seed agents, once per process)
// and wraps its body in try/catch → 500 { error }.

import { getSql } from "../db/index.js";
import { newObjectId } from "../utils/objectId.js";
import { verifiedUserId, V3_AUTH_STRICT } from "../middleware/v3Auth.js";
import { chat as togetherChat } from "./together.js";
import { T, ready, agentByKey, PROJECT_AGENT_KEYS } from "./registry.js";
import { run } from "./orchestrator.js";

const HISTORY_LIMIT = 20;
const TITLE_CHARS = 60;
const MAX_CONTENT_CHARS = 4000; // one user message; longer → 400
const SCOPES = new Set(["home", "instance"]);

// Same fallback requesterId() uses in v3Controller.js: the verified token wins;
// otherwise (outside strict mode) the caller names itself in the body or query.
function requesterId(req) {
  const verified = verifiedUserId(req);
  if (verified) return verified;
  if (V3_AUTH_STRICT) return null;
  const b = req.body || {};
  const q = req.query || {};
  const id = b.user_id ?? b.userid ?? q.user_id ?? q.userid ?? null;
  return id == null ? null : String(id);
}

// Whose chat it is, for the ownership check: the verified token wins, else the
// id the caller names in the body or query. Another user's chat is answered
// 404 (never 403) so the id does not confirm that the chat exists.
function requesterOf(req) {
  return verifiedUserId(req) || req.body?.user_id || req.query?.user_id || null;
}

const str = (v) => (v == null ? null : String(v).trim() || null);

function fail(res, e, where) {
  console.error(`[agents] ${where}:`, e?.message || e);
  const status = Number.isInteger(e?.status) && e.status >= 400 && e.status < 600 ? e.status : 500;
  res.status(status).json({ error: String(e?.message || e) });
}

// Sum every message of a chat: what GET chats/:id and POST …/messages return.
async function chatTotals(sql, chatId) {
  const [t] = await sql.unsafe(
    `SELECT COALESCE(SUM(input_tokens),0)::int AS input_tokens,
            COALESCE(SUM(output_tokens),0)::int AS output_tokens,
            COALESCE(SUM(reasoning_tokens),0)::int AS reasoning_tokens,
            COUNT(*)::int AS messages
       FROM ${T.messages} WHERE chat_id = $1`,
    [chatId],
  );
  return t || { input_tokens: 0, output_tokens: 0, reasoning_tokens: 0, messages: 0 };
}

// The driver hands jsonb back as text; presets travel as objects.
function withData(row) {
  if (!row) return row;
  if (typeof row.data !== "string") return row;
  try { return { ...row, data: JSON.parse(row.data) || {} }; } catch { return { ...row, data: {} }; }
}

// ── usage ───────────────────────────────────────────────────────────────────
// What the assistant has actually spent, read back out of the steps every
// answer stores: one row per model call, each carrying its own token counts.
// `cached` is the slice of input tokens Together served from its prefix cache.

const STEPS_ARRAY = (alias) => `CASE WHEN jsonb_typeof(${alias}.steps) = 'array' THEN ${alias}.steps ELSE '[]'::jsonb END`;

export async function getUsage(req, res) {
  try {
    await ready();
    const sql = getSql();
    const model = str(req.query.model);

    const byModel = await sql.unsafe(
      `SELECT COALESCE(s->>'model', 'unknown') AS model,
              COUNT(*)::int AS calls,
              COALESCE(SUM((s->>'input_tokens')::int), 0)::int AS input_tokens,
              COALESCE(SUM((s->>'cached_tokens')::int), 0)::int AS cached_tokens,
              COALESCE(SUM((s->>'output_tokens')::int), 0)::int AS output_tokens,
              COALESCE(SUM((s->>'reasoning_tokens')::int), 0)::int AS reasoning_tokens
         FROM ${T.messages} m, LATERAL jsonb_array_elements(${STEPS_ARRAY("m")}) s
        WHERE ($1::text IS NULL OR s->>'model' = $1)
        GROUP BY 1 ORDER BY 4 DESC`,
      [model],
    );

    const byUser = await sql.unsafe(
      `SELECT c.user_id,
              COALESCE(
                NULLIF(TRIM(COALESCE(u.first_name, '') || ' ' || COALESCE(u.last_name, '')), ''),
                NULLIF(TRIM(u.full_name), ''), NULLIF(TRIM(u.name), ''),
                NULLIF(TRIM(u.email), ''), u.username,
                'Unknown user · ' || LEFT(c.user_id, 8)
              ) AS user_name,
              COUNT(DISTINCT m.id)::int AS answers,
              COALESCE(SUM((s->>'input_tokens')::int), 0)::int AS input_tokens,
              COALESCE(SUM((s->>'cached_tokens')::int), 0)::int AS cached_tokens,
              COALESCE(SUM((s->>'output_tokens')::int), 0)::int AS output_tokens,
              COALESCE(SUM((s->>'input_tokens')::int) + SUM((s->>'output_tokens')::int), 0)::int AS total_tokens
         FROM ${T.messages} m
         JOIN ${T.chats} c ON c.id = m.chat_id
         LEFT JOIN ${T.users} u ON u.id::text = c.user_id::text,
         LATERAL jsonb_array_elements(${STEPS_ARRAY("m")}) s
        WHERE ($1::text IS NULL OR s->>'model' = $1)
        GROUP BY c.user_id, user_name
        ORDER BY total_tokens DESC
        LIMIT 20`,
      [model],
    );

    const byAgent = await sql.unsafe(
      `SELECT COALESCE(s->>'agent', '?') AS agent,
              COUNT(*)::int AS calls,
              COALESCE(SUM((s->>'input_tokens')::int) + SUM((s->>'output_tokens')::int), 0)::int AS total_tokens
         FROM ${T.messages} m, LATERAL jsonb_array_elements(${STEPS_ARRAY("m")}) s
        WHERE ($1::text IS NULL OR s->>'model' = $1)
        GROUP BY 1 ORDER BY total_tokens DESC`,
      [model],
    );

    const total = byModel.reduce((t, r) => ({
      calls: t.calls + r.calls,
      input_tokens: t.input_tokens + r.input_tokens,
      cached_tokens: t.cached_tokens + r.cached_tokens,
      output_tokens: t.output_tokens + r.output_tokens,
      reasoning_tokens: t.reasoning_tokens + r.reasoning_tokens,
    }), { calls: 0, input_tokens: 0, cached_tokens: 0, output_tokens: 0, reasoning_tokens: 0 });

    res.json({ total, byModel, byUser, byAgent });
  } catch (e) {
    fail(res, e, "getUsage");
  }
}

// ── context library ─────────────────────────────────────────────────────────
// Reusable documents an agent can be fed. An agent's own `context` column still
// applies; attached library documents are appended to it (see orchestrator.js).

const ctxIds = (v) => (Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : []);

export async function listContexts(_req, res) {
  try {
    await ready();
    const sql = getSql();
    const contexts = await sql.unsafe(
      `SELECT c.id, c.name, c.description, COALESCE(length(c.body), 0)::int AS chars,
              c.created_at, c.updated_at,
              (SELECT COUNT(*) FROM ${T.agents} a WHERE a.context_ids @> to_jsonb(c.id::text))::int AS agents
         FROM ${T.contexts} c ORDER BY c.name ASC`,
    );
    res.json({ contexts });
  } catch (e) {
    fail(res, e, "listContexts");
  }
}

export async function getContext(req, res) {
  try {
    await ready();
    const sql = getSql();
    const [row] = await sql.unsafe(`SELECT * FROM ${T.contexts} WHERE id = $1`, [str(req.params.id)]);
    if (!row) return res.status(404).json({ error: "Context not found" });
    res.json({ context: row });
  } catch (e) {
    fail(res, e, "getContext");
  }
}

export async function createContext(req, res) {
  try {
    await ready();
    const name = str(req.body?.name);
    if (!name) return res.status(400).json({ error: "A context needs a name" });
    const sql = getSql();
    const [row] = await sql.unsafe(
      `INSERT INTO ${T.contexts} (id, name, description, body) VALUES ($1, $2, $3, $4)
         RETURNING id, name, description, COALESCE(length(body), 0)::int AS chars, created_at, updated_at`,
      [newObjectId(), name, str(req.body?.description), req.body?.body == null ? "" : String(req.body.body)],
    );
    res.status(201).json({ context: row });
  } catch (e) {
    fail(res, e, "createContext");
  }
}

export async function updateContext(req, res) {
  try {
    await ready();
    const id = str(req.params.id);
    const b = req.body || {};
    const sets = [];
    const params = [id];
    for (const f of ["name", "description", "body"]) {
      if (!Object.prototype.hasOwnProperty.call(b, f)) continue;
      if (f === "name" && !str(b.name)) return res.status(400).json({ error: "A context needs a name" });
      params.push(b[f] == null ? null : String(b[f]));
      sets.push(`"${f}" = $${params.length}`);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    const sql = getSql();
    const [row] = await sql.unsafe(
      `UPDATE ${T.contexts} SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1
         RETURNING id, name, description, COALESCE(length(body), 0)::int AS chars, created_at, updated_at`,
      params,
    );
    if (!row) return res.status(404).json({ error: "Context not found" });
    res.json({ context: row });
  } catch (e) {
    fail(res, e, "updateContext");
  }
}

export async function deleteContext(req, res) {
  try {
    await ready();
    const id = str(req.params.id);
    const sql = getSql();
    // Detach it everywhere first, so no agent points at a document that is gone.
    await sql.unsafe(
      `UPDATE ${T.agents} SET context_ids = context_ids - $1 WHERE context_ids @> to_jsonb($1::text)`,
      [id],
    );
    const [row] = await sql.unsafe(`DELETE FROM ${T.contexts} WHERE id = $1 RETURNING id`, [id]);
    if (!row) return res.status(404).json({ error: "Context not found" });
    res.json({ ok: true, id: row.id });
  } catch (e) {
    fail(res, e, "deleteContext");
  }
}

// ── budget presets ──────────────────────────────────────────────────────────
// A preset is a named set of budget assumptions — monthly budget, users,
// prices, exchange rate, output share. One list, offered on every model.

export async function listBudgets(_req, res) {
  try {
    await ready();
    const sql = getSql();
    const presets = await sql.unsafe(
      `SELECT id, name, data, created_at, updated_at FROM ${T.budgets} ORDER BY name ASC`,
    );
    res.json({ presets: presets.map(withData) });
  } catch (e) {
    fail(res, e, "listBudgets");
  }
}

export async function createBudget(req, res) {
  try {
    await ready();
    const name = str(req.body?.name);
    if (!name) return res.status(400).json({ error: "A preset needs a name" });
    const data = req.body?.data && typeof req.body.data === "object" ? req.body.data : {};
    const sql = getSql();
    const [row] = await sql.unsafe(
      `INSERT INTO ${T.budgets} (id, name, data) VALUES ($1, $2, $3::jsonb)
         RETURNING id, name, data, created_at, updated_at`,
      [newObjectId(), name, JSON.stringify(data)],
    );
    res.status(201).json({ preset: withData(row) });
  } catch (e) {
    fail(res, e, "createBudget");
  }
}

export async function updateBudget(req, res) {
  try {
    await ready();
    const id = str(req.params.id);
    const sets = [];
    const params = [id];
    if (Object.prototype.hasOwnProperty.call(req.body || {}, "name")) {
      const name = str(req.body.name);
      if (!name) return res.status(400).json({ error: "A preset needs a name" });
      params.push(name);
      sets.push(`name = $${params.length}`);
    }
    if (req.body?.data && typeof req.body.data === "object") {
      params.push(JSON.stringify(req.body.data));
      sets.push(`data = $${params.length}::jsonb`);
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    const sql = getSql();
    const [row] = await sql.unsafe(
      `UPDATE ${T.budgets} SET ${sets.join(", ")}, updated_at = NOW() WHERE id = $1
         RETURNING id, name, data, created_at, updated_at`,
      params,
    );
    if (!row) return res.status(404).json({ error: "Preset not found" });
    res.json({ preset: withData(row) });
  } catch (e) {
    fail(res, e, "updateBudget");
  }
}

export async function deleteBudget(req, res) {
  try {
    await ready();
    const sql = getSql();
    const [row] = await sql.unsafe(`DELETE FROM ${T.budgets} WHERE id = $1 RETURNING id`, [str(req.params.id)]);
    if (!row) return res.status(404).json({ error: "Preset not found" });
    res.json({ ok: true, id: row.id });
  } catch (e) {
    fail(res, e, "deleteBudget");
  }
}

// ── agents ──────────────────────────────────────────────────────────────────

export async function listAgents(_req, res) {
  try {
    await ready();
    const sql = getSql();
    const agents = await sql.unsafe(
      `SELECT key, name, description, parent_key, thinking, model, pos_x, pos_y,
              COALESCE(disabled, FALSE) AS disabled, COALESCE(edited, FALSE) AS edited,
              COALESCE(context_ids, '[]'::jsonb) AS context_ids,
              COALESCE(length(context), 0)::int AS context_chars
         FROM ${T.agents} ORDER BY sort ASC, key ASC`,
    );
    res.json({ agents, project_keys: PROJECT_AGENT_KEYS });
  } catch (e) {
    fail(res, e, "listAgents");
  }
}

// What answers have cost so far, for the admin budget calculator: the number
// of answered questions, the average tokens per answer, the output share of
// those tokens, and this calendar month's totals. Read-only aggregates.
export async function getStats(_req, res) {
  try {
    await ready();
    const sql = getSql();
    const [s] = await sql.unsafe(
      `SELECT COUNT(*)::int AS questions,
              COALESCE(ROUND(AVG(input_tokens + output_tokens)), 0)::int AS avg_total_tokens,
              SUM(output_tokens)::float / NULLIF(SUM(input_tokens + output_tokens), 0) AS output_share,
              COALESCE(SUM(input_tokens) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::int AS month_input_tokens,
              COALESCE(SUM(output_tokens) FILTER (WHERE created_at >= date_trunc('month', NOW())), 0)::int AS month_output_tokens
         FROM ${T.messages}
        WHERE role = 'assistant' AND input_tokens + output_tokens > 0`,
    );
    res.json({ stats: s });
  } catch (e) {
    fail(res, e, "getStats");
  }
}

export async function getAgent(req, res) {
  try {
    await ready();
    const sql = getSql();
    const [agent] = await sql.unsafe(`SELECT * FROM ${T.agents} WHERE key = $1 LIMIT 1`, [String(req.params.key)]);
    if (!agent) return res.status(404).json({ error: "Agent not found" });
    res.json({ agent });
  } catch (e) {
    fail(res, e, "getAgent");
  }
}

// ── chats ───────────────────────────────────────────────────────────────────

// Fields an admin may change. Touching any of the content ones marks the row
// `edited`, which stops the seed in registry.js from overwriting it on boot.
const AGENT_TEXT_FIELDS = ["name", "description", "model", "system_prompt", "context"];

export async function patchAgent(req, res) {
  try {
    await ready();
    const key = str(req.params.key);
    const b = req.body || {};
    const sql0 = getSql();

    // Put the agent back to what the code defines and let the seed own it again.
    if (b.reset === true || b.reset === "true") {
      const def = agentByKey(key);
      if (!def) return res.status(404).json({ error: "Agent not found" });
      const [back] = await sql0.unsafe(
        `UPDATE ${T.agents}
            SET name = $2, description = $3, system_prompt = $4, context = $5,
                thinking = $6, model = $7, edited = FALSE, updated_at = NOW()
          WHERE key = $1
          RETURNING key, name, description, model, thinking,
                    COALESCE(disabled, FALSE) AS disabled, COALESCE(edited, FALSE) AS edited,
                    COALESCE(length(context), 0)::int AS context_chars`,
        [key, def.name, def.description, def.system_prompt, def.context, !!def.thinking, def.model],
      );
      if (!back) return res.status(404).json({ error: "Agent not found" });
      return res.json({ agent: back });
    }

    const sets = [];
    const params = [key];
    let edited = false;

    if (Object.prototype.hasOwnProperty.call(b, "disabled")) {
      if (key === "main") return res.status(400).json({ error: "The main agent cannot be turned off" });
      params.push(b.disabled === true || b.disabled === "true");
      sets.push(`disabled = $${params.length}`);
    }
    if (Object.prototype.hasOwnProperty.call(b, "context_ids")) {
      params.push(ctxIds(b.context_ids));
      sets.push(`context_ids = to_jsonb($${params.length}::text[])`);
    }
    if (Object.prototype.hasOwnProperty.call(b, "thinking")) {
      params.push(b.thinking === true || b.thinking === "true");
      sets.push(`thinking = $${params.length}`);
      edited = true;
    }
    for (const f of AGENT_TEXT_FIELDS) {
      if (!Object.prototype.hasOwnProperty.call(b, f)) continue;
      const v = b[f] == null ? null : String(b[f]);
      params.push(f === "model" || f === "name" || f === "description" ? (v && v.trim() ? v.trim() : null) : v);
      sets.push(`"${f}" = $${params.length}`);
      edited = true;
    }
    if (!sets.length) return res.status(400).json({ error: "Nothing to update" });
    if (edited) sets.push("edited = TRUE");

    const sql = getSql();
    const [row] = await sql.unsafe(
      `UPDATE ${T.agents} SET ${sets.join(", ")}, updated_at = NOW() WHERE key = $1
         RETURNING key, name, description, model, thinking,
                   COALESCE(disabled, FALSE) AS disabled, COALESCE(edited, FALSE) AS edited,
                   COALESCE(length(context), 0)::int AS context_chars`,
      params,
    );
    if (!row) return res.status(404).json({ error: "Agent not found" });
    res.json({ agent: row });
  } catch (e) {
    fail(res, e, "patchAgent");
  }
}

export async function createChat(req, res) {
  try {
    await ready();
    const sql = getSql();
    const b = req.body || {};
    const userId = requesterId(req);
    const scope = SCOPES.has(String(b.scope)) ? String(b.scope) : "home";
    const id = newObjectId();
    const [chat] = await sql.unsafe(
      `INSERT INTO ${T.chats} (id, user_id, scope, report_id, instance_id, title)
       VALUES ($1,$2,$3,$4,$5,$6) RETURNING *`,
      [id, userId, scope, str(b.report_id), str(b.instance_id), str(b.title)?.slice(0, 200) ?? null],
    );
    res.status(201).json({ chat });
  } catch (e) {
    fail(res, e, "createChat");
  }
}

export async function listChats(req, res) {
  try {
    await ready();
    const sql = getSql();
    const q = req.query || {};
    const userId = requesterId(req);
    // A chat belongs to whoever opened it; without an identity there is nothing to list.
    if (!userId) return res.json({ chats: [] });
    const scope = str(q.scope);
    const reportId = str(q.report_id);
    const chats = await sql.unsafe(
      `SELECT c.id, c.title, c.scope, c.report_id, c.instance_id, c.created_at, c.updated_at,
              COALESCE(m.messages, 0)::int AS messages,
              COALESCE(m.input_tokens, 0)::int AS input_tokens,
              COALESCE(m.output_tokens, 0)::int AS output_tokens,
              COALESCE(m.reasoning_tokens, 0)::int AS reasoning_tokens
         FROM ${T.chats} c
         LEFT JOIN (
           SELECT chat_id, COUNT(*) AS messages, SUM(input_tokens) AS input_tokens,
                  SUM(output_tokens) AS output_tokens, SUM(reasoning_tokens) AS reasoning_tokens
             FROM ${T.messages} GROUP BY chat_id
         ) m ON m.chat_id = c.id
        WHERE c.user_id = $1
          AND ($2::text IS NULL OR c.scope = $2)
          AND ($3::text IS NULL OR c.report_id = $3)
        ORDER BY c.updated_at DESC, c.created_at DESC
        LIMIT 200`,
      [userId, scope, reportId],
    );
    res.json({ chats });
  } catch (e) {
    fail(res, e, "listChats");
  }
}

export async function getChat(req, res) {
  try {
    await ready();
    const sql = getSql();
    const id = String(req.params.id);
    const [chat] = await sql.unsafe(`SELECT * FROM ${T.chats} WHERE id = $1 LIMIT 1`, [id]);
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    if (chat.user_id && String(chat.user_id) !== String(requesterOf(req))) return res.status(404).json({ error: "Chat not found" });
    const messages = await sql.unsafe(
      `SELECT * FROM ${T.messages} WHERE chat_id = $1 ORDER BY created_at ASC, id ASC`,
      [id],
    );
    const totals = await chatTotals(sql, id);
    res.json({ chat, messages, totals });
  } catch (e) {
    fail(res, e, "getChat");
  }
}

// ── messages ────────────────────────────────────────────────────────────────

export async function postMessage(req, res) {
  try {
    await ready();
    const sql = getSql();
    const chatId = String(req.params.id);
    const b = req.body || {};
    if (typeof b.content !== "string") return res.status(400).json({ error: "content must be a string" });
    const content = b.content.trim();
    if (!content) return res.status(400).json({ error: "content is required" });
    if (content.length > MAX_CONTENT_CHARS) {
      return res.status(400).json({ error: `content is too long (max ${MAX_CONTENT_CHARS} characters)` });
    }

    const [chat] = await sql.unsafe(`SELECT * FROM ${T.chats} WHERE id = $1 LIMIT 1`, [chatId]);
    if (!chat) return res.status(404).json({ error: "Chat not found" });
    if (chat.user_id && String(chat.user_id) !== String(requesterOf(req))) return res.status(404).json({ error: "Chat not found" });

    // History = the last 20 messages, oldest first, before this one.
    const recent = await sql.unsafe(
      `SELECT role, content FROM ${T.messages}
        WHERE chat_id = $1 ORDER BY created_at DESC, id DESC LIMIT ${HISTORY_LIMIT}`,
      [chatId],
    );
    const history = recent.reverse();

    // Nothing is written until the orchestra has answered: a failed model call
    // leaves no dangling user row and a retry does not duplicate it. The user
    // row keeps the time the message arrived, so it still sorts before the
    // answer; both rows take the app clock so their order never depends on
    // the DB clock.
    const userCreatedAt = new Date();
    let result;
    try {
      result = await run({
        sql,
        chat: togetherChat,
        history,
        userMessage: content,
        reportContext: b.report_context ?? null,
        // Scope for specialist tools (read/write master inputs, highlight,
        // read cells). Sourced from the chat row so the tools can only touch
        // the report / instance this chat is bound to. Absent instanceId
        // means a home-scope chat: specialists get no tools.
        scope: {
          chatId,
          userId: chat.user_id || null,
          reportId: chat.report_id || null,
          instanceId: chat.instance_id || null,
        },
      });
    } catch (e) {
      // Together's text stays in the server log; the client sees the status only.
      const status = Number.isInteger(e?.status) ? ` (HTTP ${e.status})` : "";
      console.error(`[agents] postMessage: model call failed${status}:`, e?.message || e);
      return res.status(502).json({ error: `The model call failed${status} — try again.` });
    }

    const userId = newObjectId();
    const [userRow] = await sql.unsafe(
      `INSERT INTO ${T.messages} (id, chat_id, role, content, created_at) VALUES ($1,$2,'user',$3,$4) RETURNING *`,
      [userId, chatId, content, userCreatedAt],
    );
    if (!chat.title) {
      await sql.unsafe(
        `UPDATE ${T.chats} SET title = $2, updated_at = NOW() WHERE id = $1 AND (title IS NULL OR title = '')`,
        [chatId, content.slice(0, TITLE_CHARS)],
      );
    }

    const assistantId = newObjectId();
    const [assistantRow] = await sql.unsafe(
      `INSERT INTO ${T.messages}
         (id, chat_id, role, content, input_tokens, output_tokens, reasoning_tokens, cached_input_tokens, steps, ms, created_at)
       VALUES ($1,$2,'assistant',$3,$4,$5,$6,$7,$8::jsonb,$9,$10) RETURNING *`,
      [assistantId, chatId, result.content, result.totals.input_tokens, result.totals.output_tokens,
        // The steps array is bound as-is: JSON.stringify here plus the ::jsonb
        // cast made postgres.js encode it a second time, so every row came back
        // as a JSON *string* and the per-agent chips had to be re-parsed.
        result.totals.reasoning_tokens, result.totals.cached_tokens || 0, result.steps, result.ms, new Date()],
    );
    await sql.unsafe(`UPDATE ${T.chats} SET updated_at = NOW() WHERE id = $1`, [chatId]);

    const totals = await chatTotals(sql, chatId);
    res.json({ user: userRow, assistant: assistantRow, totals });
  } catch (e) {
    fail(res, e, "postMessage");
  }
}
