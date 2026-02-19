#include <emscripten.h>
#include <vector>
#include <string>
#include <sstream>
#include <set>

struct Event {
	int type;
	int a, b;
};

std::vector<Event> events;

void log_event(int t, int a, int b=-1){
	events.push_back({t,a,b});
}

const int MAX = 1e3+10;

std::set<int> alive;

namespace lct {
	struct node {
		int p, ch[2];
		node() { p = ch[0] = ch[1] = -1; }
	};

	node t[MAX];

	bool is_root(int x) {
		return t[x].p == -1 or (t[t[x].p].ch[0] != x and t[t[x].p].ch[1] != x);
	}
	void rotate(int x) {
		int p = t[x].p, pp = t[p].p;

		// x rotates above p
		log_event(30, x, p);

		if (!is_root(p)) t[pp].ch[t[pp].ch[1] == p] = x;
		bool d = t[p].ch[0] == x;
		t[p].ch[!d] = t[x].ch[d], t[x].ch[d] = p;
		if (t[p].ch[!d]+1) t[t[p].ch[!d]].p = p;
		t[x].p = pp, t[p].p = x;
	}
	void splay(int x) {
		while (!is_root(x)) {
			int p = t[x].p, pp = t[p].p;
			if (!is_root(p)) rotate((t[pp].ch[0] == p)^(t[p].ch[0] == x) ? x : p);
			rotate(x);
		}
	}
	int access(int v) {
		int last = -1;
		for (int w = v; w+1; last = w, splay(v), w = t[v].p) {
			splay(w), t[w].ch[1] = (last == -1 ? -1 : v);

			// w now prefers last
			log_event(20, w, last);
		}
		return last;
	}
	int find_root(int v) {
		access(v);
		while (t[v].ch[0]+1) v = t[v].ch[0];
		return splay(v), v;
	}
	void link(int v, int w) { // v deve ser raiz
		access(v);
		t[v].p = w;
	}
	void cut(int v) { // remove aresta de v pro pai
		access(v);
		t[v].ch[0] = t[t[v].ch[0]].p = -1;
	}
	int lca(int v, int w) {
		return access(v), access(w);
	}
}

extern "C" {

	// ---------- commands ----------

	EMSCRIPTEN_KEEPALIVE void reset(){
		for (int i = 0; i < MAX; i++) lct::t[i] = lct::node();
		alive.clear();

		events.clear();
	}

	EMSCRIPTEN_KEEPALIVE int op_create(int u){
		if (u < 0 || u >= MAX) return 0;

		if (alive.count(u))
			return 1; // already exists

		alive.insert(u);

		log_event(10,u);
		return 1;
	}

	EMSCRIPTEN_KEEPALIVE int op_link(int u, int v){
		if (!alive.count(u) or !alive.count(v)) return 0;

		// must exist
		if (lct::find_root(u) == lct::find_root(v))
			return 0;

		// u must be represented root
		if (lct::find_root(u) != u)
			return 0;

		lct::link(u, v);

		log_event(1,u,v);
		log_event(12,u); // access(u)
		log_event(12,v); // access(v)

		return 1;
	}

	EMSCRIPTEN_KEEPALIVE int op_cut(int u,int v){
		if (!alive.count(u) or !alive.count(v)) return 0;

		lct::access(u);
		lct::splay(u);

		// ensure v is parent of u
		if (lct::t[u].ch[0] != v) {
			lct::access(v);
			lct::splay(v);
			if (lct::t[v].ch[0] != u)
				return 0;
			u = v;
		}

		lct::cut(u);

		log_event(11,u,v);
		return 1;
	}

	EMSCRIPTEN_KEEPALIVE int op_access(int u){
		if (!alive.count(u)) return 0;

		lct::access(u);
		log_event(12,u);
		return 1;
	}

	// ---------- event export ----------

	EMSCRIPTEN_KEEPALIVE const char* consume_events(){
		static std::string out;
		std::ostringstream ss;
		ss << "[";

		for(int i=0;i<events.size();i++){
			if(i) ss<<",";
			ss<<"["<<events[i].type<<","<<events[i].a<<","<<events[i].b<<"]";
		}

		ss<<"]";
		out = ss.str();
		events.clear();
		return out.c_str();
	}

	EMSCRIPTEN_KEEPALIVE const char* dump_aux(){
		static std::string out;
		std::ostringstream ss;

		ss << "[";
		bool first = true;

		for(int v : alive){

			int p = lct::t[v].p;
			int l = lct::t[v].ch[0];
			int r = lct::t[v].ch[1];

			int type = 0; // 0 = none, 1 = path parent, 2 = splay parent

			if(p != -1) {
				if(lct::t[p].ch[0] == v || lct::t[p].ch[1] == v)
					type = 2; // splay parent
				else
					type = 1; // path parent
			}

			if(!first) ss<<",";
			first=false;

			ss<<"["<<v<<","<<p<<","<<l<<","<<r<<","<<type<<"]";
		}

		ss<<"]";
		out = ss.str();
		return out.c_str();
	}



}

