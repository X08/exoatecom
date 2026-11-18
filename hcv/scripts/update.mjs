// Keeps hcv/data up to date. Runs on GitHub Actions (Node 20+, no dependencies).
//  - vault.json   : latest snapshot of the vault (only rewritten when it changed)
//  - changes.json : log of added / removed / quantity-changed items
//  - meta.json    : when the vault last changed + item-db progress
//  - items.json   : per item "id:suffix" -> {l: required level, i: item level, s: stats}
//  - tips/N.json  : tooltip HTML, sharded by itemId % 64 (loaded lazily by the page)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DIR = process.env.HCV_DIR || path.join(HERE, "..", "data");
const VAULT = process.env.HCV_VAULT_URL || "https://hcvault.roboto.space/api/vault";
const TIP = process.env.HCV_TIP_URL || "https://nether.wowhead.com/wotlk/tooltip/item/";
const LIMIT = +(process.env.HCV_LIMIT || 800);   // new items looked up per run
const CONC = +(process.env.HCV_CONC || 4);
const DELAY = +(process.env.HCV_DELAY || 120);   // ms pause per request, per worker
const MAXLOG = 800;
const SHARDS = 64;
const UA = "Mozilla/5.0 (compatible; hcv-wrapper personal item lookup)";

fs.mkdirSync(path.join(DIR, "tips"), { recursive: true });
const rd = (f, d) => { try { return JSON.parse(fs.readFileSync(path.join(DIR, f), "utf8")); } catch { return d; } };
const wr = (f, o) => fs.writeFileSync(path.join(DIR, f), JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function cats(j) {
  const ok = (a) => Array.isArray(a) && a.length && a[0] && Array.isArray(a[0].entries);
  if (ok(j)) return j;
  let best = null;
  (function walk(o, d) {
    if (!o || typeof o !== "object" || d > 2) return;
    if (ok(o) && (!best || o.length > best.length)) best = o;
    for (const k of Object.keys(o)) walk(o[k], d + 1);
  })(j, 0);
  return best || [];
}
function flat(j) {
  const m = new Map();
  for (const c of cats(j)) for (const e of c.entries || []) m.set(e.itemId + ":" + (e.suffixId || 0), { name: e.name, qty: e.available, cat: c.name });
  return m;
}

// ---- tooltip parser (same logic as the page)
function plain(html) {
  return String(html).replace(/<!--[\s\S]*?-->/g, "").replace(/<\/(tr|p|div)>|<br\s*\/?>/gi, "\n").replace(/<\/(td|th)>/gi, " ").replace(/<[^>]+>/g, "")
    .replace(/&nbsp;| /g, " ").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&#39;|&#x27;/g, "'").replace(/&amp;/g, "&");
}
const SLOTS = ["Head","Neck","Shoulder","Back","Chest","Shirt","Tabard","Wrist","Hands","Waist","Legs","Feet","Finger","Trinket","One-Hand","Main Hand","Off Hand","Two-Hand","Ranged","Thrown","Relic","Projectile","Quiver","Ammo Pouch","Bag"];
const SLOT_ALIAS = { shoulders: "Shoulder", "held in off-hand": "Off Hand", robe: "Chest", cloak: "Back", ammo: "Projectile" };
const SLOT_WORDS = "Head|Neck|Shoulders?|Back|Chest|Robe|Cloak|Shirt|Tabard|Wrist|Hands|Waist|Legs|Feet|Finger|Trinket|One-Hand|Two-Hand|Main Hand|Off Hand|Held In Off-hand|Ranged|Thrown|Relic|Projectile|Ammo Pouch|Ammo|Quiver|Bag";
// a text node that is exactly a slot word, wherever it sits in the markup
const SLOT_NODE = new RegExp(">\\s*(" + SLOT_WORDS + ")(?:&nbsp;|\\s)*<", "i");
const SLOT_LINE = new RegExp("^(" + SLOT_WORDS + ")(?:\\s+(?:Cloth|Leather|Mail|Plate|Shield|Sword|Axe|Mace|Dagger|Staff|Polearm|Bow|Gun|Crossbow|Wand|Fist Weapon|Idol|Libram|Totem|Sigil|Miscellaneous|Thrown))?$", "i");
function slotOf(html, lines) {
  const h = String(html).replace(/<!--[\s\S]*?-->/g, "");
  let m = SLOT_NODE.exec(h);
  if (!m) for (let i = 1; i < lines.length; i++) if ((m = SLOT_LINE.exec(lines[i]))) break;
  if (!m) return "";
  const w = m[1].toLowerCase();
  return SLOT_ALIAS[w] || SLOTS.find((x) => x.toLowerCase() === w) || m[1];
}
function parseTip(html) {
  const t = plain(html), st = {}, out = { l: 0, i: 0, s: st, sl: "" };
  const add = (k, n) => { st[k] = (st[k] || 0) + n; };
  let m = /Requires\s+Level\s*(\d+)/i.exec(t); if (m) out.l = +m[1];
  m = /Item\s+Level\s*(\d+)/i.exec(t); if (m) out.i = +m[1];
  const lines = t.split("\n").map((x) => x.replace(/\s+/g, " ").trim()).filter(Boolean);
  out.sl = slotOf(html, lines);
  for (const line of lines) {
    if ((m = /^\+(\d+)\s+(Strength|Agility|Stamina|Intellect|Spirit)\b/i.exec(line))) add(m[2].toLowerCase(), +m[1]);
    else if ((m = /^\+(\d+)\s+(Arcane|Fire|Frost|Nature|Shadow|Holy)\s+Resistance/i.exec(line))) add(m[2].toLowerCase() + " resistance", +m[1]);
    else if ((m = /^\+?(\d+)\s+Armor\b/i.exec(line))) add("armor", +m[1]);
    else if ((m = /^(\d+)\s+Block\b/i.exec(line))) add("block", +m[1]);
    else if ((m = /\(([\d.]+)\s+damage per second\)/i.exec(line))) st.dps = +m[1];
    else if (/^Equip:/i.test(line)) {
      const e = line.replace(/^Equip:\s*/i, "");
      if ((m = /damage and healing done by magical spells and effects by up to (\d+)/i.exec(e))) add("spell power", +m[1]);
      else if ((m = /healing done by spells and effects by up to (\d+)/i.exec(e))) add("healing power", +m[1]);
      else if ((m = /block value of your shield by (\d+)/i.exec(e))) add("block value", +m[1]);
      else if ((m = /Restores (\d+) mana per 5 sec/i.exec(e))) add("mp5", +m[1]);
      else if ((m = /(?:Increases|Improves)\s+(?:your\s+)?(.+?)\s+by\s+(?:up to\s+)?(\d+)/i.exec(e))) add(m[1].toLowerCase().replace(/^the\s+/, ""), +m[2]);
    }
  }
  return out;
}

// ---- 1. vault snapshot + change log
const res = await fetch(VAULT, { headers: { "user-agent": UA, accept: "application/json" } });
if (!res.ok) throw new Error("vault: HTTP " + res.status);
const vault = await res.json();
if (!cats(vault).length) throw new Error("vault: unexpected response shape, nothing written");
const newStr = JSON.stringify(vault);
const oldPath = path.join(DIR, "vault.json");
const oldStr = fs.existsSync(oldPath) ? fs.readFileSync(oldPath, "utf8") : null;
const meta = rd("meta.json", {});
// compare only the categories/items, so a timestamp or other volatile field in the response doesn't count as a change
let changed = !oldStr || JSON.stringify(cats(JSON.parse(oldStr))) !== JSON.stringify(cats(vault));
if (changed) {
  if (oldStr) {
    const a = flat(JSON.parse(oldStr)), b = flat(vault), now = new Date().toISOString(), log = [];
    for (const [k, v] of b) {
      const o = a.get(k);
      if (!o) log.push({ t: now, k: "add", key: k, name: v.name, cat: v.cat, to: v.qty });
      else if (o.qty !== v.qty) log.push({ t: now, k: "qty", key: k, name: v.name, cat: v.cat, from: o.qty, to: v.qty });
    }
    for (const [k, v] of a) if (!b.has(k)) log.push({ t: now, k: "del", key: k, name: v.name, cat: v.cat, from: v.qty });
    if (log.length) wr("changes.json", rd("changes.json", []).concat(log).slice(-MAXLOG));
  }
  fs.writeFileSync(oldPath, newStr);
  meta.updatedAt = new Date().toISOString();
}

// ---- 2. item database (only items we don't know yet, a limited batch per run)
const items = rd("items.json", {});
const shards = [];
for (let n = 0; n < SHARDS; n++) shards.push(rd("tips/" + n + ".json", {}));
const touched = new Set();
const want = [...flat(vault).keys()];
const todo = want.filter((k) => !items[k]).slice(0, LIMIT);
let ok = 0, fail = 0, halted = false;

async function get(u) {
  const r = await fetch(u, { headers: { "user-agent": UA, accept: "application/json" } });
  if (r.status === 429 || r.status === 403) { halted = true; throw new Error("HTTP " + r.status + " (rate limited, stopping)"); }
  if (!r.ok) throw new Error("HTTP " + r.status);
  return r.json();
}
async function one(k) {
  const [id, suf] = k.split(":").map(Number);
  let j;
  try { j = suf ? await get(TIP + id + "?rand=" + suf).catch((e) => { if (halted) throw e; return get(TIP + id); }) : await get(TIP + id); }
  catch (e) { if (halted) throw e; await sleep(600); j = await get(TIP + id + (suf ? "?rand=" + suf : "")); }
  if (!j || typeof j.tooltip !== "string" || j.tooltip.length < 20) throw new Error("unexpected response for " + k);
  const p = parseTip(j.tooltip);
  items[k] = { l: p.l, i: p.i, s: p.s, sl: p.sl };
  const b = id % SHARDS;
  shards[b][k] = j.tooltip.replace(/<!--[\s\S]*?-->/g, "");
  touched.add(b);
}
async function worker() {
  while (todo.length && !halted) {
    const k = todo.shift();
    try { await one(k); ok++; } catch (e) { fail++; if (ok === 0 && fail >= 5) halted = true; console.log("lookup failed:", k, e.message); }
    await sleep(DELAY);
  }
}
await Promise.all(Array.from({ length: CONC }, worker));

// migration: records saved before slots existed get their slot from the stored tooltip (no new requests)
let migrated = 0, noSlot = 0, shown = 0;
for (const k of Object.keys(items)) {
  if (items[k].sl) continue;
  const tip = shards[+k.split(":")[0] % SHARDS][k];
  if (!tip) continue;
  const sl = parseTip(tip).sl;
  if (sl) { items[k].sl = sl; migrated++; touched.add(0); }
  else {
    items[k].sl = "";
    if (/Binds when|\d+ Armor|damage per second/i.test(plain(tip))) { noSlot++; if (shown < 2) { shown++; console.log("no slot found for", k, "- tooltip start:", tip.slice(0, 700)); } }
  }
}

if (ok || migrated) {
  wr("items.json", items);
  for (const b of touched) wr("tips/" + b + ".json", shards[b]);
}
const m2 = { updatedAt: meta.updatedAt || new Date().toISOString(), vaultItems: want.length, known: want.filter((k) => items[k]).length };
if (JSON.stringify(m2) !== JSON.stringify(rd("meta.json", {}))) wr("meta.json", m2);
console.log(`vault ${changed ? "changed" : "unchanged"}; item db ${m2.known}/${m2.vaultItems}; fetched ${ok}, failed ${fail}${migrated ? ", slots added to " + migrated : ""}${noSlot ? ", " + noSlot + " gear items still without a slot" : ""}${halted ? " (stopped early)" : ""}`);
