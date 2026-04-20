// routes/chat.js
// Express routes for the Claude-powered onboarding chatbot.
//
// POST /api/chat/:domain
//   Body: { messages: [...], formState: {...}, extraFieldNames: [...], attachments: [...] }
//   - messages: array of { role: 'user'|'assistant', content: string|blocks[] }
//   - formState: current field name -> value map from the browser
//   - extraFieldNames: dynamic pf_* field names present in the DOM
//   - attachments: optional [{ name, mime, dataBase64 }] to splice into the latest user turn
//   Response: { assistantText, formUpdates, toolTrace, messages }
//
// GET /api/chat/config
//   Lightweight probe used by the widget to check whether ANTHROPIC_API_KEY is set.
//   Response: { ready: boolean, model: string, domains: string[] }

const express = require('express');
const claude = require('../lib/claude');

const router = express.Router();

// Allow large JSON bodies because PDFs/images are sent as base64.
router.use(express.json({ limit: '20mb' }));

const VALID_DOMAINS = new Set([
  'CUSTOMER_ONBOARDING',
  'VENDOR_ONBOARDING',
  'PRODUCT_CREATE',
  'CUSTOMER_MODIFY',
]);

router.get('/config', (req, res) => {
  res.json({
    ready: Boolean(process.env.ANTHROPIC_API_KEY),
    model: process.env.CLAUDE_MODEL || 'claude-sonnet-4-6',
    domains: Array.from(VALID_DOMAINS),
  });
});

router.post('/:domain', async (req, res) => {
  const domain = String(req.params.domain || '').toUpperCase();
  if (!VALID_DOMAINS.has(domain)) {
    return res.status(400).json({ error: 'unknown_domain', domain });
  }

  const {
    messages = [],
    formState = {},
    extraFieldNames = [],
    attachments = [],
  } = req.body || {};

  if (!Array.isArray(messages) || messages.length === 0) {
    return res.status(400).json({ error: 'messages_required' });
  }

  // Splice any attachments into the LATEST user message as image/document blocks.
  // Claude expects content to be an array of blocks when mixing text + files.
  const outMessages = messages.map((m) => ({ ...m }));
  if (Array.isArray(attachments) && attachments.length > 0) {
    // Find the last user message (by walking from the end).
    let idx = -1;
    for (let i = outMessages.length - 1; i >= 0; i -= 1) {
      if (outMessages[i].role === 'user') {
        idx = i;
        break;
      }
    }
    if (idx >= 0) {
      const msg = outMessages[idx];
      const blocks = [];

      // Preserve the text content as a leading text block.
      if (typeof msg.content === 'string') {
        if (msg.content.trim()) {
          blocks.push({ type: 'text', text: msg.content });
        }
      } else if (Array.isArray(msg.content)) {
        blocks.push(...msg.content);
      }

      for (const att of attachments) {
        if (!att || !att.dataBase64) continue;
        const mime = (att.mime || '').toLowerCase();
        if (mime.startsWith('image/')) {
          blocks.push({
            type: 'image',
            source: {
              type: 'base64',
              media_type: mime,
              data: att.dataBase64,
            },
          });
        } else if (mime === 'application/pdf') {
          blocks.push({
            type: 'document',
            source: {
              type: 'base64',
              media_type: 'application/pdf',
              data: att.dataBase64,
            },
            title: att.name || 'document.pdf',
          });
        } else {
          // Unknown file type: describe it as plain text so the model knows it arrived.
          blocks.push({
            type: 'text',
            text: `[attachment received: ${att.name || 'file'} (${mime || 'unknown type'}); contents not inlined]`,
          });
        }
      }

      if (blocks.length > 0) {
        msg.content = blocks;
      }
    }
  }

  try {
    const result = await claude.chat({
      messages: outMessages,
      domain,
      formState,
      extraFieldNames,
    });
    res.json({
      assistantText: result.assistantText,
      formUpdates: result.formUpdates,
      toolTrace: result.toolTrace,
      messages: result.messages,
    });
  } catch (err) {
    const code = err && err.code ? err.code : 'INTERNAL_ERROR';
    const status = code === 'NO_API_KEY' ? 503 : (code === 'API_ERROR' ? 502 : 500);
    res.status(status).json({
      error: code,
      message: err && err.message ? err.message : String(err),
    });
  }
});

module.exports = router;
