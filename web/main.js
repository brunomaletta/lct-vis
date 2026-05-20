let ModuleRef = null;
let canvas, ctx;

// command history
let commands = [];
let animationQueue = [];
let animating = false;

let forest = new Map();

let auxNodes = {};

window.wasmReady = false;

let createdVertices = new Set();

let mouse = {x:0,y:0};
let dragStartNode = null;
let hoverNode = null;
let hoverEdge = null;
let dragging = false;
let mouseDownPos = null;
const CLICK_EPS = 6; // pixels

const COLORS = {
    nodeFill: "#1f2933",
    nodeBorder: "#e5e7eb",
    nodeText: "#ffffff",

    nodeHover: "#334155",
    nodeActive: "#3b82f6",

    auxFill: "#2b3440",
    auxBorder: "#d0d7ff",
    auxText: "#ffffff",

    edge: "#94a3b8",
    edgePreferred: "#ff7a7a",
    edgeAux: "#d0d7ff",
    edgePath: "#a8b3c2"
};

const AUX_NODE_R = 16;

// ---------- init ----------

let auxCanvas, auxCtx;

function fixHiDPI(canvas, ctx) {
  const dpr = window.devicePixelRatio || 1;
  const w = canvas.clientWidth, h = canvas.clientHeight;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  canvas.style.width = w + "px";
  canvas.style.height = h + "px";
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}

setUiEnabled(false);
setLoading(true);

createModule(window.Module || {}).then(Module => {
	ModuleRef = Module;
    window.wasmReady = true;
    setLoading(false);
    setUiEnabled(true);
    setStatus("Ready — click the canvas or use commands", true);

    canvas = document.getElementById("treeCanvas");
    ctx = canvas.getContext("2d");
	fixHiDPI(canvas, ctx);

    auxCanvas = document.getElementById("auxCanvas");
    auxCtx = auxCanvas.getContext("2d");
	fixHiDPI(auxCanvas, auxCtx);

    // IMPORTANT
    ModuleRef.ccall("reset", null, [], []);
    updateAuxFromWasm();     // <-- missing before
    renderAux();

    renderTree();

	loadCommandsFromURL();
    rebuildFromCommands();

	window.addEventListener("hashchange", ()=>{
		loadCommandsFromURL();
		rebuildFromCommands();
	});

	canvas.addEventListener("mousemove", onMove);
	canvas.addEventListener("mousedown", onDown);
	canvas.addEventListener("mouseup", onUp);
	canvas.addEventListener("contextmenu", e=>e.preventDefault());
	canvas.addEventListener("mousedown", onRightDown);

	canvas.addEventListener("mouseleave", ()=>{
		hoverNode = null;
		hoverEdge = null;
		canvas.style.cursor = "default";
	});

	window.addEventListener("resize", () => {
		fixHiDPI(canvas, ctx);
		fixHiDPI(auxCanvas, auxCtx);
		renderTree();
		renderAux();
	});

	for (const input of document.querySelectorAll(".panel input")) {
		input.addEventListener("keydown", (e) => {
			if (e.key !== "Enter") return;
			const btn = input.parentElement?.querySelector(".btn");
			btn?.click();
		});
	}

	document.addEventListener("keydown", (e) => {
		if (!(e.ctrlKey || e.metaKey) || e.key !== "z") return;
		if (e.target.matches("input, textarea")) return;
		e.preventDefault();
		undo();
	});
}).catch((err) => {
    setLoading(false);
    setStatus("Failed to load WASM — run ./build.sh", false);
    console.error(err);
});


// ---------- command system ----------

function updateCursor(){
    if(hoverNode !== null)
        canvas.style.cursor = "pointer";
    else
        canvas.style.cursor = "default";
}


function loadCommandsFromURL(){

    if(location.hash.length<=1) return;

    const encoded = decodeURIComponent(location.hash.substring(1));
    commands = decodeCommands(encoded);
}

function encodeCommands(cmds){

    function tok(c){
        if(c.type==="create") return `c${c.a}`;
        if(c.type==="link")   return `l${c.a}-${c.b}`;
        if(c.type==="cut")    return `x${c.a}`;
        if(c.type==="access") return `a${c.a}`;
        return "";
    }

    let out = [];
    let prev = null;
    let count = 0;

    function flush(){
        if(!prev) return;

        if(count===1) out.push(prev);
        else out.push(prev + "*" + count);
    }

    for(const c of cmds){
        const t = tok(c);

        if(t===prev){
            count++;
        }else{
            flush();
            prev=t;
            count=1;
        }
    }

    flush();
    return out.join(",");
}

function decodeCommands(str){

    if(!str) return [];
    const out = [];

    function parseSingle(token){

        if(token[0]==="c")
            return {type:"create",a:Number(token.slice(1))};

        if(token[0]==="a")
            return {type:"access",a:Number(token.slice(1))};

        if(token[0]==="l"){
            const [a,b]=token.slice(1).split("-").map(Number);
            return {type:"link",a,b};
        }

        if(token[0]==="x"){
            return {type:"cut",a:Number(token.slice(1))};
        }

        return null;
    }

    for(const part of str.split(",")){

        if(part.includes("*")){
            const [base,rep] = part.split("*");
            const k = Number(rep);

            const cmd = parseSingle(base);
            for(let i=0;i<k;i++)
                out.push({...cmd});
        }
        else{
            out.push(parseSingle(part));
        }
    }

    return out;
}


function updateURL(){
    const encoded = encodeCommands(commands);
    history.replaceState(null,"","#"+encoded);
}

function setStatus(msg, ok=false){
    const el = document.getElementById("status");
    if (!el) return;
    el.textContent = msg;
    el.classList.toggle("status-ok", ok);
    el.classList.toggle("status-err", !ok);
}

function setUiEnabled(enabled){
    document.querySelectorAll(".panel input, .panel .btn").forEach((el) => {
        el.disabled = !enabled;
    });
}

function setLoading(loading){
    const surface = document.getElementById("canvasSurface");
    if (surface) surface.classList.toggle("loading", loading);
}



function expandCommand(cmd){

    const out = [];

    function need(v){
        if(!createdVertices.has(v)){
            out.push({type:"create", a:v});
            createdVertices.add(v);
        }
    }

    if(cmd.type==="create"){
        need(cmd.a);
        return out;
    }

    if(cmd.type==="link"){
        need(cmd.a);
        need(cmd.b);
    }

    if(cmd.type==="access" || cmd.type == "cut"){
        need(cmd.a);
    }

    out.push(cmd);
    return out;
}

