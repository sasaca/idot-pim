// lib/label_extract.js
// -----------------------------------------------------------------------------
// One-shot label extraction. The R&D Design tab uploads a label image; this
// helper sends the image to Claude and forces the model to emit a structured
// `report_label_fields` tool_use with seven extracted blocks of text.
//
// Returns { marketing_text, claims, legal_claims, environmental_claims,
//           nutritional_claims, dietary_claims, contacts }.
// -----------------------------------------------------------------------------

const API_URL = 'https://api.anthropic.com/v1/messages';
const MODEL   = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
const API_VERSION = '2023-06-01';

const SYSTEM = [
  'You are a label-extraction assistant for a food & beverage product information system.',
  'You receive an image of a product label and must call the report_label_fields tool with everything you can read from it, grouped into the seven fields described in the tool schema.',
  'Quote text exactly as it appears on the label — do not paraphrase. If a section is missing, leave that field as an empty string.',
  'Group multiple lines for the same field with newlines. Do not invent content; only report what is visibly on the label.',
].join(' ');

const TOOLS = [{
  name: 'report_label_fields',
  description: 'Report the structured contents of the uploaded product label.',
  input_schema: {
    type: 'object',
    properties: {
      marketing_text:        { type: 'string', description: 'Brand name, headline, taglines, sub-text used for marketing.' },
      claims:                { type: 'string', description: 'General product claims (e.g. "100% Real Fruit", "Made with Whole Grains"). Exclude legal, environmental, nutritional or dietary claims — those have their own fields.' },
      legal_claims:          { type: 'string', description: 'Legally-required text: warnings, disclaimers, country-of-origin, manufacturer, regulatory ID numbers, lot/batch markings.' },
      environmental_claims:  { type: 'string', description: 'Sustainability statements: recyclability, recycled content, FSC, carbon labels, eco-marks, packaging instructions.' },
      nutritional_claims:    { type: 'string', description: 'Anything from the nutrition facts panel and nutritional callouts (e.g. "0g Sugar", "Source of Fiber"). Include the full panel text if present.' },
      dietary_claims:        { type: 'string', description: 'Dietary attributes: Gluten-Free, Vegan, Halal, Kosher, Lactose-Free, Non-GMO, Organic, Allergen statements.' },
      contacts:              { type: 'string', description: 'Manufacturer / distributor contact info: address, phone, email, website, social handles, customer service line.' },
    },
    required: ['marketing_text','claims','legal_claims','environmental_claims','nutritional_claims','dietary_claims','contacts'],
  },
}];

function apiHeaders() {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw Object.assign(new Error('ANTHROPIC_API_KEY not set'), { code: 'NO_API_KEY' });
  return { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': API_VERSION };
}

async function extractLabel({ dataBase64, mediaType }) {
  if (!dataBase64) throw Object.assign(new Error('image required'), { code: 'BAD_INPUT' });
  const messages = [{
    role: 'user',
    content: [
      { type: 'image', source: { type: 'base64', media_type: mediaType || 'image/jpeg', data: dataBase64 } },
      { type: 'text',  text: 'Read every piece of text from this product label and call report_label_fields with the seven grouped fields.' },
    ],
  }];

  const resp = await fetch(API_URL, {
    method: 'POST',
    headers: apiHeaders(),
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 2048,
      system: SYSTEM,
      tools: TOOLS,
      // Force the model to use the tool — no free-form reply.
      tool_choice: { type: 'tool', name: 'report_label_fields' },
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
  const call = blocks.find((b) => b && b.type === 'tool_use' && b.name === 'report_label_fields');
  if (!call || !call.input) {
    throw Object.assign(new Error('Claude did not call report_label_fields'), { code: 'NO_REPORT' });
  }
  // Coerce every field to a string so the front-end can drop them into textareas.
  const out = {};
  ['marketing_text','claims','legal_claims','environmental_claims','nutritional_claims','dietary_claims','contacts']
    .forEach((k) => { out[k] = String(call.input[k] || ''); });
  return out;
}

module.exports = { extractLabel };
