const fs = require('fs-extra')
const path = require('path')

// Takes a path and returns all node_modules resolution paths (but not global include paths).
const getNodeModulePaths = p => {
  const result = []
  let paths = p.split(path.sep)
  while (paths.length) {
    result.push(path.join(paths.join(path.sep) || path.sep, 'node_modules'))
    paths.pop()
  }
  return result
}

// Creates a symlink. Ignores if fails to create due to already existing.
async function link (target, f) {
  await fs.ensureDir(path.dirname(f))
  await fs.symlink(target, f)
    .catch(e => {
      if (e.code === 'EEXIST') {
        return
      }
      throw e
    })
}

class ServerlessMonoRepo {
  constructor (serverless) {
    this.serverless = serverless
    this.hooks = {
      'package:cleanup': () => this.clean(),
      'package:initialize': () => this.initialise(),
      'deploy:function:initialize': async () => {
        await this.clean()
        await this.initialise()
      }
    }
    this.log = msg => serverless.cli.log(msg)

    // Settings
    const custom = this.serverless.service.custom || {}
    this.settings = custom.serverlessMonoRepo || {}
    this.settings.path = this.settings.path || this.serverless.config.servicePath
    
    // Move up a directory
    const splitPath = this.settings.path.split('/')
    this.settings.workspacePath = splitPath.slice(0, splitPath.length - 1).join('/')
  }

  async linkPackage (name, fromPath, toPath, created, resolved) {
    // Ignore circular dependencies
    if (resolved.includes(name)) {
      return
    }

    // Obtain list of module resolution paths to use for resolving modules
    const paths = getNodeModulePaths(fromPath)

    // Get package file path
    let pkg
    try {
      pkg = require.resolve(path.join(name, 'package.json'), { paths })
    } catch (e) {
      // Package resolve error (can happen if there is an `exports` in the package.json and the path is [package-name]/package.json).  Swallow the error
      // and try again with just the package name.  See:
      // - https://nodejs.org/api/modules.html#modules_require_resolve_request_options
      // - https://nodejs.org/api/packages.html#packages_main_entry_point_export
    }

    // If the above failed, doing a require.resolve on package.json where there is an `exports` in the package.json uses a subdirectory instead of the full package directory,
    // which will cause a failure.  Instead, just find where the package.json is located and use that directory instead.
    if (!pkg) {
      for (let i = 0; i < paths.length; ++i) {
        const pth = paths[i]
        
        if (fs.existsSync(path.join(pth, name, 'package.json'))) {
          pkg = path.join(pth, name, 'package.json')
          break;
        }
      }
    }

    // Get relative path to package & create link if not an embedded node_modules
    const target = path.relative(path.join(toPath, path.dirname(name)), path.dirname(pkg))
    if ((pkg.match(/node_modules/g) || []).length <= 1 && !created.has(name)) {
      created.add(name)
      await link(target, path.join(toPath, name))
    }

    // Get dependencies
    const { dependencies = {} } = require(pkg)

    // Link all dependencies
    await Promise.all(Object.keys(dependencies).map(dep =>
      this.linkPackage(dep, path.dirname(pkg), toPath, created, resolved.concat([name]))
    ))
  }

  async clean () {
    // Remove all symlinks that are of form [...]/node_modules/link
    this.log('Cleaning dependency symlinks')

    // Checks if a given stat result indicates a scoped package directory
    const isScopedPkgDir = c => c.s.isDirectory() && c.f.startsWith('@')

    // Cleans all links in a specific path
    async function clean (p) {
      if (!(await fs.pathExists(p))) {
        return
      }

      const files = await fs.readdir(p)
      let contents = await Promise.all(files.map(f =>
        fs.lstat(path.join(p, f)).then(s => ({ f, s }))
      ))

      // Remove all links
      await Promise.all(contents.filter(c => c.s.isSymbolicLink())
        .map(c => fs.unlink(path.join(p, c.f))))
      contents = contents.filter(c => !c.s.isSymbolicLink())

      // Remove all links in scoped packages
      await Promise.all(contents.filter(isScopedPkgDir)
        .map(c => clean(path.join(p, c.f))))
      contents = contents.filter(c => !isScopedPkgDir(c))

      // Remove directory if empty
      if (!contents.length) {
        await fs.rmdir(p)
      }
    }

    // Clean node_modules
    await clean(path.join(this.settings.path, 'node_modules'))

    const peripheralWorkspaces = this.getWorkspaceDependencies()
    await Promise.all(peripheralWorkspaces.map(workspace => clean(path.join(this.settings.workspacePath, workspace, `node_modules`))))
  }

  async initialise () {
    // Read package JSON
    this.log('Creating dependency symlinks')
    const { dependencies = {} } = require(path.join(this.settings.path, 'package.json'))
    const { workspaces = [] } = require(path.join(this.settings.workspacePath, 'package.json'))
    const workspacesToLink = this.getWorkspaceDependencies()

    for (let i = 0; i < workspaces.length; ++i) {
      const currentWorkspace = workspaces[i]
      if (dependencies[currentWorkspace]) {
        workspacesToLink.push(currentWorkspace)
      }
    }

    // Link packages that current package depends on
    await Promise.all(workspacesToLink.map(currentWorkspace => this.processLinkages(path.join(this.settings.workspacePath, currentWorkspace))))

    // Link all dependent packages
    await this.processLinkages(this.settings.path)
  }

  async processLinkages (linkagePath) {
    const { dependencies = {} } = require(path.join(linkagePath, 'package.json'))
    const contents = new Set()
    await Promise.all(Object.keys(dependencies).map(name => {
        return this.linkPackage(name, linkagePath, path.join(linkagePath, 'node_modules'), contents, [])
      }
    ))
  }

  getWorkspaceDependencies() {
    const { dependencies = {} } = require(path.join(this.settings.path, 'package.json'))
    const { workspaces = [] } = require(path.join(this.settings.workspacePath, 'package.json'))
    const relevantWorkspaces = []

    for (let i = 0; i < workspaces.length; ++i) {
      const currentWorkspace = workspaces[i]
      if (dependencies[currentWorkspace]) {
        relevantWorkspaces.push(currentWorkspace)
      }
    }

    return relevantWorkspaces
  }
}

module.exports = ServerlessMonoRepo
