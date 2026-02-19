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

const AUX_RADIUS = 16;

// ---------- init ----------

let auxCanvas, auxCtx;

createModule().then(Module => {
	ModuleRef = Module;
    window.wasmReady = true;

    canvas = document.getElementById("treeCanvas");
    ctx = canvas.getContext("2d");

    auxCanvas = document.getElementById("auxCanvas");
    auxCtx = auxCanvas.getContext("2d");

    // IMPORTANT
    ModuleRef.ccall("reset", null, [], []);
    updateAuxFromWasm();     // <-- missing before
    renderAux();

    renderTree();

	canvas.addEventListener("click", e => {
		const rect = canvas.getBoundingClientRect();

		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;

		const v = getNodeAt(x,y);

		if(v!==null){
			runCommand({type:"access",a:v});
		}
	});
	canvas.addEventListener("mousemove", e => {
		const rect = canvas.getBoundingClientRect();
		const x = e.clientX - rect.left;
		const y = e.clientY - rect.top;

		canvas.style.cursor = getNodeAt(x,y)!==null ? "pointer" : "default";
	});


});


// ---------- command system ----------

function setStatus(msg, ok=false){
    const s = document.getElementById("status");
    s.textContent = msg;
    s.style.color = ok ? "#2e7d32" : "#c0392b";
}


function renderState(){

    console.clear();

    for(const [id,node] of forest){
        console.log(
            id,
            "parent:",node.parent,
            "children:",[...node.children]
        );
    }
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

    if(cmd.type==="link" || cmd.type==="cut"){
        need(cmd.a);
        need(cmd.b);
    }

    if(cmd.type==="access"){
        need(cmd.a);
    }

    out.push(cmd);
    return out;
}

function runCommand(cmd){

    if(!window.wasmReady){
        console.log("WASM not ready yet");
        return false;
    }

    // rebuild current state in wasm
    ModuleRef.ccall("reset", null, [], []);
    for(const c of commands)
        executeOnWasm(c);

    // expand into real commands
    const expanded = expandCommand(cmd);

    // try executing all of them
    for(const c of expanded){
        const ok = executeOnWasm(c);
        if(!ok){
            setStatus("Invalid operation!");
            rebuildFromCommands();
            return false;
        }
    }

    // commit to history
    commands.push(...expanded);

    setStatus("OK", true);
    rebuildFromCommands();
    return true;
}





function undo(){
    if(commands.length===0) return;
    commands.pop();
    rebuildFromCommands();
}

function rebuildFromCommands(){

	createdVertices.clear();

	animationQueue = [];

    forest = new Map();

    ModuleRef.ccall("reset", null, [], []);

    for(const cmd of commands){
		if(cmd.type==="create")
			createdVertices.add(cmd.a);
        executeOnWasm(cmd);

        let ev = ModuleRef.ccall("consume_events","string");
        let parsed = JSON.parse(ev);

		for(const ev of parsed){
			if(ev[0] === 30)
				animationQueue.push(ev);   // animate rotations
			else
				applyEvent(ev);            // apply immediately
		}

    }

    updateAuxFromWasm();
    renderTree();
    renderAux();
    playAnimation();
}

function executeOnWasm(cmd){

    if(cmd.type==="create")
        return ModuleRef.ccall("op_create","number",["number"],[cmd.a]);

    if(cmd.type==="link")
        return ModuleRef.ccall("op_link","number",["number","number"],[cmd.a,cmd.b]);

    if(cmd.type==="cut")
        return ModuleRef.ccall("op_cut","number",["number","number"],[cmd.a,cmd.b]);

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

    auxNodes = {};

    for(const [v,p,l,r,type] of data){
        auxNodes[v] = {
            id:v,
            parent:p,
            left:l,
            right:r,
            pathParent:(type===1)
        };
    }
}



function applyEvent(ev){

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
        if(A && A.parent===b){
            let B = forest.get(b);
            B.children.delete(a);
            A.parent=null;
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

function computeRepresentedDepth(){

    const depth = new Map();

    function dfs(v,d){
        depth.set(v,d);
        const node = forest.get(v);
        for(const c of node.children)
            dfs(c,d+1);
    }

    for(const [v,node] of forest)
        if(node.parent===null)
            dfs(v,0);

    return depth;
}

function isSplayChild(v,p){
    if(p==-1) return false;
    const P = auxNodes[p];
    if(!P) return false;
    return P.left==v || P.right==v;
}

function isSplayRoot(v){
    const n = auxNodes[v];
    return n.parent==-1 || !isSplayChild(v,n.parent);
}

function buildChildSet(){
    const isChild = new Set();

    for(const id in auxNodes){
        const n = auxNodes[id];
        if(n.left!=-1) isChild.add(n.left);
        if(n.right!=-1) isChild.add(n.right);
    }

    return isChild;
}

function computeAuxLayout(){

    const visited = new Set();
    const isChild = buildChildSet();

    let x = 80;

    // ONLY real top splay roots
    for(const id in auxNodes){
        const v = parseInt(id);

        if(isSplayRoot(v) && !isChild.has(v)){
            x = layoutAuxDFS(v,0,x,visited);
            x += 120;
        }
    }

    // attach path-parent nodes under their parents
    for(const id in auxNodes){
        const v = parseInt(id);
        const n = auxNodes[v];

        if(n.parent!=-1 && !isSplayChild(v,n.parent)){
            const p = auxNodes[n.parent];
            if(!p) continue;

            n.x = p.x;
            n.y = p.y + 90;
        }
    }
}


function layoutAuxDFS(v,depth,x,visited){

    if(visited.has(v)) return x;
    visited.add(v);

    const node = auxNodes[v];

    const L=node.left, R=node.right;

    if(L===-1 && R===-1){
        node.x=x;
        node.y=80+depth*70;
        return x+70;
    }

    let start=x;

    if(L!=-1) x=layoutAuxDFS(L,depth+1,x,visited);

    node.x=x;
    node.y=80+depth*70;
    x+=70;

    if(R!=-1) x=layoutAuxDFS(R,depth+1,x,visited);

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
    if(a.y < b.y){
        from = b;
        to = a;
    }

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


    // nodes
    for(const [id,node] of forest)
        drawNode(id,node);

}

function renderAux(){

    if(!auxCtx) return;

    auxCtx.clearRect(0,0,auxCanvas.width,auxCanvas.height);

    computeAuxLayout();

    for(const id in auxNodes){
        const n = auxNodes[id];

        if(n.left!=-1)
            drawAuxEdge(n,auxNodes[n.left],"splay");

        if(n.right!=-1)
            drawAuxEdge(n,auxNodes[n.right],"splay");

        if(n.parent!=-1 && !(
            auxNodes[n.parent]?.left==n.id ||
            auxNodes[n.parent]?.right==n.id
        ))
            drawAuxEdge(n,auxNodes[n.parent],"path");
    }

    for(const id in auxNodes)
        drawAuxNode(id,auxNodes[id]);
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
    if(nums.length !== 2) return;

    if(runCommand({type:"cut",a:nums[0],b:nums[1]}))
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

    const ev = animationQueue.shift();
    applyEvent(ev);

    renderAux();

    setTimeout(stepAnimation, 350); // speed here
}

function getNodeAt(x,y){
    for(const [id,node] of forest){
        const dx = node.x - x;
        const dy = node.y - y;
        if(dx*dx + dy*dy <= 18*18) // radius
            return id;
    }
    return null;
}

