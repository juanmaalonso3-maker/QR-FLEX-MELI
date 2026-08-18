/**
 * CONTROL DE ENVÍOS FLEX - BITEK
 * Backend Google Apps Script (API JSON para frontend en GitHub Pages)
 *
 * Deploy: Ejecutar como "Yo" / Acceso: "Cualquier usuario" (incluso anónimo).
 * La seguridad la da la verificación del token de Google Sign-In en cada request.
 *
 * >>> IMPORTANTE: después de pegar este archivo, Implementar > Administrar
 *     implementaciones > Editar (lápiz) > Nueva versión > Implementar.
 *     Si no republicás con NUEVA VERSIÓN, el frontend sigue hablando con el
 *     backend viejo y verás "Acción desconocida".
 */

// ================== CONFIGURACIÓN ==================
// >>> SELLO DE VERSIÓN: subí este número cada vez que cambies el backend.
//     El frontend lo compara y te avisa en pantalla si el deploy quedó viejo.
//     Debe coincidir con BACKEND_VERSION_ESPERADA en index.html.
var VERSION = '2026-08-18-v9';

// Largo mínimo del número de envío. Bajado a 6 para aceptar el QR tipo DID (ej. 1767526).
var ENVIO_MIN_LEN = 6;

var SPREADSHEET_ID = '1FhCtudY7gCLuhbZsjSgXBw4Ti54KuF7rCJx7c9jNrU0';
var CLIENT_ID = '849214701404-ff11l3oo5k9hecabvf99cnbbgjlegeam.apps.googleusercontent.com'; // el mismo que en index.html

// ============ USUARIOS Y ROLES ============
// >>> ACÁ dás de alta / baja usuarios. La clave es el email en minúsculas y el
//     valor es el rol. Solo estos emails pueden entrar (ya NO alcanza con ser
//     @bitek.com.ar).  Roles disponibles: 'admin' | 'coordinacion'.
//       - admin        -> ve y usa TODO.
//       - coordinacion -> todo MENOS Financiero, Quincenas y Tarifas.
//     Para sumar a alguien, agregá una línea igual a las de abajo.
//       - deposito     -> SOLO las dos solapas de escaneo (MercadoLibre y OnCity).
var ROLES = {
  'juan.alonso@bitek.com.ar': 'admin',
  'coordinacion@bitek.com.ar': 'coordinacion'
  // ,'deposito@bitek.com.ar': 'deposito'            // <- operarios del depósito
  // ,'otra.persona@bitek.com.ar': 'coordinacion'   // <- ejemplo para agregar
  // ,'juanma.alonso3@gmail.com': 'admin'            // <- descomentá si querés tu Gmail
};

// Acciones que SOLO puede ejecutar un admin (Financiero, Quincenas, Tarifas).
var ACCIONES_ADMIN = { financiero: true, quincenas: true, guardarTarifas: true };

// Email ÚNICO que puede ver el Registro de actividad (logs) y exportarlo.
// Ni siquiera otros admin lo ven: es exclusivo de esta persona.
var SUPERADMIN_EMAIL = 'juan.alonso@bitek.com.ar';

// Cuánto dura la sesión propia (en días) sin volver a pedir login de Google.
// Recargar la página o demorarse NO cierra sesión mientras el token siga vigente.
var SESSION_DAYS = 90;

var TZ = 'America/Argentina/Buenos_Aires';
var ZONAS_VALIDAS = ['CABA', 'C1', 'C2', 'C3'];

// Corte quincenal de referencia: SIEMPRE un SÁBADO (así lo cuenta la logística).
// A partir de este sábado, los cortes se calculan automáticamente cada 14 días
// (hacia adelante y atrás), preservando el día de la semana (14 días = 2 semanas
// exactas => siempre sábado). El sábado ES el último día de la quincena (se cuenta).
// Ej: corte sáb 01/08/2026 -> quincena "20/07 al 01/08"; siguiente sáb 15/08 -> "03/08 al 15/08".
// Si un período real es distinto (feriados, etc.), cargalo en Config_Quincenas:
// esa tabla tiene prioridad sobre el cálculo automático.
var CORTE_ANCLA = new Date(2026, 7, 1); // sábado 01/08/2026
var MS_DIA = 24 * 3600 * 1000;

var SH_CPS       = 'Config_CPs';
var SH_TARIFAS   = 'Config_Tarifas';
var SH_QUINCENAS = 'Config_Quincenas';
var SH_REGISTRO  = 'Registro_Envios';
var SH_DASHBOARD = 'Dashboard_Gastos';
var SH_LOG       = 'Log_Errores';

// ================== ENDPOINTS ==================
// Abrí la URL /exec en el navegador: si NO ves este VERSION, el deploy quedó viejo.
function doGet() {
  return ContentService.createTextOutput(
    JSON.stringify({ status: 'API_OK', version: VERSION, desplegado: Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd HH:mm'),
                     msg: 'API de Envíos Flex v' + VERSION })
  ).setMimeType(ContentService.MimeType.JSON);
}

function doPost(e) {
  var out;
  try {
    var req = JSON.parse(e.postData.contents);
    var auth = autenticar_(req);          // { email, rol, session } o null
    if (!auth) {
      out = { status: 'NO_AUTH' };
    } else if (ACCIONES_ADMIN[req.action] && auth.rol !== 'admin') {
      out = { status: 'NO_PERM', msg: 'Tu usuario no tiene acceso a esta sección.' };
    } else {
      var email = auth.email;
      var p = req.payload || {};
      switch (req.action) {
        case 'login':           out = apiLogin(auth); break;
        case 'logout':          borrarSesion_(req.session); out = { status: 'OK' }; break;
        case 'version':         out = { status: 'OK', version: VERSION }; break;
        case 'estado':          out = apiEstado(email, auth.rol); break;
        case 'mapaCPs':         out = apiMapaCPs(); break;
        case 'registrar':       out = apiRegistrar(p, email); break;
        case 'editarEnvio':     out = apiEditarEnvio(p, email); break;
        case 'eliminarEnvio':   out = apiEliminarEnvio(p, email); break;
        case 'ultimos':         out = { status: 'OK', ultimos: ultimos_(sheet_(SH_REGISTRO), 5) }; break;
        case 'escaneosHoy':     out = { status: 'OK', escaneos: escaneosHoy_(sheet_(SH_REGISTRO)) }; break;
        case 'dashboard':       out = apiDashboard(); break;
        case 'historial':       out = apiHistorial(p); break;
        case 'quincenas':       out = apiQuincenas(p); break;
        case 'financiero':      out = apiFinanciero(); break;
        case 'logs':            out = apiLogs(auth, p); break;
        case 'buscarCP':        out = apiBuscarCP(p); break;
        case 'guardarCP':       out = apiGuardarCP(p, email); break;
        case 'guardarTarifas':  out = apiGuardarTarifas(p, email); break;

        /* ---------- OnCity / VTEX (preparación de pedidos del depósito) ---------- */
        case 'oncityPing':      out = { status:'OK', vtex: ocPingVtex(), version: VERSION }; break;
        case 'oncityOrders':    out = { status:'OK', vtex:{ok:true}, orders: ocListarPedidos(p) }; break;
        case 'oncityOrder':     out = { status:'OK', vtex:{ok:true}, order: ocPedido(p.id) }; break;
        case 'oncityScan':      out = ocRegistrarScan(p, email); break;
        case 'oncityLote':      out = ocRegistrarLote(p, email); break;
        case 'oncityEstado':    out = { status:'OK', estado: ocEstadoDia(p.dia || ocHoy()) }; break;
        case 'oncityHistorial': out = { status:'OK', filas: ocHistorial(Number(p.limit || 800)) }; break;
        case 'oncityBorrar':    out = ocBorrar(p.dia || ocHoy(), p.id, email); break;
        case 'oncityReset':     out = ocReset(p.dia, email); break;
        case 'oncityLog':       logError_(email, 'ONCITY_' + String(p.tipo || 'info').toUpperCase(), p.msg || ''); out = { status:'OK' }; break;
        default:
          out = { status: 'ERROR', msg: 'Acción desconocida (' + req.action + '). ¿Publicaste la última versión del backend con NUEVA VERSIÓN?' };
      }
    }
  } catch (err) {
    out = { status: 'ERROR', msg: 'Error del servidor: ' + err.message };
  }
  return ContentService.createTextOutput(JSON.stringify(out))
    .setMimeType(ContentService.MimeType.JSON);
}