function isRedundantAccess(cmd){
    if(cmd.type!=="access") return false;
    if(commands.length===0) return false;

    const last = commands[commands.length-1];
    return last.type==="access" && last.a===cmd.a;
}

function runCommand(cmd){

    if(!window.wasmReady){
        setStatus("WASM is still loading…", false);
        return false;
    }

    // rebuild current state in wasm (authoritative)
    ModuleRef.ccall("reset", null, [], []);
    for(const c of commands)
        executeOnWasm(c);

    // expand into real commands
    const expanded = expandCommand(cmd);

	// --- single-shot animation: capture before, run all ops, capture after ---
	const forestBefore = snapshotForestLayout();
	const auxBefore = computeLayoutForSnapshot(snapshotAuxFromWasmRaw());

	// execute all expanded commands (WASM + apply events)
	for (const c of expanded) {
		const ok = executeOnWasm(c);
		if (!ok) {
			setStatus(describeFailure(c), false);
			rebuildFromCommands(false);
			return false;
		}
		let ev = ModuleRef.ccall("consume_events", "string");
		let parsed = JSON.parse(ev);
		for (const e of parsed) {
			applyEvent(e);
		}
	}

	// commit to history (skip duplicate access)
	for (const c of expanded) {
		if (isRedundantAccess(c)) continue;
		commands.push(c);
	}

	updateURL();
	setStatus("OK", true);

	// capture final snapshots
	const forestAfter = snapshotForestLayout();
	const auxAfter = computeLayoutForSnapshot(snapshotAuxFromWasmRaw());

	// if nothing changed just rebuild and return
	if (JSON.stringify(forestBefore) === JSON.stringify(forestAfter)
	 && JSON.stringify(auxBefore) === JSON.stringify(auxAfter)) {
		rebuildFromCommands();
		return true;
	}

	// create a single combined animation job (aux + forest)
	const singleJob = {
		kind: "rotation",         // your animateRotation supports before/after aux + forest
		beforeAux: auxBefore,
		afterAux: auxAfter,
		beforeForest: forestBefore,
		afterForest: forestAfter,
		duration: 360             // tweak duration to taste
	};

	// set visible forest to starting snapshot so interpolation is coherent
	applyForestSnapshot(forestBefore);

	// queue & play
	animationQueue = [ singleJob ];
	playAnimation();

	return true;

}






function describeFailure(cmd){
    if (cmd.type === "link")
        return "Link failed — child must be a tree root and in a different component";
    if (cmd.type === "cut")
        return "Cut failed — node has no parent edge";
    if (cmd.type === "create")
        return "Create failed — invalid vertex id";
    return "Operation failed";
}

function resetAll(){
    if (!window.wasmReady) return;
    if (commands.length === 0) return;
    if (!confirm("Clear all nodes and commands?")) return;
    commands = [];
    updateURL();
    rebuildFromCommands();
    setStatus("Reset", true);
}

async function copyLink(){
    const url = location.href;
    try {
        await navigator.clipboard.writeText(url);
        setStatus("Link copied to clipboard", true);
    } catch {
        prompt("Copy this URL:", url);
        setStatus("Copy the URL from the dialog", true);
    }
}

function undo(){
    if(commands.length===0) return;

    const beforeForest=snapshotForestLayout();
    const beforeAux=computeLayoutForSnapshot(snapshotAuxFromWasmRaw());

    commands.pop();
    updateURL();
    rebuildFromCommands(false);

    const afterForest=snapshotForestLayout();
    const afterAux=computeLayoutForSnapshot(snapshotAuxFromWasmRaw());

    animationQueue=[{
        kind:"rotation",
        beforeAux:beforeAux,
        afterAux:afterAux,
        beforeForest:beforeForest,
        afterForest:afterForest,
        duration:320
    }];

    playAnimation();
    setStatus(`Undid — ${commands.length} command(s) remaining`, true);
}



function rebuildFromCommands(){
    if (!ModuleRef) return;

    createdVertices.clear();
    animationQueue = [];
    animating = false;

    forest = new Map();

    ModuleRef.ccall("reset", null, [], []);

    for(const cmd of commands){

        if(cmd.type==="create")
            createdVertices.add(cmd.a);

        // execute in wasm
        executeOnWasm(cmd);

        // consume events and APPLY ONLY (no animation ever here)
        let ev = ModuleRef.ccall("consume_events","string");
        let parsed = JSON.parse(ev);

        for(const e of parsed){
            applyEvent(e);
        }
    }

    updateAuxFromWasm();
    renderTree();
    renderAux();
}



function executeOnWasm(cmd){

    if(cmd.type==="create")
        return ModuleRef.ccall("op_create","number",["number"],[cmd.a]);

    if(cmd.type==="link")
        return ModuleRef.ccall("op_link","number",["number","number"],[cmd.a,cmd.b]);

    if(cmd.type==="cut")
        return ModuleRef.ccall("op_cut","number",["number"],[cmd.a]);

    if(cmd.type==="access")
        return ModuleRef.ccall("op_access","number",["number"],[cmd.a]);

    return 0;
}


function ensureNode(x){
    if(!forest.has(x)){
        forest.set(x,{
            parent:null,
            children:new Set(),
            preferred:null
        });
    }
    return forest.get(x);
}

function parseNumbers(text){
    const nums = text.match(/-?\d+/g);
    if(!nums) return [];
    return nums.map(Number);
}


// ---------- Apply event ----------

function updateAuxFromWasm(){
    if(!window.wasmReady) return;

    const ptr = ModuleRef._dump_aux();
    const json = ModuleRef.UTF8ToString(ptr);
    const data = JSON.parse(json);

	//console.log(data);

    auxNodes = {};

    // create nodes
    for(const [v] of data){
        auxNodes[v] = {
            id:v,
            splayParent:null,
            pathParent:null,
            left:null,
            right:null
        };
    }

    // wire relations
    for(const [v,p,l,r,type] of data){

        if(l!=-1) auxNodes[v].left = l;
        if(r!=-1) auxNodes[v].right = r;

        if(type===2) // splay parent
            auxNodes[v].splayParent = p;

        if(type===1) // path parent
            auxNodes[v].pathParent = p;
    }
}






