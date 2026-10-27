'use strict';
// MoneyBee Screening front end. No framework. All text from the server goes through textContent,
// never innerHTML, because list entries and customer names are untrusted.

const $app = document.getElementById('app');
const state = { user: null, meta: null, alertCount: 0 };

function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props || {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value') el.value = v;
    else if (k === 'checked') el.checked = !!v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  const add = (c) => {
    if (c === null || c === undefined || c === false) return;
    if (Array.isArray(c)) c.forEach(add);
    else el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

function toast(msg, isErr) {
  const box = document.getElementById('toast');
  const t = h('div', { class: isErr ? 'err' : '' }, msg);
  box.append(t);
  setTimeout(() => t.remove(), isErr ? 7000 : 3500);
}

async function api(method, path, body) {
  const res = await fetch('/api' + path, {
    method,
    headers: { 'content-type': 'application/json', 'x-requested-with': 'fetch' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data = null;
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('json')) data = await res.json();
  else data = await res.text();
  if (!res.ok) {
    if (res.status === 401 && path !== '/login') {
      state.user = null;
      renderLogin();
    } else if (res.status === 403 && data && data.mustChange) {
      renderPasswordChange(true);
    }
    const e = new Error((data && data.error) || 'Request failed (' + res.status + ')');
    e.status = res.status;
    throw e;
  }
  return data;
}

async function guard(fn) {
  try {
    return await fn();
  } catch (e) {
    toast(e.message, true);
  }
}

function fmtTime(t) {
  if (!t) return '';
  const d = new Date(t);
  return d.toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' });
}
function fmtDay(s) {
  if (!s) return '';
  const m = String(s).match(/^(\d{4})-(\d{2})-(\d{2})/);
  return m ? `${m[3]}-${m[2]}-${m[1]}` : s;
}
const canWrite = () => state.user && state.user.role !== 'viewer';
const isAdmin = () => state.user && state.user.role === 'admin';
const DECISIONS = { true_match: 'True match', false_positive: 'False positive', escalate: 'Escalated' };
const RISK = { clear: ['Clear', 'green'], open_alert: ['Open alert', 'red'], confirmed_match: ['Confirmed match', 'red'] };

function pill(text, color) { return h('span', { class: 'pill ' + (color || 'grey') }, text); }
function field(label, input, hint) { return h('div', {}, h('label', {}, label), input, hint ? h('div', { class: 'muted small' }, hint) : null); }

// ---------------------------------------------------------------- shell
const NAV = [
  ['screen', 'Screen', () => true],
  ['customers', 'Customers', () => true],
  ['alerts', 'Alerts', () => true],
  ['batch', 'Batch', () => true],
  ['lists', 'Lists', () => true],
  ['users', 'Users', isAdmin],
  ['audit', 'Audit log', isAdmin],
  ['settings', 'Settings', isAdmin],
];

async function refreshAlertCount() {
  try {
    const a = await api('GET', '/alerts?status=open');
    state.alertCount = a.rows.length;
  } catch (_) { /* ignore */ }
}

function shell(active, content) {
  $app.replaceChildren(
    h('header', { class: 'top' },
      h('div', { class: 'brand' }, 'MoneyBee Screening'),
      h('nav', {}, NAV.filter((n) => n[2]()).map(([key, label]) =>
        h('a', { href: '#/' + key, class: key === active ? 'on' : '' }, label, key === 'alerts' && state.alertCount ? h('span', { class: 'badge' }, state.alertCount) : null))),
      h('div', { class: 'who' }, state.user.name + ' (' + state.user.role + ')'),
      h('button', { onclick: () => guard(async () => { await api('POST', '/logout'); state.user = null; renderLogin(); }) }, 'Sign out')),
    h('main', {}, content));
}

// ---------------------------------------------------------------- login and password
function renderLogin() {
  const email = h('input', { type: 'email', autocomplete: 'username', required: true });
  const pw = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const form = h('form', { class: 'panel login', onsubmit: (e) => {
    e.preventDefault();
    guard(async () => {
      const r = await api('POST', '/login', { email: email.value, password: pw.value });
      state.user = r.user;
      if (r.user.mustChange) return renderPasswordChange(true);
      boot();
    });
  } },
    h('h1', {}, 'MoneyBee Screening'),
    h('p', { class: 'muted' }, 'Sign in to screen customers against sanctions lists.'),
    field('Email', email), h('div', { style: 'height:10px' }), field('Password', pw), h('div', { style: 'height:16px' }),
    h('button', { class: 'primary', type: 'submit' }, 'Sign in'));
  $app.replaceChildren(form);
  email.focus();
}

function renderPasswordChange(forced) {
  const cur = h('input', { type: 'password', autocomplete: 'current-password', required: true });
  const next = h('input', { type: 'password', autocomplete: 'new-password', required: true });
  const form = h('form', { class: 'panel login', onsubmit: (e) => {
    e.preventDefault();
    guard(async () => {
      await api('POST', '/password', { current: cur.value, next: next.value });
      state.user.mustChange = false;
      toast('Password changed.');
      boot();
    });
  } },
    h('h1', {}, 'Choose a new password'),
    h('p', { class: 'muted' }, forced ? 'You must change your password before you continue.' : 'Use at least 10 characters with letters and a number.'),
    field('Current password', cur), h('div', { style: 'height:10px' }), field('New password', next, 'At least 10 characters, with letters and a number.'), h('div', { style: 'height:16px' }),
    h('button', { class: 'primary', type: 'submit' }, 'Change password'));
  $app.replaceChildren(form);
}

// ---------------------------------------------------------------- screen form
function partyBlock(idx, onRemove) {
  const f = {};
  const mk = (name, props) => (f[name] = h(name === 'type' || name === 'gender' ? 'select' : 'input', props));
  const countryInput = (name) => h('input', { list: 'countries', placeholder: 'Start typing a country' });
  f.name = h('input', { required: idx === 0, placeholder: idx === 0 ? 'Full name or company name' : 'Full name' });
  f.type = h('select', {}, h('option', { value: 'person' }, 'Individual'), h('option', { value: 'company' }, 'Company'));
  f.role = h('input', { placeholder: idx === 0 ? 'Customer' : 'Director, shareholder, beneficial owner' });
  f.dob = h('input', { type: 'date' });
  f.gender = h('select', {}, h('option', { value: '' }, 'Not given'), h('option', { value: 'male' }, 'Male'), h('option', { value: 'female' }, 'Female'));
  f.nationality = countryInput();
  f.country = countryInput();
  f.idType = h('select', {}, [['', 'No ID provided'], ['Emirates ID', 'Emirates ID'], ['Passport', 'Passport'], ['National ID', 'National ID'], ['Residence permit', 'Residence permit'], ['Trade licence', 'Trade licence (company)'], ['Other', 'Other']].map(([v, t]) => h('option', { value: v }, t)));
  f.idNumber = h('input', { placeholder: 'Choose a document type first', autocomplete: 'off' });
  f.idCountry = countryInput();
  f.idIssue = h('input', { type: 'date' });
  f.idExpiry = h('input', { type: 'date' });
  const fmtEid = () => {
    if (f.idType.value !== 'Emirates ID') return;
    const d = f.idNumber.value.replace(/\D/g, '').slice(0, 15);
    f.idNumber.value = [d.slice(0, 3), d.slice(3, 7), d.slice(7, 14), d.slice(14)].filter(Boolean).join('-');
  };
  f.idNumber.addEventListener('input', fmtEid);
  f.idType.addEventListener('change', () => {
    const t = f.idType.value;
    f.idNumber.placeholder = t === 'Emirates ID' ? '784-YYYY-NNNNNNN-C' : t === 'Passport' ? 'Passport number' : t ? 'Document number' : 'Choose a document type first';
    if (t === 'Emirates ID' && !f.idCountry.value) f.idCountry.value = 'United Arab Emirates';
    fmtEid();
  });
  const personOnly = [f.dob, f.gender, f.nationality];
  const sync = () => {
    const co = f.type.value === 'company';
    personOnly.forEach((el) => { el.disabled = co; if (co) el.value = ''; });
    countryLabel.textContent = co ? 'Country of incorporation' : 'Country of residence';
  };
  const countryLabel = h('label', {}, 'Country of residence');
  f.type.addEventListener('change', sync);
  const root = h('div', idx === 0 ? {} : { class: 'party' },
    idx === 0 ? null : h('div', { class: 'row spread' }, h('h3', {}, 'Related party ' + idx), h('button', { type: 'button', class: 'danger', onclick: onRemove }, 'Remove')),
    h('div', { class: 'grid' },
      field('Name', f.name), field('Type', f.type), field('Role', f.role),
      field('Date of birth', f.dob), field('Gender', f.gender), field('Nationality', f.nationality),
      h('div', {}, countryLabel, f.country)),
    h('div', { style: 'margin-top:14px;padding-top:12px;border-top:1px dashed var(--line)' },
      h('h3', {}, 'Identity document'),
      h('div', { class: 'muted small', style: 'margin-bottom:8px' }, 'Optional, but it is the most reliable way to tell two people with the same name apart. An exact ID number match on a list is flagged even if the name is spelled differently.'),
      h('div', { class: 'grid' }, field('Document type', f.idType), field('Document number', f.idNumber), field('Issuing country', f.idCountry), field('Issue date', f.idIssue), field('Expiry date', f.idExpiry))));
  const read = () => ({ name: f.name.value, type: f.type.value, role: f.role.value, dob: f.dob.value, gender: f.gender.value, nationality: f.nationality.value, country: f.country.value, idType: f.idType.value, idNumber: f.idNumber.value, idCountry: f.idCountry.value, idIssue: f.idIssue.value, idExpiry: f.idExpiry.value });
  return { root, read };
}

function criteriaFields(c, listOptions) {
  const op = h('select', {}, h('option', { value: 'AND' }, 'AND: name plus every detail supplied must agree'), h('option', { value: 'OR' }, 'OR: a name match is enough'));
  op.value = c.operation;
  const thr = h('input', { type: 'number', min: 50, max: 100, value: c.nameThreshold });
  const dobE = h('input', { type: 'checkbox', checked: c.dobEnforce });
  const dobM = h('select', {}, h('option', { value: 'exact' }, 'Exact date'), h('option', { value: 'year' }, 'Year only'));
  dobM.value = c.dobMode;
  const ctry = h('input', { type: 'checkbox', checked: c.countryEnforce });
  const idm = h('input', { type: 'checkbox', checked: c.idMatch });
  const boxes = listOptions.map((l) => ({ key: l.key, name: l.name, el: h('input', { type: 'checkbox', checked: c.lists === null || c.lists.includes(l.key) }) }));
  const root = h('div', {},
    h('div', { class: 'grid' },
      field('Search operation', op), field('Name match threshold (50 to 100)', thr), field('Date of birth match', dobM)),
    h('div', { class: 'grid', style: 'margin-top:12px' },
      h('label', { class: 'check' }, dobE, 'Discard matches when date of birth disagrees'),
      h('label', { class: 'check' }, ctry, 'Discard matches when country disagrees'),
      h('label', { class: 'check' }, idm, 'Flag any exact ID number match')),
    h('div', { style: 'margin-top:12px' }, h('label', {}, 'Lists to screen'),
      h('div', { class: 'grid' }, boxes.map((b) => h('label', { class: 'check' }, b.el, b.name)))));
  const read = () => {
    const chosen = boxes.filter((b) => b.el.checked).map((b) => b.key);
    return { operation: op.value, nameThreshold: Number(thr.value), dobEnforce: dobE.checked, dobMode: dobM.value, countryEnforce: ctry.checked, idMatch: idm.checked, lists: chosen.length === boxes.length ? null : chosen };
  };
  return { root, read };
}

function countryDatalist() {
  return h('datalist', { id: 'countries' }, state.meta.countries.map((c) => h('option', { value: c.name })));
}

function viewScreen() {
  const parties = [];
  const partyBox = h('div', {});
  const addParty = () => {
    const idx = parties.length + 1;
    const p = partyBlock(idx, () => { parties.splice(parties.indexOf(p), 1); p.root.remove(); });
    parties.push(p);
    partyBox.append(p.root);
  };
  const primary = partyBlock(0);
  const ref = h('input', { placeholder: 'Leave blank to generate one' });
  const monitor = h('input', { type: 'checkbox' });
  const crit = criteriaFields(state.meta.criteria, state.meta.sanctionLists.concat(state.meta.countryLists));
  const submit = h('button', { class: 'primary', type: 'submit' }, 'Screen');
  const form = h('form', { onsubmit: (e) => {
    e.preventDefault();
    submit.disabled = true;
    submit.textContent = 'Screening...';
    guard(async () => {
      const subjects = [primary.read(), ...parties.map((p) => p.read())];
      const r = await api('POST', '/screenings', { ref: ref.value, monitor: monitor.checked, subjects, criteria: crit.read() });
      location.hash = '#/screening/' + r.screeningId;
    }).finally(() => { submit.disabled = false; submit.textContent = 'Screen'; });
  } },
    h('div', { class: 'panel' }, h('h3', {}, 'Customer'), primary.root,
      h('div', { class: 'grid', style: 'margin-top:12px' }, field('Customer reference', ref, 'Use an existing reference to screen the same customer again.'),
        h('div', {}, h('label', {}, 'Ongoing monitoring'), h('label', { class: 'check' }, monitor, 'Re-screen automatically when lists change')))),
    h('div', { class: 'panel' }, h('div', { class: 'row spread' }, h('h3', {}, 'Related parties'), h('button', { type: 'button', onclick: addParty }, 'Add related party')),
      h('div', { class: 'muted small' }, 'Directors, shareholders and beneficial owners are screened with the same criteria and appear on the same report.'), partyBox),
    h('details', { class: 'panel' }, h('summary', {}, 'Scan criteria (defaults are set by an administrator)'), h('div', { style: 'margin-top:12px' }, crit.root)),
    h('div', { class: 'row end' }, submit));
  const down = state.meta.lists.filter((l) => l.kind === 'sanctions' && l.required && (l.status !== 'ready' || l.stale));
  shell('screen', [
    h('h1', {}, 'Screen a customer'),
    h('p', { class: 'muted' }, 'Names are checked against sanctions lists and country risk lists. Paid providers are not connected yet and are shown as not screened on every report.'),
    down.length ? h('div', { class: 'banner amber' }, 'Some required lists are not ready: ' + down.map((l) => l.name + (l.stale ? ' (out of date)' : ' (' + l.status + ')')).join('; ') + '. A screening run now will be marked incomplete.') : null,
    canWrite() ? form : h('div', { class: 'banner amber' }, 'Your role is read only. You can view results but not run screenings.'),
    countryDatalist(),
  ]);
}

// ---------------------------------------------------------------- screening result
function flagPills(hit) {
  const out = [];
  if (hit.idMatch) out.push(pill('ID number matches', 'red'));
  const f = hit.flags || {};
  if (f.dob === 'match') out.push(pill('Date of birth matches' + (f.dobNote ? ' (' + f.dobNote + ')' : ''), 'red'));
  else if (f.dob === 'mismatch') out.push(pill('Date of birth differs', 'green'));
  else if (f.dob === 'unknown') out.push(pill('No date of birth on list', 'amber'));
  if (f.country === 'match') out.push(pill('Country matches', 'red'));
  else if (f.country === 'mismatch') out.push(pill('Country differs', 'green'));
  return out;
}

function hitCard(sc, sub, hit) {
  const key = hit.listKey + ':' + hit.entryId;
  const dec = sc.dispositions.find((d) => d.subjectKey === sub.key && d.hitKey === key);
  const list = sc.results.lists.find((l) => l.key === hit.listKey);
  const decision = h('select', {}, h('option', { value: 'false_positive' }, 'False positive'), h('option', { value: 'true_match' }, 'True match'), h('option', { value: 'escalate' }, 'Escalate'));
  const reason = h('input', { placeholder: 'Reason for the decision (required)' });
  const save = h('button', { class: 'primary', onclick: () => guard(async () => {
    const r = await api('POST', `/screenings/${sc.id}/review`, { subjectKey: sub.key, hitKey: key, decision: decision.value, reason: reason.value });
    toast('Decision saved.');
    await refreshAlertCount();
    renderScreening(r.screening);
  }) }, dec ? 'Change decision' : 'Save decision');
  const kv = [
    ['List', list ? list.name : hit.listKey],
    ['Matched on', hit.isAlias ? 'Alias: ' + hit.matchedName : 'Primary name'],
    ['Entry type', hit.type === 'person' ? 'Individual' : hit.type === 'company' ? 'Entity' : 'Other'],
    ['ID matched', hit.idMatch ? hit.idMatch.number + (hit.idMatch.type ? ' (' + hit.idMatch.type + ' on the list)' : '') : ''],
    ['Date(s) of birth', (hit.dobs || []).join('; ')],
    ['Nationality', (hit.nationalities || []).join(', ')],
    ['Reference', [hit.ref, hit.program].filter(Boolean).join(' / ')],
    ['Listed on', hit.listedOn],
    ['Other names', (hit.aliases || []).slice(0, 8).join('; ')],
  ].filter((r) => r[1]);
  return h('div', { class: 'hit' + (hit.strength === 'Strong' ? ' strong' : '') },
    h('div', { class: 'head' }, h('strong', {}, hit.name), h('div', { class: 'row' }, pill(hit.strength + ' match, score ' + hit.score, hit.strength === 'Strong' ? 'red' : 'amber'), ...flagPills(hit))),
    hit.previouslyConfirmed ? h('div', { class: 'banner red small' }, 'Confirmed as a true match earlier by ' + hit.previouslyConfirmed.by + ' (screening #' + hit.previouslyConfirmed.screeningId + ').') : null,
    h('dl', { class: 'kv' }, kv.flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)])),
    h('div', { class: 'review' },
      dec ? h('div', { style: 'margin-bottom:8px' }, pill(DECISIONS[dec.decision], dec.decision === 'false_positive' ? 'green' : 'red'), ' ', h('span', { class: 'muted small' }, dec.by + ', ' + fmtTime(dec.at) + ': ' + dec.reason)) : h('div', { style: 'margin-bottom:8px' }, pill('Awaiting review', 'amber')),
      canWrite() ? h('div', { class: 'grid' }, field('Decision', decision), field('Reason', reason), save) : null));
}

function renderScreening(sc) {
  const rs = sc.reviewStatus;
  const state1 = rs === 'none' ? pill('No possible matches', 'green') : rs === 'open' ? pill('Open: awaiting review', 'red') : pill('Closed: ' + (sc.outcome === 'true_match' ? 'true match confirmed' : 'cleared'), sc.outcome === 'true_match' ? 'red' : 'green');
  shell('customers', [
    h('div', { class: 'row spread' },
      h('div', {}, h('h1', {}, sc.customerName), h('div', { class: 'muted' }, sc.customerRef + ' | screened ' + fmtTime(sc.createdAt) + ' by ' + sc.createdBy.name + ' | ' + sc.trigger)),
      h('div', { class: 'row' },
        canWrite() ? h('button', { onclick: () => guard(async () => { const r = await api('POST', `/customers/${sc.customerId}/rescreen`); toast('Screened again.'); await refreshAlertCount(); location.hash = '#/screening/' + r.screeningId; }) }, 'Screen again') : null,
        h('a', { class: 'btn primary', href: `/api/screenings/${sc.id}/pdf` }, 'Download PDF report'))),
    h('div', { style: 'margin:12px 0' }, state1, ' ', sc.riskFlag ? pill('Country risk flag', 'amber') : null, ' ', sc.customerMonitor ? pill('Monitored', 'grey') : null),
    sc.incomplete ? h('div', { class: 'banner red' }, h('strong', {}, 'Incomplete screening. '), 'A clear result must not be relied on.', h('ul', {}, (sc.results.incompleteReasons || []).map((r) => h('li', {}, r)))) : null,
    sc.results.subjects.map((s, i) => h('div', { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, (i === 0 ? '' : s.role + ': ') + s.name),
      h('div', { class: 'muted small', style: 'margin-bottom:10px' }, [s.type === 'company' ? 'Company' : 'Individual', s.dob && 'born ' + fmtDay(s.dob), s.nationality && 'nationality ' + s.nationality, s.country && 'country ' + s.country, s.idNumber && (s.idType || 'ID') + ' ' + s.idNumber].filter(Boolean).join(' | ')),
      s.hits.length ? s.hits.map((hit) => hitCard(sc, s, hit)) : h('div', { class: 'banner green' }, 'No possible matches on the lists screened.'),
      s.countryFlags.length ? h('div', { class: 'banner amber' }, s.countryFlags.map((f) => h('div', {}, f.role + ': ' + f.country + ' is on ' + f.listName + (f.asOf ? ' (as of ' + fmtDay(f.asOf) + ')' : '') + (f.note ? '. ' + f.note : '')))) : null,
      s.suppressed.length ? h('details', {}, h('summary', {}, s.suppressed.length + ' match(es) previously cleared as false positives'), s.suppressed.map((x) => h('div', { class: 'small muted', style: 'margin-top:6px' }, x.name + ': cleared by ' + x.cleared.by + ' on ' + fmtTime(x.cleared.at) + '. ' + x.cleared.reason))) : null,
      (s.discarded.dob || s.discarded.country) ? h('div', { class: 'muted small', style: 'margin-top:8px' }, 'Name matches discarded: ' + s.discarded.dob + ' for date of birth, ' + s.discarded.country + ' for country.') : null,
      s.truncated ? h('div', { class: 'banner amber small' }, 'Results were limited to the strongest matches.') : null)),
    h('div', { class: 'panel' },
      h('h2', { style: 'margin-top:0' }, 'Lists screened'),
      h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, h('th', {}, 'List'), h('th', {}, 'Status'), h('th', {}, 'Detail'))),
        h('tbody', {}, sc.results.lists.map((l) => h('tr', {}, h('td', {}, l.name),
          h('td', {}, l.status === 'screened' ? pill('Screened', 'green') : l.status === 'unavailable' ? pill('Not screened: unavailable', 'red') : l.status === 'not_connected' ? pill('Not connected', 'amber') : pill('Not included', 'grey')),
          h('td', { class: 'small muted' }, [l.records != null && l.records.toLocaleString('en-GB') + (l.records === 1 ? ' record' : ' records'), l.published && 'published ' + fmtDay(l.published), l.asOf && 'as of ' + fmtDay(l.asOf), l.note].filter(Boolean).join(' | '))))))),
      h('div', { class: 'muted small', style: 'margin-top:10px' }, 'Criteria: ' + sc.criteria.operation + ', name threshold ' + sc.criteria.nameThreshold + '%, date of birth ' + (sc.criteria.dobEnforce ? sc.criteria.dobMode : 'not enforced') + ', country ' + (sc.criteria.countryEnforce ? 'enforced' : 'not enforced') + '.')),
  ]);
}

