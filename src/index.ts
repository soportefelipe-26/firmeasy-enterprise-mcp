#!/usr/bin/env node
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { ClienteFirmeasy, ErrorApi, configDelEntorno } from './api.js';
import { MAXIMO_EN_JSON, guardar, leerDocumento } from './archivos.js';

/**
 * Servidor MCP de FirmEasy Enterprise: firma con el certificado de agente automatizado de
 * la empresa, valida y consulta, desde cualquier cliente compatible.
 *
 * Habla por stdio, asi que corre en la maquina de quien lo usa y las credenciales no
 * salen de ahi. Eso decide dos cosas del diseño:
 *
 *  - Los documentos viajan por disco. Una herramienta devuelve la ruta del PDF firmado,
 *    no sus bytes: un PDF en base64 en la conversacion cuesta decenas de miles de tokens
 *    y el modelo no puede hacer nada con el.
 *  - Nada se escribe en stdout salvo el protocolo. Cualquier aviso va a stderr o el
 *    cliente se queda sin poder leer las respuestas.
 */

const VERSION = '1.0.0';

/** Lo que el agente lee antes de usar las herramientas. Corto: el detalle va en cada una. */
const INSTRUCCIONES = `Firmas y validaciones con FirmEasy Enterprise, con el certificado de agente automatizado de la empresa (sin intervención de ninguna persona).
- Si el usuario dice «firma este documento», usa «firmar» con la ruta del PDF: vuelve ya firmado y guardado al lado del original. Dile dónde quedó.
- Cada firma consume una unidad del periodo de facturación de la empresa. No firmes dos veces el mismo documento para «probar».
- Para varios documentos usa «firmar_lote» (hasta 20) y después «consultar_lote».
- Si algo falla, cuenta el mensaje de la API tal cual: casi siempre dice qué arreglar (sin periodo de facturación, servicio apagado, sin certificado...).
- Nunca muestres ni pidas el client_secret en la conversación: se configura en el cliente MCP.`;

/** El tiempo que se espera a que termine un trabajo. La API no admite mas de 30. */
const esperar = z
  .number()
  .int()
  .min(1)
  .max(30)
  .optional()
  .describe('Segundos a esperar a que termine antes de contestar (1 a 30). Por defecto 20: lo normal es que vuelva ya terminado.');

const nivel = z
  .enum(['PAdES', 'PAdES-T', 'PAdES-LTA'])
  .optional()
  .describe('Nivel de firma. PAdES es solo la firma; PAdES-T añade sello de tiempo; PAdES-LTA, además, la evidencia para archivo a largo plazo. Sin esto, el que tenga configurado la empresa.');

/** Las opciones de firma, que son las mismas en una firma suelta y en cada documento del lote. */
const opciones = {
  motivo: z.string().max(255).optional().describe('El motivo de la firma. Queda escrito en el PDF y rellena <MOTIVO>.'),
  certificado: z.string().max(64).optional().describe('El id de un certificado de «certificados». Sin esto, el predeterminado de la empresa.'),
  fv_imagen: z.string().max(60).optional().describe('Nombre de una imagen registrada (ver «listar_imagenes») para dibujar en la firma. Sin esto, la de la empresa.'),
  fv_pagina: z.union([z.number().int().min(1), z.literal('todas')]).optional().describe('Página donde se dibuja el recuadro (1 es la primera), o «todas»: sigue siendo una sola firma.'),
  fv_rotacion: z.enum(['auto', '0', '90', '180', '270']).optional().describe('Giro del recuadro en cuartos de vuelta.'),
  fv_x: z.number().int().min(0).optional().describe('Posición horizontal del recuadro, en puntos desde la esquina inferior izquierda. Por defecto 20.'),
  fv_y: z.number().int().min(0).optional().describe('Posición vertical del recuadro, en puntos desde la esquina inferior izquierda. Por defecto 20.'),
  fv_largo: z.number().int().min(20).optional().describe('Ancho del recuadro en puntos. Por defecto 200.'),
  fv_alto: z.number().int().min(10).optional().describe('Alto del recuadro en puntos. Por defecto 60.'),
  fv_texto: z
    .string()
    .max(1000)
    .optional()
    .describe(
      'Texto del recuadro, con líneas separadas por \\n. Marcadores: <FIRMANTE>, <ORGANIZACION>, <RUC>, <TITULO>, <CORREO>, <DIRECCION>, <AREA>, <CIUDAD>, <REGION>, <PAIS>, <SERIE>, <EMISOR>, <VENCE>, <FECHA>, <MOTIVO>. El que el certificado no traiga borra su línea. No escribas el pie «Firmado con firmeasy.legal»: lo añade la empresa.',
    ),
};