function applyEvent(ev){

	//console.log("event:", ev);

    const [type,a,b] = ev;

    // CREATE
    if(type===10){
        ensureNode(a);
    }

    // LINK(a,b) : a becomes child of b
    if(type===1){
        let A = ensureNode(a);
        let B = ensureNode(b);

        if(A.parent!==null){
            let old = forest.get(A.parent);
            old.children.delete(a);
        }

        A.parent = b;
        B.children.add(a);
    }

    // CUT(a,b)
    if(type===11){
        let A = forest.get(a);
        if(A != null){
			let B = forest.get(A.parent)
			if (B != null) {
				B.children.delete(a);
				A.parent=null;
			}
        }
    }

	// preferred edge change
	if(type===20){
		const parent = forest.get(a);
		if(parent)
			parent.preferred = (b === -1 ? null : b);
	}

	if(type===30){
		// rotation happened
		// auxiliary forest will already update via dump_aux()
	}

	updateAuxFromWasm();
}

const TREE_GAP_X = 56;
const TREE_GAP_Y = 72;
const TREE_BASE_Y = 64;

function computeLayout(){
    const roots = [];
    for (const [id, node] of forest)
        if (node.parent === null) roots.push(id);

    roots.sort((a, b) => a - b);

    let x = TREE_GAP_X;
    for (const r of roots) {
        x = layoutDFS(r, 0, x);
        x += TREE_GAP_X * 2;
    }

    fitToTreeCanvas(36);
}

function layoutDFS(v, depth, x){
    const node = forest.get(v);
    const children = [...node.children].sort((a, b) => a - b);

    if (children.length === 0) {
        node.x = x;
        node.y = TREE_BASE_Y + depth * TREE_GAP_Y;
        return x + TREE_GAP_X;
    }

    const start = x;
    for (const c of children)
        x = layoutDFS(c, depth + 1, x);

    node.x = (start + x - TREE_GAP_X) / 2;
    node.y = TREE_BASE_Y + depth * TREE_GAP_Y;
    return x;
}




function drawArrow(ctx,x1,y1,x2,y2,color){

    ctx.save();

    ctx.setLineDash([]);
    ctx.fillStyle = color;

    const angle = Math.atan2(y2-y1,x2-x1);
    const size = 9;

    ctx.beginPath();
    ctx.moveTo(x2,y2);
    ctx.lineTo(
        x2 - size*Math.cos(angle-Math.PI/7),
        y2 - size*Math.sin(angle-Math.PI/7)
    );
    ctx.lineTo(
        x2 - size*Math.cos(angle+Math.PI/7),
        y2 - size*Math.sin(angle+Math.PI/7)
    );
    ctx.closePath();
    ctx.fill();

    ctx.restore();
}





function drawEdge(a,b){
    ctx.beginPath();
    ctx.moveTo(a.x,a.y);
    ctx.lineTo(b.x,b.y);
    ctx.stroke();
}

function drawNode(id,node){

    const isHover = hoverNode === id;

    ctx.beginPath();
    ctx.arc(node.x,node.y,18,0,Math.PI*2);

    ctx.fillStyle = isHover ? COLORS.nodeHover : COLORS.nodeFill;
    ctx.fill();

    ctx.lineWidth = isHover ? 3 : 2;
    ctx.strokeStyle = COLORS.nodeBorder;
    ctx.stroke();

    ctx.fillStyle = COLORS.nodeText;
    ctx.textAlign="center";
    ctx.textBaseline="middle";
    ctx.font="14px sans-serif";
    ctx.fillText(id,node.x,node.y);
}


function drawAuxEdge(a,b,kind){

    const R = AUX_NODE_R;

    // ensure arrow always points upward (toward ancestor)
    let from = a, to = b;

	const color = (kind==="path") ? COLORS.edgePath : COLORS.edgeAux;

    // direction vector
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const len = Math.hypot(dx,dy);

    if(len === 0) return;

    const ux = dx/len;
    const uy = dy/len;

    // endpoint BEFORE center
    const endX = to.x - ux*R;
    const endY = to.y - uy*R;

    // ---- edge line ----
    auxCtx.strokeStyle = color;

    if(kind==="path") auxCtx.setLineDash([7,7]);
    else auxCtx.setLineDash([]);

    auxCtx.beginPath();
    auxCtx.moveTo(from.x,from.y);
    auxCtx.lineTo(endX,endY);
    auxCtx.stroke();

    auxCtx.setLineDash([]);

    // ---- arrow ----
    if (kind === "path")
		drawArrow(
			auxCtx,
			endX,endY,
			to.x - ux*(R-1),
			to.y - uy*(R-1),
			color
		);
}





function drawAuxNode(id,node){

    const isHover = hoverNode === id;

    auxCtx.beginPath();
    auxCtx.arc(node.x,node.y,AUX_NODE_R,0,Math.PI*2);

    auxCtx.fillStyle = isHover ? COLORS.nodeHover : COLORS.auxFill;
    auxCtx.fill();

    auxCtx.lineWidth = isHover ? 3 : 2;
    auxCtx.strokeStyle = COLORS.auxBorder;
    auxCtx.stroke();

    auxCtx.fillStyle = COLORS.auxText;
    auxCtx.textAlign="center";
    auxCtx.textBaseline="middle";
    auxCtx.font="13px sans-serif";
    auxCtx.fillText(id,node.x,node.y);
}



function renderTree(skipLayout=false){

    if(!ctx) return;

    ctx.clearRect(0, 0, canvas.clientWidth, canvas.clientHeight);

    if(!skipLayout) computeLayout();

    // edges
	for(const [id,node] of forest){
		for(const c of node.children){
			const child = forest.get(c);

			if(node.preferred === c){
				ctx.strokeStyle = COLORS.edgePreferred; // preferred path = red
				ctx.lineWidth=4;
			}else{
				ctx.strokeStyle = COLORS.edge;
				ctx.lineWidth=2;
			}

			drawEdge(node,child);
			ctx.lineWidth=2;
		}
	}



	if(dragging && dragStartNode!==null){
		const a=forest.get(dragStartNode);
		ctx.strokeStyle="#4da6ff";
		ctx.lineWidth=2;
		ctx.beginPath();
		ctx.moveTo(a.x,a.y);
		ctx.lineTo(mouse.x,mouse.y);
		ctx.stroke();

		drawArrow(
			ctx,
			a.x,a.y,
			mouse.x,
			mouse.y,
			"#4da6ff"
		);
	}

    // nodes
    for(const [id,node] of forest)
        drawNode(id,node);

}