async function viewScreening(id) {
  const sc = await api('GET', '/screenings/' + id);
  renderScreening(sc);
}

// ---------------------------------------------------------------- customers and alerts
async function viewCustomers() {
  let q = '', status = '', page = 0;
  const body = h('div', {});
  const qi = h('input', { placeholder: 'Search by name, reference or ID number', onkeydown: (e) => { if (e.key === 'Enter') { q = qi.value; page = 0; load(); } } });
  const st = h('select', { onchange: () => { status = st.value; page = 0; load(); } }, h('option', { value: '' }, 'All statuses'), h('option', { value: 'open_alert' }, 'Open alert'), h('option', { value: 'confirmed_match' }, 'Confirmed match'), h('option', { value: 'clear' }, 'Clear'));
  async function load() {
    const r = await api('GET', `/customers?q=${encodeURIComponent(q)}&status=${status}&page=${page}`);
    body.replaceChildren(
      h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Reference', 'Name', 'Type', 'Status', 'Monitored', 'Last screened', 'Screenings'].map((x) => h('th', {}, x)))),
        h('tbody', {}, r.rows.length ? r.rows.map((c) => h('tr', { class: 'click', onclick: () => (location.hash = '#/customer/' + c.id) },
          h('td', { class: 'mono' }, c.ref), h('td', {}, c.name), h('td', {}, c.type === 'company' ? 'Company' : 'Individual'),
          h('td', {}, pill(RISK[c.risk_status][0], RISK[c.risk_status][1])), h('td', {}, c.monitor ? 'Yes' : 'No'), h('td', {}, fmtTime(c.last_screened_at)), h('td', {}, c.screenings))) : h('tr', {}, h('td', { colspan: 7, class: 'muted' }, 'No customers yet. Screen someone to create the first one.'))))),
      h('div', { class: 'row spread', style: 'margin-top:10px' }, h('span', { class: 'muted small' }, r.total + ' customers'),
        h('div', { class: 'row' }, h('button', { disabled: page === 0, onclick: () => { page--; load(); } }, 'Previous'), h('button', { disabled: (page + 1) * 50 >= r.total, onclick: () => { page++; load(); } }, 'Next'))));
  }
  shell('customers', [h('h1', {}, 'Customers'), h('div', { class: 'row', style: 'margin:12px 0' }, qi, st), body]);
  await load();
}

