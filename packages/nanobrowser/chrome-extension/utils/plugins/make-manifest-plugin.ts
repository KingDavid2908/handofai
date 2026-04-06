import fs from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import process from 'node:process';
import type { PluginOption } from 'vite';

const rootDir = resolve(__dirname, '..', '..');
const manifestFile = resolve(rootDir, 'manifest.js');

const getManifestWithCacheBurst = (): Promise<{ default: chrome.runtime.ManifestV3 }> => {
  const withCacheBurst = (path: string) => `${path}?${Date.now().toString()}`;
  if (process.platform === 'win32') {
    return import(withCacheBurst(pathToFileURL(manifestFile).href));
  }
  return import(withCacheBurst(manifestFile));
};

function manifestToString(manifest: chrome.runtime.ManifestV3): string {
  return JSON.stringify(manifest, null, 2);
}

export default function makeManifestPlugin(config: { outDir: string }): PluginOption {
  function makeManifest(manifest: chrome.runtime.ManifestV3, to: string) {
    if (!fs.existsSync(to)) {
      fs.mkdirSync(to);
    }
    const manifestPath = resolve(to, 'manifest.json');
    fs.writeFileSync(manifestPath, manifestToString(manifest));
    console.log(`Manifest file copy complete: ${manifestPath}`);
  }

  return {
    name: 'make-manifest',
    buildStart() {
      this.addWatchFile(manifestFile);
    },
    async writeBundle() {
      const outDir = config.outDir;
      const manifest = await getManifestWithCacheBurst();
      makeManifest(manifest.default, outDir);
    },
  };
}
