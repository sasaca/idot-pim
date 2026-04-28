// lib/fx_lookup.js
// -----------------------------------------------------------------------------
// Live FX lookup powered by Claude with web_search. Used by the product
// workflow R&D tab so users can convert a Retail Price (USD) into the local
// currency of the selected market on demand.
//
// We intentionally do not cache: the requestor presses a button to fetch the
// rate for the moment they click. The handler returns { rate, asOf, source }
// or throws if the API call / parsing fails.
// -----------------------------------------------------------------------------

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const API_VERSION = '2023-06-01';

const SYSTEM = [
  'You are a financial data lookup assistant. The user gives you a currency pair and you must use the web_search tool to look up the most recent mid-market exchange rate.',
  'After searching, you MUST call the report_fx_rate tool with the rate, the as-of timestamp (in ISO 8601), and a short note describing the source.',
  'Use the latest figure you find — typically from xe.com, oanda.com, ECB, or a major financial news source. If the search returns multiple rates from different times, prefer the most recent.',
  'Always represent the rate as: 1 unit of the FROM currency = X units of the TO currency.',
  'Do not make up a rate. If you cannot find one, set rate to 0 and explain in the note.',
].join(' ');

const TOOLS = [
  {
    name: 'report_fx_rate',
    description: 'Report the looked-up FX rate back to the application.',
    input_schema: {
      type: 'object',
      properties: {
        rate:    { type: 'number', description: '1 unit of FROM currency = this many units of TO currency.' },
        as_of:   { type: 'string', description: 'ISO 8601 timestamp the rate is sourced from.' },
        source:  { type: 'string', description: 'Short description of the source, e.g. "xe.com mid-market".' },
      },
      required: ['rate', 'as_of', 'source'],
    },
  },
];

const SERVER_TOOLS = [
  { type: 'web_search_20250305', name: 'web_search', max_uses: 3 },
];

function apiHeaders() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('ANTHROPIC_API_KEY not set'), { code: 'NO_API_KEY' });
  return { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION };
}

async function getFxRate(fromCcy, toCcy) {
  if (!fromCcy || !toCcy) throw Object.assign(new Error('from and to currencies required'), { code: 'BAD_INPUT' });
  const from = String(fromCcy).toUpperCase();
  const to   = String(toCcy).toUpperCase();
  if (from === to) return { rate: 1, asOf: new Date().toISOString(), source: 'identity' };

  const userPrompt = `Look up the current mid-market exchange rate from ${from} to ${to}. Use web_search, then report the rate via the report_fx_rate tool.`;
  const messages = [{ role: 'user', content: userPrompt }];

  // Single tool-loop iteration is enough — the model fetches via web_search,
  // then emits the report_fx_rate tool_use block in the same turn or the next.
  for (let iter = 0; iter < 3; iter++) {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: apiHeaders(),
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: SYSTEM,
        tools: TOOLS.concat(SERVER_TOOLS),
        messages,
      }),
    });
    const text = await resp.text();
    let data;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
    if (!resp.ok) {
      throw Object.assign(new Error(`Anthropic API ${resp.status}: ${text.slice(0, 500)}`), {
        code: 'API_ERROR', status: resp.status,
      });
    }

    const blocks = Array.isArray(data.content) ? data.content : [];
    const reportCall = blocks.find((b) => b && b.type === 'tool_use' && b.name === 'report_fx_rate');
    if (reportCall && reportCall.input) {
      const rate = Number(reportCall.input.rate);
      if (!Number.isFinite(rate) || rate <= 0) {
        throw Object.assign(new Error('Claude could not find a valid rate'), {
          code: 'NO_RATE', note: reportCall.input.source || '',
        });
      }
      return {
        rate,
        asOf:   String(reportCall.input.as_of  || new Date().toISOString()),
        source: String(reportCall.input.source || 'web_search'),
      };
    }

    // Append the assistant turn and any web_search tool results so the model
    // can continue. Server-side tools are already resolved by Anthropic in
    // its response, so we just keep looping until report_fx_rate is emitted
    // or stop_reason is end_turn.
    messages.push({ role: 'assistant', content: blocks });
    if (data.stop_reason === 'end_turn') break;

    // Provide a nudge prompting the report.
    messages.push({
      role: 'user',
      content: 'Now call report_fx_rate with the rate you found.',
    });
  }

  throw Object.assign(new Error('Claude did not report an FX rate'), { code: 'NO_REPORT' });
}

module.exports = { getFxRate };
