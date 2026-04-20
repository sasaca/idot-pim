// lib/claude.js
// Anthropic Messages API wrapper for the iDOT PIM chatbot + document upload.
//
// Public API:
//   await chat({ messages, domain, formState, extraFieldNames })
//   -> { assistantText, assistantBlocks, formUpdates, toolTrace, messages }
//
// Environment:
//   ANTHROPIC_API_KEY   - required
//   CLAUDE_MODEL        - optional, defaults to 'claude-sonnet-4-6'
//
// Keeps zero third-party deps (uses global fetch introduced in Node 18+).

const MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const API_URL = 'https://api.anthropic.com/v1/messages';
const API_VERSION = '2023-06-01';
const MAX_TOOL_LOOPS = 8;
const MAX_TOKENS = 4096;

// ---------------------------------------------------------------------------
// Form schemas — a short description of fields per domain, used in the system
// prompt so Claude knows what to look for. NOTE: the actual allow-list of
// field names is the set of keys in the live formState snapshot the browser
// sends each turn. That snapshot is the source of truth; these schemas are a
// hint to help Claude decide what matters in a document.
// ---------------------------------------------------------------------------
const FORM_SCHEMAS = {
  CUSTOMER_ONBOARDING: `
Customer onboarding form. Typical fields: legal_name, tax_id, vat_id, duns,
dba, customer_group, country, city, postal_code, region, address_line_1,
primary_contact_name, primary_contact_email, primary_contact_phone,
currency_code, payment_terms, credit_limit, bill_to_name, bill_to_address,
ship_to_name, ship_to_address, sox flags, quality class.
  `.trim(),
  VENDOR_ONBOARDING: `
Vendor onboarding form. Typical fields: legal_name, tax_id, vat_id, duns,
dba, country, city, postal_code, region, address_line_1,
primary_contact_name, primary_contact_email, primary_contact_phone,
currency_code, payment_terms, incoterms, bank_account, iban, swift,
entity_type (corporation / partnership / sole-proprietor / LLC / foreign).
For foreign vendors: W-8BEN indicates non-US beneficial owner; withholding
flags may apply.
  `.trim(),
  PRODUCT_CREATE: `
Product master creation form. Typical fields: sku, product_name, description,
category, uom (unit of measure), weight, weight_uom, dimensions,
manufacturer, mpn, gtin, hs_code, country_of_origin, list_price, currency,
sox flags, gxp flags, hazmat flags.
  `.trim(),
  CUSTOMER_MODIFY: `
Customer modification form. Typical fields: customer_id, change_type,
effective_date, justification, plus the fields being changed (legal_name,
tax_id, payment_terms, credit_limit, bank_account, iban, contact info,
address, sales area, quality class).
  `.trim(),
};

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

// Client tool: Claude asks the browser to populate form fields.
// The tool input is a FLAT object of name -> value pairs under `fields`,
// plus an optional rationale for auditing.
const CLIENT_TOOLS = [
  {
    name: 'update_form_fields',
    description:
      'Populate one or more fields in the user\'s form. Only use field names ' +
      'that appear as keys in the provided formState object — do not invent ' +
      'new field names. Call this tool whenever you have high-confidence ' +
      'values extracted from documents or chat, and call it multiple times ' +
      'if you uncover more information later in the conversation.',
    input_schema: {
      type: 'object',
      properties: {
        fields: {
          type: 'object',
          description:
            'Flat map of form field name -> value. Keys MUST match the field ' +
            'names in the live formState (exactly, case-sensitive). Values ' +
            'can be strings, numbers, or booleans.',
          additionalProperties: true,
        },
        rationale: {
          type: 'string',
          description:
            'One sentence explaining where each value came from (document, ' +
            'user-provided, web search). Used for audit trail.',
        },
      },
      required: ['fields'],
    },
  },
];

