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

createModule().then(Module => {
	ModuleRef = Module;
    window.wasmReady = true;

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
});


// ---------- command system ----------

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
    const s = document.getElementById("status");
    s.textContent = msg;
    s.style.color = ok ? "#2e7d32" : "#c0392b";
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
        console.log("WASM not ready yet");
        return false;
    }

    // rebuild current state in wasm (authoritative)
    ModuleRef.ccall("reset", null, [], []);
    for(const c of commands)
        executeOnWasm(c);

    // expand into real commands
    const expanded = expandCommand(cmd);

    let lastAnimation = null;

	let newAnimations = [];

	for(const c of expanded){

		// state BEFORE this command step
		let prevRaw = snapshotAuxFromWasmRaw();
		let prevLayout = computeLayoutForSnapshot(prevRaw);

		const ok = executeOnWasm(c);
		if(!ok){
			setStatus("Invalid operation!");
			rebuildFromCommands(false);
			return false;
		}

		let ev = ModuleRef.ccall("consume_events","string");
		let parsed = JSON.parse(ev);

		for(const e of parsed){

			// apply logical change
			applyEvent(e);

			// whenever a rotation occurs, capture intermediate state
			if(e[0] === 30){

				const nextRaw = snapshotAuxFromWasmRaw();
				const nextLayout = computeLayoutForSnapshot(nextRaw);

				newAnimations.push({
					kind:"rotation",
					before:prevLayout,
					after:nextLayout,
					duration:260
				});

				// next animation starts from here
				prevLayout = nextLayout;
			}
		}
	}

    // commit to history (skip duplicate access)
    for(const c of expanded){
        if(isRedundantAccess(c))
            continue;
        commands.push(c);
    }

    updateURL();
    setStatus("OK", true);

    // rebuild deterministically (instant)
    rebuildFromCommands(false);

    // animate only last operation
	if(newAnimations.length>0){
		animationQueue = newAnimations;
		playAnimation();
	}

    return true;
}






function undo(){
    if(commands.length===0) return;
    commands.pop();
	updateURL();
    rebuildFromCommands(false);
}