// ================== AUTENTICACIÓN (roles + sesión propia) ==================
// Devuelve el rol del email ('admin'|'coordinacion') o '' si no está autorizado.
function rolDe_(email) {
  return ROLES[String(email || '').toLowerCase().trim()] || '';
}
function isAuthorized_(email) { return !!rolDe_(email); }

/**
 * Autentica un request. Primero intenta la SESIÓN PROPIA (token de larga duración
 * que sobrevive recargas y demoras); si no, valida el token de Google Sign-In
 * (que dura solo ~1 h y se usa para el login inicial).
 * Devuelve { email, rol, session } o null.
 */
function autenticar_(req) {
  // 1) Sesión propia (localStorage del navegador). No caduca al recargar.
  if (req && req.session) {
    var email = leerSesion_(req.session);
    if (email) {
      var rol = rolDe_(email);
      if (rol) return { email: email, rol: rol, session: req.session };
    }
  }
  // 2) Token de Google (login inicial o fallback si la sesión venció).
  if (req && req.token) {
    var em = verifyToken_(req.token);
    if (em) {
      var r = rolDe_(em);
      if (r) return { email: em, rol: r, session: null };
    }
  }
  return null;
}

/** Verifica el ID token de Google Sign-In y devuelve el email autorizado, o '' si no vale. */
function verifyToken_(token) {
  if (!token) return '';
  var cache = CacheService.getScriptCache();
  var key = 'tk_' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.MD5, token));
  var cached = cache.get(key);
  if (cached) return cached;

  var resp = UrlFetchApp.fetch(
    'https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token),
    { muteHttpExceptions: true });
  if (resp.getResponseCode() !== 200) return '';

  var info = JSON.parse(resp.getContentText());
  if (info.aud !== CLIENT_ID) return '';                     // token de otra app
  if (String(info.email_verified) !== 'true') return '';
  var email = String(info.email || '').toLowerCase().trim();
  if (!isAuthorized_(email)) return '';

  var ttlSeg = Math.floor(Math.min(Math.max((Number(info.exp) * 1000 - Date.now()) / 1000, 60), 3600));
  cache.put(key, email, ttlSeg);
  return email;
}

// ---- Sesión propia (persistida en ScriptProperties, dura SESSION_DAYS) ----
function crearSesion_(email) {
  var token = Utilities.getUuid();
  PropertiesService.getScriptProperties()
    .setProperty('sess_' + token, JSON.stringify({ email: email, exp: Date.now() + SESSION_DAYS * MS_DIA }));
  return token;
}
function leerSesion_(token) {
  if (!token) return '';
  var props = PropertiesService.getScriptProperties();
  var raw = props.getProperty('sess_' + token);
  if (!raw) return '';
  var o; try { o = JSON.parse(raw); } catch (e) { props.deleteProperty('sess_' + token); return ''; }
  if (!o || !o.exp || Date.now() > o.exp) { props.deleteProperty('sess_' + token); return ''; }
  // Renovación deslizante: extiende como mucho una vez por día (evita escribir en cada request).
  if ((o.exp - Date.now()) < (SESSION_DAYS - 1) * MS_DIA) {
    o.exp = Date.now() + SESSION_DAYS * MS_DIA;
    props.setProperty('sess_' + token, JSON.stringify(o));
  }
  return String(o.email || '');
}
function borrarSesion_(token) {
  if (token) { try { PropertiesService.getScriptProperties().deleteProperty('sess_' + token); } catch (e) {} }
}

/** Login inicial: crea (o reutiliza) la sesión propia y devuelve el estado + el token de sesión. */
function apiLogin(auth) {
  var esNueva = !auth.session;                       // vino por token de Google (login real)
  var session = auth.session || crearSesion_(auth.email);
  if (esNueva) logError_(auth.email, 'LOGIN', 'Inició sesión (rol ' + auth.rol + ').');
  var est = apiEstado(auth.email, auth.rol);
  est.session = session;
  return est;
}

// ================== HELPERS ==================
function ss_() { return SpreadsheetApp.openById(SPREADSHEET_ID); }

function sheet_(name) {
  var sh = ss_().getSheetByName(name);
  if (!sh) throw new Error('Falta la pestaña "' + name + '". Ejecutá setupInicial().');
  return sh;
}

function logError_(email, tipo, detalle) {
  try {
    sheet_(SH_LOG).appendRow([new Date(), email || '', tipo, String(detalle)]);
  } catch (e) { /* nunca frenar el registro por un fallo de log */ }
}

function normalizarCP_(cp) {
  var d = String(cp || '').replace(/\D/g, '');
  return d ? String(parseInt(d, 10)) : '';
}

function getMapaCPs_() {
  var vals = sheet_(SH_CPS).getDataRange().getValues();
  var map = {};
  for (var i = 1; i < vals.length; i++) {
    var cp = normalizarCP_(vals[i][0]);
    var zona = String(vals[i][1] || '').toUpperCase().trim();
    if (cp && !map[cp]) map[cp] = zona; // primera aparición gana
  }
  return map;
}

function getTarifas_() {
  var vals = sheet_(SH_TARIFAS).getDataRange().getValues();
  var t = {};
  for (var i = 1; i < vals.length; i++) {
    var z = String(vals[i][0] || '').toUpperCase().trim();
    var c = Number(vals[i][1]);
    if (z) t[z] = isNaN(c) ? 0 : c;
  }
  return t;
}

// ================== LÓGICA DE CORTES (VIERNES) ==================
/**
 * Devuelve el viernes de corte (fin de la quincena) que corresponde a una fecha.
 * Corte = primer ancla+14k que cae en o después de la fecha. Sirve al futuro y al pasado.
 */
function corteDe_(fecha) {
  var d = new Date(fecha); d.setHours(12, 0, 0, 0);
  var ancla = new Date(CORTE_ANCLA); ancla.setHours(12, 0, 0, 0);
  var diff = Math.round((d - ancla) / MS_DIA);
  var k = Math.ceil(diff / 14);
  return new Date(ancla.getTime() + k * 14 * MS_DIA);
}

function etiquetaQuincena_(corte) {
  var inicio = new Date(corte.getTime() - 12 * MS_DIA); // lunes de la 1ra semana (corte sábado - 12 días)
  return Utilities.formatDate(inicio, TZ, 'dd/MM') + ' al ' + Utilities.formatDate(corte, TZ, 'dd/MM');
}

/**
 * Quincena de una fecha:
 * 1) Si la fecha cae en un período cargado en Config_Quincenas, usa ese (prioridad).
 * 2) Si no, la calcula automáticamente (cortes cada 14 días, siempre viernes).
 */
function getQuincena_(fecha) {
  var d = new Date(fecha); d.setHours(12, 0, 0, 0);

  // 1) Tabla configurable (excepciones reales: feriados, cortes corridos, etc.)
  var vals = sheet_(SH_QUINCENAS).getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    var ini = vals[i][1], fin = vals[i][2];
    if (!(ini instanceof Date) || !(fin instanceof Date)) continue;
    var a = new Date(ini); a.setHours(0, 0, 0, 0);
    var b = new Date(fin); b.setHours(23, 59, 59, 999);
    if (d >= a && d <= b) {
      return String(vals[i][0] || (Utilities.formatDate(a, TZ, 'dd/MM') + ' al ' + Utilities.formatDate(b, TZ, 'dd/MM')));
    }
  }
  // 2) Cálculo automático
  return etiquetaQuincena_(corteDe_(d));
}

