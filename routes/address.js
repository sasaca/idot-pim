// routes/address.js
// Mapbox-powered address autocomplete proxy for the iDOT PIM.
//
// GET /api/address/autocomplete?q=<string>&country=<iso2>  (country optional)
//   Returns: { features: [{ place_name, address_line_1, city, region,
//     region_code, postal_code, country, country_code, center }] }
//
// GET /api/address/config
//   Returns: { ready: boolean, has_country_filter: boolean }
//
// The Mapbox access token is read from env MAPBOX_TOKEN and never sent to
// the browser. Falls back gracefully when the token is missing.

const express = require('express');
const router = express.Router();

const MAPBOX_URL = 'https://api.mapbox.com/geocoding/v5/mapbox.places';

router.get('/config', (req, res) => {
  res.json({
    ready: Boolean(process.env.MAPBOX_TOKEN),
  });
});

router.get('/autocomplete', async (req, res) => {
  const token = process.env.MAPBOX_TOKEN;
  if (!token) {
    return res.status(503).json({ error: 'NO_MAPBOX_TOKEN' });
  }

  const q = String(req.query.q || '').trim();
  if (q.length < 3) {
    return res.json({ features: [] });
  }
  // Strip anything that would break the Mapbox URL segment.
  const safeQ = q.replace(/[;?#]/g, ' ').slice(0, 200);

  const url = new URL(`${MAPBOX_URL}/${encodeURIComponent(safeQ)}.json`);
  url.searchParams.set('access_token', token);
  url.searchParams.set('autocomplete', 'true');
  url.searchParams.set('limit', '6');
  url.searchParams.set('types', 'address,place,postcode,locality');

  // Optional country filter — takes an ISO-3166 alpha-2 code (e.g. "us", "gb").
  const country = String(req.query.country || '').trim().toLowerCase();
  if (country && /^[a-z]{2}(,[a-z]{2})*$/.test(country)) {
    url.searchParams.set('country', country);
  }

  // Optional proximity bias (longitude,latitude).
  const proximity = String(req.query.proximity || '').trim();
  if (proximity && /^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/.test(proximity)) {
    url.searchParams.set('proximity', proximity);
  }

  try {
    const resp = await fetch(url.toString());
    const text = await resp.text();
    let data = null;
    try { data = JSON.parse(text); } catch (_) { data = { raw: text }; }

    if (!resp.ok) {
      return res.status(502).json({
        error: 'MAPBOX_ERROR',
        status: resp.status,
        detail: data,
      });
    }

    const features = (data.features || []).map(normalizeFeature);
    res.json({ features });
  } catch (err) {
    res.status(500).json({
      error: 'INTERNAL_ERROR',
      message: err && err.message ? err.message : String(err),
    });
  }
});

function normalizeFeature(feat) {
  const ctx = {};
  (feat.context || []).forEach((c) => {
    const kind = (c.id || '').split('.')[0];
    if (!kind) return;
    ctx[kind] = { text: c.text, short_code: c.short_code };
  });

  // Address feature: feat.address is the street number, feat.text is the street name.
  // Place/postcode/locality features: no separate number.
  const placeTypes = feat.place_type || [];
  const isAddress = placeTypes.indexOf('address') !== -1;

  let addressLine1 = '';
  if (isAddress) {
    const streetNumber = feat.address || '';
    const streetName = feat.text || '';
    addressLine1 = (streetNumber ? streetNumber + ' ' : '') + streetName;
  } else {
    addressLine1 = feat.text || '';
  }

  const regionShort = ctx.region && ctx.region.short_code
    ? String(ctx.region.short_code).toUpperCase().replace(/^[A-Z]{2}-/, '')
    : '';
  const countryShort = ctx.country && ctx.country.short_code
    ? String(ctx.country.short_code).toUpperCase()
    : '';

  return {
    place_name: feat.place_name || '',
    address_line_1: addressLine1.trim(),
    city: (ctx.place && ctx.place.text) || (ctx.locality && ctx.locality.text) || '',
    region: (ctx.region && ctx.region.text) || '',
    region_code: regionShort,
    postal_code: (ctx.postcode && ctx.postcode.text) || '',
    country: (ctx.country && ctx.country.text) || '',
    country_code: countryShort,
    center: feat.center || null,
    feature_type: placeTypes[0] || null,
  };
}

module.exports = router;
