// routes/products.js
// -----------------------------------------------------------------------------
// Legacy /products endpoints have been removed. The Products section now
// surfaces the new product-creation workflow directly. The actual queue
// router is mounted at /products by server.js (see productWorkflow.makeQueueRouter).
// This file remains only to redirect any lingering /products/:id legacy
// deep-links back to the requests list, so old bookmarks fail soft.
// -----------------------------------------------------------------------------

const express = require('express');
const router = express.Router();

// Anything other than a workflow URL ends up here; redirect to the new home.
router.get('/:rest*', (req, res) => res.redirect('/products'));

module.exports = router;
