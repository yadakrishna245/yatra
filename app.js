(() => {
  const { STATES, ORIGINS, INDIA_MAP: M, Planner } = window;
  const $ = s => document.querySelector(s);
  const svg = $("#map"), panel = $("#panel"), tip = $("#tip"), reset = $("#reset");
  const NS = "http://www.w3.org/2000/svg";
  const inr = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR", maximumFractionDigits: 0 });
  const prefs = (() => { try { return JSON.parse(localStorage.getItem("yatra") || "{}"); } catch { return {}; } })();
  const save = () => { try { localStorage.setItem("yatra", JSON.stringify(prefs)); } catch {} };
  let current = null, tab = "overview", zoomScale = 1;

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
      const [x, y] = project(d.ll);
      const x0 = Math.min(b.x, x), y0 = Math.min(b.y, y);
      b.width = Math.max(b.x + b.width, x) - x0; b.height = Math.max(b.y + b.height, y) - y0; b.x = x0; b.y = y0;
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
      const t = el("text", { x: x + 9 / s, y: y + 4 / s, "font-size": 12 / s, "stroke-width": 3 / s }, g);
      t.textContent = d.n;
      g.addEventListener("click", e => { e.stopPropagation(); highlight(i, true); });
    });
  }

  function highlight(i, scroll) {
    document.querySelectorAll(".pin").forEach(p => p.classList.toggle("hot", +p.dataset.i === i));
    document.querySelectorAll(".card.dest").forEach(c => c.classList.toggle("hot", +c.dataset.i === i));
    if (scroll) {
      if (tab !== "overview") setTab("overview");
      document.querySelector(`.card.dest[data-i="${i}"]`)?.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }

  // ---------- Selection & routing ----------
  function select(name, fromHash) {
    if (name && !STATES[name]) return;
    current = name;
    for (const n in paths) paths[n].classList.toggle("on", n === name);
    svg.classList.toggle("dim", !!name);
    reset.hidden = !name;
    if (name) tab = "overview";
    zoomTo(name);
    drawPins(name);
    render();
    if (!fromHash) history.replaceState(null, "", name ? "#" + encodeURIComponent(name) : location.pathname);
    if (name && !fromHash && matchMedia("(max-width: 960px)").matches) panel.scrollIntoView({ behavior: "smooth" });
  }
  reset.addEventListener("click", () => select(null));
  window.addEventListener("hashchange", () => select(decodeURIComponent(location.hash.slice(1)) || null, true));
  
  // Search: states and destinations
  const places = {};
  for (const [s, v] of Object.entries(STATES)) { places[s] = s; for (const d of v.dest) places[`${d.n} — ${s}`] = s; }
  $("#places").innerHTML = Object.keys(places).sort().map(p => `<option value="${p}">`).join("");
  $("#search").addEventListener("change", e => {
    const key = Object.keys(places).find(k => k.toLowerCase() === e.target.value.trim().toLowerCase())
      || Object.keys(places).find(k => k.toLowerCase().includes(e.target.value.trim().toLowerCase()));
    if (!key) return;
    select(places[key]);
    const destName = key.split(" — ")[0], i = STATES[places[key]].dest.findIndex(d => d.n === destName);
    if (i >= 0) highlight(i, true);
    e.target.value = "";
  });

  // ---------- Panel ----------
  function render() { panel.innerHTML = current ? stateView(current) : homeView(); bind(); }

  function homeView() {
    const n = Object.values(STATES), dests = n.reduce((a, s) => a + s.dest.length, 0);
    const picks = ["Rajasthan", "Kerala", "Himachal Pradesh", "Goa", "Ladakh", "Meghalaya", "Tamil Nadu", "Uttarakhand"];
    return `
      <p class="eyebrow">Your personal India guide</p>
      <h1>Discover India,<br>one state at a time.</h1>
      <p class="lede">Tap any state on the map to explore its best places, signature food and stays — then get a day-by-day plan with an honest budget for your car, bike, bus, train or flight.</p>
      <div class="stats">
        <div class="stat"><b>${n.length}</b><span>States & UTs</span></div>
        <div class="stat"><b>${dests}</b><span>Destinations</span></div>
        <div class="stat"><b>5</b><span>Ways to travel</span></div>
      </div>
      <h2>Popular right now</h2>
      <div class="chips">${picks.map(p => `<button class="chip" data-go="${p}">${p}</button>`).join("")}</div>
      <h2>How it works</h2>
      <ol class="steps">
        <li><span>Pick a state on the map, or search for a place.</span></li>
        <li><span>Browse destinations, local food and where to stay.</span></li>
        <li><span>Open <b>Plan trip</b>: choose your city, travellers and how you'll travel.</span></li>
        <li><span>Get total days, a full budget breakdown and a day-by-day itinerary — print it or save it as a PDF.</span></li>
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
      <h2>Must-try food</h2>
      <div class="food">${s.foods.map(([f, d]) => `<div class="card"><b>${f}</b><p>${d}</p></div>`).join("")}</div>`;
    if (tab === "stay") {
      const [b, m, l] = [1600, 3800, 10000].map(x => Math.round(x * s.cost / 100) * 100);
      const band = x => `${inr.format(Math.round(x * 0.75 / 100) * 100)} – ${inr.format(Math.round(x * 1.35 / 100) * 100)}`;
      return `
        <h2>Where to stay</h2>
        <p class="muted">${s.stay}.</p>
        <div class="tiers">
          <div class="card"><span class="tag">Budget</span><b>${band(b)}</b><p>Guest houses, homestays, hostels</p></div>
          <div class="card"><span class="tag">Standard</span><b>${band(m)}</b><p>3★ hotels, boutique stays</p></div>
          <div class="card"><span class="tag">Luxury</span><b>${band(l)}</b><p>4–5★, heritage & resorts</p></div>
        </div>
        <p class="fine">Typical price per room per night in season (2026). Peak holidays can be 30–60% higher.</p>`;
    }
    if (tab === "plan") return planView(name);
    return `
      <div class="grid">${s.dest.map((d, i) => `
        <article class="card dest" data-i="${i}" tabindex="0">
          <div class="card-head"><h3>${d.n}</h3><span class="tag">${d.t}</span></div>
          <p>${d.h}.</p>
          <p class="days" style="margin-top:8px">Recommended: ${d.d} day${d.d > 1 ? "s" : ""}</p>
        </article>`).join("")}
      </div>
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

  function bind() {
    panel.querySelectorAll("[data-go]").forEach(b => b.addEventListener("click", () => select(b.dataset.go)));
    panel.querySelectorAll(".tab").forEach(b => b.addEventListener("click", () => setTab(b.dataset.tab)));
    panel.querySelectorAll(".card.dest").forEach(c => {
      const go = () => highlight(+c.dataset.i);
      c.addEventListener("click", go);
      c.addEventListener("keydown", e => e.key === "Enter" && go());
    });
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

  select(decodeURIComponent(location.hash.slice(1)) || null, true);
})();