function rebuildFromCommands(){

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

function getSplayRoots(){
    const roots = [];
    for(const id in auxNodes){
        if(auxNodes[id].splayParent === null)
            roots.push(Number(id));
    }
    return roots;
}


function layoutSplay(v, depth, x){

    const node=auxNodes[v];

    const left=node.left;
    const right=node.right;

    if(left==null && right==null){
        node.localX=x;
        node.localY=depth;
        return x+1;
    }

    const start=x;

    if(left!=null)
        x=layoutSplay(left,depth+1,x);

    if(right!=null)
        x=layoutSplay(right,depth+1,x);

    node.localX=(start+x-1)/2;
    node.localY=depth;

    return x;
}


function computeLayout(){

    let roots = [];
    for(const [id,node] of forest)
        if(node.parent===null)
            roots.push(id);

    let x = 80;

    for(const r of roots){
        x = layoutDFS(r,0,x);
        x += 80;
    }
}

function layoutDFS(v,depth,x){

    const node = forest.get(v);

    if(node.children.size===0){
        node.x = x;
        node.y = 80 + depth*80;
        return x+80;
    }

    let start = x;

    for(const c of node.children)
        x = layoutDFS(c,depth+1,x);

    node.x = (start + x-80)/2;
    node.y = 80 + depth*80;

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

    ctx.beginPath();
    ctx.arc(node.x,node.y,18,0,Math.PI*2);
    ctx.fillStyle="white";
    ctx.fill();
    ctx.strokeStyle="#000";
    ctx.stroke();

    ctx.fillStyle="#000";
    ctx.textAlign="center";
    ctx.textBaseline="middle";
    ctx.font="14px sans-serif";
    ctx.fillText(id,node.x,node.y);
}

function drawAuxEdge(a,b,kind){

    const R = 16;

    // ensure arrow always points upward (toward ancestor)
    let from = a, to = b;

    const color = (kind==="path") ? "#999" : "#000";

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
    auxCtx.beginPath();
    auxCtx.arc(node.x,node.y,16,0,Math.PI*2);
    auxCtx.fillStyle="#eef";
    auxCtx.fill();
    auxCtx.strokeStyle="#000";
    auxCtx.stroke();

    auxCtx.fillStyle="#000";
    auxCtx.textAlign="center";
    auxCtx.textBaseline="middle";
    auxCtx.font="13px sans-serif";
    auxCtx.fillText(id,node.x,node.y);
}


function renderTree(){

    if(!ctx) return;

    ctx.clearRect(0,0,canvas.width,canvas.height);

    computeLayout();

    // edges
	for(const [id,node] of forest){
		for(const c of node.children){
			const child = forest.get(c);

			if(node.preferred === c){
				ctx.strokeStyle="#ff4d4d";   // preferred path = red
				ctx.lineWidth=4;
			}else{
				ctx.strokeStyle="#888";
				ctx.lineWidth=2;
			}

			drawEdge(node,child);
			ctx.lineWidth=2;
		}
	}



	if(hoverEdge){
		drawEdge(hoverEdge.u,hoverEdge.v,"#ff4444",3);
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

	if(hoverNode!==null){
		drawNode(hoverNode,"#ffd54f");
	}

    // nodes
    for(const [id,node] of forest)
        drawNode(id,node);

}

// layout tuning (tweak to taste)
const NODE_GAP_X = 48;        // horizontal spacing per localX unit
const NODE_GAP_Y = 66;        // vertical spacing inside splay tree
const PATH_PARENT_GAP_Y = 110;// vertical gap between blocks along path-parent chain
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

        // store block info
        blocks[root] = {
            root: Number(root),
            nodes,
            minLocalX: 0,
            maxLocalX: widthUnits - 1,
            localCenter: centerLocal,
            widthUnits
        };

        // also keep width in pixels
        blocks[root].widthPx = blocks[root].widthUnits * NODE_GAP_X;
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
            if (!blockChildren[parentBlock].includes(childBlock)) blockChildren[parentBlock].push(childBlock);
        }
    }

    return { nodeToRoot, blockChildren, blockParents };
}


// C: compute desired block centers (pixels) by pulling child block toward the parent node's pixel x
function computeDesiredBlockX(blocks, graph) {
    const desired = {};
    // initial desired = local center in pixels
    for (const rootId in blocks) {
        desired[rootId] = blocks[rootId].localCenter * NODE_GAP_X;
    }

    // iterate to propagate anchors from parents -> children
    const ITER = 10;
    for (let it = 0; it < ITER; ++it) {
        for (const childBlockStr in graph.blockParents) {
            const childBlock = Number(childBlockStr);
            const parentBlock = Number(graph.blockParents[childBlock]);
            if (!blocks[parentBlock]) continue;

            // find which parent node inside parentBlock the child points to
            let targetParentNode = null;
            for (const nid of blocks[childBlock].nodes) {
                const par = auxNodes[nid].pathParent;   // <-- changed here
                if (par != null && graph.nodeToRoot[par] === parentBlock) {
                    targetParentNode = par;
                    break;
                }
            }
            if (targetParentNode == null) continue;

            const parentNode = auxNodes[targetParentNode];
            const parentBlockCenterLocal = blocks[parentBlock].localCenter;
            // approximate parent node pixel (using current desired center of parent block)
            const parentNodePixel = desired[parentBlock] + (parentNode.localX - parentBlockCenterLocal) * NODE_GAP_X;

            // move child desired toward parent node pixel (damped)
            desired[childBlock] = desired[childBlock] * ANCHOR_DAMPING + parentNodePixel * PULL_WEIGHT;
        }
    }

    return desired;
}



