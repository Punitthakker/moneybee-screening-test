'use strict';
// Paid third-party providers. None are connected yet. Each one shows as "Not connected" in the app
// and on every report, so a screening never claims coverage it does not have.
//
// To connect one later, add an adapter to ADAPTERS with this shape:
//   ADAPTERS.pep = { async screen(subject) { return [ { entryId, name, score, ... } ]; } }
// and it will be included in screenings automatically.

const PROVIDERS = [
  { key: 'pep', name: 'PEP (politically exposed persons)', category: 'PEP and media' },
  { key: 'adverse_media', name: 'Adverse Media', category: 'PEP and media' },
  { key: 'interpol', name: 'INTERPOL Red Notices', category: 'Law enforcement' },
  { key: 'fbi', name: 'FBI Most Wanted terrorist list', category: 'Law enforcement' },
  { key: 'europe_wanted', name: "Europe's Most Wanted Fugitives", category: 'Law enforcement' },
  { key: 'fiu_india', name: 'FIU India Order & Judgement List', category: 'Regional' },
];

const ADAPTERS = {};

function statusList() {
  return PROVIDERS.map((p) => ({
    key: p.key,
    name: p.name,
    category: p.category,
    kind: 'provider',
    status: ADAPTERS[p.key] ? 'screened' : 'not_connected',
    note: ADAPTERS[p.key] ? '' : 'Paid provider not connected. Not screened.',
  }));
}

module.exports = { PROVIDERS, ADAPTERS, statusList };
