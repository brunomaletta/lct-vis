#!/usr/bin/env node
/** Layout checks: no overlaps, path-parent siblings share Y. */
import { pathToFileURL } from "url";
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const __dir = dirname(fileURLToPath(import.meta.url));
const web = join(__dir, "../web");

const createModule = (await import(pathToFileURL(join(web, "lct.js")).href)).default;

const DEFAULT_HASH =
  "c0,c1,c2,c3,c4,c5,c6*3,l1-0,a2,l2-0,l3-0,l4-0,l5-0,l6-0,a1,a3,a4,a5,a2,a4,a5,a6,c7,l7-0,c8,l8-0,a3,a5,a4,x2,x6,l2-5,l6-5";

const HASH = process.argv[2] || DEFAULT_HASH;

function decodeCommands(str) {
  const out = [];
  for (const part of str.split(",")) {
    const parseSingle = (token) => {
      if (token[0] === "c") return { type: "create", a: Number(token.slice(1)) };
      if (token[0] === "a") return { type: "access", a: Number(token.slice(1)) };
      if (token[0] === "l") {
        const [a, b] = token.slice(1).split("-").map(Number);
        return { type: "link", a, b };
      }
      if (token[0] === "x") return { type: "cut", a: Number(token.slice(1)) };
      return null;
    };
    if (part.includes("*")) {
      const [base, rep] = part.split("*");
      const cmd = parseSingle(base);
      for (let i = 0; i < Number(rep); i++) out.push({ ...cmd });
    } else out.push(parseSingle(part));
  }
  return out;
}

const M = await createModule();
M.ccall("reset", null, [], []);
for (const c of decodeCommands(HASH)) {
  if (c.type === "create") M.ccall("op_create", "number", ["number"], [c.a]);
  else if (c.type === "link") M.ccall("op_link", "number", ["number", "number"], [c.a, c.b]);
  else if (c.type === "access") M.ccall("op_access", "number", ["number"], [c.a]);
  else if (c.type === "cut") M.ccall("op_cut", "number", ["number"], [c.a]);
}

const mainJs = readFileSync(join(web, "main.js"), "utf8");
const sandbox = {
  auxNodes: {},
  forest: new Map(),
  canvas: { clientWidth: 800, clientHeight: 440 },
  auxCanvas: { clientWidth: 360, clientHeight: 440 },
  auxCtx: {},
  ModuleRef: M,
  AUX_NODE_R: 16,
  console,
  Map,
  Set,
  JSON,
};
sandbox.globalThis = sandbox;

const layoutChunk = mainJs.slice(
  mainJs.indexOf("// layout tuning"),
  mainJs.indexOf("// ---------- UI ----------")
);
const fn = new Function(
  "sandbox",
  `with(sandbox) { ${layoutChunk}
    updateAuxFromWasm = function(){
      const data = JSON.parse(sandbox.ModuleRef.UTF8ToString(sandbox.ModuleRef._dump_aux()));
      auxNodes = {};
      for (const [v] of data) auxNodes[v] = { id:v, splayParent:null, pathParent:null, left:null, right:null };
      for (const [v,p,l,r,type] of data) {
        if (l!=-1) auxNodes[v].left = l;
        if (r!=-1) auxNodes[v].right = r;
        if (type===2) auxNodes[v].splayParent = p;
        if (type===1) auxNodes[v].pathParent = p;
      }
    };
    updateAuxFromWasm();
    computeAuxLayoutCombined();
    return auxNodes;
  }`
);
const auxNodes = fn(sandbox);

let failed = false;

const byXY = {};
for (const id in auxNodes) {
  const n = auxNodes[id];
  const k = `${n.x},${n.y}`;
  (byXY[k] ||= []).push(Number(id));
}
const overlaps = Object.entries(byXY).filter(([, ids]) => ids.length > 1);
console.log("overlapping positions:", overlaps.length);
if (overlaps.length) {
  failed = true;
  console.table(overlaps.map(([k, ids]) => ({ pos: k, nodes: ids.join(",") })));
}

const byPP = {};
for (const id in auxNodes) {
  const pp = auxNodes[id].pathParent;
  if (pp == null) continue;
  (byPP[pp] ||= []).push({ id: Number(id), y: auxNodes[id].y });
}
console.log("path-parent sibling rows:");
for (const [pp, list] of Object.entries(byPP)) {
  const ys = [...new Set(list.map((n) => n.y))];
  const ok = ys.length === 1;
  console.log(`  parent ${pp}: Y=${ys.join(",")} nodes=[${list.map((n) => n.id).join(",")}] ${ok ? "OK" : "FAIL"}`);
  if (!ok) failed = true;
}

const AUX_R = 16;
const MIN_DIST = AUX_R * 2 + 4;
const ids = Object.keys(auxNodes).map(Number);
for (let i = 0; i < ids.length; i++) {
  for (let j = i + 1; j < ids.length; j++) {
    const a = auxNodes[ids[i]];
    const b = auxNodes[ids[j]];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    if (d < MIN_DIST) {
      failed = true;
      console.log(`collision ${ids[i]}-${ids[j]}: dist=${d.toFixed(1)} (need ${MIN_DIST})`);
    }
  }
}
if (!failed) console.log("no circle collisions (r=16)");

const xs = Object.values(auxNodes).map((n) => n.x);
const ys = Object.values(auxNodes).map((n) => n.y);
console.log("x range:", Math.min(...xs), "..", Math.max(...xs));
console.log("y range:", Math.min(...ys), "..", Math.max(...ys));

if (failed) process.exit(1);
console.log("All layout checks passed.");