// layout tuning (tweak to taste)
const NODE_GAP_X = 48;        // horizontal spacing per localX unit
const NODE_GAP_Y = 66;        // vertical spacing inside splay tree
const PATH_PARENT_GAP_Y = 110;// vertical gap between blocks along path-parent chain
const HUB_ROW_GAP_X = 28;     // horizontal gap between spokes under one hub
const AUX_NODE_CLEAR_Y = AUX_NODE_R * 2 + 12;
const BLOCK_GAP_X = 40;       // minimal horizontal gap between block bounding boxes
const BASE_Y = 80;

// --------- Combined layout (drop-in) ---------

// A: compute splay-local layouts per splay root (localX: integers, localY: depth)
function computeSplayLayouts() {
    // detect splay roots
    function isSplayChild(v, p) {
        if (p == null) return false;
        const P = auxNodes[p];
        if (!P) return false;
        return P.left === Number(v) || P.right === Number(v);
    }

    const splayRoots = [];
    for (const id in auxNodes) {
        const n = auxNodes[id];
        if (!n) continue;
        // root if no splay parent
        if (n.splayParent === null) splayRoots.push(Number(id));
    }

    const blocks = {}; // rootId -> block info
    // layout each splay tree (inorder numbering starting at 0)
    function layoutSplay(root) {
        const nextX = { x: 0 };
        function dfs(u, depth) {
            if (u == null) return;
            const n = auxNodes[u];
            if (n == null) return;
            if (n.left != null) dfs(n.left, depth + 1);
            n.localX = nextX.x++;
            n.localY = depth;
            if (n.right != null) dfs(n.right, depth + 1);
        }
        dfs(root, 0);

        // collect nodes for the block
        const nodes = [];
        function collect(u) {
            if (u == null) return;
            const n = auxNodes[u];
            nodes.push(Number(u));
            if (n.left != null) collect(n.left);
            if (n.right != null) collect(n.right);
        }
        collect(root);

        // compute min/max/useful numbers
        let minX = Infinity, maxX = -Infinity;
        for (const id of nodes) {
            const n = auxNodes[id];
            minX = Math.min(minX, n.localX);
            maxX = Math.max(maxX, n.localX);
        }
        // normalize so leftmost localX becomes 0 to ease center computations
        for (const id of nodes) auxNodes[id].localX = auxNodes[id].localX - minX;

        const widthUnits = maxX - minX + 1;
        const centerLocal = (widthUnits - 1) / 2.0; // center in localX units

        let maxLocalY = 0;
        for (const id of nodes)
            maxLocalY = Math.max(maxLocalY, auxNodes[id].localY);

        // store block info
        blocks[root] = {
            root: Number(root),
            nodes,
            minLocalX: 0,
            maxLocalX: widthUnits - 1,
            localCenter: centerLocal,
            widthUnits,
            maxLocalY,
            widthPx: widthUnits * NODE_GAP_X,
            heightPx: (maxLocalY + 1) * NODE_GAP_Y,
        };
    }

    for (const r of splayRoots) layoutSplay(r);
    return blocks;
}


// B: build block (root) graph using path-parent edges
function buildBlockGraph(blocks) {
    // node -> blockRoot
    const nodeToRoot = {};
    for (const rootId in blocks) {
        for (const id of blocks[rootId].nodes) nodeToRoot[id] = Number(rootId);
    }

    const blockChildren = {}; // parentBlock -> [childBlock...]
    const blockParents = {};  // childBlock -> parentBlock

    for (const id in auxNodes) {
        const n = auxNodes[id];
        if (n == null) continue;
        // use explicit pathParent exported by WASM
        const p = n.pathParent;
        if (p != null && p !== -1) {
            const childBlock = nodeToRoot[id];
            const parentBlock = nodeToRoot[p];
            if (childBlock == null || parentBlock == null || childBlock === parentBlock) continue;
            blockParents[childBlock] = parentBlock;
            if (!blockChildren[parentBlock]) blockChildren[parentBlock] = [];
            if (!blockChildren[parentBlock].includes(childBlock))
                blockChildren[parentBlock].push(childBlock);
        }
    }

    for (const id in blockChildren)
        blockChildren[id].sort((a, b) => a - b);

    return { nodeToRoot, blockChildren, blockParents };
}


function hubAttachLocalPx(block, attachNodeId) {
    const n = auxNodes[attachNodeId];
    return (n.localX - block.localCenter) * NODE_GAP_X;
}

function hubRowWidthPx(childIds, blocks, blockGraph) {
    let rowW = 0;
    for (let i = 0; i < childIds.length; i++) {
        if (i > 0) rowW += HUB_ROW_GAP_X;
        rowW += measureBlockFootprint(childIds[i], blocks, blockGraph).width;
    }
    return rowW;
}

function measureSubtreeWidth(blockId, blocks, blockGraph) {
    return measureBlockFootprint(blockId, blocks, blockGraph).width;
}

function findPathAttachment(parentBlock, childBlock, blocks, blockGraph) {
    for (const nid of blocks[childBlock].nodes) {
        const p = auxNodes[nid].pathParent;
        if (p != null && blockGraph.nodeToRoot[p] === Number(parentBlock))
            return { parentNode: Number(p), childNode: Number(nid) };
    }
    return null;
}

// Group child blocks by which node inside parentBlock they path-parent to.
function groupChildrenByAttach(parentBlock, childIds, blocks, blockGraph) {
    const groups = new Map();
    for (const cid of childIds) {
        const att = findPathAttachment(parentBlock, cid, blocks, blockGraph);
        const key = att ? att.parentNode : -1;
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(cid);
    }
    return groups;
}

function layoutHubRowAt(hubPx, childIds, blocks, blockGraph, positions) {
    const sorted = [...childIds].sort((a, b) => a - b);
    if (sorted.length === 0) return;

    const widths = sorted.map((cid) => measureBlockFootprint(cid, blocks, blockGraph).width);
    let totalW = widths.reduce((s, w) => s + w, 0) + HUB_ROW_GAP_X * (sorted.length - 1);
    let x = hubPx - totalW / 2;

    for (let i = 0; i < sorted.length; i++) {
        positions[sorted[i]] = x + widths[i] / 2;
        x += widths[i] + HUB_ROW_GAP_X;
    }
}

function hasMultiAttachHub(parentBlock, childIds, blocks, blockGraph) {
    for (const [parentNodeId, group] of groupChildrenByAttach(parentBlock, childIds, blocks, blockGraph)) {
        if (parentNodeId !== -1 && group.length > 1) return true;
    }
    return false;
}

