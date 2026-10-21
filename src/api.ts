/**
 * El cliente de la API de FirmEasy Enterprise.
 *
 * Aqui vive lo unico que no es traduccion directa: el canje de client_id y client_secret
 * por un token, y su renovacion. El resto del servidor no sabe que existen credenciales.
 */

/** Las direcciones de cada ambiente. Cada uno tiene sus propias empresas y credenciales. */
export const AMBIENTES = {
  pruebas: 'https://enterprisesandbox.firmeasy.legal/api',
  produccion: 'https://enterprise.digital.firmeasy.legal/api',
} as const;

export interface Config {
  baseUrl: string;
  ambiente: string;
  clientId: string;
  clientSecret: string;
}

/**
 * Lo que trae el entorno. Se lee una vez y se falla pronto: sin esto no hay nada que hacer.
 *
 * El ambiente se elige por nombre (`pruebas` o `produccion`), que es lo que entiende quien
 * instala. `FIRMEASY_BASE_URL` sigue valiendo para apuntar a otra direccion.
 */
export function configDelEntorno(): Config {
  const ambiente = (process.env.FIRMEASY_AMBIENTE ?? 'pruebas').trim().toLowerCase().replace('producción', 'produccion');
  const propia = (process.env.FIRMEASY_BASE_URL ?? '').trim().replace(/\/+$/, '');
  const clientId = (process.env.FIRMEASY_CLIENT_ID ?? '').trim();
  const clientSecret = (process.env.FIRMEASY_CLIENT_SECRET ?? '').trim();

  if (!propia && !(ambiente in AMBIENTES)) {
    throw new Error(`FIRMEASY_AMBIENTE tiene que ser «pruebas» o «produccion» (llego «${ambiente}»).`);
  }

  const faltan = [!clientId && 'FIRMEASY_CLIENT_ID', !clientSecret && 'FIRMEASY_CLIENT_SECRET'].filter(Boolean);
  if (faltan.length) {
    throw new Error(
      `Faltan variables de entorno: ${faltan.join(', ')}. ` +
        'Se configuran en el cliente MCP, en el bloque "env" del servidor. ' +
        'El client_id y el client_secret estan en el panel de FirmEasy, en Mi Empresa → Configurar → Credenciales de integracion.',
    );
  }

  return {
    baseUrl: propia || AMBIENTES[ambiente as keyof typeof AMBIENTES],
    ambiente: propia ? 'personalizado' : ambiente,
    clientId,
    clientSecret,
  };
}

/** Un error de la API con su codigo, para poder contarle al agente que hacer. */
export class ErrorApi extends Error {
  constructor(
    readonly status: number,
    readonly cuerpo: unknown,
    mensaje: string,
  ) {
    super(mensaje);
    this.name = 'ErrorApi';
  }
}

/** El mensaje que manda la API, que casi siempre dice exactamente que arreglar. */
function mensajeDe(cuerpo: unknown, status: number): string {
  if (cuerpo && typeof cuerpo === 'object') {
    const c = cuerpo as Record<string, unknown>;
    const partes = [c.error, c.message ?? c.error_description]
      .flatMap((m) => (Array.isArray(m) ? m : [m]))
      .filter((m): m is string => typeof m === 'string' && m.length > 0);
    if (partes.length) return [...new Set(partes)].join(': ');
  }
  return `La API respondio ${status}.`;
}

export class ClienteFirmeasy {
  /**
   * El token y cuando caduca. Se guarda porque una conversacion con un agente son muchas
   * llamadas seguidas y pedir un token en cada una gasta una peticion de cada dos.
   */
  private token: { valor: string; caducaEn: number } | null = null;

  constructor(readonly config: Config) {}

