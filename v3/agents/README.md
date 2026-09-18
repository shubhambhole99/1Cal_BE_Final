# Agent chat — design and contract

The 1Cal assistant: a chat orb on the home page and inside a report instance,
answered by a small **orchestra of agents** rather than one model call, because
each agent holds a narrow context (one regulation, one report) and the model's
usable context is the scarce resource. Everything here is **local-only** for now:
the orb only renders on localhost (`useIsLocalHost`), and the BE mounts
`/v3/agents` only when `AGENT_CHAT_ENABLED=true` is in its `.env` (app.js logs
`[agents] chat routes mounted` or `[agents] chat routes disabled
(AGENT_CHAT_ENABLED)` at boot), so nothing ships to production.

## Model

Together AI, `Prism-ML/Ternary-Bonsai-27B` (262k context). Key and model come
from the BE `.env`: `TOGETHER_API_KEY`, `TOGETHER_MODEL`. The key never reaches
the browser. A call times out after 150 s locally with one retry on 429 / 5xx /
network errors; on Vercel (`process.env.VERCEL`) it is 40 s and a single
attempt, under the 60 s function limit.

What the probes established (17 Sep 2026):

- It is a **reasoning model**. `message.reasoning_content` carries the
  thinking; with a small `max_tokens` it spends everything reasoning and returns
  an empty `content` with `finish_reason: "length"`. Budget ≥ 3000 tokens when
  thinking is on.
- `chat_template_kwargs: { enable_thinking: false }` switches thinking **off**
  (55-token clean answer to a 2-sentence question). Use this for routing,
  composing and the light specialists; leave it on for numeric specialists.
- `response_format: { type: "json_object" }` works and also suppresses thinking.
  Long Markdown with GFM tables and a ```mermaid block came back correct.
- Native **tool calling** works: `tools` + `tool_choice: "auto"` returns
  `finish_reason: "tool_calls"` with a proper `tool_calls[]`.
- `usage` carries `prompt_tokens`, `completion_tokens` and
  `completion_tokens_details.reasoning_tokens`. Those are the numbers shown to
  the user.
- It mistakes "DCPR" for consumer protection unless told: every system prompt
  says **DCPR 2034 = Development Control and Promotion Regulations 2034 for
  Greater Mumbai**.

## Orchestration (programmatic tool calling)

```
user message
   │
   ▼
main agent ── tools: ask_agent(agent, question) ──▶ specialist (own context)
   │  ◀── tool result ──────────────────────────────┘   (may fan out to several)
   ▼
final Markdown answer (tables, mermaid)
```

1. **Route**: call the model as the `main` agent with the last ≤ 20 chat
   messages, the user's message and one tool, `ask_agent`, whose `agent` enum is
   the list of specialist keys with their descriptions. Thinking off.
2. **Consult**: for every `tool_calls` entry, call the model as that specialist
   — its own system prompt + its context (the regulation text) + the question.
   Run the calls in parallel. The `report` specialist additionally receives the
   live report context JSON the browser sent with the message. Thinking per the
   agent's `thinking` flag.
3. **Compose**: append the tool results and call `main` again (thinking off,
   `max_tokens` 2500). Loop while it keeps calling tools, at most 3 rounds. The
   `tools` array is sent on every call (the tool-role messages refer to it); the
   last round and the JSON retry pass `tool_choice: "none"`. A repeated consult
   (same agent, same question) within one run is served from an in-run cache and
   recorded as a step with `cached: true` and zero tokens. If
   the final `content` is empty with `finish_reason: "length"`, retry once in
   JSON mode `{ "answer": "<markdown>" }`.
4. Every call's `usage` is recorded as a **step**; the message stores the steps
   and their sums.

The main agent's system prompt tells it to answer directly when no specialist is
needed, to consult more than one when a question spans regulations, and to write
**GitHub-flavoured Markdown**: tables for figures, a ```mermaid block for flows.

## Agents (seeded into `v3_agents`, upsert by key)

