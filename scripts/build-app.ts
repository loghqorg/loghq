import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'

const projectRoot = resolve(import.meta.dir, '..')
const compatibilityPath = resolve(projectRoot, 'pages')
const viewsPath = resolve(projectRoot, 'resources/views')
const relativeViewsPath = 'resources/views'

let createdCompatibilityLink = false

if (existsSync(compatibilityPath)) {
  const stat = lstatSync(compatibilityPath)
  const existingTarget = stat.isSymbolicLink()
    ? resolve(projectRoot, readlinkSync(compatibilityPath))
    : null

  if (existingTarget !== viewsPath) {
    throw new Error('Cannot build: the root pages path already exists and is not the expected resources/views link.')
  }
}
else {
  // The current SSR builder discovers only a root pages directory and does not
  // honor ui.pagesDir. Keep the source layout canonical and expose it only while
  // the framework compiles the application.
  symlinkSync(relativeViewsPath, compatibilityPath, 'dir')
  createdCompatibilityLink = true
}

try {
  const build = Bun.spawn(['./buddy', 'build'], {
    cwd: projectRoot,
    stdin: 'inherit',
    stdout: 'inherit',
    stderr: 'inherit',
  })
  const exitCode = await build.exited

  if (exitCode !== 0)
    process.exitCode = exitCode
}
finally {
  if (createdCompatibilityLink && existsSync(compatibilityPath))
    unlinkSync(compatibilityPath)
}
