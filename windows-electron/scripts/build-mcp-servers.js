#!/usr/bin/env node
/**
 * Build builtin MCP server scripts as fully self-contained CJS bundles.
 *
 * electron-vite's externalizeDepsPlugin leaves all npm packages as require()
 * calls, which works for Electron's main process (ASAR virtual FS patches
 * require()) but fails when an external `node` process runs the script from
 * app.asar.unpacked — there is no ASAR support there.
 *
 * This script uses esbuild's programmatic API (instead of CLI flags) to avoid
 * shell-quoting issues with special characters in --define values.
 */

const esbuild = require('esbuild');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const SHARED_OPTIONS = {
  bundle: true,
  platform: 'node',
  format: 'cjs',
  external: ['electron'],
  tsconfig: path.join(ROOT, 'tsconfig.json'),
  loader: { '.wasm': 'empty' },
};

async function main() {
  await Promise.all([
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/imageGenServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-image-gen.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/browserServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-browser.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/cockpitServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-cockpit.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/resources/builtinMcp/computerUseServer.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-computer-use.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/cockpit/cuaDriver/cuaDriverProxy.ts')],
      outfile: path.join(ROOT, 'out/main/builtin-mcp-cua-driver.js'),
    }),
    esbuild.build({
      ...SHARED_OPTIONS,
      entryPoints: [path.join(ROOT, 'packages/desktop/src/process/cockpit/remote/sshClaudeMain.ts')],
      outfile: path.join(ROOT, 'out/main/cockpit-ssh-claude.js'),
    }),
  ]);
}

main().catch((err) => {
  console.error('MCP server build failed:', err);
  process.exit(1);
});
