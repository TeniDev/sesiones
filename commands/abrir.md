---
description: Abre el dashboard de sesiones de Claude Code (lo arranca si no está corriendo)
allowed-tools: Bash(node:*)
---
!`node "${CLAUDE_PLUGIN_ROOT}/server.mjs" --open`

Si la salida de arriba es un error, explícalo en una línea. Si no, responde solo: "Dashboard de sesiones: http://127.0.0.1:4777". No hagas nada más.
