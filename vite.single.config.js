import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'
import { viteSingleFile } from 'vite-plugin-singlefile'

const root = path.dirname(fileURLToPath(import.meta.url))
const publicDir = path.join(root, 'public')

function escapeForScript(json) {
  // JSON 允许 \u003c 转义，可避免词条内容里的 </script> 提前结束标签。
  return json.replace(/</g, '\\u003c')
}

/**
 * 把 1 MB 索引与 8.7 MB 完整词库内联进最终 HTML，
 * 同时把 favicon 转成 data URI，保证产物只有一个文件且完全离线可用。
 */
function inlineDictionaryPlugin() {
  return {
    name: 'wordvault-inline-dictionary',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const htmlFile = Object.keys(bundle).find((name) => name.endsWith('.html'))
      if (!htmlFile) return
      const asset = bundle[htmlFile]
      if (!asset || asset.type !== 'asset') return

      const read = (file) => fs.readFileSync(path.join(publicDir, file), 'utf8')
      const indexJson = escapeForScript(read('data/index.json'))
      const dictionaryJson = escapeForScript(read('data/dictionary.json'))
      const favicon = fs.readFileSync(path.join(publicDir, 'favicon.svg')).toString('base64')

      let html = String(asset.source)
      html = html.replace(
        /<link rel="icon"[^>]*>/,
        `<link rel="icon" href="data:image/svg+xml;base64,${favicon}" />`,
      )
      html = html.replace(
        '</body>',
        [
          `<script type="application/json" id="wordvault-index">${indexJson}</script>`,
          `<script type="application/json" id="wordvault-dictionary">${dictionaryJson}</script>`,
          '</body>',
        ].join('\n'),
      )

      asset.source = html
      this.info(
        `已内联本地词库：index ${(indexJson.length / 1048576).toFixed(2)} MB，dictionary ${(
          dictionaryJson.length /
          1048576
        ).toFixed(2)} MB`,
      )
    },
  }
}

export default defineConfig({
  plugins: [react(), viteSingleFile({ removeViteModuleLoader: true }), inlineDictionaryPlugin()],
  define: {
    'import.meta.env.VITE_SINGLE_FILE': 'true',
  },
  publicDir: false,
  build: {
    outDir: 'dist-single',
    emptyOutDir: true,
    assetsInlineLimit: 1024 * 1024 * 64,
    cssCodeSplit: false,
    chunkSizeWarningLimit: 16000,
  },
})
