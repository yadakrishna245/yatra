// 3D relief map: extruded states → click flies in and splits the state into districts.
// Progressive enhancement over the SVG map in app.js (kept for no-WebGL / reduced-motion).
import * as THREE from "three";
import { SVGLoader } from "three/addons/loaders/SVGLoader.js";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { RoomEnvironment } from "three/addons/environments/RoomEnvironment.js";

const { Yatra: Y, INDIA_MAP: M, INDIA_DISTRICTS: DIST, STATES, gsap } = window;
const webgl = (() => { try { const c = document.createElement("canvas"); return !!(c.getContext("webgl2") || c.getContext("webgl")); } catch { return false; } })();
if (Y && gsap && webgl && !matchMedia("(prefers-reduced-motion: reduce)").matches) init();

function init() {
  const wrap = document.querySelector(".map-wrap"), panel = document.getElementById("panel");
  const CX = M.w / 2, CY = M.h / 2, H = 13; // map centre, state slab height (map units)
  const GOLD = new THREE.Color("#d9b26a"), INK = new THREE.Color("#26355c"), DIM = new THREE.Color("#0b1020");

  // ---------- Renderer, scene, camera ----------
  const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, powerPreference: "high-performance" });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = THREE.PCFSoftShadowMap;
  renderer.domElement.className = "gl";
  renderer.domElement.setAttribute("aria-hidden", "true");
  wrap.prepend(renderer.domElement);
  const labels = new CSS2DRenderer();
  labels.domElement.className = "gl-labels";
  wrap.appendChild(labels.domElement);
  document.body.classList.add("is-3d");

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
  const camera = new THREE.PerspectiveCamera(32, 1, 1, 6000);
  camera.position.set(0, 2600, 1900);
  const controls = new OrbitControls(camera, renderer.domElement);
  Object.assign(controls, { enableDamping: true, dampingFactor: 0.08, minDistance: 8, maxDistance: 2600,
    minPolarAngle: 0.12, maxPolarAngle: 1.15, minAzimuthAngle: -0.7, maxAzimuthAngle: 0.7, zoomSpeed: 0.8 });

  scene.add(new THREE.HemisphereLight(0xaab8ff, 0x0a0e16, 0.7));
  const key = new THREE.DirectionalLight(0xffe2b0, 2.2);
  key.position.set(-420, 700, 380);
  key.castShadow = true;
  key.shadow.mapSize.set(2048, 2048);
  Object.assign(key.shadow.camera, { left: -560, right: 560, top: 560, bottom: -560, near: 100, far: 2000 });
  key.shadow.bias = -0.0005;
  scene.add(key);
  const rim = new THREE.DirectionalLight(0x6f8cff, 0.8);
  rim.position.set(500, 300, -600);
  scene.add(rim);
  const ground = new THREE.Mesh(new THREE.PlaneGeometry(6000, 6000), new THREE.ShadowMaterial({ opacity: 0.5 }));
  ground.rotation.x = -Math.PI / 2; ground.position.y = -0.2; ground.receiveShadow = true;
  scene.add(ground);

  const map = new THREE.Group(); // built in map space: x east, y north, z up
  map.rotation.x = -Math.PI / 2;
  scene.add(map);

  // ---------- Geometry helpers ----------
  const loader = new SVGLoader();
  const flip = d => d.replace(/(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/g, (_, x, y) => `${(+x - CX).toFixed(1)},${(CY - +y).toFixed(1)}`);
  const shapesOf = d => SVGLoader.createShapes(loader.parse(`<svg xmlns="http://www.w3.org/2000/svg"><path d="${flip(d)}"/></svg>`).paths[0]);
  const local = ([lat, lng]) => {
    const r = Math.PI / 180, { scale: k, translate: [tx, ty] } = M.proj;
    return [lng * r * k + tx - CX, CY - (ty - Math.log(Math.tan(Math.PI / 4 + lat * r / 2)) * k)];
  };
  const inside = ([x, y], pts) => {
    let c = false;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++)
      if ((pts[i].y > y) !== (pts[j].y > y) && x < ((pts[j].x - pts[i].x) * (y - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x) c = !c;
    return c;
  };
  function slab(shapes, depth, material, lineColor, shrink = 1) {
    const geo = new THREE.ExtrudeGeometry(shapes, { depth, bevelEnabled: false, curveSegments: 1 });
    geo.computeBoundingBox();
    const c = geo.boundingBox.getCenter(new THREE.Vector3());
    const tight = g => g.translate(-c.x, -c.y, 0).scale(shrink, shrink, 1).translate(c.x, c.y, 0);
    if (shrink !== 1) tight(geo);
    const mesh = new THREE.Mesh(geo, material);
    mesh.castShadow = mesh.receiveShadow = true;
    const lineMat = new THREE.LineBasicMaterial({ color: lineColor, transparent: true, opacity: 0.9 });
    for (const s of shapes) for (const ring of [s, ...s.holes]) {
      const lg = new THREE.BufferGeometry().setFromPoints(ring.getPoints());
      if (shrink !== 1) tight(lg);
      const line = new THREE.LineLoop(lg, lineMat);
      line.position.z = depth + 0.05;
      mesh.add(line);
    }
    return mesh;
  }

  // ---------- States ----------
  const states = {};
  for (const [name, { d }] of Object.entries(M.states)) {
    const mesh = slab(shapesOf(d), H, new THREE.MeshStandardMaterial({ color: INK, metalness: 0.35, roughness: 0.55 }), GOLD);
    mesh.userData = { kind: "state", name };
    states[name] = mesh;
    map.add(mesh);
  }
  const stateMeshes = Object.values(states);
  const indiaBox = new THREE.Box3().setFromObject(map);

  // ---------- Camera framing (keeps the subject clear of the side panel / bottom sheet) ----------
  const mobile = () => innerWidth <= 960;
  let viewW = 1, viewH = 1, fullH = 1;
  function resize() {
    const w = innerWidth, h = innerHeight;
    renderer.setSize(w, h); labels.setSize(w, h);
    camera.aspect = w / h;
    const pw = mobile() ? 0 : panel.offsetWidth;
    const sheet = mobile() ? h * 0.5 : 0; // bottom sheet starts at 50vh
    camera.setViewOffset(w, h, pw / 2, sheet / 2, w, h);
    camera.updateProjectionMatrix();
    viewW = w - pw; viewH = h - sheet; fullH = h;
  }
  addEventListener("resize", resize);
  resize();

  const DIR = new THREE.Vector3(0, 1, 0.8).normalize(); // ~39° tilt for a state
  const DIR_HOME = new THREE.Vector3(-0.28, 1, 1.25).normalize(); // steeper, slightly turned: reads as a sculpture
  function frame(box, pad = 1.15, dir = DIR) {
    const size = box.getSize(new THREE.Vector3()), centre = box.getCenter(new THREE.Vector3());
    const t = Math.tan(THREE.MathUtils.degToRad(camera.fov / 2));
    // world height the full canvas must show so the box fits the unobstructed part of the screen
    const need = Math.max(size.z * fullH / viewH, size.x * fullH / viewW);
    const dist = Math.max((need / 2 / t) * pad, 30);
    return { target: centre, pos: centre.clone().addScaledVector(dir, dist) };
  }
  function fly({ target, pos }, duration = 1.6) {
    gsap.to(controls.target, { x: target.x, y: target.y, z: target.z, duration, ease: "power3.inOut", overwrite: true });
    gsap.to(camera.position, { x: pos.x, y: pos.y, z: pos.z, duration, ease: "power3.inOut", overwrite: true });
  }

  // ---------- Districts + pins for the selected state ----------
  let selected = null, districtGroup = null, districtMeshes = [], pins = [], stateK = 1;
  function clearState() {
    if (!districtGroup) return;
    map.remove(districtGroup);
    districtGroup.traverse(o => { o.geometry?.dispose(); o.material?.dispose?.(); });
    pins.forEach(p => p.label.element.remove());
    districtGroup = null; districtMeshes = []; pins = [];
  }
  function buildState(name) {
    clearState();
    const box = new THREE.Box3().setFromObject(states[name]);
    const span = Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
    stateK = THREE.MathUtils.clamp(span / 140, 0.06, 1.4);
    const depth = Math.max(1.2, 14 * stateK);
    districtGroup = new THREE.Group();
    (DIST[name] || []).forEach(([dn, d], i) => {
      const shapes = shapesOf(d);
      const h = (i * 0.618) % 1;
      const mat = new THREE.MeshStandardMaterial({ color: new THREE.Color().setHSL(0.105 + h * 0.03, 0.5 + h * 0.15, 0.4 + h * 0.16), metalness: 0.6, roughness: 0.36 });
      const mesh = slab(shapes, depth, mat, 0x0a0e16, 0.985);
      mesh.userData = { kind: "district", name: dn, state: name, base: mat.color.clone(), rings: shapes.map(s => s.getPoints()) };
      mesh.scale.z = 0.001;
      districtGroup.add(mesh);
      districtMeshes.push(mesh);
    });
    STATES[name].dest.forEach((dst, i) => {
      const [x, y] = local(dst.ll);
      const pin = new THREE.Group();
      const beamH = 18 * stateK + depth;
      const mat = new THREE.MeshStandardMaterial({ color: GOLD, emissive: GOLD, emissiveIntensity: 0.9, metalness: 0.3, roughness: 0.3 });
      const beam = new THREE.Mesh(new THREE.CylinderGeometry(0.35 * stateK, 0.35 * stateK, beamH, 8), mat);
      beam.rotation.x = Math.PI / 2; beam.position.z = beamH / 2;
      const head = new THREE.Mesh(new THREE.SphereGeometry(1.6 * stateK, 16, 12), mat);
      head.position.z = beamH;
      pin.add(beam, head);
      pin.position.set(x, y, 0);
      const el = document.createElement("button");
      el.className = "pin3d"; el.textContent = dst.n; el.type = "button";
      el.addEventListener("click", () => Y.openDest(i));
      const label = new CSS2DObject(el);
      label.position.set(0, 0, beamH + 2 * stateK);
      pin.add(label);
      pin.scale.setScalar(0.001);
      districtGroup.add(pin);
      pins.push({ pin, label, i, dest: dst, xy: [x, y] });
      for (const m of districtMeshes) if (m.userData.rings.some(r => inside([x, y], r))) (m.userData.dests ||= []).push(i);
    });
    map.add(districtGroup);
    gsap.to(districtMeshes.map(m => m.scale), { z: 1, duration: 0.9, ease: "power3.out", stagger: { each: 0.012, from: "center" }, delay: 0.35 });
    gsap.to(pins.map(p => p.pin.scale), { x: 1, y: 1, z: 1, duration: 0.6, ease: "back.out(2)", stagger: 0.05, delay: 0.9 });
    return box;
  }

  Y.onState = name => {
    if (name === selected) return;
    selected = name;
    setHover(null); unpin();
    for (const [n, m] of Object.entries(states)) {
      const on = !name || n === name;
      m.visible = n !== name;
      gsap.to(m.material.color, { ...(on ? INK : DIM), duration: 0.8 });
      gsap.to(m.scale, { z: name ? 0.45 : 1, duration: 0.8, ease: "power2.out" });
    }
    if (!name) { clearState(); fly(frame(indiaBox, 1.0, DIR_HOME)); return; }
    fly(frame(buildState(name), 1.3));
  };
  Y.onDest = i => {
    pins.forEach(p => p.label.element.classList.toggle("hot", p.i === i));
    if (!selected) return;
    const p = pins.find(p => p.i === i);
    if (p) {
      const target = p.pin.getWorldPosition(new THREE.Vector3());
      fly({ target, pos: target.clone().addScaledVector(DIR, Math.max(130 * stateK, 30)) }, 1.3);
    } else if (districtGroup) fly(frame(new THREE.Box3().setFromObject(districtGroup)), 1.3);
  };

  // ---------- Hover card (Wikipedia-backed) ----------
  const card = document.getElementById("hovercard");
  const q = s => card.querySelector(s);
  let hovered = null, pinned = false, wikiTimer;
  function showCard(obj, x, y) {
    const u = obj.userData, s = STATES[u.state || u.name];
    const key = u.kind + ":" + u.name;
    if (card.dataset.key !== key) {
      card.dataset.key = key;
      q(".hc-eyebrow").textContent = u.kind === "state" ? (s.type === "UT" ? "Union Territory" : "State") : `District · ${u.state}`;
      q(".hc-title").textContent = u.name;
      const chips = q(".hc-chips"); chips.textContent = "";
      if (u.kind === "state") {
        const ds = DIST[u.name] || [];
        q(".hc-meta").textContent = `Capital ${s.capital} · ${ds.length} districts · ${s.dest.length} destinations · Best ${s.best}`;
        ds.slice(0, 10).forEach(([n]) => chips.append(Object.assign(document.createElement("span"), { textContent: n })));
        if (ds.length > 10) chips.append(Object.assign(document.createElement("span"), { textContent: `+${ds.length - 10} more` }));
        q(".hc-hint").textContent = selected === u.name ? "" : "Click to explore";
      } else {
        const here = (u.dests || []).map(i => s.dest[i]);
        q(".hc-meta").textContent = here.length ? "Destinations in this district" : "No featured destination here yet";
        here.forEach(dst => {
          const b = Object.assign(document.createElement("button"), { type: "button", textContent: dst.n + " →" });
          b.addEventListener("click", () => { unpin(); Y.openDest(s.dest.indexOf(dst)); });
          chips.append(b);
        });
        q(".hc-hint").textContent = pinned ? "" : "Click to pin this card";
      }
      q(".hc-text").textContent = "Loading from Wikipedia…";
      q(".hc-img").hidden = true; q(".hc-more").hidden = true;
      clearTimeout(wikiTimer);
      wikiTimer = setTimeout(async () => {
        const w = u.kind === "state" ? await Y.wiki(u.name, `${u.name} India`) : await Y.wiki(`${u.name} district`, `${u.name} district ${u.state}`);
        if (card.dataset.key !== key) return;
        q(".hc-text").textContent = w ? w.text : "No Wikipedia summary found.";
        if (w?.img) { q(".hc-img").src = w.img; q(".hc-img").alt = w.title; q(".hc-img").hidden = false; }
        if (w?.url) { q(".hc-more").href = w.url; q(".hc-more").hidden = false; }
      }, 180);
    }
    card.hidden = false;
    if (!pinned) place(x, y);
  }
  function place(x, y) {
    const r = card.getBoundingClientRect();
    card.style.left = Math.min(x + 22, innerWidth - r.width - 12) + "px";
    card.style.top = Math.max(80, Math.min(y + 22, innerHeight - r.height - 12)) + "px";
  }
  const unpin = () => { pinned = false; card.classList.remove("pinned"); card.hidden = true; card.dataset.key = ""; };

  function setHover(obj) {
    if (obj === hovered) return;
    if (hovered) lift(hovered, false);
    hovered = obj;
    if (obj) lift(obj, true);
    renderer.domElement.style.cursor = obj ? "pointer" : "";
    if (!obj && !pinned) card.hidden = true;
  }
  function lift(m, on) {
    const district = m.userData.kind === "district";
    gsap.to(m.position, { z: on ? (district ? 3 * stateK : 6) : 0, duration: 0.35, ease: "power2.out", overwrite: true });
    gsap.to(m.material, { emissiveIntensity: on ? (district ? 0.18 : 0.35) : 0, duration: 0.35, overwrite: true });
    m.material.emissive = district ? m.userData.base : GOLD;
  }

  // ---------- Pointer: hover = raycast, click = tap without drag ----------
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let pointer = null, down = null;
  const pick = () => {
    ray.setFromCamera(ndc, camera);
    const hit = ray.intersectObjects([...districtMeshes, ...stateMeshes.filter(m => m.visible)], false)[0];
    return hit?.object || null;
  };
  const toNdc = e => ndc.set((e.clientX / innerWidth) * 2 - 1, -(e.clientY / innerHeight) * 2 + 1);
  const el = renderer.domElement;
  el.addEventListener("pointermove", e => { if (e.pointerType === "mouse") pointer = e; });
  el.addEventListener("pointerleave", () => { pointer = null; setHover(null); });
  el.addEventListener("pointerdown", e => (down = { x: e.clientX, y: e.clientY, t: performance.now() }));
  el.addEventListener("pointerup", e => {
    if (!down || Math.hypot(e.clientX - down.x, e.clientY - down.y) > 6 || performance.now() - down.t > 500) return (down = null);
    down = null;
    toNdc(e);
    const obj = pick();
    if (!obj) return unpin();
    const u = obj.userData;
    if (u.kind === "state" && u.name !== selected) return Y.select(u.name);
    pinned = false; setHover(obj); showCard(obj, e.clientX, e.clientY);
    if (u.kind === "district") { pinned = true; card.classList.add("pinned"); q(".hc-hint").textContent = ""; }
  });

  // ---------- Loop (paused when the tab is hidden) ----------
  function loop() {
    controls.update();
    if (pointer) {
      toNdc(pointer);
      const obj = pick();
      setHover(obj);
      if (obj && !pinned) showCard(obj, pointer.clientX, pointer.clientY);
      pointer = null;
    }
    renderer.render(scene, camera);
    labels.render(scene, camera);
  }
  renderer.setAnimationLoop(loop);
  document.addEventListener("visibilitychange", () => renderer.setAnimationLoop(document.hidden ? null : loop));

  // WebGL context lost → hand back to the SVG map.
  el.addEventListener("webglcontextlost", e => {
    e.preventDefault();
    renderer.setAnimationLoop(null);
    document.body.classList.remove("is-3d");
    el.remove(); labels.domElement.remove(); card.hidden = true;
    Y.onState = Y.onDest = null;
  });

  // ---------- Intro: slabs rise from the centre, camera settles ----------
  const start = Y.state();
  if (start) { Y.onState(start); Y.onDest(Y.dest()); return; } // deep link: skip the intro
  stateMeshes.forEach(m => (m.scale.z = 0.001));
  const order = stateMeshes.map(m => [m, new THREE.Box3().setFromObject(m).getCenter(new THREE.Vector3()).length()]).sort((a, b) => a[1] - b[1]);
  gsap.to(order.map(([m]) => m.scale), { z: 1, duration: 1.1, ease: "power3.out", stagger: 0.03, delay: 0.2 });
  fly(frame(indiaBox, 1.0, DIR_HOME), 2.4);
}
