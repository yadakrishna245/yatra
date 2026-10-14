// Trip planner: route, days and budget estimate. Pure functions, no DOM.
// All prices are 2026 India averages in INR; tiers are [budget, standard, luxury].
(() => {
  const MODES = {
    car:    { label: "Car",    speed: 55,  perKm: 9,   unit: "vehicle", cap: 5 },  // fuel ~₹7/km + tolls ~₹2/km
    bike:   { label: "Bike",   speed: 45,  perKm: 3,   unit: "vehicle", cap: 2 },
    bus:    { label: "Bus",    speed: 45,  perKm: [1.3, 2, 3],    unit: "person", overhead: 1, longFrom: 120 },
    train:  { label: "Train",  speed: 55,  perKm: [0.55, 1.4, 2.4], unit: "person", overhead: 2, longFrom: 150 }, // Sleeper / 3AC / 2AC
    flight: { label: "Flight", speed: 600, perKm: [4, 5.5, 9],    unit: "person", overhead: 3.5, longFrom: 400, min: [3500, 4500, 9000] },
  };
  const STAY = [1600, 3800, 10000];   // per room per night
  const FOOD = [600, 1100, 2400];     // per adult per day
  const SIGHTS = [250, 500, 1100];    // entry tickets, activities per adult per day
  const CAB_DAY = [2200, 3000, 4800]; // local sightseeing cab per vehicle per day (train/bus/flight)
  const CAB_KM = [13, 16, 24];        // intercity cab per vehicle per km
  const PACE = { relaxed: 1.4, balanced: 1, packed: 0.7 };
  const ROAD = 1.2, RAIL = 1.15, HILL_ROAD = 1.45; // straight-line -> real route distance

  const R = 6371, rad = x => x * Math.PI / 180;
  function haversine([a1, o1], [a2, o2]) {
    const s = Math.sin(rad(a2 - a1) / 2) ** 2 + Math.cos(rad(a1)) * Math.cos(rad(a2)) * Math.sin(rad(o2 - o1) / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(s));
  }

  // Shortest round trip from origin, exact search. ponytail: 8 stops = 40k orders (instant); switch to 2-opt beyond ~9.
  function order(origin, dests) {
    let best = dests, bestKm = Infinity;
    const go = (path, left, km, at) => {
      if (km >= bestKm) return;
      if (!left.length) { km += haversine(at, origin); if (km < bestKm) bestKm = km, best = path; return; }
      left.forEach((d, i) => go([...path, d], left.filter((_, j) => j !== i), km + haversine(at, d.ll), d.ll));
    };
    go([], dests, 0, origin);
    return best;
  }

  // How a leg is travelled: the chosen mode for long hops, a cab for short local hops.
  function legMode(mode, km, island, crossesSea) {
    if (crossesSea) return "flight";
    if (mode === "car" || mode === "bike") return island ? "cab" : mode;
    return km >= MODES[mode].longFrom ? mode : "cab";
  }

  function legHours(m, km) {
    if (m === "cab") return km / 45;
    return km / MODES[m].speed + (MODES[m].overhead || 0);
  }

  // Full days lost to a leg (short legs fold into a sightseeing day).
  function travelDays(m, h) {
    if (m === "flight") return h > 6 ? 1 : 0;
    if (m === "train" || m === "bus") return h <= 7 ? 0 : Math.ceil(h / 20); // overnight trains/buses
    return h <= 6 ? 0 : Math.ceil(h / 10); // road: up to ~10 h driving a day
  }

  function planTrip(state, o) {
    const tier = { budget: 0, standard: 1, luxury: 2 }[o.comfort] ?? 1;
    const adults = Math.max(1, o.adults | 0), kids = Math.max(0, o.kids | 0), people = adults + kids;
    const mode = MODES[o.mode] ? o.mode : "car";
    const notes = [];
    const chosen = state.dest.filter(d => !o.only || o.only.includes(d.n));
    if (!chosen.length) return null;

    const route = order(o.originLL, chosen);
    const stops = [{ n: o.origin, ll: o.originLL }, ...route, { n: o.origin, ll: o.originLL }];
    const vehicles = mode === "car" || mode === "bike" ? Math.ceil(people / MODES[mode].cap) : 0;
    const cabs = Math.ceil(people / 4);

    let km = 0, travel = 0, local = 0, extraDays = 0;
    const legs = [];
    for (let i = 0; i < stops.length - 1; i++) {
      const a = stops[i], b = stops[i + 1];
      const crow = haversine(a.ll, b.ll);
      const crossesSea = state.island && (i === 0 || i === stops.length - 2);
      const m = legMode(mode, crow * ROAD, state.island, crossesSea);
      const dist = Math.round(crow * (m === "flight" ? 1 : m === "train" ? RAIL : state.hills ? HILL_ROAD : ROAD));
      const hours = legHours(m, dist), days = travelDays(m, hours);
      let cost;
      if (m === "car" || m === "bike") cost = dist * MODES[m].perKm * vehicles;
      else if (m === "cab") cost = Math.max(dist * CAB_KM[tier], 800) * cabs;
      else {
        const per = Math.max(dist * MODES[m].perKm[tier], (MODES[m].min || [0, 0, 0])[tier]);
        cost = per * (adults + kids * 0.75);
      }
      (m === "cab" ? (local += cost) : (travel += cost));
      km += dist; extraDays += days;
      legs.push({ from: a.n, to: b.n, km: dist, hours: Math.round(hours * 10) / 10, mode: m, days });
    }
    if (state.island && mode !== "flight") notes.push(`${state.name || "This region"} has no road or rail link — flights are used to reach it.`);

    const destDays = route.map(d => Math.max(1, Math.round(d.d * (PACE[o.pace] || 1))));
    const sightDays = destDays.reduce((a, b) => a + b, 0);
    const days = sightDays + extraDays;
    const nights = Math.max(0, days - 1);
    const rooms = Math.max(1, Math.ceil(adults / 2) + (kids > 2 ? 1 : 0));
    const c = state.cost || 1;

    if (mode !== "car" && mode !== "bike") local += CAB_DAY[tier] * sightDays * cabs;
    const stay = STAY[tier] * c * rooms * nights;
    const food = FOOD[tier] * c * (adults + kids * 0.6) * days;
    const sights = SIGHTS[tier] * (adults + kids * 0.5) * sightDays;
    const sub = travel + local + stay + food + sights;
    const buffer = sub * 0.1;
    const r = x => Math.round(x / 100) * 100;
    const cost = { travel: r(travel), local: r(local), stay: r(stay), food: r(food), sights: r(sights), buffer: r(buffer) };
    cost.total = Object.values(cost).reduce((a, b) => a + b, 0);

    if (!state.island && !legs.some(l => l.mode === mode)) notes.push(`Distances are short, so a hired cab is used instead of ${label(mode).toLowerCase()} for every leg.`);
    if (mode === "bike" && kids) notes.push("Long bike rides aren't safe for children — consider a car or train.");
    if (mode === "bike" && km > 2500) notes.push("That's a long ride — plan a rest day every 3–4 riding days.");
    if (mode === "car" && legs.some(l => l.hours > 10)) notes.push("Some legs exceed 10 h of driving — the plan splits them with overnight stops.");

    // Day-by-day itinerary
    const itinerary = [];
    let day = 1;
    const pushTravel = leg => {
      for (let k = 0; k < leg.days; k++)
        itinerary.push({ day: day++, title: `${leg.from} → ${leg.to}`, travel: true,
          items: [`${label(leg.mode)} · ${leg.km} km · ~${leg.hours} h total`, k < leg.days - 1 ? "Overnight halt en route" : `Arrive ${leg.to}, check in & rest`] });
    };
    route.forEach((d, i) => {
      const leg = legs[i];
      pushTravel(leg);
      const hl = d.h.split(", ");
      const n = destDays[i], per = Math.ceil(hl.length / n);
      for (let k = 0; k < n; k++) {
        const items = hl.slice(k * per, (k + 1) * per);
        if (k === 0 && !leg.days) items.unshift(`${label(leg.mode)} from ${leg.from} (${leg.km} km, ~${leg.hours} h)`);
        if (!items.length) items.push("Leisure day — local markets, cafés and food");
        itinerary.push({ day: day++, title: d.n, items });
      }
    });
    const back = legs[legs.length - 1];
    if (back.days) pushTravel(back);
    else itinerary[itinerary.length - 1].items.push(`Return: ${label(back.mode)} to ${back.to} (${back.km} km, ~${back.hours} h)`);

    return { days, nights, km, rooms, vehicles, legs, cost, perPerson: Math.round(cost.total / people), itinerary, notes };
  }

  const label = m => (MODES[m] ? MODES[m].label : "Cab");
  globalThis.Planner = { planTrip, haversine, MODES };
})();
