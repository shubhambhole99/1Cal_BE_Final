// Together AI chat-completions client for the agent chat.
//
// One function, chat(options), over fetch. The key and model come from the BE
// .env (TOGETHER_API_KEY, TOGETHER_MODEL) and are read lazily on each call so
// dotenv has certainly run. The key is never logged, never put in an error
// message and never returned to a caller.
//
// See BE/v3/agents/README.md — "Model" — for what the probes established about
// Prism-ML/Ternary-Bonsai-27B (reasoning_content, enable_thinking, json mode,
// native tool calling, usage.completion_tokens_details.reasoning_tokens).

const ENDPOINT = "https://api.together.xyz/v1/chat/completions";
const DEFAULT_MODEL = "Prism-ML/Ternary-Bonsai-27B";
// Vercel cuts a function off at 60 s: one 40 s attempt there. Locally there is
// room for a long thinking call and one retry on 429 / 5xx / network error.
const TIMEOUT_MS = process.env.VERCEL ? 40_000 : 150_000;
const MAX_ATTEMPTS = process.env.VERCEL ? 1 : 2;

export function togetherModel() {
  return process.env.TOGETHER_MODEL || DEFAULT_MODEL;
}

function apiKey() {
  const k = process.env.TOGETHER_API_KEY;
  if (!k) throw new Error("TOGETHER_API_KEY is not set in the BE .env");
  return k;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Together's error body is usually { error: { message, type, code } }; fall
// back to the raw text (truncated) when it is not JSON. Never echoes headers.
function errorMessage(status, text) {
  let msg = "";
  try {
    const j = JSON.parse(text);
    msg = j?.error?.message || j?.error || j?.message || "";
    if (msg && typeof msg !== "string") msg = JSON.stringify(msg);
  } catch {
    msg = "";
  }
  if (!msg) msg = String(text || "").slice(0, 300);
  return `Together ${status}: ${msg || "request failed"}`;
}

/**
 * chat({ messages, tools, tool_choice, max_tokens, temperature, thinking, json, model })
 *   thinking (boolean) → chat_template_kwargs.enable_thinking (+ reasoning_effort "low" when false)
 *   json (boolean)     → response_format { type: "json_object" }
 * Returns { content, reasoning, toolCalls, finish, usage: { input, output, reasoning, cached }, ms }.
 *   usage.cached is how many of the input tokens came from Together's prompt cache — the
 *   automatic prefix cache. Cache hits are billed at the model's cached-input rate
 *   (e.g. GLM-5.3-Flash: $0.03 / 1M cached vs $0.15 / 1M fresh input) and are much faster.
 *   Caching kicks in automatically when a request's leading tokens match a recent request;
 *   there is no flag. To help it hit, keep system prompt + context first and identical
 *   across turns, and put the user question last.
 * Throws a plain Error carrying the HTTP status and Together's message.
 */
export async function chat(options = {}) {
  const {
    messages,
    tools,
    tool_choice,
    max_tokens = 1500,
    temperature = 0.2,
    thinking,
    json = false,
    model,
  } = options;
  if (!Array.isArray(messages) || !messages.length) {
    throw new Error("chat(): messages[] is required");
  }

  const body = {
    model: model || togetherModel(),
    messages,
    max_tokens,
    temperature,
  };
  if (Array.isArray(tools) && tools.length) {
    body.tools = tools;
    body.tool_choice = tool_choice ?? "auto"; // forwarded as given ("auto" | "none" | {…}); default only when absent
  }
  if (typeof thinking === "boolean") {
    body.chat_template_kwargs = { enable_thinking: thinking };
    // Models on Together don't share one off switch: Ternary Bonsai (Qwen
    // template) obeys enable_thinking and goes to 0 reasoning tokens. GLM-5.3
    // ignores it and every other off switch (reasoning_effort none/minimal,
    // reasoning.enabled, thinking.type — probed); "low" is its floor, roughly
    // 50–130 reasoning tokens a call instead of thousands.
    if (!thinking) body.reasoning_effort = "low";
  }
  if (json) body.response_format = { type: "json_object" };

  const headers = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey()}`,
  };
  const payload = JSON.stringify(body);

  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    const t0 = Date.now();
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
    let res;
    let text;
    try {
      res = await fetch(ENDPOINT, { method: "POST", headers, body: payload, signal: ac.signal });
      text = await res.text();
    } catch (e) {
      clearTimeout(timer);
      const timedOut = e?.name === "AbortError";
      lastErr = new Error(timedOut ? `Together request timed out after ${TIMEOUT_MS / 1000}s` : `Together network error: ${e?.message || e}`);
      lastErr.status = timedOut ? 504 : 502;
      if (attempt < MAX_ATTEMPTS) { await sleep(1000 * attempt); continue; }
      throw lastErr;
    }
    clearTimeout(timer);

    if (!res.ok) {
      const err = new Error(errorMessage(res.status, text));
      err.status = res.status;
      const retryable = res.status === 429 || res.status >= 500;
      if (retryable && attempt < MAX_ATTEMPTS) { lastErr = err; await sleep(1500 * attempt); continue; }
      throw err;
    }

    let data;
    try {
      data = JSON.parse(text);
    } catch {
      const err = new Error(`Together ${res.status}: response was not JSON`);
      err.status = 502;
      throw err;
    }

    const choice = data?.choices?.[0] || {};
    const msg = choice.message || {};
    const usage = data?.usage || {};
    return {
      content: typeof msg.content === "string" ? msg.content : (msg.content == null ? "" : String(msg.content)),
      reasoning: msg.reasoning_content || msg.reasoning || "",
      toolCalls: Array.isArray(msg.tool_calls) ? msg.tool_calls : [],
      finish: choice.finish_reason || null,
      model: model || togetherModel(),
      usage: {
        input: Number(usage.prompt_tokens) || 0,
        output: Number(usage.completion_tokens) || 0,
        reasoning: Number(usage.completion_tokens_details?.reasoning_tokens) || 0,
        cached: Number(usage.prompt_tokens_details?.cached_tokens) || 0,
      },
      ms: Date.now() - t0,
    };
  }
  // Unreachable in practice (the loop either returns or throws), kept for safety.
  throw lastErr || new Error("Together request failed");
}

export default chat;
