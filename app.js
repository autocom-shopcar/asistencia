// Asistencia · kiosco de checadas con reconocimiento facial para Shop Car.
// Una tablet fija por localidad. El rostro se reconoce EN la tablet (los
// vectores de su personal se descargan y se guardan aquí), con prueba de vida
// (parpadeo o giro de cabeza). Las checadas se guardan primero en la tablet y
// se envían a Shop Car en cuanto hay red (cola con reintento).
import * as faceapi from './lib/face-api.esm.js';

const VERSION = 'asistencia-1';
const CFG = window.SHOPCAR;

// Reconocimiento: distancia euclidiana entre vectores de 128 (menor = más parecido).
const UMBRAL = 0.48;          // por encima no se acepta
const MARGEN = 0.04;          // ventaja mínima sobre la segunda persona más parecida
const UMBRAL_DUPLICADO = 0.42; // al registrar: ya existe alguien así de parecido
const MUESTRAS_REGISTRO = 5;
const RETO_MS = 7000;
const CONFIRMAR_MS = 6000;
const SIN_AUTO_MIN = 20;       // si checó hace menos, no se registra sola la siguiente
const DESCANSO_MS = 90 * 1000; // tras atender a alguien, no volver a preguntarle por 90 s
const descanso = new Map();    // empleado_id → hasta cuándo no se le vuelve a preguntar
const JORNADA_H = 16;          // checadas más viejas ya no cuentan para sugerir el tipo
const REFRESCO_DATOS_MS = 10 * 60 * 1000;
const ENVIO_MS = 20 * 1000;

const TIPOS = {
  ENTRADA: 'Entrada',
  SALIDA_COMIDA: 'Salida a comer',
  REGRESO_COMIDA: 'Regreso de comer',
  SALIDA: 'Salida',
};
const SIGUIENTE = { ENTRADA: 'SALIDA_COMIDA', SALIDA_COMIDA: 'REGRESO_COMIDA', REGRESO_COMIDA: 'SALIDA', SALIDA: 'ENTRADA' };
const RETOS = ['PARPADEO', 'GIRO_IZQUIERDA', 'GIRO_DERECHA'];
const TEXTO_RETO = {
  PARPADEO: 'Parpadea dos veces',
  GIRO_IZQUIERDA: 'Gira la cabeza hacia tu izquierda',
  GIRO_DERECHA: 'Gira la cabeza hacia tu derecha',
};

// Modo de prueba (solo en esta computadora): ?prueba=<imagen> usa una foto en lugar
// de la cámara; &vida=1 da por buena la prueba de vida.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const PARAMS = new URLSearchParams(location.search);
const PRUEBA = LOCAL ? PARAMS.get('prueba') : null;
const PRUEBA_VIDA = LOCAL && PARAMS.get('vida') === '1';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const hora = (d) => new Date(d).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });

// ------------------------------------------------------------------ IndexedDB
const db = await new Promise((ok, mal) => {
  const r = indexedDB.open('asistencia', 1);
  r.onupgradeneeded = () => {
    r.result.createObjectStore('kv');
    r.result.createObjectStore('cola', { keyPath: 'id' });
    r.result.createObjectStore('locales', { keyPath: 'id' });
  };
  r.onsuccess = () => ok(r.result);
  r.onerror = () => mal(r.error);
});
function tx(store, modo, fn) {
  return new Promise((ok, mal) => {
    const t = db.transaction(store, modo);
    const res = fn(t.objectStore(store));
    t.oncomplete = () => ok(res?.result ?? res);
    t.onerror = () => mal(t.error);
  });
}
const kvGet = (k) => tx('kv', 'readonly', (s) => s.get(k));
const kvSet = (k, v) => tx('kv', 'readwrite', (s) => s.put(v, k));
const todos = (store) => tx(store, 'readonly', (s) => s.getAll());

