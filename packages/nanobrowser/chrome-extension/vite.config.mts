import { resolve } from 'node:path'
import { defineConfig, type PluginOption, loadEnv } from "vite"
import libAssetsPlugin from '@laynezh/vite-plugin-lib-assets'
import makeManifestPlugin from './utils/plugins/make-manifest-plugin'

const rootDir = resolve(__dirname)
const srcDir = resolve(rootDir, 'src')
const packagesDir = resolve(rootDir, '..', 'packages')
const outDir = resolve(rootDir, '..', 'dist')

const isDev = process.env.__DEV__ === 'true' || process.env.NODE_ENV !== 'production'
const isProduction = !isDev
const watchOption = isDev ? { include: [srcDir] } : null

const puppeteerBrowsersStub = `var __puppeteer_browsers_stub__={Browser:{CHROME:"chrome",FIREFOX:"firefox",EDGE:"edge"},CDP_WEBSOCKET_ENDPOINT_REGEX:/ws:\\/\\/.*\\/devtools\\/browser\\/.*/,WEBDRIVER_BIDI_WEBSOCKET_ENDPOINT_REGEX:/ws:\\/\\/.*\\/session\\/.*/,TimeoutError:class extends Error{},resolveBuildId:()=>Promise.resolve(""),detectBrowserPlatform:()=>null,getInstalledBrowsers:()=>Promise.resolve([]),uninstall:()=>Promise.resolve(),computeExecutablePath:()=>"",launch:()=>{throw new Error("Not available in extension")},resolveDefaultUserDataDir:()=>"",ChromeReleaseChannel:{}};`

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, resolve(rootDir, '..'), 'VITE_')

  return {
    resolve: {
      alias: {
        '@extension/storage': resolve(packagesDir, 'storage'),
        '@extension/i18n': resolve(packagesDir, 'i18n', 'index.ts'),
        '@extension/shared': resolve(packagesDir, 'shared'),
        '@puppeteer/browsers': resolve(__dirname, 'src/puppeteer-browsers-stub.ts'),
        '@src': resolve(__dirname, 'src'),
      },
      conditions: ['browser', 'module', 'import', 'default'],
      mainFields: ['browser', 'module', 'main']
    },
    server: {
      cors: {
        origin: ['http://localhost:5173', 'http://localhost:3000'],
        methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
        credentials: true
      },
      host: 'localhost',
      sourcemapIgnoreList: false,
    },
    plugins: [
      libAssetsPlugin({ outputPath: outDir }) as PluginOption,
      makeManifestPlugin({ outDir }),
    ],
    publicDir: resolve(rootDir, 'public'),
    build: {
      lib: {
        formats: ['iife'],
        entry: resolve(__dirname, 'src/background/index.ts'),
        name: 'BackgroundScript',
        fileName: 'background',
      },
      outDir,
      emptyOutDir: false,
      sourcemap: isDev,
      minify: isProduction,
      reportCompressedSize: isProduction,
      watch: watchOption,
      rollupOptions: {
        external: [
          'chrome',
          '@puppeteer/browsers',
        ],
        output: {
          inlineDynamicImports: true,
          globals: {
            '@puppeteer/browsers': '__puppeteer_browsers_stub__',
          },
          banner: puppeteerBrowsersStub,
        },
      },
    },
    define: {
      'import.meta.env.DEV': isDev,
      'import.meta.env.VITE_POSTHOG_API_KEY': JSON.stringify(env.VITE_POSTHOG_API_KEY || process.env.VITE_POSTHOG_API_KEY || ''),
    },
    envDir: '../',
    envPrefix: 'VITE_',
  }
})