| key | name | parent | thinking | context (file in `seed/`) |
|---|---|---|---|---|
| `main` | Main | — | off | the agent directory (generated) |
| `definitions` | DCPR definitions | main | off | `dcpr-definitions.md` (Reg 2) |
| `reg-30a` | 30A · FSI & BUA | main | on | `dcpr-reg-30.md` + `30a-explained.md` |
| `reg-33-7b` | 33(7)(B) · housing societies | main | on | `dcpr-33-7b.md` |
| `scheme-selector` | Scheme selector | main | off | `decision-logic.md` + `scheme-parameters.md` |
| `report` | Report (open project) | main | on | live report context sent by the browser |

Positions for the canvas: main at (0, 0), children in a row 220 px below,
260 px apart. Add agents by adding a row here and a seed file; nothing else.
**Code is the source of truth**: `registry.js` re-seeds every row (upsert by key)
at each start, so a prompt or context edited in the DB lasts only until the next
restart. Change the code, not the row.

## Database (schema `prod`, `CREATE TABLE IF NOT EXISTS`, never dropped)

```sql
v3_agents (
  key TEXT PRIMARY KEY, name TEXT, description TEXT, parent_key TEXT,
  system_prompt TEXT, context TEXT, thinking BOOLEAN DEFAULT false,
  model TEXT, pos_x INT DEFAULT 0, pos_y INT DEFAULT 0, sort INT DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())

v3_agent_chats (
  id VARCHAR(24) PRIMARY KEY, user_id VARCHAR(24), scope TEXT,          -- 'home' | 'instance'
  report_id VARCHAR(24), instance_id VARCHAR(24), title TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW(), updated_at TIMESTAMPTZ DEFAULT NOW())

v3_agent_messages (
  id VARCHAR(24) PRIMARY KEY, chat_id VARCHAR(24) NOT NULL, role TEXT,  -- 'user' | 'assistant'
  content TEXT, input_tokens INT DEFAULT 0, output_tokens INT DEFAULT 0,
  reasoning_tokens INT DEFAULT 0, steps JSONB DEFAULT '[]'::jsonb, ms INT,
  created_at TIMESTAMPTZ DEFAULT NOW())
```

Ids come from `newObjectId()` (`BE/utils/objectId.js`), like every other v3 row.
The user id is `verifiedUserId(req)` when a token is present, else `body.user_id`
— the same fallback `requesterId()` uses in `v3Controller.js`.

## HTTP (Express, mounted at `/v3/agents`, `attachV3User` in front)

| method | path | body / query | returns |
|---|---|---|---|
| GET | `/v3/agents` | — | `{ agents: [{ key, name, description, parent_key, thinking, model, pos_x, pos_y, context_chars }] }` |
| GET | `/v3/agents/:key` | — | `{ agent: { …all columns… } }` — the overlay shows `system_prompt` and `context` |
| POST | `/v3/agents/chats` | `{ user_id, scope, report_id?, instance_id?, title? }` | `{ chat: {…} }` |
| GET | `/v3/agents/chats` | `?user_id=&scope=&report_id=` | `{ chats: [{ id, title, scope, report_id, created_at, updated_at, messages, input_tokens, output_tokens }] }` newest first |
| GET | `/v3/agents/chats/:id` | — | `{ chat, messages: [...], totals: { input_tokens, output_tokens, reasoning_tokens, messages } }` |
| POST | `/v3/agents/chats/:id/messages` | `{ user_id, content, report_context? }` | `{ user: {…message}, assistant: {…message}, totals }` |

`GET /chats/:id` and `POST /chats/:id/messages` answer **404** when the chat
belongs to another user (`chat.user_id` set and different from the requester:
verified token, else `body.user_id` / `query.user_id`). `content` must be a
non-empty string of at most **4000** characters (400 otherwise). Nothing is
written until the orchestra has answered: on a failed model call the reply is
**502** `{ error: "The model call failed (HTTP nnn) — try again." }` and no row
is stored; Together's own error text goes to the server log only.

A message row as returned:

