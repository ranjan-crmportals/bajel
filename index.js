const { spawn } = require('child_process')
const getopts = require('getopts')
const { Console } = require('console')
const Percent = require('./percent.js')
const { timestamp, walkDir } = require('./fs_util.js')

// const trace = x => console.x || x

module.exports = async (bajelfile, stdout = process.stdout, stderr = process.stderr) => {
  const theConsole = new Console(stdout, stderr)
  const options = getopts(process.argv.slice(2), {
    boolean: ['n', 'p', 'd', 'h'],
    alias: {
      n: ['just-print', 'dry-run', 'recon'],
      h: ['help'],
      d: ['debug'],
      stopEarly: true
    }
  })
  if (options.help) {
    theConsole.log(`
       usage: bajel[-n][-p][-h][target]
       -n  dry run
       -p  print out the expanded build file
       -h  this help
       `)
    return 0
  }

  const explicitTargets = Object.keys(bajelfile).filter(k => !k.includes('%'))
  if (explicitTargets.length === 0) {
    const targetsStr = JSON.stringify(Object.keys(bajelfile))
    theConsole.error(`No explicit targets in ${targetsStr}`)
    return 1
  }

  const dryRun = options.n
  const start = options._.length > 0
    ? options._[0]
    : explicitTargets[0]

  const shellTrim = cmd => cmd.split('\n').map(s => s.trim()).join('\n')

  const printAndExec = cmd => new Promise(resolve => {
    const trimmed = shellTrim(cmd.join ? cmd.join(' ') : cmd)
    theConsole.log(trimmed)
    if (dryRun) {
      resolve(0)
      return
    }
    const process = spawn(trimmed, [], { shell: true })
    process.stdout.on('data', data => { theConsole.log(data.toString()) })
    process.stderr.on('data', data => { theConsole.error(data.toString()) })
    process.on('exit', code => {
      if (code !== 0) {
        theConsole.error(`FAILED with code ${code}: \n${trimmed}\n`)
      }
      resolve(code)
    })
  })

  /**
 * @param {string} target being built
 * @returns {[errorCode, number, execHappened]} whether succeeded and timestamp in ms of latest file change
 * */
  const recurse = async target => {
    const debugOut = f => {
      if (options.debug) {
        theConsole.log(`target "${target}" ${f()}`)
      }
    }

    let execHappened = false
    const targetTime = await timestamp(target)
    if (!bajelfile[target] && targetTime === 0) {
      theConsole.warn(target,
        'is not a file and is not one of the build targets:',
        Object.keys(bajelfile).sort())
      return [1]
    }
    const task = bajelfile[target] || {}
    const deps = task.deps || []
    const exec = task.exec
    let lastDepsTime = 0
    for (let i = 0; i < deps.length; ++i) {
      const [depCode, depTime, depExecHappened] = await recurse(deps[i])
      execHappened = execHappened || depExecHappened
      if (depCode !== 0) {
        debugOut(() => `-- execution of dep target "${deps[i]}" failed. Stopping.`)
        return [depCode]
      }
      if (depTime > lastDepsTime) {
        lastDepsTime = depTime
      }
    }

    debugOut(() => `${ago(targetTime)} and its most recent deps ${ago(lastDepsTime)}`)
    if (exec && (targetTime === 0 || targetTime < lastDepsTime)) {
      debugOut(() => targetTime === 0
        ? `does not exist and has an exec`
        : `is older than the most recent dep and has an exec`
      )
      const source = deps.length > 0 ? deps[0] : '***no-source***'
      const sources = deps.join(' ')
      if (!exec.replace) {
        throw new TypeError(`exec of target "${target}" should be a string`)
      }
      const substitutedExec = exec
        .replace(/\$@/g, target)
        .replace(/\$</g, source)
        .replace(/\$\+/g, sources)
      const code = await printAndExec(substitutedExec)
      execHappened = true
      if (code !== 0) {
        theConsole.error('FAILED  ', target, ':', deps.join(' '))
        return [code]
      }
    } else {
      debugOut(() => !exec
        ? `target "${target}" has no exec`
        : (lastDepsTime === 0
          ? `exists and there are no deps so ignoring exec`
          : `is more recent than the most recent dep so ignoring exec`
        )
      )
    }
    const updatedTime = Math.max(lastDepsTime, await timestamp(target))
    return [0, updatedTime, execHappened]
  }

  const expandDeps = () => {
    const files = []
    walkDir('.', f => { files.push(f) })
    const toAdd = {}
    const toRemove = []
    let expansionHappened = false
    for (const target in bajelfile) {
      const task = bajelfile[target]
      let deps = task.deps || []
      if (!deps.filter) {
        throw new Error('Deps should be an array in\n"' + target + '":' + JSON.stringify(task, null, 1))
      }
      let from
      for (let i = 0; i < deps.length; ++i) {
        from = Percent(deps[i])
        if (from) {
          delete deps[i]
          break
        }
      }
      deps = deps.filter(d => d)
      if (!from) {
        if (target.includes('%')) {
          throw new Error(
            `Target "${target}" has replacement pattern, but dependencies have no percents: ${JSON.stringify(deps)}`)
        }
        continue
      }
      let matchHappened
      for (const file of [...files, ...Object.keys(bajelfile)]) {
        const match = from.match(file)
        if (match) {
          const expand = x => x.split('%').join(match)
          matchHappened = expansionHappened = true
          toRemove.push(target)
          const expandedTask = {}
          if (deps) {
            expandedTask.deps = [file, ...deps.map(expand)]
          }
          if (task.exec) {
            expandedTask.exec = expand(task.exec)
          }
          toAdd[expand(target)] = expandedTask
        }
      }
      if (!matchHappened) {
        theConsole.warn(`No match for "${target}"`)
      }
    }
    toRemove.forEach(target => { delete bajelfile[target] })
    for (const target in toAdd) {
      if (bajelfile[target]) {
        theConsole.warn('Duplicate targets')
        theConsole.warn(`"${target}": ${JSON.stringify(bajelfile[target])}`)
        theConsole.warn(`"${target}": ${JSON.stringify(toAdd[target])}`)
      }
      bajelfile[target] = toAdd[target]
    }
    return expansionHappened
  }

  try {
    while (expandDeps()) { }
  } catch (e) {
    theConsole.error('Problem expanding percents: ' + e)
    if (options.p) {
      theConsole.log(bajelfile)
    }
    return 1
  }
  if (options.p) {
    theConsole.log(bajelfile)
    return 0
  }

  const t0 = Date.now()

  const ago = (t) => {
    if (t === 0) {
      return 'does not exist'
    }
    const ms = t0 - t
    if (ms < 1000) {
      return `modified ${ms.toPrecision(3)}ms ago`
    }
    const s = ms / 1000
    if (s < 60) {
      return `modified ${s.toPrecision(3)}s ago`
    }
    const min = s / 60
    if (min < 60) {
      return `modified ${min.toPrecision(3)} min ago`
    }
    const hour = min / 60
    if (hour < 24) {
      return `modified ${hour.toPrecision(3)} hours ago`
    }
    const day = hour / 24
    return `modified ${day.toPrecision(3)} days ago`
  }

  try {
    const [code, ts, execHappened] = await recurse(start)

    if (code !== 0) {
      theConsole.error(`bajel: recipe for target '${start}' failed\nbajel: *** [error] Error ${code}`)
      return code
    }
    if (dryRun) {
      return 0
    }
    const phony = (await timestamp(start) === 0)
    if (phony && !execHappened) {
      theConsole.log(`bajel: Nothing to be done for "${start}".`)
    }
    if (!phony && !execHappened) {
      theConsole.log(`bajel: '${start}' is up to date. (${ago(ts)})`)
    }
    return 0
  } catch (e) {
    theConsole.error(e.toString())
    return 1
  }
}
