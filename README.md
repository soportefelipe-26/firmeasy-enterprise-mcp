# FirmEasy Enterprise para tu IA

Conecta tu asistente de IA (Claude, Cursor, Codex, Gemini CLI, VS Code…) a **FirmEasy Enterprise** y pídele en lenguaje normal:

> «Firma el contrato que está en mi escritorio.»
> «Firma todos los PDF de la carpeta *planillas* con sello de tiempo y dime cuáles fallaron.»
> «¿Este PDF tiene la firma válida?»

La IA firma con el **certificado de agente automatizado de tu empresa**, sin que intervenga ninguna persona, y deja el PDF firmado al lado del original.

- **Tus credenciales no salen de tu equipo.** El servidor corre en tu computadora; no las guardamos en ningún sitio.
- **Los documentos no pasan por el chat.** Se leen y se guardan en tu disco; a la IA solo le llega la ruta.
- **Cada firma consume una unidad** del periodo de facturación de tu empresa. Validar no consume.

> Solo cubre la firma con el certificado de la empresa (API Agente Automatizado). La firma con DNIe en el celular y la Firma Remota necesitan que una persona ponga su DNI o su PIN, y eso no lo puede hacer una IA.

## Antes de empezar

1. **Tus credenciales:** en el panel de FirmEasy, **Mi Empresa → Configurar → Credenciales de integración**. Copia el **Client ID** y genera el **Client Secret** (se muestra una sola vez; si lo pierdes, generas otro y el anterior deja de valer).
2. **El ambiente:** `pruebas` o `produccion`. Las credenciales de uno no valen en el otro. **Empieza por pruebas**: en producción cada firma es real y se cobra.
3. Tu empresa necesita el servicio de firma activo, un certificado (o el demo, para pruebas) y un periodo de facturación abierto. Si falta algo, la IA te dirá exactamente qué.

## Instalación

### Claude Desktop (lo más fácil)

1. Descarga **`firmeasy-enterprise.mcpb`** de la sección [Releases](../../releases) de este repositorio.
2. Haz doble clic en el archivo (o arrástralo a la ventana de Claude Desktop).
3. Claude te pide **Client ID**, **Client Secret** y **Ambiente**. El secreto queda guardado en el almacén seguro del sistema.
4. Listo. Escribe: *«Comprueba mi conexión con FirmEasy»*.

### Claude Code

```bash
claude mcp add firmeasy --env FIRMEASY_AMBIENTE=pruebas --env FIRMEASY_CLIENT_ID=fe_... --env FIRMEASY_CLIENT_SECRET=cs_live_... -- npx -y github:soportefelipe-26/firmeasy-enterprise-mcp
```

En Windows (sin WSL), cambia el final por `-- cmd /c npx -y github:soportefelipe-26/firmeasy-enterprise-mcp`.

### Cursor — `.cursor/mcp.json` (o `~/.cursor/mcp.json` para todos tus proyectos)

```json
{
  "mcpServers": {
    "firmeasy": {
      "command": "npx",
      "args": ["-y", "github:soportefelipe-26/firmeasy-enterprise-mcp"],
      "env": {
        "FIRMEASY_AMBIENTE": "pruebas",
        "FIRMEASY_CLIENT_ID": "fe_...",
        "FIRMEASY_CLIENT_SECRET": "cs_live_..."
      }
    }
  }
}
```

### Codex (CLI y extensión) — `~/.codex/config.toml`

```toml
[mcp_servers.firmeasy]
command = "npx"
args = ["-y", "github:soportefelipe-26/firmeasy-enterprise-mcp"]

[mcp_servers.firmeasy.env]
FIRMEASY_AMBIENTE = "pruebas"
FIRMEASY_CLIENT_ID = "fe_..."
FIRMEASY_CLIENT_SECRET = "cs_live_..."
```

### Gemini CLI — `~/.gemini/settings.json`

