// Asistencia · kiosco de checadas con reconocimiento facial para Shop Car.
// Una tablet fija por localidad, con prueba de vida (parpadeo o giro de cabeza).
//
// Versión 2 (migración 237 de Shop Car): quien IDENTIFICA es el servidor, no la
// tablet. La tablet solo calcula el vector de la cara que tiene enfrente y lo
// manda; ya no descarga ni guarda los rostros del personal. El único vector que
// llega a tocar el dispositivo es el de cada checada mientras espera en la cola
// para enviarse (se borra en cuanto el servidor la acepta, y con el borrado por
// desvinculación o por 72 h sin contacto).
//  * Con señal: asistencia_kiosco_identificar dice quién es → prueba de vida →
//    confirmar tipo. Al enviar, el servidor vuelve a identificar con el vector.
//  * Sin señal: prueba de vida → tipo con botones (sin sugerencia) → se guarda
//    con su vector y se confirma al volver la señal (si no se reconoce, en Shop
//    Car queda como "sin reconocer").
import * as faceapi from './lib/face-api.esm.js';

const VERSION = 'asistencia-2';
const CFG = window.SHOPCAR;

// Misma persona antes y después de la prueba de vida (comparación local entre
// las dos caras de esta misma checada, no contra un catálogo).
const MISMA_PERSONA = 0.48;
const MUESTRAS_REGISTRO = 5;
const RETO_MS = 7000;
const CONFIRMAR_MS = 6000;
const CONFIRMAR_SIN_SENAL_MS = 15000; // sin señal no hay sugerencia: más tiempo para elegir
const SIN_AUTO_MIN = 20;       // si checó hace menos, no se registra sola la siguiente
const DESCANSO_MS = 90 * 1000; // tras atender a alguien, no volver a preguntarle por 90 s
const descanso = new Map();    // empleado_id → hasta cuándo no se le vuelve a preguntar
let descansoSinSenal = [];     // [{ descriptor, hasta }] solo en memoria, para el mismo caso sin señal
const JORNADA_H = 16;          // checadas más viejas ya no cuentan para sugerir el tipo
const REFRESCO_DATOS_MS = 10 * 60 * 1000;
const ENVIO_MS = 20 * 1000;
// Autodestrucción: si pasan 72 h sin hablar con el servidor (tablet perdida o
// robada), se borra todo lo local, aunque se pierdan checadas sin enviar.
const SIN_CONTACTO_MAX_MS = 72 * 3600 * 1000;
const CLAVE_TOKEN = 'asistencia-token';
const CLAVE_CONTACTO = 'asistencia-ultimo-contacto';

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
// de la cámara; &vida=1 da por buena la prueba de vida; &sinsenal=1 simula que no hay red.
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const PARAMS = new URLSearchParams(location.search);
const PRUEBA = LOCAL ? PARAMS.get('prueba') : null;
const PRUEBA_VIDA = LOCAL && PARAMS.get('vida') === '1';
const PRUEBA_SIN_SENAL = LOCAL && PARAMS.get('sinsenal') === '1';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const espera = (ms) => new Promise((r) => setTimeout(r, ms));
const hora = (d) => new Date(d).toLocaleTimeString('es-MX', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
// Vector a JSON: 128 números con 5 decimales (lo que esperan las funciones del servidor).
const vector = (d) => Array.from(d, (x) => Number(x.toFixed(5)));

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

// ------------------------------------------------------------------ borrado local
// Borra TODO lo de esta app en la tablet: token, IndexedDB "asistencia" y las
// cachés de su service worker. Se usa si Shop Car desvinculó la tablet (code
// 28000) o si pasaron 72 h sin contacto.
// OJO: en autocom-shopcar.github.io todas las apps comparten el mismo origen
// (localStorage y cachés), así que solo se borra lo que empieza con
// "asistencia"; nunca localStorage.clear() ni todas las cachés (sería borrar
// también lo de Bandera 5.13 u otras apps).
const esDeAsistencia = (clave) => clave.startsWith('asistencia');
function borrarLocalStorage(conservar = []) {
  for (let i = localStorage.length - 1; i >= 0; i--) {
    const k = localStorage.key(i);
    if (esDeAsistencia(k) && !conservar.includes(k)) localStorage.removeItem(k);
  }
}
let borrada = false;
async function borrarTodo(motivo) {
  if (borrada) return;
  borrada = true;
  modo = 'pausa';
  try { borrarLocalStorage(); } catch { /* sin almacenamiento */ }
  try {
    await Promise.all(['kv', 'cola', 'locales'].map((s) => tx(s, 'readwrite', (o) => o.clear())));
  } catch { /* la base ya no está */ }
  try {
    if ('caches' in window) await Promise.all((await caches.keys()).filter(esDeAsistencia).map((k) => caches.delete(k)));
  } catch { /* sin cachés */ }
  try { $('video').srcObject?.getTracks().forEach((t) => t.stop()); } catch { /* sin cámara */ }
  pantalla('pantalla-kiosco');
  for (const id of ['confirmar', 'resultado', 'capa-pin']) $(id).classList.add('oculto');
  $('cargando').classList.remove('oculto');
  $('cargando').innerHTML = `${motivo}<br>Se borraron los datos de esta tablet.<br><br><button class="btn primario" id="re-vincular">Vincular otra vez</button>`;
  $('re-vincular').onclick = () => location.reload();
}
const MSG_DESVINCULADA = 'Esta tablet fue desvinculada desde Shop Car.';
const MSG_SIN_CONTACTO = 'Esta tablet pasó más de 72 horas sin conectarse a Shop Car.';

function revisarSinContacto() {
  const ultimo = Number(localStorage.getItem(CLAVE_CONTACTO) || 0);
  if (token && ultimo && Date.now() - ultimo > SIN_CONTACTO_MAX_MS) {
    borrarTodo(MSG_SIN_CONTACTO);
    return true;
  }
  return false;
}

// ------------------------------------------------------------------ Shop Car
async function rpc(nombre, args) {
  if (PRUEBA_SIN_SENAL && nombre !== 'asistencia_kiosco_vincular') throw new TypeError('Sin señal (prueba)');
  const r = await fetch(`${CFG.url}/rest/v1/rpc/${nombre}`, {
    method: 'POST',
    headers: { apikey: CFG.anonKey, Authorization: `Bearer ${CFG.anonKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args),
  });
  const texto = await r.text();
  const cuerpo = texto ? JSON.parse(texto) : null;
  if (!r.ok) {
    // Incluye el PIN incorrecto (401) y la tablet bloqueada por intentos (423):
    // el servidor regresa { code, message } y aquí se trata como error.
    const e = new Error(cuerpo?.message || `Error ${r.status}`);
    e.code = cuerpo?.code;
    // Tablet desvinculada en Shop Car: borrar todo (no aplica al vincular, que
    // usa el mismo código para "código no válido").
    if (e.code === '28000' && 'p_token' in args) borrarTodo(MSG_DESVINCULADA);
    throw e;
  }
  // Contacto exitoso con el servidor: reinicia la cuenta de 72 h.
  if ('p_token' in args || nombre === 'asistencia_kiosco_vincular') localStorage.setItem(CLAVE_CONTACTO, String(Date.now()));
  return cuerpo;
}
const sinSenal = (e) => e instanceof TypeError; // fetch falló: no hay red

// ------------------------------------------------------------------ estado
let token = localStorage.getItem(CLAVE_TOKEN);
let datos = null;          // { kiosco, empleados (con tiene_rostro), recientes, descargado_at }
let gps = null;            // { latitud, longitud, precision_m, at }
let pinSupervisor = null;  // solo mientras está abierto el modo supervisor
let modo = 'kiosco';       // kiosco | registro | pausa
let enLinea = navigator.onLine && !PRUEBA_SIN_SENAL;

function pantalla(id) {
  for (const p of document.querySelectorAll('.pantalla')) p.classList.toggle('oculto', p.id !== id);
}
const conRostro = () => (datos?.empleados || []).filter((e) => e.tiene_rostro).length;

// Al arrancar la versión 2: la versión 1 guardaba los vectores de todo el
// personal (datos.empleados[].descriptores) y vectores sueltos en la cola. Se
// borran aquí; los de la cola v1 no sirven (no traen "descriptor") y el
// servidor ya no los aceptaría.
async function limpiarVectoresViejos() {
  const viejos = await kvGet('datos');
  if (viejos?.empleados?.some((e) => 'descriptores' in e)) await tx('kv', 'readwrite', (s) => s.delete('datos'));
  const colaV1 = (await todos('cola')).filter((c) => !Array.isArray(c.descriptor));
  if (colaV1.length) await tx('cola', 'readwrite', (s) => colaV1.forEach((c) => s.delete(c.id)));
  // Cualquier otra clave de Asistencia en localStorage (solo las nuestras).
  borrarLocalStorage([CLAVE_TOKEN, CLAVE_CONTACTO]);
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
    localStorage.setItem(CLAVE_TOKEN, token);
    await descargarDatos();
    await abrirKiosco();
  } catch (e) {
    msg.textContent = navigator.onLine ? e.message : 'Sin internet. Conecta la tablet y vuelve a intentar.';
  }
});

async function abrirKiosco() {
  pantalla('pantalla-kiosco');
  datos = (await kvGet('datos')) || null;
  pintarEncabezado();
  iniciarGps();
  pedirPantallaEncendida();
  try {
    await descargarDatos();
  } catch (e) {
    if (borrada) return;
    if (!datos) {
      $('cargando').textContent = 'Sin conexión y sin datos guardados. Conecta la tablet a internet.';
      return;
    }
    // Arrancó sin señal: que el indicador lo diga desde el principio.
    if (sinSenal(e)) enLinea = false;
  }
  pintarRed();
  await cargarModelos();
  await abrirCamara();
  bucle();
  setInterval(() => descargarDatos().catch(() => {}), REFRESCO_DATOS_MS);
  setInterval(enviarCola, ENVIO_MS);
  setInterval(revisarSinContacto, 10 * 60 * 1000);
  addEventListener('online', () => { enLinea = true; pintarRed(); enviarCola(); });
  addEventListener('offline', () => { enLinea = false; pintarRed(); });
  document.addEventListener('visibilitychange', () => document.visibilityState === 'visible' && enviarCola());
  enviarCola();
}

async function descargarDatos() {
  const r = await rpc('asistencia_kiosco_datos', { p_token: token, p_version: VERSION });
  datos = { ...r, descargado_at: new Date().toISOString() };
  await kvSet('datos', datos);
  pintarEncabezado();
  enLinea = true;
  pintarRed();
}

function pintarEncabezado() {
  if (!datos) return;
  $('k-localidad').textContent = datos.kiosco.localidad;
  $('k-tablet').textContent = `${datos.kiosco.nombre} · ${conRostro()} de ${datos.empleados.length} con rostro`;
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
  if (borrada) return;
  const chip = $('chip-red');
  chip.textContent = enLinea ? 'En línea' : 'Sin red';
  chip.className = `chip ${enLinea ? 'ok' : 'mal'}`;
  const n = (await todos('cola')).length;
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

// ¿Quién es? Lo decide el servidor. Regresa { quien } si lo reconoció,
// { noReconocido: true } si no, o { sinSenal: true } si no hay red.
async function identificar(descriptor) {
  try {
    const r = await rpc('asistencia_kiosco_identificar', { p_token: token, p_descriptor: vector(descriptor) });
    enLinea = true;
    if (!r?.reconocido) return { noReconocido: true };
    return { quien: { emp: r.empleado, d: r.distancia } };
  } catch (e) {
    if (sinSenal(e)) {
      enLinea = false;
      pintarRed();
      return { sinSenal: true };
    }
    throw e;
  }
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
    if (borrada) return;
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
    if (!conRostro()) return instruccion('Sin rostros registrados', 'El supervisor debe registrar al personal (⚙).');
    if (!cara) { estado.frontales = 0; return instruccion('Acércate a la cámara', 'Mira de frente, una persona a la vez.'); }
    if (varias) return instruccion('Una persona a la vez', '', 'cara');
    const m = medidas(cara);
    if (!suficienteCerca(m)) return instruccion('Acércate un poco más', '', 'cara');
    if (!deFrente(m)) { estado.frontales = 0; return instruccion('Mira de frente a la cámara', '', 'cara'); }
    estado.frontales = (estado.frontales || 0) + 1;
    if (estado.frontales < 3) return instruccion('Quédate quieto…', '', 'cara');

    const conDesc = await faceapi.detectSingleFace(fuente, opcionesDet).withFaceLandmarks().withFaceDescriptor();
    if (!conDesc) return;
    instruccion('Un momento…', '', 'cara');
    const id = await identificar(conDesc.descriptor);
    if (id.noReconocido) {
      fallos++;
      estado = { fase: 'espera', pausaHasta: Date.now() + 2500 };
      instruccion('No te reconozco', fallos >= 3 ? 'Avisa a tu supervisor para registrar tu rostro.' : 'Acércate, quítate gorra o lentes oscuros y mira de frente.', 'reto');
      return;
    }
    fallos = 0;
    const quien = id.quien ?? null; // null = sin señal: se identificará al enviar
    // Recién atendido (checó o canceló): no volver a preguntarle mientras sigue frente a la tablet.
    const ahora = Date.now();
    descansoSinSenal = descansoSinSenal.filter((x) => x.hasta > ahora);
    const enDescanso = quien
      ? (descanso.get(quien.emp.id) || 0) > ahora
      : descansoSinSenal.some((x) => faceapi.euclideanDistance(x.descriptor, conDesc.descriptor) <= MISMA_PERSONA);
    if (enDescanso) {
      estado = { fase: 'espera', pausaHasta: ahora + 4000 };
      return instruccion(quien ? `Listo, ${quien.emp.nombre.split(' ')[0]}` : 'Listo', 'Tu checada ya quedó. Puedes retirarte.', 'bien');
    }
    const reto = PRUEBA_VIDA ? 'PARPADEO' : RETOS[Math.floor(Math.random() * RETOS.length)];
    estado = {
      fase: 'reto', quien, reto, inicio: ahora, foto: foto(conDesc), antes: conDesc.descriptor,
      parpadeos: 0, ojosAbiertos: true, cumplido: PRUEBA_VIDA,
    };
    instruccion(TEXTO_RETO[reto], quien ? `Prueba de vida · ${quien.emp.nombre.split(' ')[0]}` : 'Prueba de vida · sin señal', 'reto');
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
    // Cumplió: ya de frente, confirmar LOCALMENTE que es la misma cara de antes
    // de la prueba (sin otra llamada al servidor). Este vector, el de después
    // de la prueba de vida, es el que se manda con la checada.
    if (!deFrente(m)) return;
    const conDesc = await faceapi.detectSingleFace(fuente, opcionesDet).withFaceLandmarks().withFaceDescriptor();
    if (!conDesc) return;
    if (faceapi.euclideanDistance(estado.antes, conDesc.descriptor) > MISMA_PERSONA) {
      estado = { fase: 'espera', pausaHasta: Date.now() + 2500 };
      return instruccion('No se pudo confirmar', 'Vuelve a intentarlo, una persona a la vez.', 'reto');
    }
    const datosChecada = { quien: estado.quien, reto: estado.reto, foto: estado.foto, descriptor: conDesc.descriptor };
    estado = { fase: 'confirmar' };
    instruccion('¡Listo!', '', 'bien');
    await confirmar(datosChecada);
    if (datosChecada.quien) descanso.set(datosChecada.quien.emp.id, Date.now() + DESCANSO_MS);
    else descansoSinSenal.push({ descriptor: datosChecada.descriptor, hasta: Date.now() + DESCANSO_MS });
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

function confirmar({ quien, reto, foto: imagen, descriptor }) {
  return new Promise(async (listo) => {
    // Sin señal no sabemos quién es: no hay nombre ni sugerencia, y nunca se
    // registra solo (si no toca nada, se cancela).
    const ultima = quien ? (await ultimasDe(quien.emp.id))[0] : null;
    const sugerido = !quien ? null : ultima ? SIGUIENTE[ultima.tipo] : 'ENTRADA';
    $('c-foto').src = imagen;
    $('c-nombre').textContent = quien ? quien.emp.nombre : 'Sin señal';
    $('c-puesto').textContent = quien
      ? [quien.emp.puesto, quien.emp.no_empleado && `No. ${quien.emp.no_empleado}`].filter(Boolean).join(' · ')
      : 'Elige el tipo de checada. Tu nombre se confirmará al tener señal.';
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
      if (tipo) await registrar({ quien, reto, imagen, tipo, descriptor });
      listo();
    };
    for (const [tipo, nombre] of Object.entries(TIPOS)) {
      const b = document.createElement('button');
      b.className = `btn${tipo === sugerido ? ' sugerido' : ''}`;
      b.textContent = nombre;
      b.onclick = () => fin(tipo);
      cont.appendChild(b);
    }
    $('c-cancelar').textContent = quien ? 'No soy yo · Cancelar' : 'Cancelar';
    $('c-cancelar').onclick = () => fin(null);

    // Si no toca nada: con señal se registra lo sugerido (salvo que acabe de
    // checar); sin señal, se cancela.
    const ms = quien ? CONFIRMAR_MS : CONFIRMAR_SIN_SENAL_MS;
    const barra = $('c-barra');
    barra.style.transition = 'none';
    barra.style.transform = 'scaleX(1)';
    requestAnimationFrame(() => {
      barra.style.transition = `transform ${ms}ms linear`;
      barra.style.transform = 'scaleX(0)';
    });
    const reloj = setTimeout(() => fin(quien && !reciente ? sugerido : null), ms);
    $('confirmar').classList.remove('oculto');
    sonido(880);
  });
}

async function registrar({ quien, reto, imagen, tipo, descriptor }) {
  const ahora = new Date();
  const fresco = gps && Date.now() - gps.at < 10 * 60 * 1000 ? gps : null;
  // Cada checada lleva el vector de la cara (después de la prueba de vida): el
  // servidor decide quién es; no se manda empleado_id (lo ignoraría).
  const checada = {
    id: crypto.randomUUID(),
    tipo,
    checada_at: ahora.toISOString(),
    latitud: fresco?.latitud ?? null,
    longitud: fresco?.longitud ?? null,
    precision_m: fresco?.precision_m ?? null,
    prueba_vida: reto,
    foto: imagen,
    descriptor: vector(descriptor),
  };
  await tx('cola', 'readwrite', (s) => s.put(checada));
  // "Últimas checadas" en pantalla y sugerencia del siguiente tipo (sin vector).
  await tx('locales', 'readwrite', (s) => s.put({
    id: checada.id, empleado_id: quien?.emp.id ?? null, tipo, checada_at: checada.checada_at,
    nombre: quien?.emp.nombre ?? 'Por confirmar',
  }));
  await limpiarLocales();
  pintarUltimas();
  pintarRed();

  if (quien) {
    const nombre = quien.emp.nombre.split(' ')[0];
    const saludo = tipo === 'ENTRADA' ? (ahora.getHours() < 12 ? 'Buenos días' : 'Buenas tardes') : tipo === 'SALIDA' ? 'Hasta luego' : 'Provecho';
    resultado(true, `${TIPOS[tipo]} registrada`, `${quien.emp.nombre} · ${hora(ahora)}`);
    hablar(`${TIPOS[tipo]} registrada. ${saludo}, ${nombre}.`);
  } else {
    resultado(true, 'Checada guardada', `${TIPOS[tipo]} · ${hora(ahora)}. Se confirmará al tener señal.`);
    hablar(`${TIPOS[tipo]} guardada. Se confirmará al tener señal.`);
  }
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
const MAX_INTENTOS = 5;
let enviando = false;
async function enviarCola() {
  if (enviando || !token || borrada) return;
  enviando = true;
  try {
    for (;;) {
      const cola = (await todos('cola')).sort((a, b) => a.checada_at.localeCompare(b.checada_at)).slice(0, 50);
      if (!cola.length) break;
      // Al servidor solo va lo que espera (sin el contador de intentos local).
      const lote = cola.map(({ intentos, ...c }) => c);
      const aceptadas = new Set(await rpc('asistencia_kiosco_checar', { p_token: token, p_checadas: lote }));
      // Las aceptadas (reconocidas o "sin reconocer") salen de la cola junto con
      // su vector. Las que el servidor rechazó (mal formadas) se reintentan
      // unas veces y luego se descartan para no trabar la cola.
      await tx('cola', 'readwrite', (s) => cola.forEach((c) => {
        if (aceptadas.has(c.id)) s.delete(c.id);
        else if ((c.intentos || 0) + 1 >= MAX_INTENTOS) s.delete(c.id);
        else s.put({ ...c, intentos: (c.intentos || 0) + 1 });
      }));
      enLinea = true;
      if (aceptadas.size < cola.length) {
        console.warn('Checadas no aceptadas:', cola.filter((c) => !aceptadas.has(c.id)).map((c) => c.id));
        break; // no repetir el mismo lote en este ciclo
      }
    }
  } catch (e) {
    enLinea = !sinSenal(e) && navigator.onLine;
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
    // PIN incorrecto → 401; bloqueada por 5 intentos → 423. Ambos llegan como
    // error con el mensaje del servidor (cuántos intentos quedan, etc.).
    await rpc('asistencia_kiosco_verificar_pin', { p_token: token, p_pin: $('pin').value });
    pinSupervisor = $('pin').value;
    $('capa-pin').classList.add('oculto');
    abrirSupervisor();
  } catch (e) {
    $('pin-msg').textContent = sinSenal(e) ? 'El modo supervisor necesita internet.' : e.message;
  }
});

function abrirSupervisor() {
  modo = 'pausa';
  pantalla('pantalla-admin');
  pestana('rostros');
  pintarListaEmpleados();
  // Si nadie lo cierra, regresa solo al kiosco (el PIN vale 30 min en el servidor).
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

// La pestaña "Ubicación" se quitó: la geocerca se fija en Shop Car.
function pestana(id) {
  for (const b of document.querySelectorAll('.pestanas button')) b.classList.toggle('activa', b.dataset.tab === id);
  for (const t of document.querySelectorAll('.tab')) t.classList.toggle('oculto', t.id !== `tab-${id}`);
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
      <span class="marca ${e.tiene_rostro ? 'si' : 'no'}">${e.tiene_rostro ? 'Registrado' : 'Sin rostro'}</span>
    </button>`).join('') || '<p class="sub" style="padding:12px">Sin resultados.</p>';
  for (const b of $('lista-emp').querySelectorAll('button')) {
    b.onclick = () => elegirEmpleado(datos.empleados.find((e) => e.id === Number(b.dataset.id)));
  }
}

function elegirEmpleado(emp) {
  detenerRegistro();
  empleadoSel = emp;
  pintarListaEmpleados();
  // El consentimiento firmado se sube en Shop Car; el servidor no deja
  // registrar el rostro sin él (y regresa el aviso si falta).
  $('registro').innerHTML = `
    <h2>${esc(emp.nombre)}</h2>
    <p class="sub">${emp.tiene_rostro ? 'Ya tiene rostro registrado. Registrarlo otra vez lo reemplaza.' : 'Aún no tiene rostro registrado.'}</p>
    <label class="consent"><input type="checkbox" id="r-consent">
      <span>El empleado firmó el <b>consentimiento para el uso de sus datos biométricos</b> y ya está subido en Shop Car (Asistencia → Personal y rostros).</span></label>
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
  // Las muestras viven solo en memoria hasta mandarlas; nunca se guardan aquí.
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

  // El chequeo de "rostro duplicado" (otra persona ya registrada con esta
  // cara) lo hace ahora el servidor y regresa el error con su nombre.
  try {
    await rpc('asistencia_kiosco_registrar_rostro', {
      p_token: token,
      p_pin: pinSupervisor,
      p_empleado_id: emp.id,
      p_descriptores: muestras.map(vector),
      p_consentimiento: true,
    });
    await descargarDatos();
    msg.className = 'msg ok';
    msg.textContent = `Rostro de ${emp.nombre} registrado. Ya puede checar.`;
    empleadoSel = datos.empleados.find((e) => e.id === emp.id);
    pintarListaEmpleados();
  } catch (e) {
    msg.textContent = sinSenal(e) ? 'Sin internet: el registro de rostros necesita señal.' : e.message;
    $('r-iniciar').disabled = false;
    $('r-consent').disabled = false;
  }
}

// --- tablet
async function pintarTablet() {
  $('t-localidad').textContent = `${datos.kiosco.localidad} · ${datos.kiosco.nombre}`;
  $('t-personal').textContent = `${datos.empleados.length} activos · ${conRostro()} con rostro`;
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
  await borrarTodo('Tablet desvinculada.');
};

if ('serviceWorker' in navigator && !LOCAL) navigator.serviceWorker.register('sw.js');

// ------------------------------------------------------------------ arranque
// Al final: así todo lo de arriba ya está declarado.
iniciarReloj();
await limpiarVectoresViejos();
if (!revisarSinContacto()) {
  pintarUltimas();
  if (!token) {
    pantalla('pantalla-vincular');
  } else {
    // Tablet que se actualiza desde la v1 sin marca de contacto: empieza a contar hoy.
    if (!localStorage.getItem(CLAVE_CONTACTO)) localStorage.setItem(CLAVE_CONTACTO, String(Date.now()));
    abrirKiosco();
  }
}