function isInHubFanGroup(parentBlock, childId, blocks, blockGraph) {
    const siblings = (blockGraph.blockChildren[parentBlock] || []).map(Number);
    for (const [parentNodeId, group] of groupChildrenByAttach(parentBlock, siblings, blocks, blockGraph)) {
        if (parentNodeId !== -1 && group.length > 1 && group.includes(Number(childId)))
            return true;
    }
    return false;
}

// Lay out each attach group: multi-child groups fan horizontally under their attach node.
function layoutChildAttachGroups(parentBlock, parentCenter, childIds, blocks, blockGraph, positions) {
    const groups = groupChildrenByAttach(parentBlock, childIds, blocks, blockGraph);
    let handled = false;

    for (const [parentNodeId, group] of groups) {
        if (parentNodeId === -1) continue;

        if (group.length > 1) {
            const hubPx = blockNodePixelX(parentBlock, blocks[parentBlock], parentCenter, parentNodeId);
            layoutHubRowAt(hubPx, group, blocks, blockGraph, positions);
            handled = true;
        } else {
            const target = blockCenterForAttachment(parentBlock, group[0], parentCenter, blocks, blockGraph);
            if (target != null) {
                positions[group[0]] = target;
                handled = true;
            }
        }
    }

    return handled;
}

function blockNodePixelX(blockId, block, centerX, nodeId) {
    const n = auxNodes[nodeId];
    return centerX + (n.localX - block.localCenter) * NODE_GAP_X;
}

function blockCenterForAttachment(parentBlock, childBlock, parentCenter, blocks, blockGraph) {
    const att = findPathAttachment(parentBlock, childBlock, blocks, blockGraph);
    if (!att) return null;
    const parentPx = blockNodePixelX(parentBlock, blocks[parentBlock], parentCenter, att.parentNode);
    const childLocal = auxNodes[att.childNode].localX - blocks[childBlock].localCenter;
    return parentPx - childLocal * NODE_GAP_X;
}

function shiftBlockSubtree(blockId, dx, positions, blockGraph) {
    const stack = [Number(blockId)];
    while (stack.length) {
        const b = stack.pop();
        if (positions[b] != null) positions[b] += dx;
        for (const c of blockGraph.blockChildren[b] || []) stack.push(Number(c));
    }
}

function layoutNestedChildBlocks(blockId, blocks, blockGraph, positions) {
    const children = (blockGraph.blockChildren[blockId] || []).map(Number);
    for (const childId of children) {
        if (positions[childId] == null) continue;
        const cw = measureSubtreeWidth(childId, blocks, blockGraph);
        positionBlockSubtree(childId, positions[childId] - cw / 2, blocks, blockGraph, positions);
    }
}

function positionBlockSubtree(blockId, leftX, blocks, blockGraph, positions) {
    const children = (blockGraph.blockChildren[blockId] || []).map(Number);
    const subW = measureSubtreeWidth(blockId, blocks, blockGraph);

    if (children.length === 0) {
        positions[blockId] = leftX + subW / 2;
        return subW;
    }

    positions[blockId] = leftX + subW / 2;

    if (children.length > 0 && layoutChildAttachGroups(blockId, positions[blockId], children, blocks, blockGraph, positions)) {
        layoutNestedChildBlocks(blockId, blocks, blockGraph, positions);
        return subW;
    }

    let x = leftX;
    for (const childId of children) {
        const cw = positionBlockSubtree(childId, x, blocks, blockGraph, positions);
        x += cw + BLOCK_GAP_X;
    }

    const childCenters = children.map((c) => positions[c]);
    const spanL = Math.min(...children.map((c, i) => childCenters[i] - measureSubtreeWidth(c, blocks, blockGraph) / 2));
    const spanR = Math.max(...children.map((c, i) => childCenters[i] + measureSubtreeWidth(c, blocks, blockGraph) / 2));
    positions[blockId] = (spanL + spanR) / 2;

    for (const childId of children) {
        const target = blockCenterForAttachment(blockId, childId, positions[blockId], blocks, blockGraph);
        if (target == null) continue;
        shiftBlockSubtree(childId, target - positions[childId], positions, blockGraph);
    }

    return subW;
}

// Place block trees: path-parent chains stack vertically; siblings sit side by side.
function computeBlockPositions(blocks, blockGraph) {
    const positions = {};
    const roots = Object.keys(blocks)
        .filter((b) => blockGraph.blockParents[b] == null)
        .map(Number)
        .sort((a, b) => a - b);

    let x = BLOCK_GAP_X;
    for (const rootId of roots) {
        const w = positionBlockSubtree(rootId, x, blocks, blockGraph, positions);
        x += w + BLOCK_GAP_X * 2;
    }

    // Second alignment pass for deep path-parent chains (skip hub fans — already column-aligned)
    for (let pass = 0; pass < 2; pass++) {
        for (const childId in blockGraph.blockParents) {
            const parentId = Number(blockGraph.blockParents[childId]);
            const siblings = (blockGraph.blockChildren[parentId] || []).map(Number);
            if (isInHubFanGroup(parentId, Number(childId), blocks, blockGraph))
                continue;

            const target = blockCenterForAttachment(parentId, Number(childId), positions[parentId], blocks, blockGraph);
            if (target == null) continue;
            shiftBlockSubtree(Number(childId), target - positions[childId], positions, blockGraph);
        }
    }

    return positions;
}

// ---------- Fit & center helper + small tuning ----------

function fitToTreeCanvas(padding = 36) {
    if (!canvas) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [id, node] of forest) {
        if (node.x === undefined || node.y === undefined) continue;
        minX = Math.min(minX, node.x);
        maxX = Math.max(maxX, node.x);
        minY = Math.min(minY, node.y);
        maxY = Math.max(maxY, node.y);
    }

    if (minX === Infinity) return; // nothing to fit

    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);

    // NOTE: canvas.width is in *device pixels* after fixHiDPI().
    // That's OK because you also use ctx.setTransform(dpr, ...) so logical drawing coords match CSS pixels.
    const availW = Math.max(10, canvas.clientWidth - 2 * padding);
    const availH = Math.max(10, canvas.clientHeight - 2 * padding);

    // don't scale up beyond 1 (keeps spacing readable)
    const scale = Math.min(1, Math.min(availW / contentW, availH / contentH));

    const contentCenterX = (minX + maxX) / 2;
    const contentCenterY = (minY + maxY) / 2;

    const canvasCenterX = canvas.clientWidth / 2;
    const canvasCenterY = canvas.clientHeight / 2;

    const tx = canvasCenterX - (contentCenterX * scale);
    const ty = canvasCenterY - (contentCenterY * scale);

    // apply transform: overwrite node.x/node.y to transformed coords
    for (const [id, node] of forest) {
        if (node.x === undefined || node.y === undefined) continue;
        node.x = Math.round(node.x * scale + tx);
        node.y = Math.round(node.y * scale + ty);
    }
}


