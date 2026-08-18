# Kenta · Control de Envíos y Depósito — v2026-08-18-v9

Dos archivos, y los dos se reemplazan enteros. **Publicá el backend primero.**

| Archivo | Dónde va |
|---|---|
| `Code.gs` | Apps Script del QR Flex MELI. Reemplaza al actual, completo. |
| `index.html` | Repo de GitHub Pages. Reemplaza al actual. |

## Pasos

1. **Backend.** Apps Script → `Code.gs` → Ctrl+A y pegá el nuevo encima → guardar 💾.
2. Elegí la función **`ocProbar`** en el selector de arriba → ▶ Ejecutar.
   Google va a pedir permisos nuevos (conexión externa, por VTEX): aceptá. Si sale el
   cartel de "app no verificada": *Configuración avanzada → Ir a…*.
   En el registro tenés que ver:
   ```
   Ping VTEX: {"ok":true,"ms":430}
   Pedidos listos para preparación: 16
   ```
3. **Implementar → Administrar implementaciones → ✏️ → Versión: Nueva versión → Implementar.**
   La URL `/exec` no cambia.
4. **Frontend.** Reemplazá el `index.html` del repo, esperá 1–2 minutos, recargá con Ctrl+F5.

El sello de versión subió a `2026-08-18-v9` en los dos archivos. Si publicás uno solo,
la app te avisa con el cartel rojo de backend desactualizado — es la señal de que faltó un paso.

No hay que crear ninguna pestaña en el Sheet: `Pedidos_OnCity` se crea sola con el primer escaneo.

## Qué incluye

**Tu v8 completo, intacto.** Registro/Log con su acción `logs`, corte quincenal en sábado,
backfill optimizado, login registrado, detalle por día del Financiero. Verifiqué marcador por
marcador que no falte nada y que no queden restos de la versión vieja.

**Arreglo del falso "Ya estaba registrado".** La causa era un doble disparo: el campo de CP
programaba un `confirmar()` a los 120 ms al llegar a 4 dígitos, y el Enter disparaba otro en el
acto. Si el operario tipeaba el CP y presionaba Enter, el envío se registraba dos veces: la
primera entraba bien y la segunda volvía como DUPLICADO del mismo usuario y el mismo minuto.
De ahí colgaban los otros dos síntomas: el contador bajaba (11 → 10) y "Actualizar" no limpiaba
la fila roja, porque los registros locales se ponían antes que los del servidor y la tapaban.
Además, la guarda `saving` estaba declarada pero nunca se activaba: era código muerto.
Los tres quedaron arreglados y el duplicado real de otro operario sigue avisando.

**Solapa "Escaneo OnCity".** Picking de pedidos de VTEX con el mismo login y la misma planilla:
escaneo masivo con lista consolidada de qué bajar del depósito, escaneo individual que muestra
qué producto va en cada caja, historial buscable y control de duplicados compartido entre PCs.

## Lo único que falta definir

Los operarios del depósito no están en `ROLES`, así que hoy no pueden entrar. En `Code.gs`,
arriba de todo:

```js
var ROLES = {
  'juan.alonso@bitek.com.ar': 'admin',
  'coordinacion@bitek.com.ar': 'coordinacion',
  'deposito@bitek.com.ar': 'deposito'        // <- ve SOLO las dos solapas de escaneo
};
```