// Semana Lunes a Sábado -> etiqueta "Semana del dd/MM/yyyy" (lunes de esa semana)
function getSemana_(fecha) {
  var d = new Date(fecha);
  var day = d.getDay(); // 0=Dom ... 6=Sab
  var offset = (day + 6) % 7; // días desde el lunes
  d.setDate(d.getDate() - offset);
  return 'Semana del ' + Utilities.formatDate(d, TZ, 'dd/MM/yyyy');
}

/**
 * Genera una lista de quincenas (con sus 2 semanas Lun-Sáb) alrededor de hoy.
 * atras/adelante = cuántos ciclos de 14 días incluir. Asegura que SIEMPRE haya
 * quincenas futuras generadas, así el log nunca queda sin período asignado.
 */
function generarQuincenas_(atras, adelante) {
  var corteHoy = corteDe_(new Date());
  var lista = [];
  for (var k = -atras; k <= adelante; k++) {
    var corte = new Date(corteHoy.getTime() + k * 14 * MS_DIA);   // corte = sábado
    var inicio = new Date(corte.getTime() - 12 * MS_DIA);         // lunes semana 1
    var finSemana1 = new Date(corte.getTime() - 7 * MS_DIA);      // sábado semana 1
    var inicioSemana2 = new Date(corte.getTime() - 5 * MS_DIA);   // lunes semana 2
    lista.push({
      nombre: etiquetaQuincena_(corte),
      inicio: Utilities.formatDate(inicio, TZ, 'dd/MM/yyyy'),
      corte:  Utilities.formatDate(corte, TZ, 'dd/MM/yyyy'),
      semanas: [
        { nombre: getSemana_(inicio),       inicio: Utilities.formatDate(inicio, TZ, 'dd/MM'),        fin: Utilities.formatDate(finSemana1, TZ, 'dd/MM') },
        { nombre: getSemana_(inicioSemana2), inicio: Utilities.formatDate(inicioSemana2, TZ, 'dd/MM'), fin: Utilities.formatDate(corte, TZ, 'dd/MM') }
      ]
    });
  }
  return lista;
}

// ================== ESTADO / MAPA CP ==================
function apiEstado(email, rol) {
  var shReg = sheet_(SH_REGISTRO);
  return {
    status: 'OK',
    version: VERSION,
    email: email,
    rol: rol || rolDe_(email),
    hoy: contarHoy_(shReg, email),
    tarifas: getTarifas_(),
    quincenaActual: getQuincena_(new Date()),
    ultimos: ultimos_(shReg, 5),
    escaneosHoy: escaneosHoy_(shReg)
  };
}

// Mapa CP->zona completo (se baja una sola vez para el escaneo optimista offline-first).
function apiMapaCPs() {
  var mapa = getMapaCPs_();
  return { status: 'OK', mapa: mapa, total: Object.keys(mapa).length };
}

// ================== REGISTRO DE ENVÍOS ==================
/**
 * Resuelve zona/cp a partir del payload. Devuelve {ok, zona, cpMostrar, cpNorm}
 * o {desconocido:true, cp} si el CP no está y no vino cordón manual.
 */
function resolverZona_(payload, email, envioId) {
  var matanza = String(payload.matanza || '').toUpperCase();
  if (matanza === 'NORTE') return { ok: true, zona: 'C1', cpMostrar: 'LA MATANZA NORTE', cpNorm: '' };
  if (matanza === 'SUR')   return { ok: true, zona: 'C2', cpMostrar: 'LA MATANZA SUR', cpNorm: '' };

  var cpNorm = normalizarCP_(payload.cp);
  if (!cpNorm || cpNorm.length < 4) return { error: 'Ingresá un CP válido o marcá La Matanza.' };

  var mapa = getMapaCPs_();
  var zona = mapa[cpNorm] || '';
  if (ZONAS_VALIDAS.indexOf(zona) === -1) {
    var manual = String(payload.cordonManual || '').toUpperCase();
    if (ZONAS_VALIDAS.indexOf(manual) === -1) {
      return { desconocido: true, cp: cpNorm, base: Object.keys(mapa).length };
    }
    zona = manual;
    // Persistimos el CP en Config_CPs (upsert: si ya existiera, actualiza; si no, lo agrega).
    // Esto es lo que hace que un CP cargado desde el Escaneo quede guardado de verdad.
    var accionCP = upsertCP_(cpNorm, zona, 'Cargado por operario: ' + email + ' - ' +
      Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy HH:mm'));
    logError_(email, 'CP_AGREGADO', 'CP ' + cpNorm + ' (' + accionCP + ') asignado a ' + zona + ' desde Escaneo (envío ' + envioId + ').');
    return { ok: true, zona: zona, cpMostrar: cpNorm, cpNorm: cpNorm, cpAgregado: true };
  }
  return { ok: true, zona: zona, cpMostrar: cpNorm, cpNorm: cpNorm };
}

// Alta/actualización de un CP en Config_CPs de forma segura (sin duplicar filas).
function upsertCP_(cpNorm, zona, nota) {
  var sh = sheet_(SH_CPS);
  var vals = sh.getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (normalizarCP_(vals[i][0]) === cpNorm) {
      sh.getRange(i + 1, 2).setValue(zona);
      sh.getRange(i + 1, 4).setValue(nota);
      SpreadsheetApp.flush();
      return 'actualizado';
    }
  }
  sh.appendRow([cpNorm, zona, '', nota]);
  SpreadsheetApp.flush();
  return 'agregado';
}

function apiRegistrar(payload, email) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var envioId = String(payload.envioId || '').replace(/\D/g, '');
    if (!envioId || envioId.length < ENVIO_MIN_LEN) return { status: 'ERROR', msg: 'Número de envío inválido.' };

    var shReg = sheet_(SH_REGISTRO);

    // ---- Duplicado ----
    var finder = shReg.getRange('C:C').createTextFinder(envioId).matchEntireCell(true).findNext();
    if (finder) {
      var fila = shReg.getRange(finder.getRow(), 1, 1, 2).getValues()[0];
      return {
        status: 'DUPLICADO', envioId: envioId,
        fecha: fila[0] instanceof Date ? Utilities.formatDate(fila[0], TZ, 'dd/MM/yyyy HH:mm') : String(fila[0]),
        operario: String(fila[1])
      };
    }

    // ---- Resolver zona ----
    var res = resolverZona_(payload, email, envioId);
    if (res.error) return { status: 'ERROR', msg: res.error };
    if (res.desconocido) return { status: 'CP_DESCONOCIDO', envioId: envioId, cp: res.cp, base: res.base };

    // ---- Costo congelado al momento del escaneo ----
    var tarifas = getTarifas_();
    var costo = tarifas[res.zona];
    if (costo === undefined) {
      costo = 0;
      logError_(email, 'TARIFA_FALTANTE', 'No hay tarifa para zona ' + res.zona + ' (envío ' + envioId + ').');
    }

    // ---- Períodos ----
    var ahora = new Date();
    var quincena = getQuincena_(ahora);
    var semana = getSemana_(ahora);

    shReg.appendRow([ahora, email, envioId, res.cpMostrar, res.zona, costo, quincena, semana]);
    SpreadsheetApp.flush();

    return {
      status: 'OK', envioId: envioId, cp: res.cpMostrar, zona: res.zona,
      costo: costo, quincena: quincena, semana: semana, cpAgregado: !!res.cpAgregado,
      hoy: contarHoy_(shReg, email), ultimos: ultimos_(shReg, 5)
    };
  } catch (e) {
    logError_(email, 'EXCEPCION', e.message + ' | payload: ' + JSON.stringify(payload));
    return { status: 'ERROR', msg: 'Error del sistema: ' + e.message };
  } finally {
    lock.releaseLock();
  }
}