/** Una respuesta de herramienta. El JSON va tal cual: el agente sabe leerlo. */
function texto(valor: unknown) {
  return { content: [{ type: 'text' as const, text: typeof valor === 'string' ? valor : JSON.stringify(valor, null, 2) }] };
}

/**
 * Un fallo contado para que el agente pueda actuar. `isError` hace que el cliente lo
 * pase al modelo en vez de cortar la conversacion, que es lo que queremos: casi todos
 * estos errores se arreglan cambiando un parametro y reintentando.
 */
function fallo(e: unknown) {
  const mensaje = e instanceof ErrorApi ? `${e.message} (HTTP ${e.status})` : e instanceof Error ? e.message : String(e);
  return { content: [{ type: 'text' as const, text: mensaje }], isError: true };
}

/** Envuelve la herramienta para que ningun fallo tumbe el servidor. */
function seguro<T>(fn: (args: T) => Promise<ReturnType<typeof texto>>) {
  return async (args: T) => {
    try {
      return await fn(args);
    } catch (e) {
      return fallo(e);
    }
  };
}

/** Quita el documento en base64 de una respuesta y lo deja en disco. */
async function guardarDe(respuesta: Record<string, unknown>, campo: 'documento_base64' | 'zip_base64', destino: string | undefined, sugerido: string) {
  const { [campo]: base64, ...resto } = respuesta;
  if (typeof base64 !== 'string') return resto;
  const ruta = await guardar(Buffer.from(base64, 'base64'), destino, sugerido);
  return { ...resto, guardado_en: ruta };
}

