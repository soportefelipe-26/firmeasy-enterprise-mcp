/**
 * Arma el archivo que el cliente instala en Claude Desktop con doble clic:
 * `paquete/firmeasy-enterprise.mcpb`.
 *
 * Un .mcpb es un zip con el manifest.json, el servidor compilado y sus node_modules: en el
 * equipo del cliente no se instala nada mas. Lo empaqueta la herramienta oficial
 * (@anthropic-ai/mcpb), que ademas valida el manifiesto.
 *
 *   npm run empaquetar
 */
import { execSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const raiz = join(dirname(fileURLToPath(import.meta.url)), '..');
const armado = join(raiz, 'build', 'mcpb');
const salida = join(raiz, 'paquete');
const destino = join(salida, 'firmeasy-enterprise.mcpb');

const paquete = JSON.parse(readFileSync(join(raiz, 'package.json'), 'utf8'));
const manifiesto = JSON.parse(readFileSync(join(raiz, 'manifest.json'), 'utf8'));
if (manifiesto.version !== paquete.version) {
  throw new Error(`La version del manifest.json (${manifiesto.version}) no es la del package.json (${paquete.version}).`);
}

rmSync(armado, { recursive: true, force: true });
mkdirSync(join(armado, 'dist'), { recursive: true });
mkdirSync(salida, { recursive: true });

cpSync(join(raiz, 'manifest.json'), join(armado, 'manifest.json'));
for (const archivo of ['index.js', 'api.js', 'archivos.js']) {
  cpSync(join(raiz, 'dist', archivo), join(armado, 'dist', archivo));
}
if (existsSync(join(raiz, 'icon.png'))) cpSync(join(raiz, 'icon.png'), join(armado, 'icon.png'));

// Solo las dependencias de ejecucion: TypeScript y los tipos no viajan.
writeFileSync(
  join(armado, 'package.json'),
  JSON.stringify({ name: paquete.name, version: paquete.version, type: 'module', private: true, dependencies: paquete.dependencies }, null, 2),
);
execSync('npm install --omit=dev --no-audit --no-fund', { cwd: armado, stdio: 'inherit' });

rmSync(destino, { force: true });
execSync(`npx --yes @anthropic-ai/mcpb pack "${armado}" "${destino}"`, { cwd: raiz, stdio: 'inherit' });

if (!existsSync(destino)) throw new Error('No se genero el .mcpb.');
console.log(`\nListo: ${destino} (${Math.round(statSync(destino).size / 1024)} KB)`);
