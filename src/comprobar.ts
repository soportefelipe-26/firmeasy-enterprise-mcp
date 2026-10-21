/**
 * Prueba de humo: levanta el servidor como lo haria un cliente MCP, lista las
 * herramientas y llama a las dos que no gastan cuota.
 *
 * No sustituye a probar desde Claude o Cursor, pero coge lo que mas se rompe: un esquema
 * de herramienta mal formado —que el cliente rechaza sin decir por que— y las credenciales
 * o la URL mal puestas.
 *
 *   FIRMEASY_AMBIENTE=pruebas FIRMEASY_CLIENT_ID=... FIRMEASY_CLIENT_SECRET=... \
 *     npm run comprobar
 */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const aqui = dirname(fileURLToPath(import.meta.url));

const transporte = new StdioClientTransport({
  command: process.execPath,
  args: [join(aqui, 'index.js')],
  env: {
    FIRMEASY_AMBIENTE: process.env.FIRMEASY_AMBIENTE ?? 'pruebas',
    FIRMEASY_BASE_URL: process.env.FIRMEASY_BASE_URL ?? '',
    FIRMEASY_CLIENT_ID: process.env.FIRMEASY_CLIENT_ID ?? '',
    FIRMEASY_CLIENT_SECRET: process.env.FIRMEASY_CLIENT_SECRET ?? '',
  },
});

const cliente = new Client({ name: 'comprobacion', version: '1.0.0' });
await cliente.connect(transporte);

const { tools } = await cliente.listTools();
console.log(`herramientas: ${tools.length}`);
for (const t of tools) console.log(`  ${t.name.padEnd(22)} ${t.description?.slice(0, 70) ?? ''}`);

for (const nombre of ['configuracion', 'certificados']) {
  const r = (await cliente.callTool({ name: nombre, arguments: {} })) as {
    isError?: boolean;
    content: { type: string; text?: string }[];
  };
  const texto = r.content.map((c) => c.text ?? '').join('');
  console.log(`\n${nombre}: ${r.isError ? 'ERROR' : 'ok'}\n${texto.slice(0, 400)}`);
}

await cliente.close();