```json
{
  "mcpServers": {
    "firmeasy": {
      "command": "npx",
      "args": ["-y", "github:soportefelipe-26/firmeasy-enterprise-mcp"],
      "env": {
        "FIRMEASY_AMBIENTE": "pruebas",
        "FIRMEASY_CLIENT_ID": "fe_...",
        "FIRMEASY_CLIENT_SECRET": "cs_live_..."
      }
    }
  }
}
```

### VS Code (Copilot) — `.vscode/mcp.json`

```json
{
  "servers": {
    "firmeasy": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "github:soportefelipe-26/firmeasy-enterprise-mcp"],
      "env": {
        "FIRMEASY_AMBIENTE": "pruebas",
        "FIRMEASY_CLIENT_ID": "fe_...",
        "FIRMEASY_CLIENT_SECRET": "cs_live_..."
      }
    }
  }
}
```

Después de cambiar la configuración, **reinicia el cliente**: ninguno la relee en caliente. Las opciones con `npx` necesitan **Node 20 o superior** y **Git**: la primera vez descargan y preparan el servidor desde este repositorio (tarda un minuto), las siguientes ya arrancan al momento. Claude Desktop no necesita nada de esto.

> **ChatGPT (web) y la app de Gemini** solo se conectan a servidores alojados en internet, no a uno que corre en tu equipo. Por ahora no son compatibles.

## Qué puede hacer

| Herramienta | Qué hace | ¿Consume firmas? |
|---|---|---|
| `certificados` | Con qué certificado firma tu empresa y cuáles tiene | No |
| `configuracion` | Qué servicios tiene activos y su nivel de firma por defecto | No |
| `firmar` | Firma un PDF del disco y guarda el firmado al lado (`-firmado.pdf`) | Sí, una |
| `consultar_firma` | Recoge una firma que tardó más de lo esperado | No |
| `firmar_lote` | Firma de 1 a 20 PDF en una llamada | Una por documento |
| `consultar_lote` | Cómo va el lote; guarda un zip con los firmados | No |
| `validar` | Comprueba las firmas de un PDF | No |
| `consultar_validacion` | Recoge una validación que tardó | No |
| `listar_imagenes` · `registrar_imagen` · `borrar_imagen` | El logo o la rúbrica que se dibuja en la firma | No |

Puedes pedir el **nivel** (*«con sello de tiempo»* = `PAdES-T`, *«para archivo a largo plazo»* = `PAdES-LTA`), el **motivo**, el **certificado**, y dónde y cómo se dibuja la firma (*«en la última página, abajo a la derecha, con mi logo»*).

## Problemas frecuentes

| Lo que ves | Qué hacer |
|---|---|
| «Las credenciales no valen en el ambiente…» | El Client ID o el Secret están mal, o son de otro ambiente. |
| «No active billing period found» (402) | Tu empresa no tiene periodo de facturación abierto: pídelo a tu proveedor. |
| «Quota exceeded» (403) | Se acabaron las firmas del periodo. |
| «Agent signing disabled» (403) | El servicio de firma está apagado para tu empresa. |
| «No certificate» / «Certificate expired» (412) | Tu empresa no tiene certificado, o venció. |
| La IA no ve las herramientas | Revisa la configuración y reinicia el cliente. Prueba `npx -y github:soportefelipe-26/firmeasy-enterprise-mcp` en una terminal: si falta algo, lo dice. |

## Para desarrolladores

```bash
npm install
npm run build

# Comprueba credenciales y conexión (no gasta firmas)
FIRMEASY_AMBIENTE=pruebas FIRMEASY_CLIENT_ID=... FIRMEASY_CLIENT_SECRET=... npm run comprobar

# Genera paquete/firmeasy-enterprise.mcpb para Claude Desktop
npm run empaquetar
```

Variables de entorno: `FIRMEASY_AMBIENTE` (`pruebas` por defecto, o `produccion`), `FIRMEASY_CLIENT_ID`, `FIRMEASY_CLIENT_SECRET` y, opcional, `FIRMEASY_BASE_URL` para apuntar a otra dirección de la API.
