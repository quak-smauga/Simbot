// LOGO — Q z czterech łuków QUAK, które po intro zlewają się w jedno koło z oczami (bot mieszka w kole).
// Kolor końcowy = currentColor → mono (ciemny w light, jasny w dark). CSS: app.css, blok „qlogo”.
//   makeLogo({size, intro}) → .qlogo  ·  logoSVG(color, bg) → statyczny SVG (favicon)  ·  blinkLogos() — jeden timer.
const R=40, CX=50, CY=50, SW=17;
const pt = a => { const t=(a-90)*Math.PI/180; return [ (CX+R*Math.cos(t)).toFixed(2), (CY+R*Math.sin(t)).toFixed(2) ]; };
const arc = (from,to) => { const [x1,y1]=pt(from),[x2,y2]=pt(to); return `M${x1} ${y1} A${R} ${R} 0 0 1 ${x2} ${y2}`; };
const ARCS = [-45,45,135,225].map(a=>arc(a,a+90));           // 4 pełne łuki (bez szczelin w geometrii)
const GAPS = [-45,45,135,225].map(a=>arc(a-2.2,a+2.2));       // szczeliny = krótkie kreski w kolorze tła na stykach
const TAIL = 'M60 60 L92 92';
const EYES = [40,60];                                          // x oczu, y=50

function eye(x){ return `<g class="eye" transform="translate(${x} 50)"><circle class="pupil" r="5.2"/><circle r="1.6" cx="-1.8" cy="-1.8" fill="var(--bg,#fff)" opacity=".9"/><rect class="lid" x="-6" y="-6" width="12" height="12" fill="var(--bg,#fff)"/></g>`; }
function logoMarkup(){
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    ${ARCS.map(d=>`<path class="arc" d="${d}"/>`).join('')}
    ${GAPS.map(d=>`<path class="gap" d="${d}" fill="none"/>`).join('')}
    <path class="tail" d="${TAIL}"/>
    ${EYES.map(eye).join('')}
  </svg>`;
}
function makeLogo({size=160,intro=true}={}){
  const el=document.createElement('div'); el.className='qlogo'+(intro?' intro':''); el.style.setProperty('--s',size+'px'); el.innerHTML=logoMarkup(); return el;
}
/* statyczny SVG stanu końcowego — kolory na sztywno (favicon, druk) */
function logoSVG(color='#1b1b1a', bg='none'){
  return `<svg viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg"><circle cx="50" cy="50" r="${R}" fill="none" stroke="${color}" stroke-width="${SW}"/>${EYES.map(x=>`<circle cx="${x}" cy="50" r="5.2" fill="${color}"/>`).join('')}${bg!=='none'?EYES.map(x=>`<circle cx="${x-1.8}" cy="48.2" r="1.6" fill="${bg}" opacity=".9"/>`).join(''):''}</svg>`;
}
function _startBlinking(){
  (function loop(){
    if(Math.random()<.5) document.querySelectorAll('.qlogo').forEach(l=>{ l.classList.add('blink'); setTimeout(()=>l.classList.remove('blink'),120); });
    setTimeout(loop,1400+Math.random()*2200);
  })();
}

export function blinkLogos() {
  if (blinkLogos.on) return; blinkLogos.on = true;
  (function loop() {
    if (Math.random() < .5) document.querySelectorAll('.qlogo').forEach(l => { l.classList.add('blink'); setTimeout(() => l.classList.remove('blink'), 120); });
    setTimeout(loop, 1400 + Math.random() * 2200);
  })();
}
export { makeLogo, logoSVG, logoMarkup };
