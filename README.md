# HTML Widget para monday.com

Widget personalizado (app de monday.com) que permite pegar y ejecutar código **HTML / CSS / JavaScript** dentro de un dashboard o de una vista de tablero.

- Cada instancia del widget guarda su propio HTML (`monday.storage.instance`).
- El HTML se ejecuta en un `iframe` aislado (`sandbox`) con scripts habilitados.
- El código puede acceder al contexto de monday y lanzar consultas GraphQL.
- Sin build: es un sitio estático, desplegable en Vercel tal cual.

## Estructura

```
index.html      UI del widget (visor + editor)
src/app.js      Lógica: SDK de monday, storage, render, puente API
src/styles.css  Estilos (soporta tema light / dark / black de monday)
vercel.json     Cabeceras (frame-ancestors para que monday pueda embeberlo)
```

## Uso dentro del HTML

Dentro de tu código tienes disponible el objeto `window.monday`:

| Propiedad / método | Descripción |
| --- | --- |
| `monday.context` | Contexto del widget: `boardId`/`boardIds`, `user`, `theme`, `instanceId`… |
| `monday.settings` | Settings del widget definidos en el Developer Center (si los añades) |
| `monday.boards` | Tableros con columnas, grupos e ítems (solo si activas "Inyectar datos del tablero") |
| `monday.theme` | `light`, `dark` o `black` |
| `monday.api(query, variables)` | Ejecuta GraphQL contra la API de monday. Devuelve una Promise |
| `monday.execute(type, params)` | Ejecuta acciones del SDK, p. ej. `monday.execute("openItemCard", { itemId })` |

Ejemplo:

```html
<ul id="lista"></ul>
<script>
  monday.api('query { me { name email } }').then(function (r) {
    document.getElementById('lista').innerHTML = '<li>' + r.data.me.name + '</li>';
  });
</script>
```

## Desarrollo local

```bash
npm run dev
```

Abre http://localhost:3000. Fuera de monday el widget usa `localStorage` y el puente API devuelve error (solo funciona embebido en monday).

## Despliegue en Vercel

1. Importa el repositorio en Vercel.
2. Framework preset: **Other**. Sin build command ni output directory.
3. Deploy. Anota la URL, p. ej. `https://monday-html-widget.vercel.app`.

## Alta en monday.com

1. En monday, pulsa tu avatar → **Developers** (Centro de desarrolladores).
2. **Create app** → ponle nombre (p. ej. "HTML Widget").
3. Menú **Features** → **Create feature** → elige **Dashboard Widget** (para dashboards) y/o **Board View** (para vistas de tablero) → **Custom URL**.
4. En la feature, pega la URL de Vercel en **Custom URL** y guarda. Repite si creaste dos features.
5. Menú **OAuth & Permissions** → añade el scope `boards:read` (y `boards:write` si tu HTML va a modificar datos vía `monday.api`).
6. Menú **Install** → **Install app** en tu cuenta.
7. En un dashboard: **Add widget** → **Apps** → selecciona tu app. En un tablero: **+** junto a las vistas → **Apps** → selecciona tu app.
8. Pasa el ratón por el widget → **✎ Editar** → pega tu HTML → **Guardar**.

Para publicar cambios de código basta con hacer push: Vercel redespliega y monday carga la URL actualizada.

## Notas de seguridad

- El HTML se ejecuta con `sandbox="allow-scripts allow-forms allow-popups allow-modals allow-downloads"`, sin `allow-same-origin`, por lo que no puede leer cookies ni el DOM del host.
- Solo pueden editar el código usuarios que no sean *view only* ni invitados.
- El acceso a la API se hace con el token de sesión del usuario que visualiza el widget y sus permisos.