// Vertical gap between splay blocks along a path-parent chain
const PATH_PARENT_GAP_Y_TUNE = 72;

function nodeYInBlock(nodeId, baseY) {
    return baseY + auxNodes[nodeId].localY * NODE_GAP_Y;
}

// Lowest pixel Y of the splay subtree rooted at attachNode (within this block).
function splaySubtreeBottomInBlock(block, attachNodeId, baseY) {
    let bottom = nodeYInBlock(attachNodeId, baseY);
    const stack = [attachNodeId];

    while (stack.length) {
        const u = stack.pop();
        if (!block.nodes.includes(Number(u))) continue;
        const n = auxNodes[u];
        bottom = Math.max(bottom, nodeYInBlock(u, baseY));
        if (n.left != null) stack.push(n.left);
        if (n.right != null) stack.push(n.right);
    }

    return bottom;
}

function pathChildRowY(block, attachNodeId, baseY) {
    const bottom = splaySubtreeBottomInBlock(block, attachNodeId, baseY);
    return bottom + Math.max(PATH_PARENT_GAP_Y_TUNE, AUX_NODE_CLEAR_Y);
}

function pathChildRowOffset(block, attachNodeId) {
    return pathChildRowY(block, attachNodeId, 0);
}

// Full footprint of a block + path-child subtrees (uses splay width/height and hub rows).
function measureBlockFootprint(blockId, blocks, blockGraph) {
    const b = blocks[blockId];
    const children = (blockGraph.blockChildren[blockId] || []).map(Number);

    let minX = -b.localCenter * NODE_GAP_X - AUX_NODE_R;
    let maxX = (b.maxLocalX - b.localCenter) * NODE_GAP_X + AUX_NODE_R;
    let height = b.heightPx + 2 * AUX_NODE_R;

    if (children.length === 0)
        return { width: maxX - minX, height };

    const groups = [...groupChildrenByAttach(blockId, children, blocks, blockGraph)];
    groups.sort((a, bb) => {
        if (a[0] === -1) return 1;
        if (bb[0] === -1) return -1;
        return auxNodes[bb[0]].localY - auxNodes[a[0]].localY;
    });

    let stackFloor = 0;

    for (const [parentNodeId, group] of groups) {
        const rowTop =
            parentNodeId === -1
                ? height + Math.max(PATH_PARENT_GAP_Y_TUNE, AUX_NODE_CLEAR_Y)
                : Math.max(pathChildRowOffset(b, parentNodeId), stackFloor);

        if (group.length > 1) {
            const rowW = hubRowWidthPx(group, blocks, blockGraph);
            const hubX = hubAttachLocalPx(b, parentNodeId);
            minX = Math.min(minX, hubX - rowW / 2);
            maxX = Math.max(maxX, hubX + rowW / 2);
            let rowH = 0;
            for (const cid of group)
                rowH = Math.max(rowH, measureBlockFootprint(cid, blocks, blockGraph).height);
            height = Math.max(height, rowTop + rowH);
            stackFloor = rowTop + rowH + AUX_NODE_CLEAR_Y;
        } else if (group.length === 1) {
            const fp = measureBlockFootprint(group[0], blocks, blockGraph);
            const att = findPathAttachment(blockId, group[0], blocks, blockGraph);
            const hubX =
                parentNodeId !== -1
                    ? hubAttachLocalPx(b, parentNodeId)
                    : att
                      ? hubAttachLocalPx(b, att.parentNode)
                      : 0;
            minX = Math.min(minX, hubX - fp.width / 2);
            maxX = Math.max(maxX, hubX + fp.width / 2);
            height = Math.max(height, rowTop + fp.height);
            stackFloor = rowTop + fp.height + AUX_NODE_CLEAR_Y;
        }
    }

    return { width: maxX - minX, height };
}

function blockTreeMaxY(blockId, blocks, blockGraph) {
    let m = -Infinity;
    const stack = [Number(blockId)];
    while (stack.length) {
        const bid = stack.pop();
        for (const id of blocks[bid].nodes) {
            const y = auxNodes[id].y;
            if (y != null) m = Math.max(m, y);
        }
        for (const c of blockGraph.blockChildren[bid] || []) stack.push(Number(c));
    }
    return m;
}

// Fit layout into auxCanvas: scale & translate to keep everything visible with padding.
function fitToAuxCanvas(padding = 36) {
    if (!auxCanvas || !auxCtx) return;

    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const id in auxNodes) {
        const n = auxNodes[id];
        if (n.x === undefined || n.y === undefined) continue;
        minX = Math.min(minX, n.x);
        maxX = Math.max(maxX, n.x);
        minY = Math.min(minY, n.y);
        maxY = Math.max(maxY, n.y);
    }

    if (minX === Infinity) return; // nothing to fit

    const contentW = Math.max(1, maxX - minX);
    const contentH = Math.max(1, maxY - minY);

    const availW = Math.max(10, auxCanvas.clientWidth - 2 * padding);
    const availH = Math.max(10, auxCanvas.clientHeight - 2 * padding);

    // scale down if needed, but don't scale up beyond 1 (keeps node positions readable)
    const scale = Math.min(1, Math.min(availW / contentW, availH / contentH));

    // center content in canvas (after scaling)
    const contentCenterX = (minX + maxX) / 2;
    const contentCenterY = (minY + maxY) / 2;

    const canvasCenterX = auxCanvas.clientWidth / 2;
    const canvasCenterY = auxCanvas.clientHeight / 2;

    const tx = canvasCenterX - (contentCenterX * scale);
    const ty = canvasCenterY - (contentCenterY * scale);

    // apply transform: overwrite n.x/n.y to transformed coords
    for (const id in auxNodes) {
        const n = auxNodes[id];
        if (n.x === undefined || n.y === undefined) continue;
        n.x = Math.round(n.x * scale + tx);
        n.y = Math.round(n.y * scale + ty);
    }
}

