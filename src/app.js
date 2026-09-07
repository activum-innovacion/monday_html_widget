/*
 * HTML Widget para monday.com
 * ---------------------------
 * - Guarda el código HTML por instancia de widget (monday.storage.instance).
 * - Renderiza el HTML en un iframe aislado (sandbox) con scripts habilitados.
 * - Expone al HTML del usuario:
 *     window.monday.context  -> contexto del widget (tablero, usuario, tema…)
 *     window.monday.settings -> settings del widget
 *     window.monday.boards   -> datos del tablero (opcional, si se activa)
 *     window.monday.api(query, variables) -> ejecuta GraphQL contra monday vía puente postMessage
 *     window.monday.execute(type, params) -> monday.execute (p.ej. abrir un ítem)
 * - Fuera de monday (abriendo la URL directamente) usa localStorage para poder probar en local.
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'html_widget_v1';
  var hasSdk = typeof window.mondaySdk === 'function';
  var inMonday = hasSdk && window.self !== window.top;
  var monday = hasSdk ? window.mondaySdk() : null;

  var state = {
    context: null,
    settings: {},
    html: '',
    loadBoards: false,
    limit: 100,
    boards: null,
    editing: false
  };

  var $ = function (id) { return document.getElementById(id); };
  var viewer = $('viewer'), editor = $('editor'), frame = $('frame'), empty = $('empty');
  var code = $('code'), optBoard = $('opt-board'), optLimit = $('opt-limit'), status = $('status');

  /* ---------------- Persistencia ---------------- */

  function withTimeout(promise, ms, label) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(function () { reject(new Error(label + ' no respondió en ' + ms + ' ms')); }, ms);
      promise.then(function (v) { clearTimeout(t); resolve(v); }, function (e) { clearTimeout(t); reject(e); });
    });
  }

  // Clave por instancia para el storage global (por si el storage de instancia no está disponible).
  function globalKey() {
    var id = (state.context && state.context.instanceId) || 'default';
    return STORAGE_KEY + ':' + id;
  }

  function describe(res) {
    try { return JSON.stringify(res); } catch (e) { return String(res); }
  }

  function readValue(res) {
    var raw = res && res.data && res.data.value;
    return raw ? safeParse(raw) : null;
  }

  function localGet() {
    try { return safeParse(localStorage.getItem(globalKey())); } catch (e) { return null; }
  }
  function localSet(raw) {
    try { localStorage.setItem(globalKey(), raw); } catch (e) {}
  }

  function loadStored() {
    if (!inMonday) return Promise.resolve(localGet());
    return withTimeout(monday.storage.instance.getItem(STORAGE_KEY), 8000, 'monday.storage.instance')
      .then(function (res) {
        console.log('[html-widget] instance.getItem', res);
        var v = readValue(res);
        if (v) return v;
        return withTimeout(monday.storage.getItem(globalKey()), 8000, 'monday.storage').then(function (res2) {
          console.log('[html-widget] storage.getItem', res2);
          return readValue(res2) || localGet();
        });
      })
      .catch(function (err) {
        console.warn('[html-widget] fallo leyendo storage, usando localStorage', err);
        return localGet();
      });
  }

  function saveStored(payload) {
    var raw = JSON.stringify(payload);
    localSet(raw); // copia local siempre, como último respaldo
    if (!inMonday) return Promise.resolve({ where: 'localStorage' });

    var ok = function (res) { return res && res.data && res.data.success !== false && !res.data.error && !res.error; };

    return withTimeout(monday.storage.instance.setItem(STORAGE_KEY, raw), 8000, 'monday.storage.instance')
      .then(function (res) {
        console.log('[html-widget] instance.setItem', res);
        if (ok(res)) return { where: 'instance' };
        return withTimeout(monday.storage.setItem(globalKey(), raw), 8000, 'monday.storage').then(function (res2) {
          console.log('[html-widget] storage.setItem', res2);
          if (ok(res2)) return { where: 'global' };
          throw new Error('instance: ' + describe(res) + ' | global: ' + describe(res2));
        });
      })
      .catch(function (err) {
        console.error('[html-widget] no se pudo guardar en monday storage', err);
        return { where: 'localStorage', error: (err && err.message) || String(err) };
      });
  }

  function safeParse(raw) {
    if (!raw) return null;
    try { return JSON.parse(raw); } catch (e) { return { html: String(raw) }; }
  }

  /* ---------------- Datos del tablero ---------------- */

  function boardIds() {
    var c = state.context || {};
    if (Array.isArray(c.boardIds) && c.boardIds.length) return c.boardIds;
    if (c.boardId) return [c.boardId];
    return [];
  }

  var BOARDS_QUERY =
    'query ($ids: [ID!], $limit: Int) {' +
    '  boards(ids: $ids) {' +
    '    id name description' +
    '    columns { id title type settings_str }' +
    '    groups { id title color }' +
    '    items_page(limit: $limit) {' +
    '      cursor' +
    '      items { id name group { id title } column_values { id text value type } }' +
    '    }' +
    '  }' +
    '}';

  function fetchBoards() {
    var ids = boardIds();
    if (!inMonday || !state.loadBoards || !ids.length) return Promise.resolve(null);
    return monday.api(BOARDS_QUERY, { variables: { ids: ids, limit: state.limit } })
      .then(function (res) { return (res && res.data && res.data.boards) || []; })
      .catch(function (err) { console.error('[html-widget] error cargando tableros', err); return { error: String(err) }; });
  }

  /* ---------------- Render ---------------- */

  function bootstrapScript(payload) {
    // Se inyecta en el iframe ANTES del HTML del usuario.
    return '<script>(function(){' +
      'var seq=0,pending={};' +
      'function call(type,data){return new Promise(function(res,rej){var id=++seq;pending[id]={res:res,rej:rej};' +
      'parent.postMessage({source:"html-widget",type:type,id:id,data:data},"*");});}' +
      'window.addEventListener("message",function(e){var m=e.data;if(!m||m.source!=="html-widget-host")return;' +
      'var p=pending[m.id];if(!p)return;delete pending[m.id];m.error?p.rej(new Error(m.error)):p.res(m.result);});' +
      'window.monday=' + JSON.stringify(payload) + ';' +
      'window.monday.api=function(q,v){return call("api",{query:q,variables:v||{}});};' +
      'window.monday.execute=function(t,p){return call("execute",{type:t,params:p||{}});};' +
      '})();<\/script>';
  }

  function buildSrcdoc(html) {
    var payload = {
      context: state.context,
      settings: state.settings,
      boards: state.boards,
      theme: (state.context && state.context.theme) || 'light'
    };
    var boot = bootstrapScript(payload);
    var base = '<base target="_blank">';
    var headRe = /<head[^>]*>/i;
    if (headRe.test(html)) return html.replace(headRe, function (m) { return m + base + boot; });
    return '<!doctype html><html><head><meta charset="utf-8">' + base + boot + '</head><body>' + html + '</body></html>';
  }

  function showError(msg) {
    console.error('[html-widget]', msg);
    var p = document.createElement('p');
    p.className = 'error';
    p.textContent = 'Error: ' + msg;
    empty.appendChild(p);
    empty.hidden = false;
  }

  function render() {
    var has = !!(state.html && state.html.trim());
    viewer.classList.toggle('is-empty', !has);
    empty.hidden = has;
    frame.srcdoc = has ? buildSrcdoc(state.html) : '';
  }

  function refresh() {
    return fetchBoards().then(function (b) { state.boards = b; render(); });
  }

  /* ---------------- Puente postMessage (iframe -> monday) ---------------- */

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || m.source !== 'html-widget' || e.source !== frame.contentWindow) return;
    var reply = function (result, error) {
      frame.contentWindow.postMessage({ source: 'html-widget-host', id: m.id, result: result, error: error }, '*');
    };
    if (!inMonday) return reply(null, 'Solo disponible dentro de monday.com');
    var p;
    if (m.type === 'api') p = monday.api(m.data.query, { variables: m.data.variables });
    else if (m.type === 'execute') p = monday.execute(m.data.type, m.data.params);
    else return reply(null, 'Tipo de mensaje desconocido: ' + m.type);
    p.then(function (r) { reply(r); }).catch(function (err) { reply(null, (err && err.message) || String(err)); });
  });

  /* ---------------- Editor ---------------- */

  function openEditor() {
    state.editing = true;
    code.value = state.html;
    optBoard.checked = state.loadBoards;
    optLimit.value = state.limit;
    setStatus('');
    viewer.hidden = true;
    editor.hidden = false;
    code.focus();
  }

  function closeEditor() {
    state.editing = false;
    editor.hidden = true;
    viewer.hidden = false;
  }

  function setStatus(msg, cls) {
    status.textContent = msg || '';
    status.className = 'status' + (cls ? ' ' + cls : '');
  }

  $('btn-edit').addEventListener('click', openEditor);
  $('btn-cancel').addEventListener('click', closeEditor);
  $('btn-example').addEventListener('click', function () {
    code.value = EXAMPLE;
    optBoard.checked = true;
  });
  $('btn-save').addEventListener('click', function () {
    var btn = this;
    btn.disabled = true;
    setStatus('Guardando…');
    state.html = code.value;
    state.loadBoards = optBoard.checked;
    state.limit = Math.max(1, Math.min(500, parseInt(optLimit.value, 10) || 100));
    saveStored({ html: state.html, loadBoards: state.loadBoards, limit: state.limit })
      .then(function (r) {
        if (inMonday) monday.execute('valueCreatedForUser');
        if (r.error) {
          // Guardado solo en este navegador: avisar pero seguir funcionando.
          setStatus('Guardado solo en este navegador. monday storage falló: ' + r.error, 'error');
          if (inMonday) monday.execute('notice', { message: 'HTML guardado solo en este navegador (monday storage no disponible)', type: 'error', timeout: 8000 });
          render();
          return refresh();
        }
        setStatus('Guardado', 'ok');
        closeEditor();
        return refresh();
      })
      .then(function () { btn.disabled = false; });
  });

  code.addEventListener('keydown', function (e) {
    if (e.key === 'Tab') {
      e.preventDefault();
      var s = code.selectionStart, t = code.selectionEnd;
      code.value = code.value.slice(0, s) + '  ' + code.value.slice(t);
      code.selectionStart = code.selectionEnd = s + 2;
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); $('btn-save').click(); }
  });

  /* ---------------- Arranque ---------------- */

  function applyContext(ctx) {
    state.context = ctx || {};
    document.documentElement.setAttribute('data-theme', state.context.theme || 'light');
    // Los usuarios de solo lectura no pueden editar.
    var u = state.context.user || {};
    $('btn-edit').hidden = !!(u.isViewOnly || u.isGuest);
  }

  function init() {
    console.log('[html-widget] iniciado', { sdk: hasSdk, inMonday: inMonday, url: location.href });
    if (inMonday) {
      monday.listen('context', function (res) { applyContext(res.data); if (!state.editing) refresh(); });
      monday.listen('settings', function (res) { state.settings = res.data || {}; if (!state.editing) render(); });
      monday.listen('events', function () { if (!state.editing && state.loadBoards) refresh(); });
    } else {
      applyContext({ theme: 'light', user: {} });
    }

    render(); // estado vacío visible mientras carga el storage

    // Esperar al contexto (necesario para instanceId) antes de leer el storage.
    var ctxReady = inMonday
      ? withTimeout(monday.get('context'), 5000, 'monday.get(context)')
          .then(function (res) { applyContext(res.data); })
          .catch(function (err) { console.warn('[html-widget] sin contexto', err); })
      : Promise.resolve();

    ctxReady.then(loadStored).then(function (stored) {
      if (stored) {
        state.html = stored.html || '';
        state.loadBoards = !!stored.loadBoards;
        state.limit = stored.limit || 100;
      }
      return refresh();
    }).catch(function (err) {
      showError((err && err.message) || String(err));
    });
  }

  var EXAMPLE = [
    '<!doctype html>',
    '<html>',
    '<head>',
    '  <meta charset="utf-8">',
    '  <style>',
    '    body { font-family: Figtree, Roboto, sans-serif; margin: 16px; color: #323338; }',
    '    body.dark { color: #d5d8df; }',
    '    .card { border: 1px solid #d0d4e4; border-radius: 8px; padding: 12px; margin-bottom: 8px; }',
    '    .count { font-size: 32px; font-weight: 700; }',
    '  </style>',
    '</head>',
    '<body>',
    '  <h2>Resumen del tablero</h2>',
    '  <div id="out">Cargando…</div>',
    '  <script>',
    '    if (monday.theme !== "light") document.body.classList.add("dark");',
    '    var boards = monday.boards || [];',
    '    if (!boards.length) {',
    '      document.getElementById("out").textContent =',
    '        "Activa \\"Inyectar datos del tablero\\" en el editor para ver datos aquí.";',
    '    } else {',
    '      document.getElementById("out").innerHTML = boards.map(function (b) {',
    '        var items = b.items_page.items;',
    '        return "<div class=card><strong>" + b.name + "</strong>" +',
    '               "<div class=count>" + items.length + "</div>ítems cargados</div>";',
    '      }).join("");',
    '    }',
    '    // También puedes lanzar tus propias consultas GraphQL:',
    '    // monday.api("query { me { name } }").then(function (r) { console.log(r.data.me.name); });',
    '  </script>',
    '</body>',
    '</html>'
  ].join('\n');

  init();
})();
