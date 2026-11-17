// KROPKA — holograficzny torus (three.js, z kropka.html Kacpra) sterowany stanem sesji.
//   listening   → spokojny oddech, cyjan; poziom mikrofonu lekko powiększa
//   thinking    → szybsze fale, kierunek „prądu” przełącza się
//   speaking    → tętni od RMS odtwarzanego głosu (usta)
//   working     → bursztyn, wolny obrót (komputer pracuje)
//   waiting_user→ róż, pulsuje (czeka na Ciebie)
// Shader 1:1 z oryginału + uniformy: level (0..1), hue (przesunięcie koloru), speed.
import * as THREE from '/vendor/three.module.js';

const VERT = `
varying vec2 vUv;
varying vec3 vPosition;
void main() {
  vUv = uv;
  vPosition = position;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = `
uniform float time;
uniform float direction;
uniform float level;
uniform float hue;
varying vec2 vUv;
varying vec3 vPosition;

float wave(vec3 p, float t) {
  return sin(p.x * 4.0 + t) + sin(p.y * 4.0 - t) + sin(p.z * 4.0 + t * 0.5);
}
vec3 hueShift(vec3 c, float h) {
  const vec3 k = vec3(0.57735);
  float ca = cos(h), sa = sin(h);
  return c * ca + cross(k, c) * sa + k * dot(k, c) * (1.0 - ca);
}
void main() {
  float w = wave(vPosition, time * direction);
  float intensity = sin(w * (2.0 + level * 3.0));           // interferencja — głos zagęszcza
  float stripes = sin((vUv.y + time * 0.2) * 40.0);          // holograficzne linie
  float finalPattern = intensity * 0.7 + stripes * 0.3;
  vec3 color = vec3(
    0.2 + 0.8 * sin(finalPattern + time),
    0.5 + 0.5 * sin(finalPattern + 2.0),
    1.0
  );
  color = hueShift(color, hue);
  color += level * 0.35;                                     // rozjaśnienie od głosu
  gl_FragColor = vec4(color, 1.0);
}`;

const STATES = {
  // QUAK: niebieski słucha, zielony mówi, żółty pracuje, czerwony czeka (hue = obrót koloru shadera, bazowo niebieski)
  idle:         { hue: 0.35, speed: 0.6, scale: 0.92, breathe: 0.02 },
  listening:    { hue: 0.35, speed: 1.0, scale: 1.0,  breathe: 0.035 },
  thinking:     { hue: 0.6,  speed: 2.4, scale: 1.0,  breathe: 0.05 },
  speaking:     { hue: -1.2, speed: 1.3, scale: 1.05, breathe: 0.0 },
  working:      { hue: -2.3, speed: 0.8, scale: 1.0,  breathe: 0.03, spin: 0.35 },
  waiting_user: { hue: -3.0, speed: 0.08, scale: 1.0, breathe: 0.0 }, // pyta: zatrzymuje się i patrzy
};

export function createKropka(canvas, { getLevel }) {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true });
  renderer.setClearColor(0x000000, 0); // tło daje CSS (motyw), kropka wisi w aplikacji, nie na czarnej planszy
  renderer.setPixelRatio(Math.min(2, devicePixelRatio || 1));
  const scene = new THREE.Scene();
  const camera = new THREE.PerspectiveCamera(75, 1, 0.1, 1000);
  camera.position.z = 3;
  const geometry = new THREE.TorusGeometry(0.4, 0.4, 128, 128);
  const material = new THREE.ShaderMaterial({
    uniforms: { time: { value: 0 }, direction: { value: 1 }, level: { value: 0 }, hue: { value: 0 } },
    vertexShader: VERT, fragmentShader: FRAG,
  });
  const torus = new THREE.Mesh(geometry, material);
  scene.add(torus);

  let state = 'idle', target = STATES.idle, cur = { hue: 0, speed: 0.6, scale: 0.92 };
  let smoothLevel = 0, t = 0, last = performance.now(), flipT = 0, running = false, raf = 0;
  let gesture = 0;        // chwilowa korekta skali (mrugnięcie −, impuls +, wciągnięcie −)
  let thinkSince = 0;     // „myślę” — flipy zwalniają z czasem

  let offsetY = 0; // panel (szeroki, niski): donut wyżej, napisy pod nim; pełny ekran: na środku
  function resize() {
    const w = canvas.clientWidth || 1, h = canvas.clientHeight || 1;
    if (canvas.width !== Math.floor(w * renderer.getPixelRatio()) || canvas.height !== Math.floor(h * renderer.getPixelRatio())) {
      renderer.setSize(w, h, false);
      const aspect = w / h;
      camera.aspect = aspect;
      // wąski ekran (telefon): odsuń kamerę, żeby donut nie zajmował całej szerokości
      // telefon: odsuń kamerę, żeby donut nie zajmował całej szerokości; niska, szeroka karta (dok): przybliż
      camera.position.z = aspect < 1 ? (3 / aspect) * 0.72 : aspect > 2.2 ? 2.1 : 3;
      camera.updateProjectionMatrix();
      offsetY = 0;
      torus.position.y = offsetY;
    }
  }
  function frame(now) {
    if (!running) return;
    raf = requestAnimationFrame(frame);
    const dt = Math.min(0.05, (now - last) / 1000); last = now;
    resize();
    // poziom: głos asystenta (speaking) albo mikrofon (listening)
    const lv = Math.max(0, Math.min(1, getLevel(state)));
    smoothLevel += (lv - smoothLevel) * (lv > smoothLevel ? 0.5 : 0.12);
    cur.hue += (target.hue - cur.hue) * 0.06;
    cur.speed += (target.speed - cur.speed) * 0.06;
    const breathe = 1 + Math.sin(now * 0.0021) * target.breathe;
    gesture *= 0.86;
    const sc = target.scale * breathe + smoothLevel * 0.28 + gesture;
    cur.scale += (sc - cur.scale) * 0.25;
    torus.scale.setScalar(cur.scale);
    t += dt * cur.speed;
    material.uniforms.time.value = t;
    material.uniforms.level.value = smoothLevel;
    material.uniforms.hue.value = cur.hue;
    if (state === 'thinking') {
      const age = (now - thinkSince) / 1000;
      const period = 500 + Math.min(2500, age * 350); // żywo na początku, spokojniej gdy trwa
      if (now - flipT > period) { material.uniforms.direction.value *= -1; flipT = now; }
    }
    torus.rotation.y += dt * (target.spin || 0);
    torus.rotation.x += dt * (target.spin ? target.spin * 0.4 : 0);
    renderer.render(scene, camera);
  }
  canvas.addEventListener('click', () => { material.uniforms.direction.value *= -1; });
  return {
    setState(s) { const n = STATES[s] ? s : 'idle'; if (n === 'thinking' && state !== 'thinking') thinkSince = performance.now(); state = n; target = STATES[state]; },
    /** usłyszałem — krótkie mrugnięcie */
    blink() { gesture = -0.07; },
    /** komputer kliknął — impuls */
    pulse() { gesture = 0.09; },
    /** przerwanie — wciągnięcie */
    shrink() { gesture = -0.22; },
    start() { if (running) return; running = true; last = performance.now(); raf = requestAnimationFrame(frame); },
    stop() { running = false; cancelAnimationFrame(raf); },
    get state() { return state; },
  };
}