// D: resolve collisions — ensure block centers separated by block widths + gap
function resolveBlockPositions(blocks, desired) {
    const items = Object.keys(blocks).map(k => ({ id: Number(k), want: desired[k] || blocks[k].localCenter * NODE_GAP_X, width: blocks[k].widthPx }));
    items.sort((a, b) => a.want - b.want);

    const placed = {};
    if (items.length === 0) return placed;

    // place first centered at its wanted position
    placed[items[0].id] = items[0].want;
    let rightEdge = placed[items[0].id] + items[0].width / 2;

    for (let i = 1; i < items.length; ++i) {
        const it = items[i];
        const halfW = it.width / 2;
        const minCenter = rightEdge + BLOCK_GAP_X + halfW;
        const center = Math.max(it.want, minCenter);
        placed[it.id] = center;
        rightEdge = center + halfW;
    }

    // second pass: try to pull left if a later block wanted more left (local balancing)
    for (let i = items.length - 2; i >= 0; --i) {
        const cur = items[i];
        const nxt = items[i + 1];
        const maxCenter = placed[nxt.id] - (cur.width / 2) - BLOCK_GAP_X;
        if (placed[cur.id] > maxCenter) {
            placed[cur.id] = maxCenter;
        }
    }

    return placed;
}

// ---------- Fit & center helper + small tuning ----------

// Tweak these to control how strongly child blocks are pulled under parent node
const PULL_WEIGHT = 0.65;      // currently we used 0.65 (child moves 65% toward parent's pixel x)
const ANCHOR_DAMPING = 1 - PULL_WEIGHT; // e.g. 0.35
// Vertical stacking for path-parent. Reduce to bring blocks closer vertically.
const PATH_PARENT_GAP_Y_TUNE = 80; // try 80..120

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

    const availW = Math.max(10, auxCanvas.width - 2 * padding);
    const availH = Math.max(10, auxCanvas.height - 2 * padding);

    // scale down if needed, but don't scale up beyond 1 (keeps node positions readable)
    const scale = Math.min(1, Math.min(availW / contentW, availH / contentH));

    // center content in canvas (after scaling)
    const contentCenterX = (minX + maxX) / 2;
    const contentCenterY = (minY + maxY) / 2;

    const canvasCenterX = auxCanvas.width / 2;
    const canvasCenterY = auxCanvas.height / 2;

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
function applyGlobalCoords(blocks, graph, blockPositions){

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

        // 2) place children blocks relative to actual parent node
        const children = graph.blockChildren[blockId] || [];

        for(const child of children){

            let parentNodeId = null;
            let childAttachId = null;

            // find attachment edge
            for(const nid of blocks[child].nodes){
                const p = auxNodes[nid].pathParent;
                if(p!=null && graph.nodeToRoot[p]===blockId){
                    parentNodeId = p;
                    childAttachId = Number(nid);
                    break;
                }
            }

            if(parentNodeId==null){
                placeBlock(child, baseY + PATH_PARENT_GAP_Y_TUNE);
                continue;
            }

            const parentNode = auxNodes[parentNodeId];

            // compute minimum required gap using splay gap
            let splayGap = 0;
            const childNode = auxNodes[childAttachId];
            if(childNode.splayParent!=null){
                const sp = auxNodes[childNode.splayParent];
                splayGap = Math.max(0,(childNode.localY - sp.localY) * NODE_GAP_Y);
            }

            const MIN_EXTRA = 10;

            const childBaseY =
                parentNode.y + Math.max(PATH_PARENT_GAP_Y_TUNE, splayGap + MIN_EXTRA);

            placeBlock(child, childBaseY);
        }
    }

    // roots = blocks without parent
    for(const b in blocks){
        if(graph.blockParents[b]==null){
            placeBlock(Number(b), BASE_Y);
        }
    }

    fitToAuxCanvas(36);
}


