// Quick self-test against the fictional sample list. Run with: npm test
const fs = require("fs");
const path = require("path");
const assert = require("assert");
const { parseUN, state, searchLocal } = require("./server");

const parsed = parseUN(fs.readFileSync(path.join(__dirname, "sample-un.xml"), "utf8"));
state.records = parsed.records;

assert.strictEqual(parsed.records.length, 3, "should parse 2 people + 1 company");

const top = (name, type) => {
  const r = searchLocal(name, type);
  return r.length ? r[0] : null;
};

let r = top("Testov Alexei Demoson");
assert(r && r.score === 100, "exact name should score 100");

r = top("Alex Demoson");
assert(r && r.score === 100 && r.matchedName === "Alex Demoson", "alias should match exactly");

r = top("Aleksei Demoson");
assert(r && r.score >= 85 && r.score < 100, "spelling variant should score high but not 100, got " + (r && r.score));

r = top("Maria Fictionova");
assert(r && r.type === "person" && r.score === 100, "person exact");

r = top("Demo Trading Company", "company");
assert(r && r.type === "company" && r.score >= 85, "company partial name should match, got " + (r && r.score));

assert.strictEqual(top("Demo Trading Company", "person"), null, "type filter should exclude companies");
assert.strictEqual(top("John Smith"), null, "unrelated name should not match");
assert.strictEqual(top("Bluewave Logistics FZE"), null, "unrelated company should not match");

console.log("All tests passed.");
