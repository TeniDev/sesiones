---
name: progreso
description: Reporta el avance GLOBAL de esta sesión al dashboard de sesiones (porcentaje del plan, etapa, paso actual y métricas del dominio). Úsalo cuando trabajes un plan de varios pasos (etapas, waves, fases, migraciones) o cuando el usuario pida reportar o actualizar el progreso; actualízalo en cada hito.
---

# Reportar el progreso al dashboard

El dashboard (`/sesiones:abrir`, http://127.0.0.1:4777) ya mide solo las waves y los bloques; lo que no puede saber es cuánto falta del plan. Eso lo declaras tú reescribiendo completo el archivo de ESTA sesión:

```bash
mkdir -p ~/.claude/sesiones/progress && cat > ~/.claude/sesiones/progress/$CLAUDE_CODE_SESSION_ID.json <<'JSON'
{
  "percent": 27,
  "stage": "Etapa 2 de 4 · módulo de pagos",
  "step": "Migración a la arquitectura nueva",
  "basis": "Ponderado por pasos: la migración pesa más; un paso en curso cuenta según su avance",
  "startedAt": "2026-10-05T10:26:00Z",
  "metrics": [
    { "label": "Tareas cerradas", "value": "12/30" },
    { "label": "Tests en rojo", "value": 4 },
    { "label": "Archivos por migrar", "value": 310 }
  ]
}
JSON
```

Si tu shell es PowerShell (Windows), escribe el mismo JSON con `Set-Content` en `$HOME\.claude\sesiones\progress\$env:CLAUDE_CODE_SESSION_ID.json` (crea la carpeta con `New-Item -ItemType Directory -Force`).

Reglas:
- `percent` (obligatorio, 0–100) es el avance del objetivo COMPLETO de la sesión, no el de la wave actual. Estímalo ponderando los pasos del plan por su esfuerzo y explica el criterio en `basis` (una línea).
- `stage` es la parte del plan en la que vas (etapa, wave, hito) y `step` el paso actual en pocas palabras.
- `metrics` son 3–6 números del dominio que muestren cuánto falta (conflictos, archivos pendientes, tests en rojo, decisiones abiertas...). Mídelos con un comando, nunca los inventes.
- `startedAt` (opcional) es la fecha ISO en que empezó la etapa.
- Actualízalo al arrancar el plan y en cada hito (wave lanzada o terminada, cambio de etapa, commit), no en cada paso pequeño. Es un solo comando: no se lo anuncies al usuario.