async function viewCustomer(id) {
  const { customer: c, history } = await api('GET', '/customers/' + id);
  const mon = h('input', { type: 'checkbox', checked: c.monitor, disabled: !canWrite(), onchange: () => guard(async () => { await api('PATCH', '/customers/' + id, { monitor: mon.checked }); toast(mon.checked ? 'Ongoing monitoring on.' : 'Ongoing monitoring off.'); }) });
  shell('customers', [
    h('div', { class: 'row spread' }, h('div', {}, h('h1', {}, c.name), h('div', { class: 'muted' }, c.ref + ' | ' + (c.type === 'company' ? 'Company' : 'Individual'))),
      canWrite() ? h('button', { class: 'primary', onclick: () => guard(async () => { const r = await api('POST', `/customers/${id}/rescreen`); await refreshAlertCount(); location.hash = '#/screening/' + r.screeningId; }) }, 'Screen again') : null),
    h('div', { style: 'margin:12px 0' }, pill(RISK[c.risk_status][0], RISK[c.risk_status][1]), ' ', h('label', { class: 'check', style: 'display:inline-flex;margin-left:12px' }, mon, 'Ongoing monitoring')),
    h('div', { class: 'panel' }, h('h3', {}, 'Names on file'), h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Role', 'Born', 'Nationality', 'Country', 'ID'].map((x) => h('th', {}, x)))),
      h('tbody', {}, c.subjects.map((s) => h('tr', {}, h('td', {}, s.name), h('td', {}, s.role), h('td', {}, fmtDay(s.dob)), h('td', {}, s.nationality), h('td', {}, s.country), h('td', {}, s.idNumber))))))),
    h('h2', {}, 'Screening history'),
    h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'By', 'Trigger', 'Result', 'Review'].map((x) => h('th', {}, x)))),
      h('tbody', {}, history.map((s) => h('tr', { class: 'click', onclick: () => (location.hash = '#/screening/' + s.id) },
        h('td', {}, fmtTime(s.created_at)), h('td', {}, s.by_name || 'System'), h('td', {}, s.trigger),
        h('td', {}, s.hit_count ? pill(s.hit_count + ' possible match(es)', 'red') : pill('No matches', 'green'), ' ', s.risk_flag ? pill('Country risk', 'amber') : null, ' ', s.incomplete ? pill('Incomplete', 'red') : null),
        h('td', {}, s.review_status === 'none' ? '' : s.review_status === 'open' ? 'Open' : 'Closed: ' + (s.outcome === 'true_match' ? 'true match' : 'cleared'))))))),
  ]);
}