// Server-side tool: lets Claude run a live web search (Anthropic-hosted).
const SERVER_TOOLS = [
  {
    type: 'web_search_20250305',
    name: 'web_search',
    max_uses: 4,
  },
];

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------
function buildSystemPrompt(domain, formState, extraFieldNames) {
  const schema = FORM_SCHEMAS[domain] || FORM_SCHEMAS.CUSTOMER_ONBOARDING;
  const fieldNames = Object.keys(formState || {});
  const extras = Array.isArray(extraFieldNames) ? extraFieldNames : [];
  const allowlist = Array.from(new Set(fieldNames.concat(extras))).sort();

  const currentValues = fieldNames
    .filter((k) => formState[k] !== '' && formState[k] !== null && formState[k] !== undefined && formState[k] !== false)
    .map((k) => `  ${k} = ${JSON.stringify(formState[k])}`)
    .join('\n') || '  (all fields currently empty)';

  return [
    `You are an expert master-data onboarding assistant helping a requestor fill in the ${domain.replaceAll('_', ' ').toLowerCase()} form in the iDOT PIM application.`,
    ``,
    `FORM CONTEXT:`,
    schema,
    ``,
    `FIELD NAMES THAT EXIST IN THE FORM (your ONLY allowlist — do not invent others):`,
    allowlist.length ? allowlist.map((n) => `  - ${n}`).join('\n') : '  (none — form not yet rendered)',
    ``,
    `CURRENT FIELD VALUES:`,
    currentValues,
    ``,
    `WORKFLOW RULES:`,
    `1. When the user attaches a document (PDF / image), extract every field you can identify and call update_form_fields with a flat { field_name: value } object.`,
    `2. Use ONLY the field names listed above. If the document contains data that has no matching field, mention it in your text reply but do NOT invent a field name.`,
    `3. Never fabricate values. If a field is unclear or missing from the document, leave it out rather than guessing.`,
    `4. You may call update_form_fields multiple times as you uncover new info.`,
    `5. You may use web_search to verify company identity, resolve country codes from country names, or look up missing details like DUNS numbers or legal entity types.`,
    `6. For SOX / GxP / compliance-sensitive fields (tax_id, bank_account, iban, credit_limit, payment_terms, legal_name), call out any risk or irregularity in your text reply.`,
    `7. Respond in plain, concise business English. Keep replies under 4 sentences unless the user explicitly asks for more detail.`,
    ``,
    `DATA NORMALIZATION:`,
    `- Countries: use ISO-3166 alpha-2 codes when the form expects a code (e.g. "US", "GB", "DE"). If unsure whether the form wants a code or a name, try the code first.`,
    `- Currencies: use ISO-4217 codes (e.g. "USD", "EUR", "GBP").`,
    `- Dates: use YYYY-MM-DD.`,
    `- Phone numbers: E.164 where possible (e.g. "+14155551234").`,
    `- Email: lowercase.`,
    `- Enumerations (entity_type, customer_group, etc.): use UPPER_SNAKE_CASE unless you can see the form expects a different casing.`,
  ].join('\n');
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function apiHeaders() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    const err = new Error('ANTHROPIC_API_KEY is not set on the server.');
    err.code = 'NO_API_KEY';
    throw err;
  }
  return {
    'Content-Type': 'application/json',
    'x-api-key': key,
    'anthropic-version': API_VERSION,
  };
}

async function callMessages(payload) {
  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify(payload),
  });
  const text = await resp.text();
  let data = null;
  try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }
  if (!resp.ok) {
    const err = new Error(`Anthropic API ${resp.status}: ${text.slice(0, 500)}`);
    err.code = 'API_ERROR';
    err.status = resp.status;
    err.response = data;
    throw err;
  }
  return data;
}

// Extract plain-text assistant reply from a content-block array.
function textFromBlocks(blocks) {
  if (!Array.isArray(blocks)) return '';
  return blocks
    .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
    .map((b) => b.text)
    .join('\n')
    .trim();
}