// top-level combined function
function computeAuxLayoutCombined() {
    if (!auxNodes || Object.keys(auxNodes).length === 0) return;
    const blocks = computeSplayLayouts();
    const graph = buildBlockGraph(blocks);
    const desired = computeDesiredBlockX(blocks, graph);
    const blockPositions = resolveBlockPositions(blocks, desired);
    applyGlobalCoords(blocks, graph, blockPositions);
}


function renderAux(skipLayout = false){
    if(!auxCtx) return;
    auxCtx.clearRect(0,0,auxCanvas.width,auxCanvas.height);

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
        renderTree();
        renderAux();
        return;
    }

    const job = animationQueue.shift();

    if(job.kind==="rotation"){
        animateBetweenSnapshots(job.before, job.after, job.duration)
            .then(()=>{
                animating=false;
                renderTree();
                renderAux();
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

function getTreeEdgeAt(x,y){
    const TH = 8;

    for(const [p,node] of forest){
        for(const c of node.children){
            const child = forest.get(c);

            if(distPointSegment(x,y,node.x,node.y,child.x,child.y)<TH)
                return {u:p,v:c};
        }
    }
    return null;
}


function onMove(e){
    const r = canvas.getBoundingClientRect();
    mouse.x = e.clientX - r.left;
    mouse.y = e.clientY - r.top;

    hoverNode = getTreeNodeAt(mouse.x,mouse.y);
    hoverEdge = getTreeEdgeAt(mouse.x,mouse.y);

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
		if (!forest.get(id).parent) {
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

// animate between two computed-snapshots (beforeSnap, afterSnap), both produced by computeLayoutForSnapshot.
// - We set current auxNodes to a copy of afterSnap's structure so edges reflect the final structure,
//   but initial positions are taken from beforeSnap and interpolated to afterSnap.
function animateBetweenSnapshots(beforeSnap, afterSnap, duration = 350) {
    return new Promise(resolve => {
        // union of node ids
        const ids = new Set([...Object.keys(beforeSnap).map(Number), ...Object.keys(afterSnap).map(Number)]);

        // build start/end coordinate maps
        const startPos = {}, endPos = {};
        for (const id of ids) {
            const b = beforeSnap[id] || beforeSnap[String(id)];
            const a = afterSnap[id] || afterSnap[String(id)];
            startPos[id] = { x: b ? b.x : (a ? a.x : 0), y: b ? b.y : (a ? a.y : 0) };
            endPos[id] = { x: a ? a.x : (b ? b.x : 0), y: a ? a.y : (b ? b.y : 0) };
        }

        // Set auxNodes structure to afterSnap (so edges/left/right/pathParent represent the final arrangement)
        auxNodes = {};
        for (const id in afterSnap) {
            auxNodes[id] = Object.assign({}, afterSnap[id]); // copy
            // initialize positions to startPos (these will be interpolated)
            const n = auxNodes[id];
            const s = startPos[id];
            n.x = s.x; n.y = s.y;
        }

        const startTime = performance.now();

        function frame(now) {
            const t = Math.min(1, (now - startTime) / duration);
            const easeT = easeInOutCubic(t);

            // interpolate positions onto auxNodes (these are used by renderAux(true))
            for (const id of ids) {
                const s = startPos[id];
                const e = endPos[id];
                const cur = auxNodes[id];
                if (!cur) continue;
                cur.x = s.x + (e.x - s.x) * easeT;
                cur.y = s.y + (e.y - s.y) * easeT;
            }

            // RENDER, skipping layout so our interpolated x/y are respected
            renderAux(true);

            if (t < 1) {
                requestAnimationFrame(frame);
            } else {
                // final snap: set auxNodes to a deep copy of afterSnap so state is exact
                auxNodes = deepCopyAux(afterSnap);
                // render final state (allow layout to run if you want final consistency)
                renderAux(false);
                resolve();
            }
        }

        requestAnimationFrame(frame);
    });
}