```json
{ "id": "…", "role": "assistant", "content": "…markdown…",
  "input_tokens": 1834, "output_tokens": 611, "reasoning_tokens": 402, "ms": 8120,
  "steps": [
    { "agent": "main",    "phase": "route",   "input_tokens": 410, "output_tokens": 62,  "reasoning_tokens": 0,   "ms": 900 },
    { "agent": "reg-30a", "phase": "consult", "input_tokens": 1211,"output_tokens": 480, "reasoning_tokens": 402, "ms": 6100, "question": "…" },
    { "agent": "main",    "phase": "compose", "input_tokens": 213, "output_tokens": 69,  "reasoning_tokens": 0,   "ms": 1100 }
  ],
  "created_at": "…" }
```

History sent to the model = the chat's last **20** messages (user + assistant),
oldest first, before the new user message. Older messages stay in the DB and on
screen; they are simply not sent.

## Report context (browser → `report` agent)

Built in `Workspace.jsx` from what the workspace already holds, capped at ~30 KB:

```json
{ "report": { "id": "…", "name": "…" },
  "calcs": [ { "instanceId": "…", "name": "Asha 30(A)+33(7B)+33(20B)",
               "templateId": "…", "versionId": "…",
               "metrics": { "Total Revenue": 123.4, "Net Plot": 1900, … },
               "sections": { "area": [ { "label": "Net plot…", "values": { "BUA (sqm)": 1900, … } } ],
                             "cost": [ … ], "fin": [ … ] },
               "masterInputs": [ { "name": "Plot Area", "value": "2000", "group": "Plot" } ] } ] }
```

`metrics` = `extractMetrics(computed).values`; `sections` = `summaryRows(sec, col)`
for each of `SUMMARY_SECTIONS` with the numbers read at `sec.valueCols`;
`masterInputs` arrives through `onMeta` from RetemplateTwo (name, value, group).

## Front end (`FE/components/AgentChat/`)

| file | export | role |
|---|---|---|
| `api.js` | `listAgents()`, `getAgent(key)`, `createChat(b)`, `listChats(q)`, `getChat(id)`, `sendMessage(id, b)` | fetch to `${NEXT_PUBLIC_BACKEND_URL}/v3/agents/…`, `Authorization` from `localStorage.token` |
| `ChatOrb.jsx` | default `ChatOrb({ scope, reportId, instanceIds, getReportContext, palette })` | fixed bottom-right orb; **renders nothing unless `useIsLocalHost()`**; toggles the panel |
| `ChatPanel.jsx` | default | right sidebar, 440 px: header (title, chat totals in/out, new chat, chat picker), tabs **Chat** / **Agents** |
| `Message.jsx` | default | one bubble: Markdown via `react-markdown` + `remark-gfm`; ```mermaid fences → `MermaidBlock`; token badge `in 1,834 · out 611 (402 thinking)`; agent chips from `steps` |
| `MermaidBlock.jsx` | default | `import("mermaid")` on demand, renders SVG, shows the source on failure |
| `Composer.jsx` | default | textarea, Enter to send, Shift+Enter newline, "model sees the last 20 messages" |
| `AgentsCanvas.jsx` | default `AgentsCanvas({ agents, activeKeys, onOpenAgent })` | `@xyflow/react` canvas, nodes from `pos_x/pos_y`, edges parent→child, `activeKeys` (agents in the last answer) highlighted, **double-click** → `onOpenAgent(key)` |
| `AgentOverlay.jsx` | default `AgentOverlay({ agentKey, onClose, sidebarWidth, reportContext })` | fixed overlay over everything **except** the chat sidebar (`right: sidebarWidth`); fetches `getAgent(key)`; shows name, model, thinking, description, system prompt, context (with a character and ~token count); for `report` shows the live `reportContext` JSON |

Mounts: `app/page.jsx` (`LandingL`) renders `<ChatOrb scope="home" palette={…brass…} />`;
`Workspace.jsx` renders `<ChatOrb scope="instance" reportId={reportId}
instanceIds={…} getReportContext={buildReportContext} />`.

Theme: cream/paper with the cinnabar accent in the instance (T3 tokens); the
home orb takes the landing's brass palette through the `palette` prop. Selects are
shadcn on cream, never transparent. No purple.