// ------------------------------------------------------------------ Shop Car
async function rpc(nombre, args) {
  const r = await fetch(`${CFG.url}/rest/v1/rpc/${nombre}`, {
    method: 'POST',
    headers: { apikey: CFG.anonKey, Authorization: `Bearer ${CFG.anonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const texto = await r.text();
  const cuerpo = texto ? JSON.parse(texto) : null;
  if (!r.ok) {
    const e = new Error(cuerpo?.message || `Error ${r.status}`);
    e.code = cuerpo?.code;
    throw e;
  }
  return cuerpo;
}
const desvinculada = (e) => e?.code === '28000';

// ------------------------------------------------------------------ estado
let token = localStorage.getItem('asistencia-token');
let datos = null;          // { kiosco, empleados, recientes, descargado_at }
let indice = [];           // [{ emp, descriptores: Float32Array[] }]
let gps = null;            // { latitud, longitud, precision_m, at }
let pinSupervisor = null;  // solo mientras está abierto el modo supervisor
let modo = 'kiosco';       // kiosco | registro | pausa
let enLinea = navigator.onLine;

function pantalla(id) {
  for (const p of document.querySelectorAll('.pantalla')) p.classList.toggle('oculto', p.id !== id);
}

// ------------------------------------------------------------------ vincular

$('form-vincular').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  const msg = $('msg-vincular');
  msg.className = 'msg';
  msg.textContent = 'Vinculando…';
  try {
    const r = await rpc('asistencia_kiosco_vincular', { p_codigo: $('codigo').value, p_version: VERSION });
    token = r.token;
    localStorage.setItem('asistencia-token', token);
    await descargarDatos();
    await abrirKiosco();
  } catch (e) {
    msg.textContent = navigator.onLine ? e.message : 'Sin internet. Conecta la tablet y vuelve a intentar.';
  }
});

async function abrirKiosco() {
  pantalla('pantalla-kiosco');
  datos = (await kvGet('datos')) || null;
  if (datos) prepararIndice();
  pintarEncabezado();
  iniciarGps();
  pedirPantallaEncendida();
  try {
    await descargarDatos();
  } catch (e) {
    if (desvinculada(e)) return mostrarDesvinculada();
    if (!datos) {
      $('cargando').textContent = 'Sin conexión y sin datos guardados. Conecta la tablet a internet.';
      return;
    }
  }
  await cargarModelos();
  await abrirCamara();
  bucle();
  setInterval(() => descargarDatos().catch((e) => desvinculada(e) && mostrarDesvinculada()), REFRESCO_DATOS_MS);
  setInterval(enviarCola, ENVIO_MS);
  addEventListener('online', () => { enLinea = true; pintarRed(); enviarCola(); });
  addEventListener('offline', () => { enLinea = false; pintarRed(); });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && enviarCola());
  enviarCola();
}

function mostrarDesvinculada() {
  $('cargando').classList.remove('oculto');
  $('cargando').innerHTML = 'Esta tablet ya no está vinculada a Shop Car.<br>Pide un código nuevo a tu supervisor.<br><br><button class="btn primario" id="re-vincular">Vincular otra vez</button>';
  $('re-vincular').onclick = () => { localStorage.removeItem('asistencia-token'); location.reload(); };
}

async function descargarDatos() {
  const r = await rpc('asistencia_kiosco_datos', { p_token: token, p_version: VERSION });
  datos = { ...r, descargado_at: new Date().toISOString() };
  await kvSet('datos', datos);
  prepararIndice();
  pintarEncabezado();
  enLinea = true;
  pintarRed();
}

function prepararIndice() {
  indice = datos.empleados
    .filter((e) => Array.isArray(e.descriptores) && e.descriptores.length)
    .map((e) => ({ emp: e, descriptores: e.descriptores.map((d) => Float32Array.from(d)) }));
}

function pintarEncabezado() {
  if (!datos) return;
  $('k-localidad').textContent = datos.kiosco.localidad;
  $('k-tablet').textContent = `${datos.kiosco.nombre} · ${indice.length} de ${datos.empleados.length} con rostro`;
  $('a-tablet').textContent = `${datos.kiosco.localidad} · ${datos.kiosco.nombre}`;
}

// ------------------------------------------------------------------ reloj, red, GPS
function iniciarReloj() {
  const tic = () => {
    const d = new Date();
    $('reloj').textContent = d.toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
    const f = d.toLocaleDateString('es-MX', { weekday: 'long', day: 'numeric', month: 'long' });
    $('fecha').textContent = f.charAt(0).toUpperCase() + f.slice(1);
  };
  tic();
  setInterval(tic, 1000);
}

async function pintarRed() {
  const chip = $('chip-red');
  chip.textContent = enLinea ? 'En línea' : 'Sin red';
  chip.className = `chip ${enLinea ? 'ok' : 'mal'}`;
  const n = (await todos('cola')).length;
  $('chip-cola').classList.toggle('oculto', n === 0);
  $('chip-cola').textContent = `${n} por enviar`;
  $('chip-cola').className = n ? 'chip mal' : 'chip oculto';
}

function iniciarGps() {
  if (!('geolocation' in navigator)) { $('chip-gps').textContent = 'Sin GPS'; return; }
  navigator.geolocation.watchPosition(
    (p) => {
      gps = { latitud: p.coords.latitude, longitud: p.coords.longitude, precision_m: Math.round(p.coords.accuracy), at: Date.now() };
      $('chip-gps').textContent = `GPS ±${gps.precision_m} m`;
      $('chip-gps').className = 'chip ok';
      if (!$('tab-ubicacion').classList.contains('oculto')) pintarUbicacion();
    },
    () => { $('chip-gps').textContent = 'GPS sin permiso'; $('chip-gps').className = 'chip mal'; },
    { enableHighAccuracy: true, maximumAge: 60000, timeout: 30000 },
  );
}

async function pedirPantallaEncendida() {
  try {
    if ('wakeLock' in navigator) {
      await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && navigator.wakeLock.request('screen').catch(() => {}));
    }
  } catch { /* el navegador no lo permite: no pasa nada */ }
}

// ------------------------------------------------------------------ cámara y modelos
const opcionesDet = new faceapi.TinyFaceDetectorOptions({ inputSize: 320, scoreThreshold: 0.5 });
let fuente = $('video');

async function cargarModelos() {
  $('cargando').textContent = 'Cargando reconocimiento facial…';
  await faceapi.tf.ready();
  await Promise.all([
    faceapi.nets.tinyFaceDetector.loadFromUri('modelos'),
    faceapi.nets.faceLandmark68Net.loadFromUri('modelos'),
    faceapi.nets.faceRecognitionNet.loadFromUri('modelos'),
  ]);
}

async function abrirCamara() {
  if (PRUEBA) {
    const img = new Image();
    img.src = PRUEBA;
    await img.decode();
    // &recorte=x,y,ancho,alto para quedarse con un rostro de una foto de grupo.
    const [x, y, w, h] = (PARAMS.get('recorte') || `0,0,${img.naturalWidth},${img.naturalHeight}`).split(',').map(Number);
    const c = $('lienzo-prueba');
    c.width = w;
    c.height = h;
    c.getContext('2d').drawImage(img, x, y, w, h, 0, 0, w, h);
    c.classList.remove('oculto');
    $('video').classList.add('oculto');
    fuente = c;
    $('cargando').classList.add('oculto');
    return;
  }
  try {
    const s = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: 640 }, height: { ideal: 480 } },
      audio: false,
    });
    $('video').srcObject = s;
    await $('video').play();
    $('cargando').classList.add('oculto');
  } catch (e) {
    $('cargando').textContent = 'No se pudo abrir la cámara. Da permiso de cámara a esta app y recarga.';
    throw e;
  }
}

// ------------------------------------------------------------------ geometría del rostro
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
function ear(ojo) {
  return (dist(ojo[1], ojo[5]) + dist(ojo[2], ojo[4])) / (2 * dist(ojo[0], ojo[3]));
}
function medidas(det) {
  const lm = det.landmarks;
  const ojos = [lm.getLeftEye(), lm.getRightEye()];
  const centros = ojos.map((o) => ({ x: o.reduce((s, p) => s + p.x, 0) / o.length, y: o.reduce((s, p) => s + p.y, 0) / o.length }))
    .sort((a, b) => a.x - b.x);
  const nariz = lm.getNose()[3];
  // 0.5 = de frente. En la imagen SIN espejo, girar hacia la izquierda de la
  // persona mueve la nariz hacia la derecha de la imagen (valor mayor).
  const giro = (nariz.x - centros[0].x) / (centros[1].x - centros[0].x);
  return { ear: (ear(ojos[0]) + ear(ojos[1])) / 2, giro, ancho: det.detection.box.width };
}
const anchoFuente = () => (fuente.videoWidth || fuente.width || 640);
const deFrente = (m) => m.giro > 0.38 && m.giro < 0.62 && m.ear > 0.22;
const suficienteCerca = (m) => m.ancho > anchoFuente() * 0.22;

function caraPrincipal(dets) {
  if (!dets.length) return { cara: null };
  const orden = [...dets].sort((a, b) => b.detection.box.width - a.detection.box.width);
  const varias = orden.length > 1 && orden[1].detection.box.width > orden[0].detection.box.width * 0.7;
  return { cara: orden[0], varias };
}

function identificar(descriptor) {
  let mejor = null, segunda = Infinity;
  for (const p of indice) {
    let d = Infinity;
    for (const v of p.descriptores) d = Math.min(d, faceapi.euclideanDistance(descriptor, v));
    if (!mejor || d < mejor.d) {
      if (mejor) segunda = Math.min(segunda, mejor.d);
      mejor = { emp: p.emp, d };
    } else {
      segunda = Math.min(segunda, d);
    }
  }
  if (!mejor || mejor.d > UMBRAL || segunda - mejor.d < MARGEN) return null;
  return mejor;
}

function foto(det) {
  const b = det.detection.box;
  const lado = Math.max(b.width, b.height) * 1.7;
  const x = Math.max(0, b.x + b.width / 2 - lado / 2);
  const y = Math.max(0, b.y + b.height / 2 - lado / 2);
  const c = document.createElement('canvas');
  c.width = c.height = 160;
  c.getContext('2d').drawImage(fuente, x, y, lado, lado, 0, 0, 160, 160);
  return c.toDataURL('image/jpeg', 0.6);
}

// ------------------------------------------------------------------ bucle del kiosco
let estado = { fase: 'espera' };
let fallos = 0;

function instruccion(titulo, detalle = '', guia = '') {
  $('instruccion').textContent = titulo;
  $('detalle').textContent = detalle;
  $('guia').className = `guia ${guia}`;
}
function flecha(reto) {
  const f = $('flecha');
  f.classList.toggle('oculto', !reto || reto === 'PARPADEO');
  // La vista está en espejo: la izquierda de la persona se ve a la izquierda de la pantalla.
  if (reto === 'GIRO_IZQUIERDA') { f.className = 'flecha izq'; f.textContent = '←'; }
  if (reto === 'GIRO_DERECHA') { f.className = 'flecha der'; f.textContent = '→'; }
}

async function bucle() {
  for (;;) {
    if (modo === 'kiosco' && datos) {
      try { await paso(); } catch (e) { console.error(e); }
    }
    await espera(estado.fase === 'espera' ? 250 : 90);
  }
}

async function paso() {
  const dets = await faceapi.detectAllFaces(fuente, opcionesDet).withFaceLandmarks();
  const { cara, varias } = caraPrincipal(dets);

  if (estado.fase === 'espera') {
    flecha(null);
    // Deja leer el último aviso ("No te reconozco", etc.) antes de seguir.
    if (estado.pausaHasta > Date.now()) return;
    if (!indice.length) return instruccion('Sin rostros registrados', 'El supervisor debe registrar al personal (⚙).');
    if (!cara) { estado.frontales = 0; return instruccion('Acércate a la cámara', 'Mira de frente, una persona a la vez.'); }
    if (varias) return instruccion('Una persona a la vez', '', 'cara');
    const m = medidas(cara);
    if (!suficienteCerca(m)) return instruccion('Acércate un poco más', '', 'cara');
    if (!deFrente(m)) { estado.frontales = 0; return instruccion('Mira de frente a la cámara', '', 'cara'); }
    estado.frontales = (estado.frontales || 0) + 1;
    if (estado.frontales < 3) return instruccion('Quédate quieto…', '', 'cara');

    const conDesc = await faceapi.detectSingleFace(fuente, opcionesDet).withFaceLandmarks().withFaceDescriptor();
    if (!conDesc) return;
    const quien = identificar(conDesc.descriptor);
    if (!quien) {
      fallos++;
      estado = { fase: 'espera', pausaHasta: Date.now() + 2500 };
      instruccion('No te reconozco', fallos >= 3 ? 'Avisa a tu supervisor para registrar tu rostro.' : 'Acércate, quítate gorra o lentes oscuros y mira de frente.', 'reto');
      return;
    }
    fallos = 0;
    // Recién atendido (checó o canceló): no volver a preguntarle mientras sigue frente a la tablet.
    if ((descanso.get(quien.emp.id) || 0) > Date.now()) {
      estado = { fase: 'espera', pausaHasta: Date.now() + 4000 };
      return instruccion(`Listo, ${quien.emp.nombre.split(' ')[0]}`, 'Tu checada ya quedó. Puedes retirarte.', 'bien');
    }
    const reto = PRUEBA_VIDA ? 'PARPADEO' : RETOS[Math.floor(Math.random() * RETOS.length)];
    estado = { fase: 'reto', quien, reto, inicio: Date.now(), foto: foto(conDesc), parpadeos: 0, ojosAbiertos: true, cumplido: PRUEBA_VIDA };
    instruccion(TEXTO_RETO[reto], `Prueba de vida · ${estado.quien.emp.nombre.split(' ')[0]}`, 'reto');
    flecha(reto);
    return;
  }

  if (estado.fase === 'reto') {
    if (Date.now() - estado.inicio > RETO_MS) {
      flecha(null);
      estado = { fase: 'espera', pausaHasta: Date.now() + 2500 };
      return instruccion('No se completó la prueba', 'Vuelve a intentarlo.', 'reto');
    }
    if (!cara) return;
    const m = medidas(cara);
    if (!estado.cumplido) {
      if (estado.reto === 'PARPADEO') {
        if (estado.ojosAbiertos && m.ear < 0.2) { estado.ojosAbiertos = false; }
        else if (!estado.ojosAbiertos && m.ear > 0.25) { estado.ojosAbiertos = true; estado.parpadeos++; }
        if (estado.parpadeos >= 2) estado.cumplido = true;
      } else if (estado.reto === 'GIRO_IZQUIERDA' && m.giro > 0.7) {
        estado.cumplido = true;
      } else if (estado.reto === 'GIRO_DERECHA' && m.giro < 0.3) {
        estado.cumplido = true;
      }
      if (estado.cumplido) { flecha(null); instruccion('Ahora mira de frente', '', 'bien'); }
      return;
    }
    // Cumplió: confirmar que sigue siendo la misma persona, ya de frente.
    if (!deFrente(m)) return;
    const conDesc = await faceapi.detectSingleFace(fuente, opcionesDet).withFaceLandmarks().withFaceDescriptor();
    if (!conDesc) return;
    const otra = identificar(conDesc.descriptor);
    if (!otra || otra.emp.id !== estado.quien.emp.id) {
      estado = { fase: 'espera', pausaHasta: Date.now() + 2500 };
      return instruccion('No se pudo confirmar', 'Vuelve a intentarlo, una persona a la vez.', 'reto');
    }
    const quien = { emp: estado.quien.emp, d: Math.max(estado.quien.d, otra.d) };
    const datosChecada = { quien, reto: estado.reto, foto: estado.foto };
    estado = { fase: 'confirmar' };
    instruccion('¡Listo!', '', 'bien');
    await confirmar(datosChecada);
    descanso.set(quien.emp.id, Date.now() + DESCANSO_MS);
    estado = { fase: 'espera', pausaHasta: Date.now() + 2500 };
  }
}

// ------------------------------------------------------------------ confirmación y registro
async function ultimasDe(empleadoId) {
  const desde = Date.now() - JORNADA_H * 3600 * 1000;
  const locales = (await todos('locales')).filter((c) => c.empleado_id === empleadoId);
  const remotas = (datos.recientes || []).filter((c) => c.empleado_id === empleadoId);
  const porId = new Map([...remotas, ...locales].map((c) => [c.id, c]));
  return [...porId.values()]
    .filter((c) => new Date(c.checada_at).getTime() > desde)
    .sort((a, b) => new Date(b.checada_at) - new Date(a.checada_at));
}

function confirmar({ quien, reto, foto: imagen }) {
  return new Promise(async (listo) => {
    const ultimas = await ultimasDe(quien.emp.id);
    const ultima = ultimas[0];
    const sugerido = ultima ? SIGUIENTE[ultima.tipo] : 'ENTRADA';
    $('c-foto').src = imagen;
    $('c-nombre').textContent = quien.emp.nombre;
    $('c-puesto').textContent = [quien.emp.puesto, quien.emp.no_empleado && `No. ${quien.emp.no_empleado}`].filter(Boolean).join(' · ');
    const aviso = $('c-aviso');
    // Checó hace poco: no se registra nada solo; tiene que tocar el tipo.
    const minutos = ultima ? Math.floor((Date.now() - new Date(ultima.checada_at).getTime()) / 60000) : null;
    const reciente = minutos != null && minutos < SIN_AUTO_MIN;
    aviso.classList.toggle('oculto', !ultima);
    aviso.textContent = ultima
      ? `Tu última checada: ${TIPOS[ultima.tipo]} a las ${hora(ultima.checada_at)}.${reciente ? ` Fue hace ${minutos < 1 ? 'menos de un minuto' : `${minutos} min`}: toca el tipo solo si quieres registrar otra.` : ''}`
      : '';

    const cont = $('c-tipos');
    cont.innerHTML = '';
    let terminado = false;
    const fin = async (tipo) => {
      if (terminado) return;
      terminado = true;
      clearTimeout(reloj);
      $('confirmar').classList.add('oculto');
      if (tipo) await registrar({ quien, reto, imagen, tipo });
      listo();
    };
    for (const [tipo, nombre] of Object.entries(TIPOS)) {
      const b = document.createElement('button');
      b.className = `btn${tipo === sugerido ? ' sugerido' : ''}`;
      b.textContent = nombre;
      b.onclick = () => fin(tipo);
      cont.appendChild(b);
    }
    $('c-cancelar').onclick = () => fin(null);

    // Si no toca nada, se registra lo sugerido (salvo que acabe de checar).
    const barra = $('c-barra');
    barra.style.transition = 'none';
    barra.style.transform = 'scaleX(1)';
    requestAnimationFrame(() => {
      barra.style.transition = `transform ${CONFIRMAR_MS}ms linear`;
      barra.style.transform = 'scaleX(0)';
    });
    const reloj = setTimeout(() => fin(reciente ? null : sugerido), CONFIRMAR_MS);
    $('confirmar').classList.remove('oculto');
    sonido(880);
  });
}

async function registrar({ quien, reto, imagen, tipo }) {
  const ahora = new Date();
  const fresco = gps && Date.now() - gps.at < 10 * 60 * 1000 ? gps : null;
  const checada = {
    id: crypto.randomUUID(),
    empleado_id: quien.emp.id,
    tipo,
    checada_at: ahora.toISOString(),
    latitud: fresco?.latitud ?? null,
    longitud: fresco?.longitud ?? null,
    precision_m: fresco?.precision_m ?? null,
    similitud: Number(quien.d.toFixed(3)),
    prueba_vida: reto,
    foto: imagen,
  };
  await tx('cola', 'readwrite', (s) => s.put(checada));
  await tx('locales', 'readwrite', (s) => s.put({ id: checada.id, empleado_id: checada.empleado_id, tipo, checada_at: checada.checada_at, nombre: quien.emp.nombre }));
  await limpiarLocales();
  pintarUltimas();
  pintarRed();

  const nombre = quien.emp.nombre.split(' ')[0];
  const saludo = tipo === 'ENTRADA' ? (ahora.getHours() < 12 ? 'Buenos días' : 'Buenas tardes') : tipo === 'SALIDA' ? 'Hasta luego' : 'Provecho';
  resultado(true, `${TIPOS[tipo]} registrada`, `${quien.emp.nombre} · ${hora(ahora)}`);
  hablar(`${TIPOS[tipo]} registrada. ${saludo}, ${nombre}.`);
  enviarCola();
  await espera(2600);
  $('resultado').classList.add('oculto');
}

function resultado(bien, titulo, texto) {
  $('r-icono').textContent = bien ? '✓' : '!';
  $('r-icono').className = `r-icono${bien ? '' : ' mal'}`;
  $('r-titulo').textContent = titulo;
  $('r-texto').textContent = texto;
  $('resultado').classList.remove('oculto');
  sonido(bien ? 1320 : 330);
}

async function limpiarLocales() {
  const viejas = (await todos('locales')).filter((c) => Date.now() - new Date(c.checada_at).getTime() > 48 * 3600 * 1000);
  if (viejas.length) await tx('locales', 'readwrite', (s) => viejas.forEach((c) => s.delete(c.id)));
}

async function pintarUltimas() {
  const ultimas = (await todos('locales')).sort((a, b) => new Date(b.checada_at) - new Date(a.checada_at)).slice(0, 6);
  $('ultimas').innerHTML = ultimas.map((c) => `<div><span>${esc(c.nombre)}</span><span>${esc(TIPOS[c.tipo])} · ${hora(c.checada_at)}</span></div>`).join('');
}

let audio;
function sonido(freq) {
  try {
    audio ||= new AudioContext();
    const o = audio.createOscillator(), g = audio.createGain();
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.15, audio.currentTime);
    g.gain.exponentialRampToValueAtTime(0.001, audio.currentTime + 0.25);
    o.connect(g).connect(audio.destination);
    o.start();
    o.stop(audio.currentTime + 0.25);
  } catch { /* sin audio */ }
}
function hablar(texto) {
  try {
    const u = new SpeechSynthesisUtterance(texto);
    u.lang = 'es-MX';
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  } catch { /* sin voz */ }
}

// ------------------------------------------------------------------ envío
let enviando = false;
async function enviarCola() {
  if (enviando || !token) return;
  enviando = true;
  try {
    for (;;) {
      const cola = (await todos('cola')).sort((a, b) => a.checada_at.localeCompare(b.checada_at)).slice(0, 50);
      if (!cola.length) break;
      const aceptadas = await rpc('asistencia_kiosco_checar', { p_token: token, p_checadas: cola });
      // Lo que la base no aceptó (p. ej. empleado dado de baja) se descarta para no trabar la cola.
      await tx('cola', 'readwrite', (s) => cola.forEach((c) => s.delete(c.id)));
      if (aceptadas.length < cola.length) console.warn('Checadas no aceptadas:', cola.filter((c) => !aceptadas.includes(c.id)));
      enLinea = true;
    }
  } catch (e) {
    if (desvinculada(e)) mostrarDesvinculada();
    enLinea = navigator.onLine && !(e instanceof TypeError);
  } finally {
    enviando = false;
    pintarRed();
  }
}

// ------------------------------------------------------------------ supervisor
$('btn-admin').onclick = () => {
  $('pin').value = '';
  $('pin-msg').textContent = '';
  $('capa-pin').classList.remove('oculto');
  $('pin').focus();
};
$('pin-cancelar').onclick = () => $('capa-pin').classList.add('oculto');
$('form-pin').addEventListener('submit', async (ev) => {
  ev.preventDefault();
  $('pin-msg').textContent = 'Verificando…';
  try {
    await rpc('asistencia_kiosco_verificar_pin', { p_token: token, p_pin: $('pin').value });
    pinSupervisor = $('pin').value;
    $('capa-pin').classList.add('oculto');
    abrirSupervisor();
  } catch (e) {
    $('pin-msg').textContent = navigator.onLine ? e.message : 'El modo supervisor necesita internet.';
  }
});

function abrirSupervisor() {
  modo = 'pausa';
  pantalla('pantalla-admin');
  pestana('rostros');
  pintarListaEmpleados();
  // Si nadie lo cierra, regresa solo al kiosco.
  clearTimeout(abrirSupervisor.t);
  abrirSupervisor.t = setTimeout(salirSupervisor, 10 * 60 * 1000);
}
function salirSupervisor() {
  clearTimeout(abrirSupervisor.t);
  pinSupervisor = null;
  detenerRegistro();
  pantalla('pantalla-kiosco');
  estado = { fase: 'espera' };
  modo = 'kiosco';
}
$('a-salir').onclick = salirSupervisor;

function pestana(id) {
  for (const b of document.querySelectorAll('.pestanas button')) b.classList.toggle('activa', b.dataset.tab === id);
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('oculto', t.id !== `tab-${id}`);
  if (id === 'ubicacion') pintarUbicacion();
  if (id === 'tablet') pintarTablet();
  if (id !== 'rostros') detenerRegistro();
}
for (const b of document.querySelectorAll('.pestanas button')) b.onclick = () => pestana(b.dataset.tab);

// --- rostros
let empleadoSel = null;
$('buscar').addEventListener('input', pintarListaEmpleados);
function pintarListaEmpleados() {
  const q = $('buscar').value.trim().toLowerCase();
  const lista = datos.empleados.filter((e) => !q || `${e.nombre} ${e.no_empleado ?? ''} ${e.puesto ?? ''}`.toLowerCase().includes(q));
  $('lista-emp').innerHTML = lista.map((e) => `
    <button data-id="${e.id}" class="${empleadoSel?.id === e.id ? 'sel' : ''}">
      <span>${esc(e.nombre)}<small>${esc([e.puesto, e.no_empleado && 'No. ' + e.no_empleado].filter(Boolean).join(' · '))}</small></span>
      <span class="marca ${e.descriptores?.length ? 'si' : 'no'}">${e.descriptores?.length ? 'Registrado' : 'Sin rostro'}</span>
    </button>`).join('') || '<p class="sub" style="padding:12px">Sin resultados.</p>';
  for (const b of $('lista-emp').querySelectorAll('button')) {
    b.onclick = () => elegirEmpleado(datos.empleados.find((e) => e.id === Number(b.dataset.id)));
  }
}

function elegirEmpleado(emp) {
  detenerRegistro();
  empleadoSel = emp;
  pintarListaEmpleados();
  $('registro').innerHTML = `
    <h2>${esc(emp.nombre)}</h2>
    <p class="sub">${emp.descriptores?.length ? 'Ya tiene rostro registrado. Registrarlo otra vez lo reemplaza.' : 'Aún no tiene rostro registrado.'}</p>
    <label class="consent"><input type="checkbox" id="r-consent">
      <span>El empleado firmó el <b>consentimiento para el uso de sus datos biométricos</b> (rostro) para control de asistencia.</span></label>
    <div class="vista oculto" id="r-vista"></div>
    <div class="progreso oculto" id="r-progreso">${'<span></span>'.repeat(MUESTRAS_REGISTRO)}</div>
    <p id="r-msg" class="msg"></p>
    <div class="botones"><button id="r-iniciar" class="btn primario" disabled>Tomar muestras del rostro</button></div>`;
  $('r-consent').onchange = () => { $('r-iniciar').disabled = !$('r-consent').checked; };
  $('r-iniciar').onclick = () => tomarMuestras(emp);
}

let registroActivo = null;
function detenerRegistro() {
  if (registroActivo) registroActivo.cancelado = true;
  registroActivo = null;
  // El video regresa a su lugar en el kiosco.
  const v = $('video');
  if (!v.parentElement.classList.contains('camara')) document.querySelector('.camara').prepend(v);
  modo = pantallaActual() === 'pantalla-admin' ? 'pausa' : 'kiosco';
}
const pantallaActual = () => document.querySelector('.pantalla:not(.oculto)')?.id;

async function tomarMuestras(emp) {
  const ctl = { cancelado: false };
  registroActivo = ctl;
  modo = 'registro';
  const msg = $('r-msg');
  msg.className = 'msg';
  msg.textContent = 'Preparando la cámara… (la primera vez tarda unos segundos)';
  $('r-iniciar').disabled = true;
  $('r-consent').disabled = true;
  if (!PRUEBA) $('r-vista').appendChild($('video'));
  $('r-vista').classList.toggle('oculto', !!PRUEBA);
  $('r-progreso').classList.remove('oculto');
  const barras = $('r-progreso').querySelectorAll('span');
  const muestras = [];
  let ultima = 0;
  const limite = Date.now() + 60000;

  while (muestras.length < MUESTRAS_REGISTRO && !ctl.cancelado && Date.now() < limite) {
    await espera(150);
    const det = await faceapi.detectSingleFace(fuente, opcionesDet).withFaceLandmarks().withFaceDescriptor();
    if (!det) { msg.textContent = 'No veo un rostro. Que mire a la cámara.'; continue; }
    const m = medidas(det);
    if (!suficienteCerca(m)) { msg.textContent = 'Que se acerque un poco más.'; continue; }
    if (!deFrente(m)) { msg.textContent = 'Que mire de frente, con los ojos abiertos.'; continue; }
    if (Date.now() - ultima < 500) continue;
    ultima = Date.now();
    muestras.push(det.descriptor);
    barras[muestras.length - 1].classList.add('lleno');
    msg.textContent = muestras.length < MUESTRAS_REGISTRO ? 'Bien. Que mueva un poco la cabeza, sin dejar de mirar a la cámara.' : 'Revisando…';
    if (PRUEBA) await espera(300);
  }
  if (ctl.cancelado) return;
  if (muestras.length < MUESTRAS_REGISTRO) {
    msg.textContent = 'No se completaron las muestras. Mejora la luz y vuelve a intentar.';
    $('r-iniciar').disabled = false;
    $('r-consent').disabled = false;
    return detenerRegistro();
  }
  detenerRegistro();

  // ¿Ya existe otra persona con este rostro?
  for (const p of indice) {
    if (p.emp.id === emp.id) continue;
    const d = Math.min(...muestras.flatMap((m) => p.descriptores.map((v) => faceapi.euclideanDistance(m, v))));
    if (d < UMBRAL_DUPLICADO) {
      msg.textContent = `Este rostro se parece mucho al de ${p.emp.nombre}, que ya está registrado. Revisa que sea la persona correcta.`;
      $('r-iniciar').disabled = false;
      $('r-consent').disabled = false;
      return;
    }
  }

  try {
    await rpc('asistencia_kiosco_registrar_rostro', {
      p_token: token,
      p_pin: pinSupervisor,
      p_empleado_id: emp.id,
      p_descriptores: muestras.map((m) => Array.from(m, (x) => Number(x.toFixed(5)))),
      p_consentimiento: true,
    });
    await descargarDatos();
    msg.className = 'msg ok';
    msg.textContent = `Rostro de ${emp.nombre} registrado. Ya puede checar.`;
    empleadoSel = datos.empleados.find((e) => e.id === emp.id);
    pintarListaEmpleados();
  } catch (e) {
    msg.textContent = e.message;
    $('r-iniciar').disabled = false;
    $('r-consent').disabled = false;
  }
}

// --- ubicación
function pintarUbicacion() {
  const k = datos.kiosco;
  $('u-guardada').textContent = k.latitud != null ? `${k.latitud.toFixed(6)}, ${k.longitud.toFixed(6)} · radio ${k.radio_m} m` : 'Sin ubicación guardada';
  $('u-radio').value = k.radio_m ?? 300;
  if (gps) {
    const lejos = k.latitud != null ? distanciaM(gps, k) : null;
    $('u-actual').textContent = `${gps.latitud.toFixed(6)}, ${gps.longitud.toFixed(6)} · ±${gps.precision_m} m${lejos != null ? ` · a ${Math.round(lejos)} m de la guardada` : ''}`;
  } else {
    $('u-actual').textContent = 'Esperando GPS…';
  }
}
function distanciaM(a, b) {
  const r = (x) => (x * Math.PI) / 180;
  const h = Math.sin(r(b.latitud - a.latitud) / 2) ** 2 + Math.cos(r(a.latitud)) * Math.cos(r(b.latitud)) * Math.sin(r(b.longitud - a.longitud) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}
$('u-fijar').onclick = async () => {
  const msg = $('u-msg');
  msg.className = 'msg';
  if (!gps) { msg.textContent = 'Aún no hay posición GPS.'; return; }
  if (gps.precision_m > 100) { msg.textContent = `La precisión del GPS es baja (±${gps.precision_m} m). Acerca la tablet a una ventana y espera.`; return; }
  try {
    await rpc('asistencia_kiosco_fijar_ubicacion', {
      p_token: token, p_pin: pinSupervisor, p_latitud: gps.latitud, p_longitud: gps.longitud, p_radio_m: Number($('u-radio').value) || 300,
    });
    await descargarDatos();
    pintarUbicacion();
    msg.className = 'msg ok';
    msg.textContent = 'Ubicación de la localidad guardada.';
  } catch (e) {
    msg.textContent = e.message;
  }
};

// --- tablet
async function pintarTablet() {
  $('t-localidad').textContent = `${datos.kiosco.localidad} · ${datos.kiosco.nombre}`;
  $('t-personal').textContent = `${datos.empleados.length} activos · ${indice.length} con rostro`;
  $('t-datos').textContent = new Date(datos.descargado_at).toLocaleString('es-MX');
  $('t-cola').textContent = String((await todos('cola')).length);
  $('t-version').textContent = VERSION;
}
$('t-actualizar').onclick = async () => {
  const msg = $('t-msg');
  msg.className = 'msg';
  try {
    await descargarDatos();
    await enviarCola();
    await pintarTablet();
    msg.className = 'msg ok';
    msg.textContent = 'Datos actualizados.';
  } catch (e) {
    msg.textContent = e.message;
  }
};
$('t-completa').onclick = () => document.documentElement.requestFullscreen?.().catch(() => {});
$('t-desvincular').onclick = async () => {
  const pendientes = (await todos('cola')).length;
  const aviso = pendientes ? `\n\nOJO: hay ${pendientes} checadas sin enviar y se perderán.` : '';
  if (!confirm(`¿Desvincular esta tablet de Shop Car? Para volver a usarla se necesitará un código nuevo.${aviso}`)) return;
  localStorage.removeItem('asistencia-token');
  await tx('kv', 'readwrite', (s) => s.clear());
  await tx('cola', 'readwrite', (s) => s.clear());
  await tx('locales', 'readwrite', (s) => s.clear());
  location.reload();
};

if ('serviceWorker' in navigator && !LOCAL) navigator.serviceWorker.register('sw.js');

// ------------------------------------------------------------------ arranque
// Al final: así todo lo de arriba ya está declarado.
iniciarReloj();
pintarUltimas();
if (!token) {
  pantalla('pantalla-vincular');
} else {
  abrirKiosco();
}