// Pull tool_use blocks out of the assistant's content array.
function toolUses(blocks) {
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((b) => b && b.type === 'tool_use');
}

// ---------------------------------------------------------------------------
// Main chat loop
// ---------------------------------------------------------------------------
async function chat({ messages, domain, formState, extraFieldNames }) {
  if (!Array.isArray(messages) || messages.length === 0) {
    throw Object.assign(new Error('messages required'), { code: 'BAD_INPUT' });
  }
  const system = buildSystemPrompt(domain, formState || {}, extraFieldNames || []);
  const tools = CLIENT_TOOLS.concat(SERVER_TOOLS);

  // formUpdates is a single flat map we merge into across tool calls.
  const formUpdates = {};
  const toolTrace = [];
  const workingMessages = messages.map((m) => ({ role: m.role, content: m.content }));

  let loops = 0;
  let finalBlocks = [];
  let finalText = '';

  while (loops < MAX_TOOL_LOOPS) {
    loops += 1;

    const payload = {
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      tools,
      messages: workingMessages,
    };

    const resp = await callMessages(payload);
    const blocks = resp.content || [];
    finalBlocks = blocks;
    finalText = textFromBlocks(blocks);

    const uses = toolUses(blocks);

    // Append the assistant turn to the transcript so tool_result messages can follow.
    workingMessages.push({ role: 'assistant', content: blocks });

    // Determine whether we need to loop again (client tool calls need tool_result).
    // Server tools (web_search_20250305) are resolved by Anthropic on its side —
    // their results arrive back as web_search_tool_result blocks in THIS response's
    // content array, and do NOT require a client-side tool_result turn.
    const clientToolCalls = uses.filter((u) => u.name === 'update_form_fields');

    // Merge update_form_fields results into formUpdates.
    const toolResultContent = [];
    for (const u of clientToolCalls) {
      let fields = null;
      let rationale = null;
      const input = u.input || {};
      if (input && typeof input === 'object' && input.fields && typeof input.fields === 'object') {
        fields = input.fields;
        rationale = typeof input.rationale === 'string' ? input.rationale : null;
      } else if (input && typeof input === 'object') {
        // Defensive: if the model skipped the wrapper object, treat the whole
        // input as the flat fields map (excluding reserved keys).
        const { rationale: r, fields: _f, ...rest } = input;
        fields = rest;
        rationale = typeof r === 'string' ? r : null;
      }

      if (fields && typeof fields === 'object') {
        for (const [k, v] of Object.entries(fields)) {
          formUpdates[k] = v;
        }
      }

      toolTrace.push({
        name: 'update_form_fields',
        fields,
        rationale,
      });

      // Emit a tool_result so the model can continue the conversation.
      toolResultContent.push({
        type: 'tool_result',
        tool_use_id: u.id,
        content:
          'OK — applied ' +
          (fields ? Object.keys(fields).length : 0) +
          ' field(s) to the form.',
      });
    }

    // If the stop reason is tool_use and we have client tool calls to answer,
    // send a user turn with tool_result blocks and loop.
    if (resp.stop_reason === 'tool_use' && toolResultContent.length > 0) {
      workingMessages.push({ role: 'user', content: toolResultContent });
      continue;
    }

    // Otherwise we're done.
    break;
  }

  return {
    assistantText: finalText,
    assistantBlocks: finalBlocks,
    formUpdates,
    toolTrace,
    messages: workingMessages,
  };
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------
module.exports = {
  chat,
  FORM_SCHEMAS,
  CLIENT_TOOLS,
  SERVER_TOOLS,
  buildSystemPrompt,
};

// Simple helper to describe a form for debugging.
module.exports.describeForm = function describeForm(domain) {
  return {
    domain,
    schema: FORM_SCHEMAS[domain] || null,
    tools: CLIENT_TOOLS.map((t) => t.name),
  };
};
