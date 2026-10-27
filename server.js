// MoneyBee screening test server.
// - Loads the UN Security Council consolidated list (downloaded on start, cached in ./data).
// - Falls back to a FICTIONAL sample list if the download fails and there is no cache.
// - Optional: set WATCHMAN_URL to also query a running Watchman instance.

const http = require("http");
const fs = require("fs");
const path = require("path");
const { XMLParser } = require("fast-xml-parser");
const { scoreRecord } = require("./match");

const PORT = Number(process.env.PORT || 3000);
const WATCHMAN_URL = (process.env.WATCHMAN_URL || "").replace(/\/$/, "");
const UN_URL = "https://scsanctions.un.org/resources/xml/en/consolidated.xml";
const DATA_DIR = path.join(__dirname, "data");
const CACHE_FILE = path.join(DATA_DIR, "un-consolidated.xml");
const SAMPLE_FILE = path.join(__dirname, "sample-un.xml");
const MIN_SCORE = 70;

const arr = (v) => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v]);
const text = (v) => (v === undefined || v === null ? "" : String(typeof v === "object" ? v["#text"] ?? "" : v)).trim();

function parseUN(xml) {
  const parser = new XMLParser({ ignoreAttributes: false, parseTagValue: false, trimValues: true });
  const doc = parser.parse(xml);
  const root = doc.CONSOLIDATED_LIST || {};
  const records = [];

  for (const p of arr(root.INDIVIDUALS && root.INDIVIDUALS.INDIVIDUAL)) {
    const name = [p.FIRST_NAME, p.SECOND_NAME, p.THIRD_NAME, p.FOURTH_NAME].map(text).filter(Boolean).join(" ");
    if (!name) continue;
    records.push({
      id: text(p.DATAID),
      type: "person",
      name,
      aliases: arr(p.INDIVIDUAL_ALIAS).map((a) => text(a.ALIAS_NAME)).filter(Boolean),
      list: text(p.UN_LIST_TYPE),
      ref: text(p.REFERENCE_NUMBER),
      listedOn: text(p.LISTED_ON),
      country: arr(p.NATIONALITY && p.NATIONALITY.VALUE).map(text).filter(Boolean).join(", "),
    });
  }

  for (const e of arr(root.ENTITIES && root.ENTITIES.ENTITY)) {
    const name = text(e.FIRST_NAME);
    if (!name) continue;
    records.push({
      id: text(e.DATAID),
      type: "company",
      name,
      aliases: arr(e.ENTITY_ALIAS).map((a) => text(a.ALIAS_NAME)).filter(Boolean),
      list: text(e.UN_LIST_TYPE),
      ref: text(e.REFERENCE_NUMBER),
      listedOn: text(e.LISTED_ON),
      country: "",
    });
  }
  return { records, generated: root["@_dateGenerated"] || "" };
}

const state = { records: [], source: "none", generated: "", loadedAt: null, note: "" };

async function loadList() {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  try {
    const res = await fetch(UN_URL, { signal: AbortSignal.timeout(60000) });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const xml = await res.text();
    const parsed = parseUN(xml);
    if (!parsed.records.length) throw new Error("downloaded file had no records");
    fs.writeFileSync(CACHE_FILE, xml);
    Object.assign(state, { records: parsed.records, source: "UN live download", generated: parsed.generated, note: "" });
  } catch (err) {
    if (fs.existsSync(CACHE_FILE)) {
      const parsed = parseUN(fs.readFileSync(CACHE_FILE, "utf8"));
      Object.assign(state, { records: parsed.records, source: "UN cached copy", generated: parsed.generated, note: "Live download failed (" + err.message + "), using the cached copy." });
    } else {
      const parsed = parseUN(fs.readFileSync(SAMPLE_FILE, "utf8"));
      Object.assign(state, { records: parsed.records, source: "FICTIONAL SAMPLE DATA", generated: parsed.generated, note: "Could not download the UN list (" + err.message + "). Results below are against fictional demo names only." });
    }
  }
  state.loadedAt = new Date().toISOString();
  console.log(`Loaded ${state.records.length} records from: ${state.source}`);
  if (state.note) console.log(state.note);
}

function searchLocal(name, type) {
  const out = [];
  for (const r of state.records) {
    if (type && type !== "any" && r.type !== type) continue;
    const { score, matchedName } = scoreRecord(name, r);
    if (score >= MIN_SCORE) out.push({ ...r, score, matchedName });
  }
  out.sort((a, b) => b.score - a.score);
  return out.slice(0, 10);
}

async function searchWatchman(name) {
  if (!WATCHMAN_URL) return null;
  // Watchman changed its API between versions, so try the newer path first, then the older one.
  const paths = ["/v2/search?name=", "/search?name="];
  let lastErr = "";
  for (const p of paths) {
    try {
      const res = await fetch(WATCHMAN_URL + p + encodeURIComponent(name) + "&limit=10", { signal: AbortSignal.timeout(15000) });
      if (res.ok) return { ok: true, endpoint: p, data: await res.json() };
      lastErr = p + " returned HTTP " + res.status;
    } catch (err) {
      lastErr = err.message;
    }
  }
  return { ok: false, error: lastErr };
}

const MIME = { ".html": "text/html; charset=utf-8", ".css": "text/css", ".js": "text/javascript" };

function send(res, code, body, type = "application/json") {
  res.writeHead(code, { "Content-Type": type });
  res.end(typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, "http://localhost");

  if (url.pathname === "/api/status") {
    return send(res, 200, {
      source: state.source,
      records: state.records.length,
      listGenerated: state.generated,
      loadedAt: state.loadedAt,
      note: state.note,
      watchman: WATCHMAN_URL || null,
    });
  }

  if (url.pathname === "/api/search") {
    const name = (url.searchParams.get("name") || "").trim();
    const type = url.searchParams.get("type") || "any";
    if (name.length < 2) return send(res, 400, { error: "Enter at least 2 characters." });
    const started = Date.now();
    const [matches, watchman] = await Promise.all([Promise.resolve(searchLocal(name, type)), searchWatchman(name)]);
    return send(res, 200, {
      query: name,
      type,
      source: state.source,
      ms: Date.now() - started,
      matches,
      watchman,
    });
  }

  const file = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
  const full = path.join(__dirname, "public", path.normalize(file).replace(/^(\.\.[/\\])+/, ""));
  if (full.startsWith(path.join(__dirname, "public")) && fs.existsSync(full) && fs.statSync(full).isFile()) {
    return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || "application/octet-stream");
  }
  send(res, 404, { error: "Not found" });
});

if (require.main === module) {
  loadList().then(() => {
    server.listen(PORT, () => console.log(`Open http://localhost:${PORT}`));
  });
}

module.exports = { parseUN, searchLocal, state, loadList, server };