async function viewAlerts() {
  let tab = 'open';
  const body = h('div', {});
  async function load() {
    const r = await api('GET', '/alerts?status=' + tab);
    body.replaceChildren(h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'Reference', 'Customer', 'Possible matches', 'Source', 'Review'].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.rows.length ? r.rows.map((a) => h('tr', { class: 'click', onclick: () => (location.hash = '#/screening/' + a.id) },
        h('td', {}, fmtTime(a.created_at)), h('td', { class: 'mono' }, a.ref), h('td', {}, a.name), h('td', {}, a.hit_count), h('td', {}, a.trigger),
        h('td', {}, a.review_status === 'open' ? pill('Open', 'red') : pill(a.outcome === 'true_match' ? 'True match' : 'Cleared', a.outcome === 'true_match' ? 'red' : 'green')))) : h('tr', {}, h('td', { colspan: 6, class: 'muted' }, tab === 'open' ? 'No open alerts.' : 'Nothing here yet.'))))));
  }
  const tabs = h('div', { class: 'tabs' }, ['open', 'closed'].map((t) => h('button', { class: t === tab ? 'on' : '', onclick: (e) => { tab = t; [...tabs.children].forEach((b) => b.classList.remove('on')); e.target.classList.add('on'); load(); } }, t === 'open' ? 'Open' : 'Closed')));
  shell('alerts', [h('h1', {}, 'Alerts'), h('p', { class: 'muted' }, 'Screenings with possible matches that need a decision. Ongoing monitoring adds alerts here when a list changes.'), tabs, body]);
  await load();
}

