# sesiones: dashboard de tus sesiones de Claude Code

Una página local (http://127.0.0.1:4777) que muestra en vivo tus sesiones de Claude Code:

- **Estado de cada sesión:** Trabajando, Necesita tu respuesta, Esperándote o Terminada. Las terminadas se pueden cerrar a los 2 minutos y nunca desaparecen solas.
- **% de avance:** el global que declara la sesión, o el de la wave en curso con su tiempo estimado restante.
- **Waves de Workflow:** sus fases y sus agentes, con el tiempo de cada uno, lo que están haciendo y su resultado.
- **Bloques de trabajo:** cada prompt, cuánto duró, qué archivos tocó y qué commits hizo.

Todo es local: el plugin solo lee `~/.claude` (`%USERPROFILE%\.claude` en Windows) y no envía nada fuera de tu PC.

## Requisitos

- **Claude Code** (terminal, VS Code o Desktop) en Windows, macOS o Linux.
- **Node.js 18 o superior** en el PATH. Compruébalo con `node --version`. En Windows se instala con `winget install OpenJS.NodeJS.LTS` o con el instalador LTS de https://nodejs.org. Después de instalarlo, cierra y vuelve a abrir el editor o la terminal.
- **Git**. En Windows ya lo tienes, porque Claude Code necesita Git for Windows.

## Instalar

Dentro de Claude Code:

```
/plugin marketplace add TeniDev/sesiones
/plugin install sesiones@teni
```

O desde una terminal (también sirve PowerShell):

```
claude plugin marketplace add TeniDev/sesiones
claude plugin install sesiones@teni
```

Después abre una sesión nueva de Claude Code para que cargue el plugin.

## Usar

- **`/sesiones:abrir`** arranca el servidor si no está corriendo y abre la página en tu navegador. El servidor sigue funcionando en segundo plano hasta que reinicies el equipo.
- **`/sesiones:progreso`** pide a la sesión que declare su % global, su etapa y métricas de su trabajo; Claude lo actualiza en cada hito. Úsalo en sesiones con un plan largo. Las demás sesiones muestran el avance de su wave en curso.

## Actualizar

```
claude plugin marketplace update teni
claude plugin update sesiones@teni
```

Abre una sesión nueva y ejecuta `/sesiones:abrir`. Si sigue corriendo el servidor de la versión anterior, se reemplaza solo.

## Desinstalar

```
claude plugin uninstall sesiones@teni
claude plugin marketplace remove teni
```

El servidor se detiene al reiniciar el equipo. Para cerrarlo antes:

- **Windows (PowerShell):** `Get-NetTCPConnection -LocalPort 4777 -State Listen | % { Stop-Process -Id $_.OwningProcess }`
- **macOS/Linux:** `lsof -ti:4777 | xargs kill`

El plugin deja dos cosas en `~/.claude`, que puedes borrar: el archivo `sesiones-dashboard.json` y la carpeta `sesiones/`.

## Si algo no funciona

- **`/sesiones:abrir` dice que no encuentra `node`:** falta Node.js o no está en el PATH. Instálalo y reinicia el editor.
- **El puerto 4777 está ocupado por otro programa:** de momento el puerto no se puede cambiar.
- **Una sesión no aparece:** solo se muestran las sesiones vistas mientras el servidor estaba corriendo. Las ejecuciones `claude -p` (headless) se ocultan a propósito.
- **Algo dejó de funcionar tras actualizar Claude Code:** el plugin lee archivos internos de Claude Code que no están documentados, y una actualización puede cambiarlos. Avísale a Teni.
