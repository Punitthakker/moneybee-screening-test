'use strict';
// PDF screening report, modelled on a standard customer screening report layout:
// customer summary, identification details, alert summary, scan criteria, matches, lists screened.

const PDFDocument = require('pdfkit');
const { countryName } = require('./countries');

const M = 40;
const W = 595.28 - M * 2;
const COLORS = { ink: '#1a1a1a', muted: '#666666', rule: '#999999', band: '#e6e6e6', red: '#b3261e', amber: '#b26a00', green: '#1e7a46' };

function safe(s) {
  return String(s == null ? '' : s)
    .replace(/[–—]/g, '-')
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[^\x20-\x7e -ÿ\n]/g, '?');
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function fmt(d) {
  if (!d) return '';
  const x = new Date(d);
  if (Number.isNaN(x.getTime())) return String(d);
  return `${pad(x.getUTCDate())}-${pad(x.getUTCMonth() + 1)}-${x.getUTCFullYear()} ${pad(x.getUTCHours())}:${pad(x.getUTCMinutes())}:${pad(x.getUTCSeconds())} (UTC)`;
}

function fmtDay(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : String(s);
}

const STATUS_TEXT = {
  screened: 'Screened',
  unavailable: 'NOT SCREENED (list unavailable)',
  not_included: 'Not included in this scan',
  not_connected: 'Not connected (not screened)',
};

const TRIGGER_TEXT = { manual: 'Manual screening', batch: 'Batch upload', monitoring: 'Ongoing monitoring', rescreen: 'Re-screening' };
const DECISION_TEXT = { true_match: 'True match', false_positive: 'False positive', escalate: 'Escalated' };