// ---------------------------------------------------------------- batch
async function viewBatch() {
  const file = h('input', { type: 'file', accept: '.csv,.txt' });
  const name = h('input', { placeholder: 'Batch name (optional)' });
  const body = h('div', {});
  let timer = null;
  async function load() {
    const r = await api('GET', '/batches');
    body.replaceChildren(h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['#', 'Name', 'Started', 'By', 'Progress', 'Alerts', 'Errors', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.rows.length ? r.rows.map((b) => h('tr', {}, h('td', {}, b.id), h('td', {}, b.name), h('td', {}, fmtTime(b.created_at)), h('td', {}, b.by_name),
        h('td', {}, h('div', { class: 'bar' }, h('div', { style: 'width:' + Math.round((100 * b.done) / Math.max(1, b.total)) + '%' })), h('span', { class: 'small muted' }, b.done + ' of ' + b.total + (b.status === 'failed' ? ' (failed)' : ''))),
        h('td', {}, b.alerts), h('td', {}, b.errors), h('td', {}, h('a', { href: `/api/batches/${b.id}/csv` }, 'Results CSV')))) : h('tr', {}, h('td', { colspan: 8, class: 'muted' }, 'No batches yet.'))))));
    if (r.rows.some((b) => b.status === 'running')) { clearTimeout(timer); timer = setTimeout(() => { if (location.hash === '#/batch') load(); }, 1500); }
    else await refreshAlertCount();
  }
  shell('batch', [
    h('h1', {}, 'Batch screening'),
    h('p', { class: 'muted' }, 'Upload a CSV with one row per name. Rows that share a customer_ref are one customer: the first row is the customer and the rest are related parties.'),
    canWrite() ? h('div', { class: 'panel' }, h('div', { class: 'row' }, file, name,
      h('button', { class: 'primary', onclick: () => guard(async () => {
        if (!file.files[0]) throw new Error('Choose a CSV file first.');
        const text = await file.files[0].text();
        const r = await api('POST', '/batches', { name: name.value || file.files[0].name, csv: text });
        toast('Batch started with ' + r.total + ' customers.');
        file.value = '';
        load();
      }) }, 'Start batch'), h('a', { href: '/api/batch-template' }, 'Download template'))) : null,
    body,
  ]);
  await load();
}