async function main() {
  const api = new ClienteFirmeasy(configDelEntorno());

  const server = new McpServer({ name: 'firmeasy-enterprise', version: VERSION }, { instructions: INSTRUCCIONES });

  server.registerTool(
    'certificados',
    {
      title: 'Certificados de la empresa',
      description:
        'Con qué certificado firma hoy la empresa («en_uso»: el suyo o el demo del sistema, que no tiene validez legal) y sus certificados propios. No gasta firmas: es la primera llamada útil para comprobar que la conexión y las credenciales funcionan.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    seguro(async () => {
      // La lista son los certificados propios; si la empresa firma con el demo del sistema,
      // esta vacia aunque pueda firmar. `en_uso` dice con cual firma de verdad.
      const [en_uso, propios] = await Promise.all([api.certificadoEnUso(), api.certificados()]);
      return texto({ ambiente: api.config.ambiente, en_uso, ...(propios as object) });
    }),
  );

  server.registerTool(
    'configuracion',
    {
      title: 'Qué puede hacer la empresa',
      description:
        'Qué servicios tiene activos la empresa (firmar, sellar, validar), su nivel de firma por defecto y su firma visual. Conviene mirarlo antes de explicar por qué una llamada responde 403.',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    seguro(async () => texto(await api.configuracion())),
  );

  server.registerTool(
    'firmar',
    {
      title: 'Firmar un PDF',
      description:
        'Firma un PDF del disco con el certificado de la empresa y guarda el firmado al lado del original con el sufijo «-firmado» (o donde diga «guardar_en»). Espera a que termine: lo normal es que vuelva ya firmado, con «guardado_en». Si tarda más, devuelve un «id» para «consultar_firma». Consume una firma del periodo.',
      inputSchema: {
        archivo: z.string().describe('Ruta del PDF a firmar. Absoluta, o relativa al directorio desde el que se abrió el cliente.'),
        guardar_en: z.string().optional().describe('Dónde dejar el PDF firmado. Sin esto, al lado del original con el sufijo «-firmado».'),
        destino_url: z.string().url().optional().describe('Si se indica, el firmado se sube a esa URL (https) y no se guarda aquí.'),
        nivel,
        esperar,
        ...opciones,
      },
    },
    seguro(async ({ archivo, guardar_en, esperar: espera, ...query }) => {
      const { bytes, ruta } = await leerDocumento(archivo);
      const trabajo = (await api.firmar(bytes, { ...query, esperar: espera ?? 20 })) as Record<string, unknown>;

      // Sin terminar todavia no hay documento; con destino_url no lo habra nunca aqui.
      if (trabajo.status !== 'COMPLETED' || query.destino_url) {
        return texto({ ...trabajo, siguiente: trabajo.status === 'FAILED' || query.destino_url ? undefined : 'Usa «consultar_firma» con este id.' });
      }
      const completo = (await api.estadoFirma({ id: String(trabajo.id) })) as Record<string, unknown>;
      return texto(await guardarDe(completo, 'documento_base64', guardar_en, ruta));
    }),
  );

  server.registerTool(
    'consultar_firma',
    {
      title: 'Cómo quedó una firma',
      description:
        'Estado de un trabajo de firma y, si ya terminó, el PDF firmado guardado en disco. Es la segunda mitad de «firmar» cuando no terminó a tiempo. El PDF se entrega una sola vez: si ya se recogió o pasó su plazo, vuelve solo el estado.',
      inputSchema: {
        id: z.string().uuid().describe('El id que devolvió «firmar».'),
        guardar_en: z.string().optional().describe('Dónde dejar el PDF firmado. Sin esto, en el directorio actual con el nombre que trae.'),
        esperar,
      },
    },
    seguro(async ({ id, guardar_en, esperar: espera }) => {
      const estado = (await api.estadoFirma({ id, esperar: espera ?? 20 })) as Record<string, unknown>;
      return texto(await guardarDe(estado, 'documento_base64', guardar_en, String(estado.filename ?? `${id}.pdf`)));
    }),
  );

  server.registerTool(
    'validar',
    {
      title: 'Validar un PDF firmado',
      description:
        'Comprueba las firmas de un PDF: si son íntegras, si los certificados eran válidos al firmar y qué nivel tiene cada una. Lee «resumen.valido» para el veredicto; «sin_firmas: true» significa que el PDF no tiene firmas, no que sean inválidas. No consume firmas.',
      inputSchema: {
        archivo: z.string().describe('Ruta del PDF firmado a validar.'),
        esperar,
      },
      annotations: { readOnlyHint: true },
    },
    seguro(async ({ archivo, esperar: espera }) => {
      const { bytes, nombre } = await leerDocumento(archivo, MAXIMO_EN_JSON);
      const informe = (await api.validar(bytes, nombre, espera ?? 20)) as Record<string, unknown>;
      // El informe original del motor es enorme y el resumen ya lo dice todo.
      const { reporte: _, ...resto } = informe;
      return texto(resto);
    }),
  );

  server.registerTool(
    'consultar_validacion',
    {
      title: 'Resultado de una validación',
      description: 'El informe de una validación que no terminó a tiempo.',
      inputSchema: { id: z.string().describe('El id que devolvió «validar».'), esperar },
      annotations: { readOnlyHint: true },
    },
    seguro(async ({ id, esperar: espera }) => {
      const { reporte: _, ...resto } = (await api.estadoValidacion(id, espera ?? 20)) as Record<string, unknown>;
      return texto(resto);
    }),
  );

  server.registerTool(
    'firmar_lote',
    {
      title: 'Firmar varios PDF',
      description:
        'Firma de 1 a 20 documentos en una llamada. Las opciones de fuera valen para todos y cada documento puede pisarlas. Devuelve un «lote» para «consultar_lote», que es donde se recogen los firmados. Cada documento aceptado consume una firma.',
      inputSchema: {
        documentos: z
          .array(
            z.object({
              archivo: z.string().optional().describe('Ruta del PDF en disco. Esto o «url», no los dos.'),
              url: z.string().url().optional().describe('Dirección pública (https) de la que descargarlo, si ya está publicado.'),
              nombre: z.string().max(255).optional().describe('Cómo se llama el documento. Sin esto, el nombre del archivo.'),
              destino_url: z.string().url().optional().describe('Si se indica, este firmado se sube ahí y no vuelve en el zip.'),
              ...opciones,
            }),
          )
          .min(1)
          .max(20),
        referencia: z.string().max(120).optional().describe('Tu referencia del lote. Vuelve tal cual en cada consulta.'),
        tracking_id: z
          .string()
          .uuid()
          .optional()
          .describe('El id del lote, puesto por ti (un UUID). Si se reintenta con el mismo, no se firma nada nuevo: responde 409 y se consulta el que ya existe.'),
        nivel,
        ...opciones,
      },
    },
    seguro(async ({ documentos, ...resto }) => {
      // El zip por documento lo arma el servidor: quien pide «firma esta carpeta» da
      // rutas, no base64, y comprimir a mano seria trabajo del agente sin motivo.
      let total = 0;
      const preparados = [];
      for (const { archivo, url, nombre, ...propias } of documentos) {
        if (!archivo === !url) throw new Error('Cada documento lleva «archivo» o «url», uno de los dos.');
        if (url) {
          preparados.push({ ...propias, nombre: nombre ?? url.split('/').pop() ?? 'documento.pdf', documento_url: url });
          continue;
        }
        const doc = await leerDocumento(archivo!, MAXIMO_EN_JSON);
        const zip = (await comprimir(doc.nombre, doc.bytes)).toString('base64');
        total += zip.length;
        preparados.push({ ...propias, nombre: nombre ?? doc.nombre, documento_zip_base64: zip });
      }
      if (total > 48 * 1024 * 1024) {
        throw new Error('Los documentos juntos pasan de lo que admite una llamada (50 MB). Parte el lote en varios, o usa «url» para los más pesados.');
      }
      return texto(await api.firmarLote({ ...resto, documentos: preparados }));
    }),
  );

  server.registerTool(
    'consultar_lote',
    {
      title: 'Cómo va un lote',
      description:
        'Estado de los documentos de un lote y, si hay firmados nuevos, el zip con ellos guardado en disco. Cada documento se entrega una sola vez: cada consulta trae los que terminaron desde la anterior.',
      inputSchema: {
        lote: z.string().uuid().describe('El «lote» que devolvió «firmar_lote».'),
        guardar_en: z.string().optional().describe('Dónde dejar el zip. Sin esto, en el directorio actual.'),
        esperar,
      },
    },
    seguro(async ({ lote, guardar_en, esperar: espera }) => {
      const estado = (await api.estadoLote({ lote, esperar: espera ?? 20 })) as Record<string, unknown>;
      return texto(await guardarDe(estado, 'zip_base64', guardar_en, `lote-${lote.slice(0, 8)}.zip`));
    }),
  );

  server.registerTool(
    'listar_imagenes',
    {
      title: 'Imágenes de firma visual',
      description: 'Las imágenes registradas (logo o rúbrica) que se pueden dibujar en la firma con «fv_imagen».',
      inputSchema: {},
      annotations: { readOnlyHint: true },
    },
    seguro(async () => texto(await api.imagenes())),
  );

  server.registerTool(
    'registrar_imagen',
    {
      title: 'Registrar una imagen de firma',
      description:
        'Sube un PNG o JPEG (hasta 5 MB) para dibujarlo en la firma. Si ya existe una con ese nombre, la reemplaza. El nombre vuelve normalizado (minúsculas, con guiones): es el que se usa en «fv_imagen». Máximo 10 imágenes.',
      inputSchema: {
        archivo: z.string().describe('Ruta del PNG o JPEG.'),
        nombre: z.string().max(60).describe('Con qué nombre se registra, por ejemplo «logo» o «rubrica-gerente».'),
      },
    },
    seguro(async ({ archivo, nombre }) => {
      const { bytes } = await leerDocumento(archivo, 5 * 1024 * 1024);
      return texto(await api.registrarImagen(nombre, bytes));
    }),
  );

  server.registerTool(
    'borrar_imagen',
    {
      title: 'Borrar una imagen de firma',
      description: 'Quita una imagen registrada y devuelve las que quedan. Los documentos ya firmados no cambian.',
      inputSchema: { nombre: z.string().describe('El nombre (o el id) de la imagen.') },
      annotations: { destructiveHint: true },
    },
    seguro(async ({ nombre }) => texto(await api.borrarImagen(nombre))),
  );

  await server.connect(new StdioServerTransport());
}