function apiEditarEnvio(payload, email) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var envioId = String(payload.envioId || '').replace(/\D/g, '');
    if (!envioId) return { status: 'ERROR', msg: 'Envío inválido.' };

    var shReg = sheet_(SH_REGISTRO);
    var finder = shReg.getRange('C:C').createTextFinder(envioId).matchEntireCell(true).findNext();
    if (!finder) return { status: 'ERROR', msg: 'No encontré el envío ' + envioId + '.' };
    var row = finder.getRow();

    var res = resolverZona_(payload, email, envioId);
    if (res.error) return { status: 'ERROR', msg: res.error };
    if (res.desconocido) return { status: 'CP_DESCONOCIDO', envioId: envioId, cp: res.cp, base: res.base };

    var tarifas = getTarifas_();
    var costo = tarifas[res.zona]; if (costo === undefined) costo = 0;

    var anterior = shReg.getRange(row, 4, 1, 2).getValues()[0]; // cp, zona
    shReg.getRange(row, 4).setValue(res.cpMostrar); // CP Ingresado
    shReg.getRange(row, 5).setValue(res.zona);      // Zona
    shReg.getRange(row, 6).setValue(costo);         // Costo (se recalcula con tarifa vigente)
    SpreadsheetApp.flush();
    logError_(email, 'ENVIO_EDITADO', 'Envío ' + envioId + ': ' + anterior[0] + '/' + anterior[1] + ' -> ' + res.cpMostrar + '/' + res.zona);

    return {
      status: 'OK', envioId: envioId, cp: res.cpMostrar, zona: res.zona, costo: costo,
      hoy: contarHoy_(shReg, email), ultimos: ultimos_(shReg, 5)
    };
  } finally {
    lock.releaseLock();
  }
}

function apiEliminarEnvio(payload, email) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var envioId = String(payload.envioId || '').replace(/\D/g, '');
    if (!envioId) return { status: 'ERROR', msg: 'Envío inválido.' };

    var shReg = sheet_(SH_REGISTRO);
    var finder = shReg.getRange('C:C').createTextFinder(envioId).matchEntireCell(true).findNext();
    if (!finder) return { status: 'ERROR', msg: 'No encontré el envío ' + envioId + '.' };
    var row = finder.getRow();
    var datos = shReg.getRange(row, 1, 1, 5).getValues()[0];
    shReg.deleteRow(row);
    SpreadsheetApp.flush();
    logError_(email, 'ENVIO_ELIMINADO', 'Envío ' + envioId + ' (CP ' + datos[3] + ', zona ' + datos[4] + ') eliminado.');

    return { status: 'OK', envioId: envioId, hoy: contarHoy_(shReg, email), ultimos: ultimos_(shReg, 5) };
  } finally {
    lock.releaseLock();
  }
}

function contarHoy_(shReg, email) {
  var hoy = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var vals = shReg.getDataRange().getValues();
  var n = 0;
  for (var i = vals.length - 1; i >= 1; i--) {
    var f = vals[i][0];
    if (!(f instanceof Date)) continue;
    if (Utilities.formatDate(f, TZ, 'yyyy-MM-dd') !== hoy) break; // registros ordenados por fecha
    if (String(vals[i][1]).toLowerCase() === email) n++;
  }
  return n;
}

// Últimos N registros (más reciente primero)
function ultimos_(shReg, n) {
  var vals = shReg.getDataRange().getValues();
  var out = [];
  for (var j = vals.length - 1; j >= 1 && out.length < n; j--) {
    var fe = vals[j][0];
    out.push({
      fecha: fe instanceof Date ? Utilities.formatDate(fe, TZ, 'dd/MM HH:mm') : String(fe),
      operario: String(vals[j][1] || '').split('@')[0],
      envio: String(vals[j][2] || ''),
      cp: String(vals[j][3] || ''),
      zona: String(vals[j][4] || ''),
      costo: Number(vals[j][5]) || 0
    });
  }
  return out;
}

// TODOS los escaneos del día de hoy (más reciente primero). Sirve para la lista
// de la sección Escaneo, que ahora muestra el día completo (no solo los últimos 5).
function escaneosHoy_(shReg) {
  var hoy = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var vals = shReg.getDataRange().getValues();
  var out = [];
  for (var j = vals.length - 1; j >= 1; j--) {
    var fe = vals[j][0];
    if (!(fe instanceof Date)) continue;
    if (Utilities.formatDate(fe, TZ, 'yyyy-MM-dd') !== hoy) break; // registros ordenados por fecha
    out.push({
      fecha: Utilities.formatDate(fe, TZ, 'dd/MM HH:mm'),
      operario: String(vals[j][1] || '').split('@')[0],
      envio: String(vals[j][2] || ''),
      cp: String(vals[j][3] || ''),
      zona: String(vals[j][4] || ''),
      costo: Number(vals[j][5]) || 0
    });
  }
  return out;
}

// ================== DASHBOARD OPERATIVO (HOY) ==================
// IMPORTANTE: este dashboard NO filtra por usuario. El admin ve TODOS los envíos
// del día, escaneados por cualquier operario (juan.alonso, coordinacion, etc.).
function apiDashboard() {
  var vals = sheet_(SH_REGISTRO).getDataRange().getValues();
  var hoyStr = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
  var hoy = { cant: 0, total: 0, zonas: { CABA: 0, C1: 0, C2: 0, C3: 0, OTRA: 0 } };
  var porOper = {}; // desglose por operario del día (visibilidad total del admin)

  for (var i = 1; i < vals.length; i++) {
    var f = vals[i][0];
    if (!(f instanceof Date) || Utilities.formatDate(f, TZ, 'yyyy-MM-dd') !== hoyStr) continue;
    var zona = String(vals[i][4] || '').toUpperCase();
    if (ZONAS_VALIDAS.indexOf(zona) === -1) zona = 'OTRA';
    var costo = Number(vals[i][5]) || 0;
    hoy.zonas[zona]++;
    hoy.cant++;
    hoy.total += costo;

    var oper = String(vals[i][1] || '(sin usuario)').split('@')[0];
    if (!porOper[oper]) porOper[oper] = { cant: 0, total: 0 };
    porOper[oper].cant++;
    porOper[oper].total += costo;
  }

  var operarios = Object.keys(porOper).map(function (o) {
    return { operario: o, cant: porOper[o].cant, total: porOper[o].total };
  }).sort(function (a, b) { return b.cant - a.cant; });

  return {
    status: 'OK',
    version: VERSION,
    hoy: hoy,
    operariosHoy: operarios,
    erroresHoy: contarErroresHoy_(),
    ultimos: ultimos_(sheet_(SH_REGISTRO), 5),
    tarifas: getTarifas_(),
    quincenaActual: getQuincena_(new Date()),
    totalRegistros: vals.length - 1,
    totalCPs: Object.keys(getMapaCPs_()).length
  };
}

// Cuenta filas del Log del día que representan fallas de carga (no ediciones normales).
function contarErroresHoy_() {
  try {
    var vals = sheet_(SH_LOG).getDataRange().getValues();
    var hoyStr = Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd');
    var tiposFalla = ['EXCEPCION', 'SIN_QUINCENA', 'TARIFA_FALTANTE'];
    var n = 0;
    for (var i = vals.length - 1; i >= 1; i--) {
      var f = vals[i][0];
      if (!(f instanceof Date)) continue;
      if (Utilities.formatDate(f, TZ, 'yyyy-MM-dd') !== hoyStr) break;
      if (tiposFalla.indexOf(String(vals[i][2]).toUpperCase()) !== -1) n++;
    }
    return n;
  } catch (e) { return 0; }
}

