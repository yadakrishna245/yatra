(() => {
  const { STATES, ORIGINS, INDIA_MAP: M, Planner } = window;
  const $ = s => document.querySelector(s);
  const svg = $("#map"), panel = $("#panel"), tip = $("#tip"), reset = $("#reset");
  const NS = "http://www.w3.org/2000/svg";
  const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
  const prefs = (() => { try { return JSON.parse(localStorage.getItem("yatra") || "{}"); } catch { return {}; } })();
  const save = () => { try { localStorage.setItem("yatra", JSON.stringify(prefs)); } catch {} };
  let current = null, destI = -1, tab = "overview", zoomScale = 1;

  const list = s => (s ? s.split("; ") : []);
  const title = s => s.split(" — ")[0];
  const STAY_BASE = { low: 1600, mid: 3800, lux: 10000 }; // same base rates as planner.js
  const band = (base, cost) => `${inr.format(Math.round(base * cost * 0.75 / 100) * 100)} – ${inr.format(Math.round(base * cost * 1.35 / 100) * 100)}`;
  const gmap = (q, d) => `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent([q, d && d.n, current].filter(Boolean).join(", "))}`;
  const ext = 'target="_blank" rel="noopener"';
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)").matches;
  window.gsap?.ticker.lagSmoothing(0); // slow frames (heavy WebGL) must not stall UI reveals

  // Wikipedia summaries (CORS-enabled REST API). Exact title first, then search; cached per session.
  const WIKI_TITLES = { "Jammu and Kashmir": "Jammu and Kashmir (union territory)", "Punjab": "Punjab, India", "Puducherry": "Puducherry (union territory)" };
  const wikiCache = new Map();
  function wiki(title, search = title) {
    if (wikiCache.has(title)) return wikiCache.get(title);
    const summary = async t => {
      const r = await fetch("https://en.wikipedia.org/api/rest_v1/page/summary/" + encodeURIComponent(t.replace(/ /g, "_")));
      if (!r.ok) return null;
      const j = await r.json();
      return j.type === "standard" ? j : null;
    };
    const p = (async () => {
      let j = await summary(WIKI_TITLES[title] || title);
      if (!j) {
        const r = await fetch("https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=1&format=json&origin=*&srsearch=" + encodeURIComponent(search));
        const t = (await r.json()).query?.search?.[0]?.title;
        if (t) j = await summary(t);
      }
      const img = j?.thumbnail?.source;
      return j && { title: j.title, text: j.extract, img: img && img.startsWith("https://") ? img : null, url: j.content_urls?.desktop?.page };
    })().catch(() => null);
    wikiCache.set(title, p);
    return p;
  }
  const wikiQuery = (d, state) => [d.n.split(/ & |, | \(/)[0], `${d.n} ${state}`];
  const wikiBlock = (title, search) => `<section class="wiki" data-title="${title}" data-search="${search}"><p class="muted">Loading from Wikipedia…</p></section>`;
  function fillWiki() {
    panel.querySelectorAll(".wiki[data-title]").forEach(async box => {
      const w = await wiki(box.dataset.title, box.dataset.search);
      if (!box.isConnected) return;
      box.textContent = "";
      if (!w) return box.remove();
      if (w.img) box.append(Object.assign(document.createElement("img"), { src: w.img, alt: w.title, loading: "lazy" }));
      const body = document.createElement("div");
      body.append(Object.assign(document.createElement("p"), { textContent: w.text }));
      const a = Object.assign(document.createElement("a"), { href: w.url, target: "_blank", rel: "noopener", textContent: `From Wikipedia: ${w.title} ↗` });
      a.className = "credit";
      body.append(a);
      box.append(body);
    });
  }

  // Mercator, same projection the map paths were generated with (docs/map-gen.mjs)
  const project = ([lat, lng]) => {
    const r = Math.PI / 180, { scale: k, translate: [tx, ty] } = M.proj;
    return [lng * r * k + tx, ty - Math.log(Math.tan(Math.PI / 4 + lat * r / 2)) * k];
  };
  const el = (tag, attrs = {}, parent) => {
    const n = document.createElementNS(NS, tag);
    for (const k in attrs) n.setAttribute(k, attrs[k]);
    parent && parent.appendChild(n);
    return n;
  };

  // ---------- Map ----------
  svg.setAttribute("viewBox", `0 0 ${M.w} ${M.h}`);
  svg.innerHTML = `<defs><linearGradient id="goldFill" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="#d9b26a"/><stop offset="1" stop-color="#8a6a32"/></linearGradient></defs>`;
  const zoom = el("g", { id: "zoom" }, svg), statesG = el("g", {}, zoom), pinsG = el("g", {}, zoom);
  const paths = {};
  for (const [name, { d }] of Object.entries(M.states)) {
    const p = el("path", { d, class: "state", tabindex: 0, role: "button", "aria-label": name }, statesG);
    p.addEventListener("click", () => select(name));
    p.addEventListener("keydown", e => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), select(name)));
    p.addEventListener("mousemove", e => showTip(e, name));
    p.addEventListener("mouseleave", () => (tip.hidden = true));
    paths[name] = p;
  }
  function showTip(e, text) {
    const r = svg.parentElement.getBoundingClientRect();
    tip.textContent = text; tip.hidden = false;
    tip.style.left = e.clientX - r.left + "px"; tip.style.top = e.clientY - r.top + "px";
  }

  function zoomTo(name) {
    if (!name) { zoom.style.transform = ""; zoomScale = 1; return; }
    const { x, y, width, height } = paths[name].getBBox(), b = { x, y, width, height };
    for (const d of STATES[name].dest) { // include pins (islands spread wider than outline)
      const [px, py] = project(d.ll);
      const x0 = Math.min(b.x, px), y0 = Math.min(b.y, py);
      b.width = Math.max(b.x + b.width, px) - x0; b.height = Math.max(b.y + b.height, py) - y0; b.x = x0; b.y = y0;
    }
    const s = Math.min(14, 0.78 * Math.min(M.w / Math.max(b.width, 1), M.h / Math.max(b.height, 1)));
    zoomScale = s;
    // CSS transforms on SVG elements are in viewBox units with origin 0 0
    zoom.style.transform = `translate(${M.w / 2 - (b.x + b.width / 2) * s}px, ${M.h / 2 - (b.y + b.height / 2) * s}px) scale(${s})`;
  }

  function drawPins(name) {
    pinsG.innerHTML = "";
    if (!name) return;
    const s = zoomScale;
    STATES[name].dest.forEach((d, i) => {
      const [x, y] = project(d.ll);
      const g = el("g", { class: "pin", "data-i": i, tabindex: 0, role: "button", "aria-label": d.n }, pinsG);
      el("circle", { cx: x, cy: y, r: 6 / s }, g);
      const t = el("text", { x: x + 9 / s, y: y + 4 / s, "font-size": 11 / s, "stroke-width": 3 / s }, g);
      t.textContent = d.n;
      g.addEventListener("click", e => { e.stopPropagation(); openDest(i); });
      g.addEventListener("keydown", e => e.key === "Enter" && openDest(i));
    });
  }
  const markPin = i => document.querySelectorAll(".pin").forEach(p => p.classList.toggle("hot", +p.dataset.i === i));

  // ---------- Selection & routing (#State or #State/Destination) ----------
  function select(name, fromHash, i = -1) {
    if (name && !STATES[name]) return;
    const sameState = name === current;
    current = name; destI = name ? i : -1;
    if (!sameState) {
      for (const n in paths) paths[n].classList.toggle("on", n === name);
      svg.classList.toggle("dim", !!name);
      reset.hidden = !name;
      tab = "overview";
      zoomTo(name);
      drawPins(name);
    }
    markPin(destI);
    if (!sameState) Yatra.onState?.(name);
    Yatra.onDest?.(destI);
    render();
    if (!fromHash) {
      const h = name ? "#" + encodeURIComponent(name) + (destI >= 0 ? "/" + encodeURIComponent(STATES[name].dest[destI].n) : "") : location.pathname;
      history.replaceState(null, "", h);
      if (name && matchMedia("(max-width: 960px)").matches) panel.scrollIntoView({ behavior: "smooth" });
      else window.scrollTo({ top: 0, behavior: "smooth" });
    }
  }
  const openDest = i => select(current, false, i);
  function fromHash() {
    const [s, d] = location.hash.slice(1).split("/").map(decodeURIComponent);
    const i = s && STATES[s] ? STATES[s].dest.findIndex(x => x.n === d) : -1;
    select(s || null, true, i);
  }
  reset.addEventListener("click", () => select(null));
  window.addEventListener("hashchange", fromHash);

  // Search: states, destinations and individual attractions
  const places = {};
  for (const [s, v] of Object.entries(STATES)) {
    places[s] = [s, -1];
    v.dest.forEach((d, i) => {
      places[`${d.n} — ${s}`] = [s, i];
      for (const p of list(d.see)) places[`${title(p)} — ${d.n}, ${s}`] ||= [s, i];
    });
  }
  const keys = Object.keys(places).sort();
  $("#places").innerHTML = keys.map(p => `<option value="${p.replace(/"/g, "&quot;")}">`).join("");
  $("#search").addEventListener("change", e => {
    const q = e.target.value.trim().toLowerCase();
    if (!q) return;
    const key = keys.find(k => k.toLowerCase() === q) || keys.find(k => k.toLowerCase().startsWith(q)) || keys.find(k => k.toLowerCase().includes(q));
    if (!key) return;
    const [s, i] = places[key];
    if (s !== current) select(s);
    if (i >= 0) openDest(i);
    e.target.value = "";
  });

  // ---------- Panel ----------
  function render() {
    const view = (current || "") + "/" + destI;
    panel.innerHTML = !current ? homeView() : destI >= 0 ? destView(current, destI) : stateView(current);
    bind();
    fillWiki();
    if (window.gsap && !reduceMotion && view !== lastView) reveal();
    lastView = view;
  }
  let lastView = null;
  // Headline word-by-word, then the rest of the panel. The h1 keeps its plain text as aria-label.
  function reveal() {
    const h = panel.querySelector("h1");
    if (h) {
      h.setAttribute("aria-label", h.textContent);
      h.innerHTML = h.innerHTML.split(/(<br>)/).map(part => part === "<br>" ? part :
        part.split(" ").map(w => w ? `<span class="word" aria-hidden="true"><span>${w}</span></span>` : "").join(" ")).join("");
      gsap.fromTo(h.querySelectorAll(".word > span"), { yPercent: 110 }, { yPercent: 0, duration: 0.8, ease: "power4.out", stagger: 0.06 });
    }
    gsap.fromTo([...panel.children].filter(c => c !== h), { y: 18, opacity: 0 }, { y: 0, opacity: 1, duration: 0.6, ease: "power3.out", stagger: 0.04, delay: 0.15, clearProps: "all" });
  }

  function homeView() {
    const n = Object.values(STATES), dests = n.reduce((a, s) => a + s.dest.length, 0);
    const picks = ["Rajasthan", "Kerala", "Telangana", "Himachal Pradesh", "Goa", "Ladakh", "Meghalaya", "Tamil Nadu", "Uttarakhand"];
    return `
      <p class="eyebrow">Your personal India guide</p>
      <h1>Discover India,<br>one state at a time.</h1>
      <p class="lede">Tap any state on the map to explore its places, local food and the best hotels from luxury to budget, then get a day-by-day plan with an honest budget for your car, bike, bus, train or flight.</p>
      <div class="stats">
        <div class="stat"><b>${n.length}</b><span>States & UTs</span></div>
        <div class="stat"><b>${dests}</b><span>Destinations</span></div>
        <div class="stat"><b>${Math.floor((keys.length - n.length - dests) / 100) * 100}+</b><span>Places to visit</span></div>
      </div>
      <h2>Popular right now</h2>
      <div class="chips">${picks.map(p => `<button class="chip" data-go="${p}">${p}</button>`).join("")}</div>
      <h2>How it works</h2>
      <ol class="steps">
        <li><span>Hover a state to preview it, click to fly in. Inside, hover any district for its story.</span></li>
        <li><span>Or search any city or sight, e.g. "Charminar".</span></li>
        <li><span>Open a destination to see places to visit, famous local food and hotels.</span></li>
        <li><span>Open <b>Plan trip</b>: choose your city, travellers and how you'll travel.</span></li>
        <li><span>Get total days, a full budget breakdown and a day-by-day itinerary. Print it or save it as a PDF.</span></li>
      </ol>`;
  }

  function stateView(name) {
    const s = STATES[name];
    const total = s.dest.reduce((a, d) => a + d.d, 0);
    const tabs = [["overview", "Destinations"], ["food", "Food"], ["stay", "Stay"], ["plan", "Plan trip"]];
    return `
      <p class="eyebrow">${s.type === "UT" ? "Union Territory" : "State"}</p>
      <h1>${name}</h1>
      <p class="lede">${s.tagline}</p>
      ${tab === "overview" ? wikiBlock(name, name + " India") : ""}
      <div class="meta">
        <span>Capital <b>${s.capital}</b></span>
        <span>Best time <b>${s.best}</b></span>
        <span>To see it all <b>~${total} days</b></span>
      </div>
      <div class="tabs" role="tablist">${tabs.map(([id, l]) => `<button class="tab" role="tab" data-tab="${id}" aria-selected="${tab === id}">${l}</button>`).join("")}</div>
      <div id="tabBody">${tabBody(name)}</div>`;
  }

  function tabBody(name) {
    const s = STATES[name];
    if (tab === "food") return `
      <h2>Signature dishes</h2>
      <div class="food">${s.foods.map(([f, d]) => `<div class="card"><b>${f}</b><p>${d}</p></div>`).join("")}</div>
      <h2>Where locals eat</h2>
      <div class="grid">${s.dest.map((d, i) => `
        <div class="card"><div class="card-head"><h3>${d.n}</h3><button class="more" data-dest="${i}">Open →</button></div>
        <ul class="hotels">${list(d.eat).map(x => { const [dish, at] = x.split(" @ "); return `<li><b>${dish}</b>${at ? ` · ${at}` : ""}</li>`; }).join("")}</ul></div>`).join("")}
      </div>`;
    if (tab === "stay") return `
      <h2>Price guide</h2>
      <div class="tiers">
        <div class="card"><span class="tag">Budget & safe</span><b>${band(STAY_BASE.low, s.cost)}</b><p>Govt tourism hotels, branded budget chains, hostels</p></div>
        <div class="card"><span class="tag">Mid-range</span><b>${band(STAY_BASE.mid, s.cost)}</b><p>3–4★ hotels, boutique & heritage stays</p></div>
        <div class="card"><span class="tag">Luxury</span><b>${band(STAY_BASE.lux, s.cost)}</b><p>5★, palaces & resorts</p></div>
      </div>
      <p class="fine">Typical price per room per night in season (2026). Peak holidays can be 30–60% higher. ${s.stay}.</p>
      <h2>Hotels by destination</h2>
      <div class="grid">${s.dest.map((d, i) => `
        <div class="card"><div class="card-head"><h3>${d.n}</h3><button class="more" data-dest="${i}">All stays →</button></div>
        ${stayLists(d)}</div>`).join("")}
      </div>`;
    if (tab === "plan") return planView(name);
    return `
      <div class="grid">${s.dest.map((d, i) => `
        <article class="card dest" data-dest="${i}" tabindex="0" role="button" aria-label="Open ${d.n}">
          <div class="card-head"><h3>${d.n}</h3><span class="tag">${d.t}</span></div>
          <p>${list(d.see).slice(0, 6).map(title).join(" · ")}</p>
          <div class="card-foot"><span class="days">Recommended: ${d.d} day${d.d > 1 ? "s" : ""}</span><span class="more">Places, food & stays →</span></div>
        </article>`).join("")}
      </div>
      <p class="callout"><b>Local tip:</b> ${s.tips}</p>`;
  }

  const TIERS = [["lux", "Luxury"], ["mid", "Mid-range"], ["low", "Budget & safe"]];
  const stayLists = d => TIERS.filter(([k]) => d[k]).map(([k, label]) => `
      <div class="stay-tier"><span class="tag">${label}</span>
        <ul class="hotels">${list(d[k]).slice(0, 2).map(h => `<li><a href="${gmap(title(h), d)}" ${ext}>${h}</a></li>`).join("")}</ul></div>`).join("");

  function destView(name, i) {
    const s = STATES[name], d = s.dest[i];
    const see = list(d.see).map(x => x.split(" — "));
    const eat = list(d.eat).map(x => x.split(" @ "));
    return `
      <button class="back" data-back>← All of ${name}</button>
      <p class="eyebrow">${d.t} · ${name}</p>
      <h1>${d.n}</h1>
      <div class="meta">
        <span>Recommended <b>${d.d} day${d.d > 1 ? "s" : ""}</b></span>
        <span>Best time <b>${s.best}</b></span>
        <a class="link" href="${gmap(d.n)}" ${ext}>Open in Google Maps ↗</a>
      </div>
      ${wikiBlock(...wikiQuery(d, name))}
      <div class="actions"><button class="btn solid" data-planhere>Plan a trip to ${d.n}</button>${s.dest.length > 1 ? `<button class="btn" data-planall>Plan all of ${name}</button>` : ""}</div>

      <h2>Places to visit</h2>
      <div class="places">${see.map(([p, note]) => `
        <a class="place" href="${gmap(p, d)}" ${ext}><b>${p}</b>${note ? `<span>${note}</span>` : ""}</a>`).join("")}
      </div>

      <h2>Famous local food</h2>
      <div class="food">${eat.map(([dish, at]) => `
        <div class="card"><b>${dish}</b>${at ? `<p>Try at <a href="${gmap(at.split(",")[0], d)}" ${ext}>${at}</a></p>` : ""}</div>`).join("")}
      </div>

      <h2>Where to stay</h2>
      <div class="stays">${TIERS.filter(([k]) => d[k]).map(([k, label]) => `
        <div class="card">
          <div class="card-head"><span class="tag">${label}</span><span class="days">${band(STAY_BASE[k], s.cost)} / night</span></div>
          <ul class="hotels">${list(d[k]).map(h => `<li><a href="${gmap(title(h), d)}" ${ext}>${h}</a></li>`).join("")}</ul>
        </div>`).join("")}
      </div>
      <p class="fine">Hotels are well-known options, not paid listings. Budget picks favour government tourism hotels and branded chains with 24×7 front desks. Tap any name to open it in Google Maps and check recent reviews before booking.</p>
      <p class="callout"><b>Local tip:</b> ${s.tips}</p>`;
  }

  // ---------- Planner ----------
  const opts = () => ({
    origin: prefs.origin || "Delhi", mode: prefs.mode || "car", adults: prefs.adults ?? 2, kids: prefs.kids ?? 0,
    comfort: prefs.comfort || "standard", pace: prefs.pace || "balanced",
  });
  let only = null;

  function planView(name) {
    const o = opts(), s = STATES[name];
    only = only && only.state === name ? only : { state: name, list: s.dest.map(d => d.n) };
    const seg = (key, items) => `<div class="seg" role="radiogroup">${items.map(([v, l]) =>
      `<label><input type="radio" name="${key}" value="${v}" ${o[key] === v ? "checked" : ""}><span>${l}</span></label>`).join("")}</div>`;
    return `
      <form class="form" id="planForm" onsubmit="return false">
        <label class="field"><span>Starting from</span>
          <select name="origin">${Object.keys(ORIGINS).sort().map(c => `<option ${c === o.origin ? "selected" : ""}>${c}</option>`).join("")}</select></label>
        <div class="field" style="grid-template-columns:1fr 1fr;gap:10px">
          <label class="field"><span>Adults</span><input type="number" name="adults" min="1" max="20" value="${o.adults}"></label>
          <label class="field"><span>Children</span><input type="number" name="kids" min="0" max="10" value="${o.kids}"></label>
        </div>
        <div class="field full"><span>Travel by</span>${seg("mode", [["car", "Car"], ["bike", "Bike"], ["bus", "Bus"], ["train", "Train"], ["flight", "Flight"]])}</div>
        <div class="field"><span>Comfort</span>${seg("comfort", [["budget", "Budget"], ["standard", "Standard"], ["luxury", "Luxury"]])}</div>
        <div class="field"><span>Pace</span>${seg("pace", [["relaxed", "Relaxed"], ["balanced", "Balanced"], ["packed", "Packed"]])}</div>
        <div class="field full"><span>Places to cover</span>
          <div class="seg">${s.dest.map(d => `<label><input type="checkbox" name="only" value="${d.n}" ${only.list.includes(d.n) ? "checked" : ""}><span>${d.n}</span></label>`).join("")}</div>
        </div>
      </form>
      <div id="result" class="result">${resultView(name)}</div>`;
  }

  function resultView(name) {
    const o = opts();
    const p = Planner.planTrip({ ...STATES[name], name }, { ...o, originLL: ORIGINS[o.origin], only: only.list });
    if (!p) return `<p class="muted">Select at least one place to build your plan.</p>`;
    const rows = [["Travel to & between", p.cost.travel], ["Local cabs & transfers", p.cost.local], ["Stay", p.cost.stay],
      ["Food", p.cost.food], ["Sightseeing & entry", p.cost.sights], ["Buffer (10%)", p.cost.buffer]].filter(r => r[1] > 0);
    const max = Math.max(...rows.map(r => r[1]));
    const who = `${o.adults} adult${o.adults > 1 ? "s" : ""}${o.kids ? ` + ${o.kids} child${o.kids > 1 ? "ren" : ""}` : ""}`;
    const veh = p.vehicles ? ` · ${p.vehicles} ${o.mode === "bike" ? "bike" : "car"}${p.vehicles > 1 ? "s" : ""}` : "";
    return `
      <div class="kpis">
        <div class="stat"><b>${p.days}D / ${p.nights}N</b><span>Trip length</span></div>
        <div class="stat"><b>${inr.format(p.cost.total)}</b><span>Total budget</span></div>
        <div class="stat"><b>${inr.format(p.perPerson)}</b><span>Per person</span></div>
        <div class="stat"><b>${p.km.toLocaleString("en-IN")} km</b><span>Round trip</span></div>
      </div>
      <p class="fine">${who} · ${p.rooms} room${p.rooms > 1 ? "s" : ""}${veh} · ${o.comfort} comfort · ${o.pace} pace</p>
      ${p.notes.length ? `<div class="notes">${p.notes.map(n => `<p>${n}</p>`).join("")}</div>` : ""}
      <h2>Budget breakdown</h2>
      <div class="bars">${rows.map(([l, v]) => `
        <div class="bar"><span>${l}</span><div class="track"><i style="width:${(v / max) * 100}%"></i></div><span class="amt">${inr.format(v)}</span></div>`).join("")}
      </div>
      <h2>Route</h2>
      <ol class="legs">${p.legs.map(l => `<li><b>${l.from} → ${l.to}</b> · ${l.mode === "cab" ? "Cab" : Planner.MODES[l.mode].label} · ${l.km} km · ~${l.hours} h</li>`).join("")}</ol>
      <h2>Day-by-day plan</h2>
      <ol class="timeline">${p.itinerary.map(d => `
        <li class="${d.travel ? "travel" : ""}"><h4><small>Day ${d.day}</small>${d.title}</h4><ul>${d.items.map(i => `<li>${i}</li>`).join("")}</ul></li>`).join("")}
      </ol>
      <div class="actions"><button class="btn" id="print">Print / save as PDF</button><button class="btn" id="share">Copy link</button></div>
      <p class="fine">Estimates use 2026 average prices: fuel ~₹105/L, tolls, Sleeper/3AC/2AC rail fares, economy/premium fares, room rates by state. Distances are approximate road/rail routes. Always check live fares and seasonal closures before booking.</p>`;
  }

  function planFor(names) {
    only = { state: current, list: names };
    destI = -1; tab = "plan";
    history.replaceState(null, "", "#" + encodeURIComponent(current));
    markPin(-1); render();
    window.scrollTo({ top: 0, behavior: "smooth" });
  }

  function bind() {
    panel.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => select(b.dataset.go)));
    panel.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
    panel.querySelectorAll("[data-dest]").forEach(c => {
      const go = () => openDest(+c.dataset.dest);
      c.addEventListener("click", go);
      c.addEventListener("keydown", e => e.key === "Enter" && go());
      c.addEventListener("mouseenter", () => markPin(+c.dataset.dest));
    });
    panel.querySelector("[data-back]")?.addEventListener("click", () => select(current, false, -1));
    panel.querySelector("[data-planhere]")?.addEventListener("click", () => planFor([STATES[current].dest[destI].n]));
    panel.querySelector("[data-planall]")?.addEventListener("click", () => planFor(STATES[current].dest.map(d => d.n)));
    const form = $("#planForm");
    if (form) form.addEventListener("input", () => {
      const f = new FormData(form);
      prefs.origin = f.get("origin"); prefs.mode = f.get("mode"); prefs.comfort = f.get("comfort"); prefs.pace = f.get("pace");
      prefs.adults = Math.min(20, Math.max(1, +f.get("adults") || 1)); prefs.kids = Math.min(10, Math.max(0, +f.get("kids") || 0));
      only.list = f.getAll("only");
      save();
      $("#result").innerHTML = resultView(current);
      bindResult();
    });
    bindResult();
  }
  function bindResult() {
    $("#print")?.addEventListener("click", () => window.print());
    $("#share")?.addEventListener("click", e => {
      navigator.clipboard?.writeText(location.href).then(() => (e.target.textContent = "Link copied ✓"));
    });
  }
  function setTab(t) { tab = t; render(); }

  const Yatra = (window.Yatra = { select: n => select(n), openDest: i => openDest(i), state: () => current, dest: () => destI, wiki });
  const pick = $("#statePick");
  pick.innerHTML = '<option value="">Jump to a state…</option>' + Object.keys(STATES).sort().map(s => `<option>${s}</option>`).join("");
  pick.addEventListener("change", () => { if (pick.value) select(pick.value); pick.value = ""; });
  fromHash();
})();
