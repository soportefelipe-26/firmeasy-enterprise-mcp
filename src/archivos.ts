import { readFile, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, resolve } from 'node:path';

/**
 * Los documentos van y vienen por disco, no por la conversacion.
 *
 * Un PDF en base64 dentro de una respuesta de herramienta se lleva decenas de miles de
 * tokens y el modelo no puede hacer nada con el: lo unico util es su ruta. Asi que aqui
 * se lee del disco lo que se firma y se escribe en disco lo que vuelve firmado.
 */

/**
 * Lo que cabe en una llamada: la API admite 50 MB por cuerpo. Un documento que viaja en
 * base64 dentro de un JSON (validar, lote) crece un tercio, asi que ahi el limite es menor.
 */
export const MAXIMO_BINARIO = 50 * 1024 * 1024;
export const MAXIMO_EN_JSON = 36 * 1024 * 1024;

/** Ruta absoluta, o relativa al directorio desde el que arranco el cliente. */
export function rutaDe(entrada: string): string {
  return isAbsolute(entrada) ? entrada : resolve(process.cwd(), entrada);
}

export async function leerDocumento(entrada: string, maximo = MAXIMO_BINARIO): Promise<{ bytes: Buffer; ruta: string; nombre: string }> {
  const ruta = rutaDe(entrada);
  let bytes: Buffer;
  try {
    bytes = await readFile(ruta);
  } catch {
    throw new Error(`No se pudo leer «${ruta}». Comprueba la ruta; si es relativa, lo es al directorio desde el que se abrio el cliente.`);
  }

  if (bytes.length === 0) throw new Error(`«${ruta}» esta vacio.`);
  if (bytes.length > maximo) {
    throw new Error(`«${ruta}» pesa ${Math.ceil(bytes.length / 1048576)} MB y el maximo aqui son ${maximo / 1048576} MB.`);
  }

  return { bytes, ruta, nombre: basename(ruta) };
}

/**
 * Donde se deja lo que vuelve. Sin `guardar_en` se escribe al lado del original con un
 * sufijo: es lo que espera quien pidio «firma este contrato» y no dijo nada mas.
 */
export async function guardar(bytes: Buffer, destino: string | undefined, sugerido: string): Promise<string> {
  const ruta = destino ? rutaDe(destino) : join(dirname(rutaDe(sugerido)), conSufijo(basename(sugerido)));
  await writeFile(ruta, bytes);
  return ruta;
}

function conSufijo(nombre: string): string {
  const ext = extname(nombre);
  return `${nombre.slice(0, nombre.length - ext.length)}-firmado${ext || '.pdf'}`;
}