// ================== HISTORIAL COMPLETO ==================
// Devuelve TODOS los registros (más reciente primero) para filtrar en el frontend.
function apiHistorial(payload) {
  var vals = sheet_(SH_REGISTRO).getDataRange().getValues();
  var regs = [];
  for (var i = vals.length - 1; i >= 1; i--) {
    var fe = vals[i][0];
    regs.push({
      fechaISO: fe instanceof Date ? Utilities.formatDate(fe, TZ, 'yyyy-MM-dd') : '',
      fecha: fe instanceof Date ? Utilities.formatDate(fe, TZ, 'dd/MM/yyyy HH:mm') : String(fe),
      operario: String(vals[i][1] || '').split('@')[0],
      envio: String(vals[i][2] || ''),
      cp: String(vals[i][3] || ''),
      zona: String(vals[i][4] || ''),
      costo: Number(vals[i][5]) || 0,
      quincena: String(vals[i][6] || ''),
      semana: String(vals[i][7] || '')
    });
  }
  return { status: 'OK', registros: regs, total: regs.length };
}

// ================== HOJA DE QUINCENAS (a futuro) ==================
function apiQuincenas(payload) {
  var atras = Number(payload.atras); if (isNaN(atras)) atras = 3;
  var adelante = Number(payload.adelante); if (isNaN(adelante)) adelante = 8;
  return {
    status: 'OK',
    actual: getQuincena_(new Date()),
    lista: generarQuincenas_(atras, adelante)
  };
}

// ================== DASHBOARD FINANCIERO (histórico) ==================
function apiFinanciero() {
  var vals = sheet_(SH_REGISTRO).getDataRange().getValues();
  var zonas = ZONAS_VALIDAS.concat(['OTRA']);
  var porQ = {}, porS = {}, ordenQ = [], ordenS = [];
  var totalGeneral = 0, cantGeneral = 0;
  var porZonaGlobal = { CABA: { c: 0, m: 0 }, C1: { c: 0, m: 0 }, C2: { c: 0, m: 0 }, C3: { c: 0, m: 0 }, OTRA: { c: 0, m: 0 } };

  for (var i = 1; i < vals.length; i++) {
    var zona = String(vals[i][4] || '').toUpperCase();
    if (ZONAS_VALIDAS.indexOf(zona) === -1) zona = 'OTRA';
    var costo = Number(vals[i][5]) || 0;
    var q = String(vals[i][6] || 'SIN PERÍODO');
    var s = String(vals[i][7] || 'SIN SEMANA');

    if (!porQ[q]) { porQ[q] = nuevoAcum_(zonas); ordenQ.push(q); }
    if (!porS[s]) { porS[s] = nuevoAcum_(zonas); ordenS.push(s); }
    acumular_(porQ[q], zona, costo);
    acumular_(porS[s], zona, costo);

    porZonaGlobal[zona].c++; porZonaGlobal[zona].m += costo;
    totalGeneral += costo; cantGeneral++;
  }

  function serie(orden, data) {
    return orden.map(function (k) {
      var a = data[k], z = {};
      zonas.forEach(function (zn) { z[zn] = { c: a[zn].c, m: a[zn].m }; });
      return { nombre: k, zonas: z, cant: a.cant, total: a.total };
    }).reverse(); // más reciente primero
  }

  return {
    status: 'OK',
    quincenas: serie(ordenQ, porQ),
    semanas: serie(ordenS, porS),
    porZona: porZonaGlobal,
    totalGeneral: totalGeneral,
    cantGeneral: cantGeneral,
    tarifas: getTarifas_()
  };
}

// ================== REGISTRO DE ACTIVIDAD (LOGS) — solo SUPERADMIN ==================
/**
 * Devuelve las filas de Log_Errores (más reciente primero). Es el "registro de
 * actividad": logins, cargas de CP, ediciones de envíos, cambios de tarifas,
 * backfills y también los PROBLEMAS (excepciones, tarifas faltantes, etc.).
 * Restringido por EMAIL exacto: ni otros admin pueden verlo.
 */
function apiLogs(auth, p) {
  if (!auth || String(auth.email || '').toLowerCase().trim() !== SUPERADMIN_EMAIL) {
    return { status: 'NO_PERM', msg: 'Sección restringida.' };
  }
  var lim = Number(p && p.limit); if (isNaN(lim) || lim <= 0) lim = 2000;
  var vals = sheet_(SH_LOG).getDataRange().getValues();
  var out = [];
  for (var i = vals.length - 1; i >= 1 && out.length < lim; i--) {
    var f = vals[i][0];
    out.push({
      fecha: f instanceof Date ? Utilities.formatDate(f, TZ, 'dd/MM/yyyy HH:mm:ss') : String(f),
      usuario: String(vals[i][1] || ''),
      tipo: String(vals[i][2] || ''),
      detalle: String(vals[i][3] || '')
    });
  }
  return { status: 'OK', logs: out, total: vals.length - 1 };
}

// ================== GESTIÓN DE CPs ==================
function apiBuscarCP(payload) {
  var cp = normalizarCP_(payload.cp);
  if (!cp) return { status: 'ERROR', msg: 'CP inválido.' };
  var vals = sheet_(SH_CPS).getDataRange().getValues();
  for (var i = 1; i < vals.length; i++) {
    if (normalizarCP_(vals[i][0]) === cp) {
      return {
        status: 'OK', encontrado: true, cp: cp,
        zona: String(vals[i][1] || '').toUpperCase().trim(),
        localidad: String(vals[i][2] || ''),
        notas: String(vals[i][3] || '')
      };
    }
  }
  return { status: 'OK', encontrado: false, cp: cp, base: vals.length - 1 };
}

function apiGuardarCP(payload, email) {
  var cp = normalizarCP_(payload.cp);
  var zona = String(payload.zona || '').toUpperCase().trim();
  if (!cp || cp.length < 4) return { status: 'ERROR', msg: 'CP inválido.' };
  if (ZONAS_VALIDAS.indexOf(zona) === -1) return { status: 'ERROR', msg: 'Cordón inválido.' };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_(SH_CPS);
    var nota = 'Editado por ' + email + ' - ' + Utilities.formatDate(new Date(), TZ, 'dd/MM/yyyy HH:mm');
    var vals = sh.getDataRange().getValues();
    for (var i = 1; i < vals.length; i++) {
      if (normalizarCP_(vals[i][0]) === cp) {
        var zonaAnterior = String(vals[i][1] || '');
        sh.getRange(i + 1, 2).setValue(zona);
        sh.getRange(i + 1, 4).setValue(nota);
        logError_(email, 'CP_EDITADO', 'CP ' + cp + ': ' + zonaAnterior + ' -> ' + zona);
        return { status: 'OK', accion: 'actualizado', cp: cp, zona: zona };
      }
    }
    sh.appendRow([cp, zona, '', nota]);
    logError_(email, 'CP_AGREGADO', 'CP ' + cp + ' agregado con cordón ' + zona + ' (desde sección CPs).');
    return { status: 'OK', accion: 'agregado', cp: cp, zona: zona };
  } finally {
    lock.releaseLock();
  }
}

// ================== GESTIÓN DE TARIFAS ==================
function apiGuardarTarifas(payload, email) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = sheet_(SH_TARIFAS);
    var vals = sh.getDataRange().getValues();
    var cambios = [];
    ZONAS_VALIDAS.forEach(function (z) {
      var nuevo = Number(payload[z]);
      if (isNaN(nuevo) || nuevo < 0) return;
      var hallado = false;
      for (var i = 1; i < vals.length; i++) {
        if (String(vals[i][0] || '').toUpperCase().trim() === z) {
          if (Number(vals[i][1]) !== nuevo) {
            sh.getRange(i + 1, 2).setValue(nuevo);
            cambios.push(z + ': ' + vals[i][1] + ' -> ' + nuevo);
          }
          hallado = true;
          break;
        }
      }
      if (!hallado) {
        sh.appendRow([z, nuevo]);
        cambios.push(z + ': (nueva) ' + nuevo);
      }
    });
    if (cambios.length) logError_(email, 'TARIFAS_EDITADAS', cambios.join(' | '));
    return { status: 'OK', tarifas: getTarifas_(), cambios: cambios.length };
  } finally {
    lock.releaseLock();
  }
}