// ---------------------------------------------------------------- lists
function toBase64(buf) {
  let s = '';
  const bytes = new Uint8Array(buf);
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}

const STATUS_PILL = { ready: ['Ready', 'green'], loading: ['Loading', 'amber'], error: ['Error', 'red'], empty: ['No data', 'red'], not_connected: ['Not connected', 'amber'], screened: ['Connected', 'green'] };

function uploadPanel(list, reload) {
  const file = h('input', { type: 'file', accept: '.csv,.xlsx,.txt,.tsv' });
  const out = h('div', {});
  let payload = null;
  file.addEventListener('change', () => guard(async () => {
    out.replaceChildren();
    const f = file.files[0];
    if (!f) return;
    const data = toBase64(await f.arrayBuffer());
    const p = await api('POST', `/lists/${list.key}/preview`, { filename: f.name, data });
    payload = { filename: f.name, data, headerRow: p.headerRow };
    const headers = p.headers.map((x) => x).filter(Boolean);
    const sel = (value, multi) => {
      const s = h('select', multi ? { multiple: true, size: Math.min(5, headers.length) } : {}, multi ? null : h('option', { value: '' }, '(none)'), headers.map((x) => h('option', { value: x }, x)));
      if (multi) [...s.options].forEach((o) => { o.selected = (value || []).includes(o.value); });
      else s.value = value || '';
      return s;
    };
    const m = p.mapping;
    const ctl = { name: sel(m.name, true), aliases: sel(m.aliases, true), type: sel(m.type), dob: sel(m.dob), nationality: sel(m.nationality), country: sel(m.country), idNumber: sel(m.idNumber), ref: sel(m.ref), remarks: sel(m.remarks) };
    const mode = h('select', {}, h('option', { value: 'replace' }, 'Replace the whole list'), h('option', { value: 'append' }, 'Add to the existing list'));
    const readMulti = (s) => [...s.selectedOptions].map((o) => o.value);
    out.replaceChildren(
      h('p', { class: 'muted small' }, p.rows + ' rows found. Check the column mapping, then import. Hold Ctrl or Cmd to pick several columns.'),
      h('div', { class: 'grid' }, field('Name column(s)', ctl.name), field('Alias column(s)', ctl.aliases), field('Type', ctl.type), field('Date of birth', ctl.dob), field('Nationality', ctl.nationality), field('Country', ctl.country), field('ID or passport number', ctl.idNumber), field('Reference', ctl.ref), field('Remarks', ctl.remarks), field('Import mode', mode)),
      h('div', { class: 'tbl-wrap', style: 'margin-top:10px' }, h('table', {}, h('thead', {}, h('tr', {}, p.headers.map((x) => h('th', {}, x)))), h('tbody', {}, p.sample.map((r) => h('tr', {}, p.headers.map((_, i) => h('td', { class: 'small' }, r[i] || ''))))))),
      h('div', { class: 'row end', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: () => guard(async () => {
        const mapping = { name: readMulti(ctl.name), aliases: readMulti(ctl.aliases), type: ctl.type.value, dob: ctl.dob.value, nationality: ctl.nationality.value, country: ctl.country.value, idNumber: ctl.idNumber.value, ref: ctl.ref.value, remarks: ctl.remarks.value };
        const r = await api('POST', `/lists/${list.key}/import`, { ...payload, mapping, mode: mode.value });
        toast(`Imported. The list now has ${r.total} records.` + (r.skipped ? ` ${r.skipped} rows skipped.` : ''));
        reload();
      }) }, 'Import')));
  }));
  return h('div', { class: 'panel' }, h('div', { class: 'row spread' }, h('h3', {}, 'Upload: ' + list.name),
    list.records ? h('button', { class: 'danger', onclick: () => { if (confirm('Remove all records from ' + list.name + '? Screenings will be marked incomplete until it is loaded again.')) guard(async () => { await api('DELETE', `/lists/${list.key}/entries`); reload(); }); } }, 'Remove all records') : null),
    list.key === 'uae' ? h('p', { class: 'muted small' }, 'The UAE Local Terrorist List is published by the Executive Office for Control and Non-Proliferation as a PDF or Excel file. Download it from the EOCN site, save it as .xlsx or .csv, and upload it here each time it changes. Until you do, every screening is marked incomplete.') : h('p', { class: 'muted small' }, 'Your own internal watchlist. Optional.'),
    file, out);
}

