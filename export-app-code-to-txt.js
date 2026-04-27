const fs = require('node:fs')
const path = require('node:path')

const projectRoot = process.cwd()
const appDir = path.join(projectRoot, 'app')
const outputPath = path.resolve(process.argv[2] || 'app-code.txt')

const CODE_EXT = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.css',
  '.html',
  '.json',
  '.md',
  '.py',
  '.yml',
  '.yaml'
])

function isCodeFile(filePath) {
  return CODE_EXT.has(path.extname(filePath).toLowerCase())
}

function walk(dir, out) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'out') continue
    const abs = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      walk(abs, out)
    } else if (entry.isFile() && isCodeFile(abs)) {
      out.push(abs)
    }
  }
}

function main() {
  if (!fs.existsSync(appDir)) {
    throw new Error(`未找到目录: ${appDir}`)
  }

  const files = []
  walk(appDir, files)
  files.sort((a, b) => a.localeCompare(b))

  const chunks = []
  for (const abs of files) {
    const rel = path.relative(projectRoot, abs).replace(/\\/g, '/')
    const content = fs.readFileSync(abs, 'utf8')
    chunks.push(`===== ${rel} =====\n${content}\n`)
  }

  fs.writeFileSync(outputPath, chunks.join('\n'), 'utf8')
  console.log(`已导出 ${files.length} 个文件到: ${outputPath}`)
}

main()