// ================== SETUP INICIAL (ejecutar 1 vez desde el editor) ==================
function setupInicial() {
  var ss = ss_();

  function ensure(name, headers) {
    var sh = ss.getSheetByName(name) || ss.insertSheet(name);
    if (headers && sh.getLastRow() === 0) {
      sh.getRange(1, 1, 1, headers.length).setValues([headers])
        .setFontWeight('bold').setBackground('#1a73e8').setFontColor('#ffffff');
      sh.setFrozenRows(1);
    }
    return sh;
  }

  ensure(SH_CPS, ['CP', 'Cordon', 'Localidad', 'Notas']);
  var shT = ensure(SH_TARIFAS, ['Zona', 'Costo']);
  if (shT.getLastRow() === 1) {
    shT.getRange(2, 1, 4, 2).setValues([['CABA', 2750], ['C1', 3740], ['C2', 4730], ['C3', 7670]]);
  }
  ensure(SH_QUINCENAS, ['Nombre', 'Fecha Inicio', 'Fecha Fin']);
  ensure(SH_REGISTRO, ['Fecha/Hora', 'Operario', 'Envio ID', 'CP Ingresado', 'Zona', 'Costo', 'Quincena', 'Semana']);
  ensure(SH_LOG, ['Fecha/Hora', 'Usuario', 'Tipo', 'Detalle']);
  ensure(SH_DASHBOARD, null);

  ss.setSpreadsheetTimeZone(TZ);
  actualizarDashboard();
  SpreadsheetApp.flush();
}

// ================== DASHBOARD EN EL SHEET (vista del dueño) ==================
function actualizarDashboard() {
  var sh = sheet_(SH_DASHBOARD);
  var vals = sheet_(SH_REGISTRO).getDataRange().getValues();
  sh.clear();

  var zonas = ZONAS_VALIDAS.concat(['OTRA']);
  var porQ = {}, porS = {}, ordenQ = [], ordenS = [];

  for (var i = 1; i < vals.length; i++) {
    var zona = String(vals[i][4] || '').toUpperCase();
    if (ZONAS_VALIDAS.indexOf(zona) === -1) zona = 'OTRA';
    var costo = Number(vals[i][5]) || 0;
    var q = String(vals[i][6] || 'SIN PERÍODO');
    var s = String(vals[i][7] || 'SIN SEMANA');

    if (!porQ[q]) { porQ[q] = nuevoAcum_(zonas); ordenQ.push(q); }
    if (!porS[s]) { porS[s] = nuevoAcum_(zonas); ordenS.push(s); }
    acumular_(porQ[q], zona, costo);
    acumular_(porS[s], zona, costo);
  }

  var row = 1;
  row = escribirBloque_(sh, row, '💰 GASTOS POR QUINCENA (corte sábado)', 'Quincena', ordenQ, porQ, zonas);
  row += 2;
  escribirBloque_(sh, row, '📅 GASTOS POR SEMANA (Lunes a Sábado)', 'Semana', ordenS, porS, zonas);

  sh.autoResizeColumns(1, zonas.length * 2 + 4);
  sh.getRange('A1').activate();
}

function nuevoAcum_(zonas) {
  var o = { total: 0, cant: 0 };
  zonas.forEach(function (z) { o[z] = { c: 0, m: 0 }; });
  return o;
}

function acumular_(a, zona, costo) {
  a[zona].c++; a[zona].m += costo;
  a.cant++; a.total += costo;
}

function escribirBloque_(sh, row, titulo, etiqueta, orden, data, zonas) {
  sh.getRange(row, 1).setValue(titulo).setFontSize(13).setFontWeight('bold');
  row++;
  var head = [etiqueta];
  zonas.forEach(function (z) { head.push(z + ' (cant)'); head.push(z + ' ($)'); });
  head.push('TOTAL ENVÍOS'); head.push('TOTAL $');
  sh.getRange(row, 1, 1, head.length).setValues([head])
    .setFontWeight('bold').setBackground('#e8f0fe');
  row++;

  var body = [], granTotal = 0, granCant = 0;
  orden.forEach(function (k) {
    var a = data[k], line = [k];
    zonas.forEach(function (z) { line.push(a[z].c); line.push(a[z].m); });
    line.push(a.cant); line.push(a.total);
    granTotal += a.total; granCant += a.cant;
    body.push(line);
  });
  if (body.length) {
    sh.getRange(row, 1, body.length, head.length).setValues(body);
    row += body.length;
    var totLine = ['TOTAL GENERAL'];
    for (var i = 1; i < head.length - 2; i++) totLine.push('');
    totLine.push(granCant); totLine.push(granTotal);
    sh.getRange(row, 1, 1, head.length).setValues([totLine])
      .setFontWeight('bold').setBackground('#fce8e6');
    row++;
  } else {
    sh.getRange(row, 1).setValue('(sin registros)');
    row++;
  }
  return row;
}

// ================== BACKFILL DE PERÍODOS (reparar registros viejos) ==================
/**
 * Recalcula Quincena y Semana de TODOS los registros existentes usando la lógica
 * automática de cortes viernes. Repara las filas que quedaron con "SIN PERÍODO".
 * Ejecutar UNA vez desde el editor, o desde el menú "Envíos Flex". Es idempotente.
 */
function backfillPeriodos() {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try {
    var ss = ss_();
    var sh = ss.getSheetByName(SH_REGISTRO);
    if (!sh) throw new Error('Falta la pestaña "' + SH_REGISTRO + '".');
    var vals = sh.getDataRange().getValues();
    if (vals.length < 2) return { reparados: 0, total: 0 };

    // >>> OPTIMIZACIÓN: leemos Config_Quincenas UNA sola vez. Antes getQuincena_
    //     reabría la planilla en cada registro (~288 aperturas) y podía tardar
    //     tanto que llegaba al límite de 6 min y se colgaba. Ahora corre en segundos.
    var qConf = [];
    var shQ = ss.getSheetByName(SH_QUINCENAS);
    if (shQ) {
      var confVals = shQ.getDataRange().getValues();
      for (var r = 1; r < confVals.length; r++) {
        var ini = confVals[r][1], fin = confVals[r][2];
        if (!(ini instanceof Date) || !(fin instanceof Date)) continue;
        var a = new Date(ini); a.setHours(0, 0, 0, 0);
        var b = new Date(fin); b.setHours(23, 59, 59, 999);
        qConf.push({ a: a, b: b, nombre: String(confVals[r][0] ||
          (Utilities.formatDate(a, TZ, 'dd/MM') + ' al ' + Utilities.formatDate(b, TZ, 'dd/MM'))) });
      }
    }
    // Misma lógica que getQuincena_ pero sin tocar la planilla en cada vuelta.
    function quincenaRapida_(d0) {
      var d = new Date(d0); d.setHours(12, 0, 0, 0);
      for (var j = 0; j < qConf.length; j++) {
        if (d >= qConf[j].a && d <= qConf[j].b) return qConf[j].nombre; // excepción cargada a mano
      }
      return etiquetaQuincena_(corteDe_(d)); // cálculo automático (corte sábado)
    }

    var colQuin = [], colSem = [], reparados = 0;
    for (var i = 1; i < vals.length; i++) {
      var f = vals[i][0];
      if (f instanceof Date) {
        var q = quincenaRapida_(f), s = getSemana_(f);
        if (String(vals[i][6]) !== q || String(vals[i][7]) !== s) reparados++;
        colQuin.push([q]); colSem.push([s]);
      } else {
        colQuin.push([vals[i][6]]); colSem.push([vals[i][7]]);
      }
    }
    sh.getRange(2, 7, colQuin.length, 1).setValues(colQuin);
    sh.getRange(2, 8, colSem.length, 1).setValues(colSem);
    SpreadsheetApp.flush();
    actualizarDashboard();

    var msg = 'Backfill listo: ' + reparados + ' de ' + (vals.length - 1) + ' registros actualizados.';
    logError_('sistema', 'BACKFILL_PERIODOS', msg);
    try { SpreadsheetApp.getUi().alert(msg); } catch (e) {}
    return { reparados: reparados, total: vals.length - 1 };
  } finally {
    lock.releaseLock();
  }
}