function render(sc, viewer) {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: M, bufferPages: true, info: { Title: 'Customer Screening Report', Author: 'MoneyBee Screening' } });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const bottom = () => doc.page.height - 60;
    const need = (h) => {
      if (doc.y + h > bottom()) doc.addPage();
    };

    const section = (title) => {
      need(60);
      doc.moveDown(0.8);
      doc.font('Helvetica').fontSize(15).fillColor(COLORS.ink).text(safe(title), M, doc.y, { width: W, align: 'center' });
      doc.moveDown(0.3);
      doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(1).strokeColor(COLORS.rule).stroke();
      doc.moveDown(0.4);
    };

    const kv = (rows) => {
      const labelW = 170;
      const valueW = W - labelW - 10;
      rows.forEach(([label, value, color], i) => {
        const v = safe(value === undefined || value === null || value === '' ? '-' : value);
        doc.font('Helvetica').fontSize(9.5);
        const h = Math.max(doc.heightOfString(v, { width: valueW }), doc.heightOfString(safe(label), { width: labelW - 8 })) + 7;
        need(h);
        const y = doc.y;
        if (i % 2 === 0) doc.rect(M, y, W, h).fill(COLORS.band);
        doc.fillColor(COLORS.muted).font('Helvetica').fontSize(9.5).text(safe(label), M + 6, y + 3.5, { width: labelW - 8 });
        doc.fillColor(color || COLORS.ink).font(color ? 'Helvetica-Bold' : 'Helvetica').text(v, M + labelW + 4, y + 3.5, { width: valueW });
        doc.y = y + h;
      });
      doc.fillColor(COLORS.ink);
    };

    // ---------- title ----------
    doc.font('Helvetica-Bold').fontSize(20).fillColor(COLORS.ink).text('Customer Screening Report', M, M, { width: W, align: 'center' });
    doc.moveDown(0.3);
    doc.moveTo(M, doc.y).lineTo(M + W, doc.y).lineWidth(1).strokeColor(COLORS.rule).stroke();
    doc.moveDown(0.4);
    doc.font('Helvetica').fontSize(9).fillColor(COLORS.ink).text(safe(`Report generated on ${fmt(new Date())} for ${viewer.name}`), M, doc.y, { width: W });

    if (sc.incomplete) {
      doc.moveDown(0.6);
      const reasons = (sc.results.incompleteReasons || []).map((r) => '- ' + r).join('\n');
      const text = 'INCOMPLETE SCREENING. One or more required lists were not available when this screening ran, so a clear result must not be relied on.\n' + reasons;
      doc.font('Helvetica-Bold').fontSize(9);
      const h = doc.heightOfString(safe(text), { width: W - 16 }) + 12;
      need(h);
      const y = doc.y;
      doc.rect(M, y, W, h).lineWidth(1.2).strokeColor(COLORS.red).stroke();
      doc.fillColor(COLORS.red).text(safe(text), M + 8, y + 6, { width: W - 16 });
      doc.y = y + h;
      doc.fillColor(COLORS.ink);
    }

    // ---------- customer summary ----------
    section('Customer Summary');
    const reviewText =
      sc.reviewStatus === 'none' ? 'No review needed' : sc.reviewStatus === 'open' ? 'Open: awaiting review' : 'Closed: ' + (DECISION_TEXT[sc.outcome] || sc.outcome || 'cleared').replace('Escalated', 'Escalated').replace('cleared', 'Cleared');
    kv([
      ['Customer ID', sc.customerRef],
      ['Customer name', sc.customerName],
      ['Customer type', sc.customerType === 'company' ? 'Company' : 'Individual'],
      ['Screened on', fmt(sc.createdAt)],
      ['Screening reference', '#' + sc.id],
      ['Triggered by', TRIGGER_TEXT[sc.trigger] || sc.trigger],
      ['Screened by', sc.createdBy && sc.createdBy.name],
      ['Ongoing monitoring', sc.customerMonitor ? 'Yes' : 'No'],
      ['Review status', reviewText],
    ]);

    // ---------- each subject ----------
    const decFor = (subjectKey, hitKey) => sc.dispositions.find((d) => d.subjectKey === subjectKey && d.hitKey === hitKey);
    sc.results.subjects.forEach((s, i) => {
      section(i === 0 ? 'Customer Identification Details' : `Related Party ${i}: ${s.role}`);
      kv([
        ['Name', s.name],
        ['Role', s.role],
        ['Type', s.type === 'company' ? 'Company' : 'Individual'],
        ...(s.type === 'person' ? [['Gender', s.gender ? s.gender[0].toUpperCase() + s.gender.slice(1) : ''], ['Date of birth', fmtDay(s.dob)]] : []),
        ['Nationality', s.nationality ? countryName(s.nationality) : ''],
        [s.type === 'company' ? 'Country of incorporation' : 'Country of residence', s.country ? countryName(s.country) : ''],
        ['ID document type', s.idType],
        ['ID number', s.idNumber],
        ['ID issuing country', s.idCountry ? countryName(s.idCountry) : ''],
        ['ID issue date', fmtDay(s.idIssue)],
        ['ID expiry date', fmtDay(s.idExpiry)],
      ]);

      section(i === 0 ? 'Alert Summary' : `Alert Summary: ${s.name}`);
      const alert = s.hits.length > 0;
      kv([
        ['Alert', alert ? 'Yes' : 'No', alert ? COLORS.red : COLORS.green],
        ['Possible matches awaiting or under review', String(s.hits.length)],
        ['Country risk flags', s.countryFlags.length ? 'Yes (' + s.countryFlags.length + ')' : 'No', s.countryFlags.length ? COLORS.amber : null],
        ['Matches previously cleared as false positives', String(s.suppressed.length)],
        ['Name matches discarded (date of birth mismatch)', String(s.discarded.dob)],
        ['Name matches discarded (country mismatch)', String(s.discarded.country)],
      ]);
      if (s.truncated) {
        doc.moveDown(0.3).font('Helvetica-Oblique').fontSize(8.5).fillColor(COLORS.amber).text('Results were limited to the strongest matches. Narrow the search or review manually.', M, doc.y, { width: W });
        doc.fillColor(COLORS.ink);
      }

      if (s.hits.length) {
        section(i === 0 ? 'Possible Matches' : `Possible Matches: ${s.name}`);
        s.hits.forEach((h, n) => {
          const d = decFor(s.key, `${h.listKey}:${h.entryId}`);
          const list = sc.results.lists.find((l) => l.key === h.listKey);
          const flagText = [
            h.idMatch ? 'ID number matches' : '',
            h.flags.dob === 'match' ? 'Date of birth matches' + (h.flags.dobNote ? ' (' + h.flags.dobNote + ')' : '') : h.flags.dob === 'mismatch' ? 'Date of birth differs' : h.flags.dob === 'unknown' ? 'No date of birth on list entry' : '',
            h.flags.country === 'match' ? 'Country matches' : h.flags.country === 'mismatch' ? 'Country differs' : '',
          ].filter(Boolean).join('; ');
          const rows = [
            [`Match ${n + 1}`, `${h.name}  (score ${h.score}, ${h.strength} match)`, h.strength === 'Strong' ? COLORS.red : COLORS.amber],
            ['List', list ? list.name : h.listKey],
            ['Matched on', h.isAlias ? 'Alias: ' + h.matchedName : 'Primary name'],
            ['Entry type', h.type === 'person' ? 'Individual' : h.type === 'company' ? 'Entity' : 'Other'],
            ['Date(s) of birth on list', (h.dobs || []).join('; ')],
            ['Nationality on list', (h.nationalities || []).map(countryName).join(', ')],
            ['Reference and programme', [h.ref, h.program].filter(Boolean).join(' / ')],
            ['Listed on', h.listedOn],
            ['Other names', (h.aliases || []).join('; ')],
            ['Comparison with customer', flagText],
            ['Review decision', d ? `${DECISION_TEXT[d.decision]}: ${d.reason} (${d.by}, ${fmt(d.at)})` : 'Awaiting review', d ? (d.decision === 'false_positive' ? COLORS.green : COLORS.red) : COLORS.amber],
          ];
          need(120);
          kv(rows);
          doc.moveDown(0.5);
        });
      }
      if (s.suppressed.length) {
        doc.moveDown(0.2).font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.ink).text('Previously cleared matches (not re-alerted)', M, doc.y, { width: W });
        doc.moveDown(0.2);
        kv(s.suppressed.map((h) => [`${h.name}`, `Cleared as false positive by ${h.cleared.by} on ${fmt(h.cleared.at)}: ${h.cleared.reason}`]));
      }
      if (s.countryFlags.length) {
        doc.moveDown(0.4).font('Helvetica-Bold').fontSize(9.5).fillColor(COLORS.ink).text('Country risk flags', M, doc.y, { width: W });
        doc.moveDown(0.2);
        kv(s.countryFlags.map((f) => [`${f.role}: ${f.country}`, `${f.listName}${f.asOf ? ' (as of ' + fmtDay(f.asOf) + ')' : ''}${f.note ? '. ' + f.note : ''}`, COLORS.amber]));
      }
    });

    // ---------- scan criteria ----------
    const c = sc.criteria;
    section('Scan Criteria');
    kv([
      ['Search operation', c.operation === 'AND' ? 'Basic search with AND operation (name plus every detail supplied must agree)' : 'Basic search with OR operation (name match is enough)'],
      ['Name match threshold', c.nameThreshold + '%'],
      ['ID number match', c.idMatch ? 'Included with 100%' : 'Not included'],
      ['Date of birth', c.dobEnforce ? `Included, ${c.dobMode === 'exact' ? 'exact date' : 'year only'}` : 'Not enforced (shown for review only)'],
      ['Country', c.countryEnforce ? 'Included, must agree' : 'Not enforced (shown for review only)'],
    ]);

    section('Lists Screened');
    kv(
      sc.results.lists.map((l) => {
        let v = STATUS_TEXT[l.status] || l.status;
        if (l.status === 'screened' || l.status === 'unavailable') {
          const bits = [];
          if (l.records != null) bits.push(l.records.toLocaleString('en-GB') + ' records');
          if (l.published) bits.push('published ' + fmtDay(l.published));
          if (l.asOf) bits.push('as of ' + fmtDay(l.asOf));
          if (l.version) bits.push('version ' + l.version);
          if (bits.length) v += ' (' + bits.join(', ') + ')';
        }
        if (l.note) v += '. ' + l.note;
        return [l.name, v, l.status === 'unavailable' ? COLORS.red : l.status === 'not_connected' ? COLORS.amber : null];
      })
    );

    doc.moveDown(0.8).font('Helvetica-Oblique').fontSize(8).fillColor(COLORS.muted).text(
      'This report records the result of an automated screening at the time shown. A clear result is only as complete as the lists listed above. Possible matches require review by a qualified person before any decision is taken.',
      M, doc.y, { width: W }
    );

    // ---------- footers ----------
    const range = doc.bufferedPageRange();
    for (let i = range.start; i < range.start + range.count; i++) {
      doc.switchToPage(i);
      doc.page.margins.bottom = 0;
      const y = doc.page.height - 36;
      doc.moveTo(M, y - 6).lineTo(M + W, y - 6).lineWidth(0.5).strokeColor(COLORS.rule).stroke();
      doc.font('Helvetica').fontSize(8).fillColor(COLORS.muted);
      doc.text('MoneyBee Confidential', M, y, { width: W / 3, align: 'left', lineBreak: false });
      doc.text(safe(`${sc.customerRef} / screening #${sc.id}`), M + W / 3, y, { width: W / 3, align: 'center', lineBreak: false });
      doc.text(`Page ${i + 1} of ${range.count}`, M + (W * 2) / 3, y, { width: W / 3, align: 'right', lineBreak: false });
    }
    doc.end();
  });
}

module.exports = { render };
