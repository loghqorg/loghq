import { existsSync, lstatSync, readlinkSync, symlinkSync, unlinkSync } from 'node:fs'
import { resolve } from 'node:path'
import { buildForProduction } from '@stacksjs/stx'

const projectRoot = resolve(import.meta.dir, '..')
const resourcesRoot = resolve(projectRoot, 'resources')
const compatibilityPath = resolve(resourcesRoot, 'pages')
const viewsPath = resolve(projectRoot, 'resources/views')
const relativeViewsPath = 'views'

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
  // The current SSR builder discovers only a pages directory beneath its root
  // and does not honor ui.pagesDir. Building from resources preserves every
  // view's relative imports; expose views as resources/pages only while the
  // framework compiles the application.
  symlinkSync(relativeViewsPath, compatibilityPath, 'dir')
  createdCompatibilityLink = true
}

try {
  const result = await buildForProduction({
    root: resourcesRoot,
    outputDir: resolve(projectRoot, '.output'),
    componentsDir: resolve(resourcesRoot, 'components'),
    layoutsDir: resolve(resourcesRoot, 'layouts'),
    partialsDir: resolve(resourcesRoot, 'partials'),
    publicDir: resolve(projectRoot, 'public'),
  })
  console.log(`Compiled ${result.pageCount} SSR routes to ${result.outputDir}.`)
}
finally {
  if (createdCompatibilityLink && existsSync(compatibilityPath))
    unlinkSync(compatibilityPath)
}