// Menú en el Sheet
function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('Envíos Flex')
    .addItem('🔄 Actualizar Dashboard', 'actualizarDashboard')
    .addItem('🩹 Reparar quincenas de registros viejos', 'backfillPeriodos')
    .addToUi();
}


/* ============================================================================
 *  ONCITY · PREPARACIÓN DE PEDIDOS (VTEX + Envíame)
 * ============================================================================
 *  Segunda solapa de escaneo. Dos partes:
 *    1) Proxy a la API de VTEX (la AppKey/AppToken viven acá, nunca en el HTML).
 *    2) Hoja Pedidos_OnCity: estado compartido entre todas las PCs del depósito,
 *       para que una máquina sepa lo que escaneó la otra.
 *  El login y los roles son los mismos del control de envíos Flex.
 * ========================================================================== */

var OC_ACCOUNT = 'kenta993';
var OC_KEY     = 'vtexappkey-kenta993-ZVANCF';
var OC_TOKEN   = 'PPUAHFRMQHAHDCSTDANVNXOPAMMOQBZXXVCGOQGPDQBDYQFRIVRXRSOQRINKZZFHBVWZTINNOCZSNLTZJTNUDJJOFPWBZUKABGRTRRSHSLRFFGFZOKKXMQYSJTZUBPEC';
var OC_ENV     = 'vtexcommercestable';

var SH_ONCITY  = 'Pedidos_OnCity';
var OC_COLS = ['Clave','Fecha','Día','Pedido','Secuencia','Cliente','Destino','Estado VTEX',
               'SKUs','Productos','Unidades','Origen','Armado','Hora armado','Máquina','Usuario'];

function ocHoy(){ return Utilities.formatDate(new Date(), TZ, 'yyyy-MM-dd'); }
function ocDiaStr(v){
  if (v instanceof Date) return Utilities.formatDate(v, TZ, 'yyyy-MM-dd');
  return String(v || '');
}

// ---------------------------------------------------------------- VTEX
function ocVtexGet(path){
  var r = UrlFetchApp.fetch('https://' + OC_ACCOUNT + '.' + OC_ENV + '.com.br' + path, {
    method: 'get',
    headers: { 'X-VTEX-API-AppKey': OC_KEY, 'X-VTEX-API-AppToken': OC_TOKEN, 'Accept': 'application/json' },
    muteHttpExceptions: true, followRedirects: true
  });
  var code = r.getResponseCode();
  if (code === 401 || code === 403) throw new Error('VTEX rechazó las credenciales (HTTP ' + code + ')');
  if (code === 404) throw new Error('VTEX no encontró el pedido (HTTP 404)');
  if (code >= 300) throw new Error('VTEX respondió HTTP ' + code);
  return JSON.parse(r.getContentText());
}

function ocPingVtex(){
  try {
    var t = new Date().getTime();
    ocVtexGet('/api/oms/pvt/orders?per_page=1');
    return { ok: true, ms: new Date().getTime() - t };
  } catch (e) {
    return { ok: false, error: String(e.message || e) };
  }
}

/** Deja del pedido solo lo que el depósito necesita. VTEX manda importes en centavos. */
function ocSlim(o){
  var cp = o.clientProfileData || {};
  var ad = (o.shippingData && o.shippingData.address) || {};
  return {
    orderId: o.orderId, sequence: o.sequence, status: o.status,
    statusDescription: o.statusDescription, creationDate: o.creationDate,
    clientName: ((cp.firstName || '') + ' ' + (cp.lastName || '')).trim() || o.clientName || '',
    totalValue: (o.value || 0) / 100,
    marketplaceOrderId: o.marketplaceOrderId || '',
    shipping: {
      receiver: ad.receiverName || '',
      address: [ad.street, ad.number].filter(String).join(' '),
      city: ad.city || '', state: ad.state || '', zip: ad.postalCode || '',
      phone: cp.phone || ''
    },
    items: (o.items || []).map(function (it){
      return { skuId: it.id, productId: it.productId, refId: it.refId || '', ean: it.ean || '',
               sellerSku: it.sellerSku || '', name: it.name || it.skuName || '',
               quantity: it.quantity, unitPrice: (it.price || 0) / 100, imageUrl: it.imageUrl || '' };
    })
  };
}

function ocListarPedidos(p){
  var status = p.status || 'ready-for-handling';
  var maxPages = Math.min(Number(p.pages || 3), 10);
  var lista = [], page = 1;
  while (page <= maxPages){
    var j = ocVtexGet('/api/oms/pvt/orders?f_status=' + encodeURIComponent(status) +
                      '&per_page=100&page=' + page + '&orderBy=creationDate,desc');
    var chunk = j.list || [];
    lista = lista.concat(chunk);
    var pag = j.paging || {};
    if (chunk.length < 100 || page >= (pag.pages || 1)) break;
    page++;
  }
  if (String(p.full) !== '1'){
    return lista.map(function (o){
      return { orderId:o.orderId, sequence:o.sequence, clientName:o.clientName,
               creationDate:o.creationDate, totalValue:(o.totalValue||0)/100,
               status:o.status, statusDescription:o.statusDescription, items:[] };
    });
  }
  return ocDetalles(lista.map(function (o){ return o.orderId; }));
}

/** Detalles en tandas paralelas, con caché de 5 minutos. */
function ocDetalles(ids){
  var cache = CacheService.getScriptCache();
  var out = [], faltan = [];
  ids.forEach(function (id){
    var c = cache.get('oc_' + id);
    if (c) { try { out.push(JSON.parse(c)); return; } catch (e) {} }
    faltan.push(id);
  });
  var headers = { 'X-VTEX-API-AppKey': OC_KEY, 'X-VTEX-API-AppToken': OC_TOKEN, 'Accept': 'application/json' };
  for (var i = 0; i < faltan.length; i += 20){
    var tanda = faltan.slice(i, i + 20);
    var reqs = tanda.map(function (id){
      return { url: 'https://' + OC_ACCOUNT + '.' + OC_ENV + '.com.br/api/oms/pvt/orders/' + encodeURIComponent(id),
               method: 'get', headers: headers, muteHttpExceptions: true };
    });
    UrlFetchApp.fetchAll(reqs).forEach(function (r, ix){
      if (r.getResponseCode() >= 300) return;
      try {
        var slim = ocSlim(JSON.parse(r.getContentText()));
        cache.put('oc_' + tanda[ix], JSON.stringify(slim), 300);
        out.push(slim);
      } catch (e) {}
    });
  }
  var porId = {};
  out.forEach(function (o){ porId[o.orderId] = o; });
  return ids.map(function (id){ return porId[id]; }).filter(function (x){ return !!x; });
}

function ocPedido(id){
  if (!id) throw new Error('Falta el id del pedido');
  var cache = CacheService.getScriptCache();
  var c = cache.get('oc_' + id);
  if (c) { try { return JSON.parse(c); } catch (e) {} }
  var slim = ocSlim(ocVtexGet('/api/oms/pvt/orders/' + encodeURIComponent(id)));
  cache.put('oc_' + id, JSON.stringify(slim), 300);
  return slim;
}

// ------------------------------------------------ estado compartido (planilla)
function ocHoja(){
  var ss = ss_();
  var sh = ss.getSheetByName(SH_ONCITY);
  if (!sh){
    sh = ss.insertSheet(SH_ONCITY);
    sh.getRange(1, 1, 1, OC_COLS.length).setValues([OC_COLS])
      .setFontWeight('bold').setBackground('#0072CE').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    sh.getRange('A:A').setNumberFormat('@');   // texto plano: si no, Sheets rompe la clave
    sh.getRange('C:C').setNumberFormat('@');
  }
  return sh;
}