// Replace applyGlobalCoords (or add after it) with this safer version
function applyGlobalCoords(blocks, blockGraph, blockPositions){

    const placed = new Set();

    function placeBlock(blockId, baseY){

        if(placed.has(blockId)) return;
        placed.add(blockId);

        const block = blocks[blockId];
        const centerX = blockPositions[blockId];

        // 1) place THIS block
        for(const id of block.nodes){
            const n = auxNodes[id];
            const dx = (n.localX - block.localCenter) * NODE_GAP_X;

            n.x = Math.round(centerX + dx);
            n.y = Math.round(baseY + n.localY * NODE_GAP_Y);
        }

        // 2) path-parent children: one row per attach node (same Y for same path parent)
        const children = (blockGraph.blockChildren[blockId] || []).map(Number);
        if (children.length === 0) return;

        const groups = [...groupChildrenByAttach(blockId, children, blocks, blockGraph)];
        groups.sort((a, bb) => {
            if (a[0] === -1) return 1;
            if (bb[0] === -1) return -1;
            return auxNodes[bb[0]].localY - auxNodes[a[0]].localY;
        });

        let stackFloor = null;
        for (const [parentNodeId, group] of groups) {
            let y;
            if (parentNodeId === -1) {
                let blockBottomY = baseY;
                for (const id of block.nodes)
                    blockBottomY = Math.max(blockBottomY, nodeYInBlock(id, baseY));
                y = blockBottomY + Math.max(PATH_PARENT_GAP_Y_TUNE, AUX_NODE_CLEAR_Y);
            } else {
                y = pathChildRowY(block, parentNodeId, baseY);
                if (stackFloor != null) y = Math.max(y, stackFloor);
            }

            for (const child of group)
                placeBlock(child, y);

            let bottom = -Infinity;
            for (const child of group)
                bottom = Math.max(bottom, blockTreeMaxY(child, blocks, blockGraph));
            if (bottom > -Infinity)
                stackFloor = bottom + AUX_NODE_CLEAR_Y;
        }
    }

    // roots = blocks without parent
    for(const b in blocks){
        if(blockGraph.blockParents[b]==null){
            placeBlock(Number(b), BASE_Y);
        }
    }

    fitToAuxCanvas(36);
}


// top-level combined function
function computeAuxLayoutCombined() {
    if (!auxNodes || Object.keys(auxNodes).length === 0) return;
    const blocks = computeSplayLayouts();
    const blockGraph = buildBlockGraph(blocks);
    const blockPositions = computeBlockPositions(blocks, blockGraph);
    applyGlobalCoords(blocks, blockGraph, blockPositions);
}


function renderAux(skipLayout = false){
    if(!auxCtx) return;
    auxCtx.clearRect(0, 0, auxCanvas.clientWidth, auxCanvas.clientHeight);

    // During animation we will pass skipLayout = true so we DON'T run the
    // layout (which would overwrite the interpolated x/y values).
    if(!skipLayout)
        computeAuxLayoutCombined();

	// draw splay edges
	for(const id in auxNodes){
		const n = auxNodes[id];
		if(n.left != null) drawAuxEdge(n, auxNodes[n.left], "splay");
		if(n.right != null) drawAuxEdge(n, auxNodes[n.right], "splay");
	}
	// draw path-parent edges (overlay) — use explicit pathParent
	for(const id in auxNodes){
		const n = auxNodes[id];
		if(n.pathParent != null && auxNodes[n.pathParent] != null) {
			// draw edge from this node upward to its path parent
			drawAuxEdge(n, auxNodes[n.pathParent], "path");
		}
	}
	// draw nodes
	for(const id in auxNodes) drawAuxNode(id, auxNodes[id]);


}






// ---------- UI ----------

function uiCreate(){
    const box = document.getElementById("createBox");
    const nums = parseNumbers(box.value);
    if(nums.length !== 1) return;

    if(runCommand({type:"create",a:nums[0]}))
        box.value = "";
}

function uiLink(){
    const box = document.getElementById("linkBox");
    const nums = parseNumbers(box.value);
    if(nums.length !== 2) return;

    if(runCommand({type:"link",a:nums[0],b:nums[1]}))
        box.value = "";
}

function uiCut(){
    const box = document.getElementById("cutBox");
    const nums = parseNumbers(box.value);
    if(nums.length !== 1) return;

    if(runCommand({type:"cut",a:nums[0]}))
        box.value = "";
}

function uiAccess(){
    const box = document.getElementById("accessBox");
    const nums = parseNumbers(box.value);
    if(nums.length !== 1) return;

    if(runCommand({type:"access",a:nums[0]}))
        box.value = "";
}

// Animation

function playAnimation(){
    if(animating) return;
    animating = true;
    stepAnimation();
}

function stepAnimation(){

    if(animationQueue.length===0){
        animating=false;
        // After all animations finished, rebuild authoritative state so
        // wasm + aux + forest are guaranteed consistent with commands.
        rebuildFromCommands();
        return;
    }

    const job = animationQueue.shift();

    if(job.kind === "rotation"){
        animateRotation(job).then(() => {
            // proceed to next animation
            stepAnimation();
        });
    }
    else if(job.kind === "forest"){
        animateForest(job).then(() => {
            stepAnimation();
        });
    }
    else if(job.kind === "aux"){
        animateAux(job).then(() => {
            stepAnimation();
        });
    }
}


function getTreeNodeAt(x,y){
    const R = 18;

    for(const [id,node] of forest){
        const dx = node.x - x;
        const dy = node.y - y;
        if(dx*dx + dy*dy <= R*R)
            return id;
    }
    return null;
}

function distPointSegment(px,py, ax,ay, bx,by){
    const vx = bx-ax, vy = by-ay;
    const wx = px-ax, wy = py-ay;

    const t = Math.max(0, Math.min(1,(wx*vx+wy*vy)/(vx*vx+vy*vy)));
    const cx = ax + t*vx;
    const cy = ay + t*vy;

    return Math.hypot(px-cx, py-cy);
}


function onMove(e){
    const r = canvas.getBoundingClientRect();
    mouse.x = e.clientX - r.left;
    mouse.y = e.clientY - r.top;

    hoverNode = getTreeNodeAt(mouse.x,mouse.y);

	updateCursor();

    renderTree();
}