function countryEditor(cl, reload) {
  const text = h('textarea', { rows: 10, value: cl.countries.map((c) => c.name + (c.note ? ' | ' + c.note : '')).join('\n') });
  const asOf = h('input', { type: 'date', value: cl.asOf || '' });
  const source = h('input', { value: cl.source || '' });
  return h('div', { class: 'panel' }, h('h3', {}, cl.name),
    cl.verifiedBy ? h('div', { class: 'small' }, pill('Verified', 'green'), ' by ' + cl.verifiedBy + ' on ' + fmtTime(cl.verifiedAt)) : h('div', {}, pill('Not verified', 'amber'), h('span', { class: 'small muted' }, ' Check this list against the official source, then press Mark as verified.')),
    h('div', { class: 'grid', style: 'margin-top:10px' }, field('As of', asOf), field('Source', source)),
    h('div', { style: 'margin-top:10px' }, field('Countries, one per line (optional note after a vertical bar)', text)),
    isAdmin() ? h('div', { class: 'row end', style: 'margin-top:10px' },
      h('button', { onclick: () => guard(async () => {
        const countries = text.value.split('\n').map((l) => l.trim()).filter(Boolean).map((l) => { const [n, ...rest] = l.split('|'); return { name: n.trim(), note: rest.join('|').trim() }; });
        await api('PUT', '/country-lists/' + cl.key, { countries, asOf: asOf.value || null, source: source.value });
        toast('Saved. Mark the list as verified once you have checked it.');
        reload();
      }) }, 'Save changes'),
      h('button', { class: 'primary', onclick: () => guard(async () => { await api('POST', `/country-lists/${cl.key}/verify`); toast('Marked as verified.'); reload(); }) }, 'Mark as verified')) : null);
}

async function viewLists() {
  const r = await api('GET', '/lists');
  state.meta.lists = r.lists;
  const reload = () => viewLists();
  const sanctions = r.lists.filter((l) => l.kind === 'sanctions');
  const country = r.lists.filter((l) => l.kind === 'country');
  const provs = r.lists.filter((l) => l.kind === 'provider');
  const row = (l) => {
    const [t, c] = l.stale ? ['Out of date', 'red'] : STATUS_PILL[l.status] || [l.status, 'grey'];
    return h('tr', {}, h('td', {}, l.name, l.mode === 'upload' ? h('div', { class: 'small muted' }, 'Uploaded by an administrator') : null),
      h('td', {}, pill(t, c)), h('td', {}, l.records != null ? l.records.toLocaleString('en-GB') : ''),
      h('td', { class: 'small muted' }, [l.published && 'published ' + l.published, l.fetchedAt && 'checked ' + fmtTime(l.fetchedAt), l.changedAt && 'changed ' + fmtTime(l.changedAt), l.asOf && 'as of ' + fmtDay(l.asOf)].filter(Boolean).join(' | '),
        l.error ? h('div', { style: 'color:var(--red)' }, l.error) : null));
  };
  const head = (cols) => h('thead', {}, h('tr', {}, cols.map((x) => h('th', {}, x))));
  shell('lists', [
    h('div', { class: 'row spread' }, h('h1', {}, 'Lists and providers'),
      isAdmin() ? h('div', { class: 'row' }, h('button', { onclick: () => guard(async () => { await api('POST', '/lists/refresh'); toast('Refresh started. Reload this page in a minute.'); }) }, 'Refresh feeds now'),
        h('button', { onclick: () => guard(async () => { const o = await api('POST', '/monitoring/run'); toast(o.skipped ? 'A monitoring run is already in progress.' : `Monitoring checked ${o.checked} customers, ${o.newAlerts} new alert(s).`); await refreshAlertCount(); }) }, 'Run monitoring now')) : null),
    h('p', { class: 'muted' }, 'Downloaded lists refresh automatically and are re-checked for changes. Ongoing monitoring re-screens monitored customers whenever a list changes.'),
    h('h2', {}, 'Sanctions lists'), h('div', { class: 'tbl-wrap' }, h('table', {}, head(['List', 'Status', 'Records', 'Detail']), h('tbody', {}, sanctions.map(row)))),
    h('h2', {}, 'Country risk lists'), h('div', { class: 'tbl-wrap' }, h('table', {}, head(['List', 'Status', 'Countries', 'Detail']), h('tbody', {}, country.map((l) => { const x = row(l); return x; })))),
    h('h2', {}, 'Paid providers'), h('p', { class: 'muted small' }, 'Not connected for this release. They are shown as not screened on every report, so a screening never claims coverage it does not have.'),
    h('div', { class: 'tbl-wrap' }, h('table', {}, head(['Provider', 'Status']), h('tbody', {}, provs.map((p) => h('tr', {}, h('td', {}, p.name), h('td', {}, pill(STATUS_PILL[p.status][0], STATUS_PILL[p.status][1]))))))),
    isAdmin() ? [h('h2', {}, 'Manage uploaded lists'), uploadPanel(sanctions.find((l) => l.key === 'uae'), reload), uploadPanel(sanctions.find((l) => l.key === 'custom'), reload),
      h('h2', {}, 'Manage country lists'), r.countryLists.map((c) => countryEditor(c, reload))] : null,
  ]);
}