function ocFila(sh, clave){
  var last = sh.getLastRow();
  if (last < 2) return -1;
  var keys = sh.getRange(2, 1, last - 1, 1).getValues();
  for (var i = keys.length - 1; i >= 0; i--){      // lo reciente primero
    if (String(keys[i][0]) === clave) return i + 2;
  }
  return -1;
}

/**
 * Registra un escaneo. Si el pedido ya estaba, no duplica: devuelve quién lo tomó
 * antes para que la app avise. Con candado, porque dos PCs pueden escanear la
 * misma etiqueta en el mismo segundo.
 */
function ocRegistrarScan(p, email){
  if (!p.id) return { status:'ERROR', msg:'Falta el id del pedido' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ocHoja();
    var dia = p.dia || ocHoy();
    var clave = dia + '|' + p.id;
    var armado = String(p.armado) === '1' || p.armado === 1 || p.armado === true;
    var fila = ocFila(sh, clave);

    if (fila > 0){
      var r = sh.getRange(fila, 1, 1, OC_COLS.length).getValues()[0];
      var existente = {
        pedido: r[3], seq: String(r[4] || ''), cliente: r[5],
        armado: String(r[12]) === 'SI', maquina: r[14], via: String(r[11] || ''),
        ts: r[1] instanceof Date ? r[1].getTime() : null,
        horaArmado: r[13] instanceof Date ? r[13].getTime() : null
      };
      // La fila existía solo porque el pedido se trajo de VTEX ("auto"): este es
      // el primer escaneo real, así que no es un duplicado.
      if (existente.via === 'auto' && p.via && p.via !== 'auto'){
        sh.getRange(fila, 12).setValue(p.via);
        sh.getRange(fila, 15).setValue(p.maquina || '');
        sh.getRange(fila, 2).setValue(new Date());
        if (armado) sh.getRange(fila, 13, 1, 2).setValues([['SI', new Date()]]);
        return { status:'OK', nuevo:true, ascendido:true };
      }
      if (armado && !existente.armado){
        sh.getRange(fila, 13, 1, 3).setValues([['SI', new Date(), p.maquina || '']]);
        existente.armado = true;
        return { status:'OK', nuevo:false, actualizado:true, existente:existente };
      }
      return { status:'OK', nuevo:false, existente:existente };
    }

    sh.appendRow([clave, new Date(), dia, p.id, p.seq || '', p.cliente || '', p.destino || '',
                  p.estado || '', p.skus || '', p.productos || '', p.unidades || '', p.via || '',
                  armado ? 'SI' : 'NO', armado ? new Date() : '', p.maquina || '', email || '']);
    return { status:'OK', nuevo:true };
  } finally {
    lock.releaseLock();
  }
}

/**
 * Alta en lote (lo que trae el botón "Traer todos los listo para preparación").
 * Escribe de una sola vez para no hacer 20 llamadas seguidas a la planilla.
 */
function ocRegistrarLote(p, email){
  var pedidos = p.pedidos;
  if (typeof pedidos === 'string'){ try { pedidos = JSON.parse(pedidos); } catch (e) { pedidos = []; } }
  if (!pedidos || !pedidos.length) return { status:'OK', agregados:0 };

  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ocHoja();
    var dia = p.dia || ocHoy();
    var last = sh.getLastRow();
    var existentes = {};
    if (last >= 2){
      var keys = sh.getRange(2, 1, last - 1, 1).getValues();
      for (var i = 0; i < keys.length; i++) existentes[String(keys[i][0])] = true;
    }
    var filas = [], ahora = new Date();
    for (var j = 0; j < pedidos.length; j++){
      var q = pedidos[j];
      var clave = dia + '|' + q.id;
      if (existentes[clave]) continue;
      existentes[clave] = true;
      filas.push([clave, ahora, dia, q.id, q.seq || '', q.cliente || '', q.destino || '',
                  q.estado || '', q.skus || '', q.productos || '', q.unidades || '', 'auto',
                  'NO', '', p.maquina || '', email || '']);
    }
    if (filas.length) sh.getRange(sh.getLastRow() + 1, 1, filas.length, OC_COLS.length).setValues(filas);
    return { status:'OK', agregados: filas.length };
  } finally {
    lock.releaseLock();
  }
}

/** Foto liviana del día: cada PC se sincroniza sin bajar todo. */
function ocEstadoDia(dia){
  var sh = ocHoja();
  var last = sh.getLastRow();
  var out = [];
  if (last >= 2){
    var vals = sh.getRange(2, 1, last - 1, OC_COLS.length).getValues();
    for (var i = 0; i < vals.length; i++){
      if (ocDiaStr(vals[i][2]) !== dia) continue;
      out.push({ p: vals[i][3], s: String(vals[i][4] || ''), c: vals[i][5],
                 a: String(vals[i][12]) === 'SI' ? 1 : 0, m: vals[i][14], v: String(vals[i][11] || ''),
                 t: vals[i][1] instanceof Date ? vals[i][1].getTime() : null,
                 ta: vals[i][13] instanceof Date ? vals[i][13].getTime() : null });
    }
  }
  return { dia: dia, pedidos: out };
}

function ocHistorial(limit){
  var sh = ocHoja();
  var last = sh.getLastRow();
  if (last < 2) return [];
  var n = Math.min(limit || 800, last - 1);
  var vals = sh.getRange(last - n + 1, 1, n, OC_COLS.length).getValues();
  var out = [];
  for (var i = vals.length - 1; i >= 0; i--){
    var v = vals[i];
    if (!v[3]) continue;
    out.push({ dia: ocDiaStr(v[2]), ts: v[1] instanceof Date ? v[1].getTime() : null,
               pedido: v[3], seq: String(v[4] || ''), cliente: v[5], destino: v[6], estado: v[7],
               skus: v[8], productos: v[9], unidades: v[10], via: v[11],
               armado: String(v[12]) === 'SI', maquina: v[14], usuario: v[15] });
  }
  return out;
}

function ocBorrar(dia, id, email){
  if (!id) return { status:'ERROR', msg:'Falta el id del pedido' };
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ocHoja();
    var fila = ocFila(sh, dia + '|' + id);
    if (fila < 0) return { status:'OK', borradas:0 };
    sh.deleteRow(fila);
    logError_(email, 'ONCITY_BORRADO', 'Pedido ' + id + ' (' + dia + ') eliminado del historial.');
    return { status:'OK', borradas:1 };
  } finally {
    lock.releaseLock();
  }
}

/** dia = 'YYYY-MM-DD' borra ese día; dia = 'all' vacía la hoja entera. */
function ocReset(dia, email){
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var sh = ocHoja();
    var last = sh.getLastRow();
    if (last < 2) return { status:'OK', borradas:0 };
    if (dia === 'all'){
      sh.deleteRows(2, last - 1);
      logError_(email, 'ONCITY_RESET', 'Historial OnCity borrado completo (' + (last - 1) + ' filas).');
      return { status:'OK', borradas: last - 1 };
    }
    var objetivo = dia || ocHoy();
    var vals = sh.getRange(2, 3, last - 1, 1).getValues();
    var n = 0;
    for (var i = vals.length - 1; i >= 0; i--){       // de abajo hacia arriba: si no, se corren las filas
      if (ocDiaStr(vals[i][0]) === objetivo){ sh.deleteRow(i + 2); n++; }
    }
    logError_(email, 'ONCITY_RESET', 'Día ' + objetivo + ' reiniciado (' + n + ' filas).');
    return { status:'OK', borradas:n };
  } finally {
    lock.releaseLock();
  }
}

/** Prueba manual desde el editor: verifica VTEX y la hoja compartida. */
function ocProbar(){
  Logger.log('Ping VTEX: %s', JSON.stringify(ocPingVtex()));
  var l = ocListarPedidos({ full:'0', pages:1 });
  Logger.log('Pedidos listos para preparación: %s', l.length);
  if (l.length) Logger.log('Detalle del primero: %s', JSON.stringify(ocPedido(l[0].orderId)));
  Logger.log('Hoja compartida: %s', ocHoja().getName());
}
