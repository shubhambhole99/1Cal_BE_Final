// HTTP handlers for /v3/agents. See README.md — "HTTP".
//
// Every handler awaits ready() (ensure tables + seed agents, once per process)
// and wraps its body in try/catch → 500 { error }.

import { getSql } from "../db/index.js";
import { newObjectId } from "../utils/objectId.js";
import { verifiedUserId, V3_AUTH_STRICT } from "../middleware/v3Auth.js";
import { chat as togetherChat } from "./together.js";
import { T, ready } from "./registry.js";
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

// ── agents ──────────────────────────────────────────────────────────────────

export async function listAgents(_req, res) {
  try {
    await ready();
    const sql = getSql();
    const agents = await sql.unsafe(
      `SELECT key, name, description, parent_key, thinking, model, pos_x, pos_y,
              COALESCE(length(context), 0)::int AS context_chars
         FROM ${T.agents} ORDER BY sort ASC, key ASC`,
    );
    res.json({ agents });
  } catch (e) {
    fail(res, e, "listAgents");
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
         (id, chat_id, role, content, input_tokens, output_tokens, reasoning_tokens, steps, ms, created_at)
       VALUES ($1,$2,'assistant',$3,$4,$5,$6,$7::jsonb,$8,$9) RETURNING *`,
      [assistantId, chatId, result.content, result.totals.input_tokens, result.totals.output_tokens,
        // The steps array is bound as-is: JSON.stringify here plus the ::jsonb
        // cast made postgres.js encode it a second time, so every row came back
        // as a JSON *string* and the per-agent chips had to be re-parsed.
        result.totals.reasoning_tokens, result.steps, result.ms, new Date()],
    );
    await sql.unsafe(`UPDATE ${T.chats} SET updated_at = NOW() WHERE id = $1`, [chatId]);

    const totals = await chatTotals(sql, chatId);
    res.json({ user: userRow, assistant: assistantRow, totals });
  } catch (e) {
    fail(res, e, "postMessage");
  }
}