// ---------------------------------------------------------------- admin: users, audit, settings
async function viewUsers() {
  const r = await api('GET', '/users');
  const email = h('input', { type: 'email' }), name = h('input', {}), pw = h('input', { type: 'text', autocomplete: 'off' });
  const role = h('select', {}, ['analyst', 'viewer', 'admin'].map((x) => h('option', { value: x }, x)));
  shell('users', [
    h('h1', {}, 'Users'),
    h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['Name', 'Email', 'Role', 'Status', 'Last sign in', ''].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.rows.map((u) => {
        const rs = h('select', { onchange: () => guard(async () => { await api('PATCH', '/users/' + u.id, { role: rs.value }); toast('Role updated.'); }) }, ['admin', 'analyst', 'viewer'].map((x) => h('option', { value: x }, x)));
        rs.value = u.role;
        return h('tr', {}, h('td', {}, u.name), h('td', {}, u.email), h('td', {}, rs), h('td', {}, u.active ? pill('Active', 'green') : pill('Disabled', 'red'), u.must_change ? ' ' : null, u.must_change ? pill('Must change password', 'amber') : null), h('td', {}, fmtTime(u.last_login)),
          h('td', {}, h('div', { class: 'row' },
            h('button', { onclick: () => guard(async () => { await api('PATCH', '/users/' + u.id, { active: !u.active }); viewUsers(); }) }, u.active ? 'Disable' : 'Enable'),
            h('button', { onclick: () => { const p = prompt('New temporary password for ' + u.email + ' (10+ characters, letters and a number). They must change it at next sign in.'); if (p) guard(async () => { await api('PATCH', '/users/' + u.id, { password: p }); toast('Password reset.'); }); } }, 'Reset password'))));
      })))),
    h('div', { class: 'panel' }, h('h3', {}, 'Add a user'), h('div', { class: 'grid' }, field('Name', name), field('Email', email), field('Role', role, 'Analysts can screen and review. Viewers are read only.'), field('Temporary password', pw, 'They must change it at first sign in.')),
      h('div', { class: 'row end', style: 'margin-top:10px' }, h('button', { class: 'primary', onclick: () => guard(async () => { await api('POST', '/users', { name: name.value, email: email.value, role: role.value, password: pw.value }); toast('User added.'); viewUsers(); }) }, 'Add user'))),
  ]);
}

async function viewAudit() {
  let page = 0, action = '', user = '';
  const body = h('div', {});
  async function load() {
    const r = await api('GET', `/audit?page=${page}&action=${encodeURIComponent(action)}&user=${encodeURIComponent(user)}`);
    body.replaceChildren(h('div', { class: 'tbl-wrap' }, h('table', {}, h('thead', {}, h('tr', {}, ['When', 'User', 'Action', 'Item', 'Detail', 'IP'].map((x) => h('th', {}, x)))),
      h('tbody', {}, r.rows.map((a) => h('tr', {}, h('td', { class: 'small' }, fmtTime(a.at)), h('td', { class: 'small' }, a.user_email || 'system'), h('td', { class: 'mono' }, a.action), h('td', { class: 'small' }, [a.entity, a.entity_id].filter(Boolean).join(' ')), h('td', { class: 'small muted' }, a.detail ? JSON.stringify(a.detail).slice(0, 220) : ''), h('td', { class: 'small muted' }, a.ip || '')))))),
      h('div', { class: 'row', style: 'margin-top:10px' }, h('button', { disabled: page === 0, onclick: () => { page--; load(); } }, 'Newer'), h('button', { disabled: r.rows.length < 100, onclick: () => { page++; load(); } }, 'Older')));
  }
  const a = h('input', { placeholder: 'Action starts with, e.g. screening', onkeydown: (e) => { if (e.key === 'Enter') { action = a.value; user = u.value; page = 0; load(); } } });
  const u = h('input', { placeholder: 'User email contains', onkeydown: (e) => { if (e.key === 'Enter') { action = a.value; user = u.value; page = 0; load(); } } });
  shell('audit', [h('h1', {}, 'Audit log'), h('p', { class: 'muted' }, 'Every sign in, screening, review decision, list change and report download. Press Enter in a filter to apply it.'), h('div', { class: 'row', style: 'margin:12px 0' }, a, u), body]);
  await load();
}

async function viewSettings() {
  const c = await api('GET', '/settings/criteria');
  const crit = criteriaFields(c, state.meta.sanctionLists.concat(state.meta.countryLists));
  shell('settings', [
    h('h1', {}, 'Default scan criteria'),
    h('p', { class: 'muted' }, 'These apply to new screenings, to batches and to ongoing monitoring. Individual screenings can override them except in monitoring.'),
    h('div', { class: 'panel' }, crit.root, h('div', { class: 'row end', style: 'margin-top:12px' }, h('button', { class: 'primary', onclick: () => guard(async () => { await api('PUT', '/settings/criteria', crit.read()); state.meta.criteria = await api('GET', '/settings/criteria'); toast('Defaults saved.'); }) }, 'Save defaults'))),
    h('div', { class: 'panel' }, h('h3', {}, 'Your account'), h('button', { onclick: () => renderPasswordChange(false) }, 'Change my password')),
  ]);
}

// ---------------------------------------------------------------- router and boot
const ROUTES = {
  screen: viewScreen, customers: viewCustomers, alerts: viewAlerts, batch: viewBatch, lists: viewLists,
  users: viewUsers, audit: viewAudit, settings: viewSettings,
};

async function route() {
  if (!state.user) return;
  const parts = location.hash.replace(/^#\/?/, '').split('/');
  const name = parts[0] || 'screen';
  await guard(async () => {
    state.meta = await api('GET', '/meta');
    if (name === 'screening' && parts[1]) return viewScreening(parts[1]);
    if (name === 'customer' && parts[1]) return viewCustomer(parts[1]);
    const adminOnly = ['users', 'audit', 'settings'];
    if (adminOnly.includes(name) && !isAdmin()) { location.hash = '#/screen'; return; }
    return (ROUTES[name] || viewScreen)();
  });
}

async function boot() {
  try {
    const me = await api('GET', '/me');
    state.user = me.user;
  } catch (e) {
    if (e.status === 403) return; // password change screen already shown
    return renderLogin();
  }
  await refreshAlertCount();
  route();
}

window.addEventListener('hashchange', route);
boot();
