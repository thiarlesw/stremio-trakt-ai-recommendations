const BASE = process.env.AI_BASE_URL;
const KEY = process.env.AI_API_KEY;
const MODEL = process.env.AI_MODEL || 'glm-5.2';

async function callAI(systemPrompt, userPrompt, { temperature = 0.5, maxTokens = 20000, model = MODEL, timeoutMs = 240000 } = {}) {
  if (!BASE || !KEY) return '';
  let data;
  try {
    const res = await fetch(`${BASE}/chat/completions`, {
      method: 'POST',
      signal: AbortSignal.timeout(timeoutMs),
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${KEY}`,
      },
      body: JSON.stringify({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature,
        max_tokens: maxTokens,
      }),
    });
    data = await res.json();
  } catch (err) {
    console.warn('[llm] fetch failed:', err.message);
    return '';
  }
  if (data.error) {
    console.error('[llm] erro:', data.error.message || JSON.stringify(data.error));
    return '';
  }
  const msg = data.choices?.[0]?.message;
  return msg?.content || msg?.reasoning_content || '';
}

function simpleCallAI(systemPrompt, userPrompt, opts = {}) {
  return callAI(systemPrompt, userPrompt, { maxTokens: 6000, timeoutMs: 240000, ...opts });
}

module.exports = { callAI, simpleCallAI, MODEL };