  /** Token vigente, pidiendo uno nuevo si el que hay se acaba dentro de poco. */
  private async accessToken(forzar = false): Promise<string> {
    // Treinta segundos de margen: entre que se decide usarlo y llega al servidor pasa
    // tiempo, y un token que caduca en vuelo da un 401 que parece de credenciales malas.
    if (!forzar && this.token && this.token.caducaEn - 30_000 > Date.now()) return this.token.valor;

    const res = await fetch(`${this.config.baseUrl}/v1/oauth/token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        grant_type: 'client_credentials',
        client_id: this.config.clientId,
        client_secret: this.config.clientSecret,
      }),
    });

    const cuerpo = await res.json().catch(() => null);
    if (!res.ok) {
      throw new ErrorApi(
        res.status,
        cuerpo,
        res.status === 401
          ? `Las credenciales no valen en el ambiente «${this.config.ambiente}». Revisa el client_id y el client_secret (son distintos en pruebas y en produccion) y que la empresa no este suspendida.`
          : mensajeDe(cuerpo, res.status),
      );
    }

    const { access_token, expires_in } = cuerpo as { access_token: string; expires_in: number };
    this.token = { valor: access_token, caducaEn: Date.now() + expires_in * 1000 };
    return access_token;
  }

  /**
   * Una peticion a la API. `cuerpo` va en JSON salvo que sea un Buffer, que es como
   * viajan el PDF que se firma y el que se valida.
   */
  private async peticion(
    metodo: string,
    ruta: string,
    opciones: { query?: Record<string, unknown>; cuerpo?: unknown; tipo?: string } = {},
    reintento = false,
  ): Promise<unknown> {
    const url = new URL(this.config.baseUrl + ruta);
    for (const [k, v] of Object.entries(opciones.query ?? {})) {
      if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    }

    const cabeceras: Record<string, string> = { Authorization: `Bearer ${await this.accessToken(reintento)}` };
    let body: Uint8Array | string | undefined;
    if (Buffer.isBuffer(opciones.cuerpo)) {
      cabeceras['Content-Type'] = opciones.tipo ?? 'application/pdf';
      body = new Uint8Array(opciones.cuerpo);
    } else if (opciones.cuerpo !== undefined) {
      cabeceras['Content-Type'] = 'application/json';
      body = JSON.stringify(opciones.cuerpo);
    }

    const res = await fetch(url, { method: metodo, headers: cabeceras, body });
    const cuerpo = await res.json().catch(() => null);

    // Un token que el servidor da por vencido antes de tiempo: uno nuevo y una vez mas.
    if (res.status === 401 && !reintento && (cuerpo as { error?: string } | null)?.error === 'invalid_token') {
      return this.peticion(metodo, ruta, opciones, true);
    }
    // 202 no es un fallo: es el trabajo en curso, y su cuerpo trae el identificador.
    if (!res.ok) throw new ErrorApi(res.status, cuerpo, mensajeDe(cuerpo, res.status));
    return cuerpo;
  }

  /* ---------------- lo que usa el servidor ---------------- */

  certificados() {
    return this.peticion('GET', '/v1/certificates');
  }

  /** El que firma hoy: el predeterminado de la empresa o el demo del sistema. */
  certificadoEnUso() {
    return this.peticion('GET', '/v1/certificate');
  }

  configuracion() {
    return this.peticion('GET', '/v1/config');
  }

  firmar(pdf: Buffer, query: Record<string, unknown>) {
    return this.peticion('POST', '/v1/sign', { cuerpo: pdf, query });
  }

  estadoFirma(cuerpo: { id: string; esperar?: number; documento?: boolean }) {
    return this.peticion('POST', '/v1/sign/status', { cuerpo });
  }

  firmarLote(cuerpo: unknown) {
    return this.peticion('POST', '/v1/sign/batch', { cuerpo });
  }

  estadoLote(cuerpo: unknown) {
    return this.peticion('POST', '/v1/sign/batch/status', { cuerpo });
  }

  validar(pdf: Buffer, nombre: string, esperar?: number) {
    return this.peticion('POST', '/v1/validate', { cuerpo: { documento_base64: pdf.toString('base64'), nombre, esperar } });
  }

  estadoValidacion(id: string, esperar?: number) {
    return this.peticion('GET', `/v1/validate/${encodeURIComponent(id)}`, { query: { esperar } });
  }

  registrarImagen(nombre: string, imagen: Buffer) {
    return this.peticion('POST', '/v1/signature-image', { cuerpo: { nombre, imagen_base64: imagen.toString('base64') } });
  }

  imagenes() {
    return this.peticion('GET', '/v1/signature-images');
  }

  borrarImagen(nombre: string) {
    return this.peticion('DELETE', `/v1/signature-image/${encodeURIComponent(nombre)}`);
  }
}