/** Un zip de un solo archivo, sin dependencias: es lo que espera `documento_zip_base64`. */
async function comprimir(nombre: string, bytes: Buffer): Promise<Buffer> {
  const { deflateRawSync, crc32 } = await import('node:zlib');
  const nombreBytes = Buffer.from(nombre, 'utf8');
  const comprimido = deflateRawSync(bytes);
  const crc = crc32(bytes);

  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0);
  local.writeUInt16LE(20, 4);
  local.writeUInt16LE(0x0800, 6); // nombre en UTF-8
  local.writeUInt16LE(8, 8); // deflate
  local.writeUInt32LE(crc, 14);
  local.writeUInt32LE(comprimido.length, 18);
  local.writeUInt32LE(bytes.length, 22);
  local.writeUInt16LE(nombreBytes.length, 26);

  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0);
  central.writeUInt16LE(20, 4);
  central.writeUInt16LE(20, 6);
  central.writeUInt16LE(0x0800, 8);
  central.writeUInt16LE(8, 10);
  central.writeUInt32LE(crc, 16);
  central.writeUInt32LE(comprimido.length, 20);
  central.writeUInt32LE(bytes.length, 24);
  central.writeUInt16LE(nombreBytes.length, 28);

  const fin = Buffer.alloc(22);
  const tamCentral = central.length + nombreBytes.length;
  const desdeCentral = local.length + nombreBytes.length + comprimido.length;
  fin.writeUInt32LE(0x06054b50, 0);
  fin.writeUInt16LE(1, 8);
  fin.writeUInt16LE(1, 10);
  fin.writeUInt32LE(tamCentral, 12);
  fin.writeUInt32LE(desdeCentral, 16);

  return Buffer.concat([local, nombreBytes, comprimido, central, nombreBytes, fin]);
}

main().catch((e: unknown) => {
  // A stderr: stdout es el canal del protocolo y escribir ahi rompe al cliente.
  console.error(`[firmeasy-mcp] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