function onDown(e){
    if(e.button!==0) return;


	const r = canvas.getBoundingClientRect();
	mouse.x = e.clientX - r.left;
	mouse.y = e.clientY - r.top;

	mouseDownPos = {x:mouse.x, y:mouse.y};

	const id = getTreeNodeAt(mouse.x,mouse.y);

    if(id!==null){
		dragStartNode=id;
		if (forest.get(id).parent == null) {
			dragging=true;
		}
    }
    else{
		dragStartNode=null;
		dragging=false;
    }
}

function onUp(e){
    if(e.button!==0) return;
    if (!mouseDownPos) return;

    const dx = mouse.x - mouseDownPos.x;
    const dy = mouse.y - mouseDownPos.y;
    const moved = Math.hypot(dx,dy) > CLICK_EPS;

    const target = getTreeNodeAt(mouse.x,mouse.y);

    // --- CASE 1: click on empty → create ---
    if(dragStartNode == null && !moved){
        createNode();
    }

    // --- CASE 2: click same node → ACCESS ---
    else if(dragStartNode!==null && target===dragStartNode && !moved){
        runCommand({type:"access",a:dragStartNode});
    }

    // --- CASE 3: drag node to node → LINK ---
    else if(dragStartNode!==null && target!==null && target!==dragStartNode){
        runCommand({type:"link",a:dragStartNode,b:target});
    }

    dragging=false;
    dragStartNode=null;
    mouseDownPos=null;
}


function onRightDown(e){
    if(e.button!==2) return;

	const r = canvas.getBoundingClientRect();
	mouse.x = e.clientX - r.left;
	mouse.y = e.clientY - r.top;

	const target = getTreeNodeAt(mouse.x,mouse.y);
    if(target != null){
        runCommand({type:"cut",a:target});
    }
}


function smallestFreeID(){
    let i=0;
    while(createdVertices.has(i)) i++;
    return i;
}

function createNode(){
    const id = smallestFreeID();
    runCommand({type:"create",a:id});
}





// ------------------- New helpers for animation snapshots & tweening -------------------

function applyForestSnapshot(snap){
    // snap: { id: { x,y,parent,preferred,children:[..] }, ... }
    forest = new Map();
    createdVertices.clear();

    for(const idStr of Object.keys(snap)){
        const id = Number(idStr);
        const s = snap[idStr];
        createdVertices.add(id);
        forest.set(id, {
            parent: s.parent,
            children: new Set(s.children || []),
            preferred: s.preferred,
            x: s.x,
            y: s.y
        });
    }
}

function snapshotForestLayout(){
    computeLayout(); // fills node.x node.y

    const snap = {};
    for(const [id,node] of forest){
        snap[id]={
            x:node.x,
            y:node.y,
            parent:node.parent,
            preferred:node.preferred,
            children:[...node.children]
        };
    }
    return snap;
}


function deepCopyAux(aux) {
    const out = {};
    for (const id in aux) {
        const n = aux[id];
        out[id] = {
            id: n.id,
            splayParent: n.splayParent == null ? null : Number(n.splayParent),
            pathParent: n.pathParent == null ? null : Number(n.pathParent),
            left: n.left == null ? null : Number(n.left),
            right: n.right == null ? null : Number(n.right),
            localX: n.localX == null ? 0 : n.localX,
            localY: n.localY == null ? 0 : n.localY,
            x: n.x == null ? 0 : n.x,
            y: n.y == null ? 0 : n.y
        };
    }
    return out;
}

// read raw aux from wasm and return a snapshot object (id -> node) WITHOUT computed pixel coords
function snapshotAuxFromWasmRaw() {
    const ptr = ModuleRef._dump_aux();
    const json = ModuleRef.UTF8ToString(ptr);
    const data = JSON.parse(json);

    const snap = {};
    for (const [v, p, l, r, type] of data) {
        snap[v] = {
            id: Number(v),
            splayParent: type === 2 ? (p === -1 ? null : Number(p)) : null,
            pathParent: type === 1 ? (p === -1 ? null : Number(p)) : null,
            left: l === -1 ? null : Number(l),
            right: r === -1 ? null : Number(r),
            // localX/localY/x/y will be filled by layout step
            localX: 0, localY: 0, x: 0, y: 0
        };
    }
    return snap;
}

// compute the pixel layout for a snapshot using your existing layout pipeline
// (temporarily replaces auxNodes, runs computeAuxLayoutCombined, then restores auxNodes).
function computeLayoutForSnapshot(snapshot) {
    const saved = auxNodes;
    auxNodes = snapshot;
    try {
        computeAuxLayoutCombined(); // this will fill snapshot nodes' x,y
    } finally {
        auxNodes = saved;
    }
    // ensure numbers are numeric (and copy back)
    const out = deepCopyAux(snapshot);
    return out;
}

// easing function
function easeInOutCubic(t) {
    return t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2;
}

function interpolateAux(beforeSnap, afterSnap, t){

    const ids = new Set([
        ...Object.keys(beforeSnap).map(Number),
        ...Object.keys(afterSnap).map(Number)
    ]);

    // ensure auxNodes structure matches AFTER structure
    auxNodes = {};
    for(const id in afterSnap){
        auxNodes[id] = {...afterSnap[id]};
    }

    // interpolate coordinates
    for(const id of ids){

        const a = beforeSnap[id] || afterSnap[id];
        const b = afterSnap[id] || beforeSnap[id];

        if(!auxNodes[id]) continue;

        auxNodes[id].x = a.x + (b.x - a.x) * t;
        auxNodes[id].y = a.y + (b.y - a.y) * t;
    }
}


function animateRotation(job){

    return new Promise(resolve=>{

        const ids = new Set([
            ...Object.keys(job.beforeForest),
            ...Object.keys(job.afterForest)
        ].map(Number));

        const start = performance.now();

        function frame(now){

            const t=Math.min(1,(now-start)/job.duration);
            const e=easeInOutCubic(t);

            // ---- AUX ----
            interpolateAux(job.beforeAux,job.afterAux,e);

            // ---- FOREST ----
            for(const id of ids){

                const a=job.beforeForest[id]||job.afterForest[id];
                const b=job.afterForest[id]||job.beforeForest[id];

                const node=forest.get(Number(id));
                if(!node) continue;

                node.x=a.x+(b.x-a.x)*e;
                node.y=a.y+(b.y-a.y)*e;
            }

            renderTree(true);
            renderAux(true);

            if(t<1) requestAnimationFrame(frame);
            else{
                renderTree(false);
                renderAux(false);
                resolve();
            }
        }

        requestAnimationFrame(frame);
    });
}



