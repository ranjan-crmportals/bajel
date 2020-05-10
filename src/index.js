const getopts = require('getopts')
const StrConsole = require('./teeconsole.js')
const { timestamp, walkDir } = require('./fs_util.js')
const Variables = require('./variables.js')
const Tasks = require('./tasks.js')
const ago = require('./ago.js')

// const trace = x => console.log('trace:', x) || x

/**
 * @returns [errorCode, stdoutString, stderrString]
 */
module.exports = async (bajelfile) => {
  const { tConsole, tStdout, tStderr } = StrConsole()
  const options = getopts(process.argv.slice(2), {
    boolean: ['n', 'p', 'd', 'h'],
    alias: {
      n: ['just-print', 'dry-run', 'recon'],
      h: ['help'],
      t: ['targets'],
      T: ['targets-expanded'],
      d: ['debug'],
      stopEarly: true
    }
  })
  if (options.help) {
    tConsole.log(`
       usage: bajel[-n][-p][-h][target]
       -n  dry run
       -p  print out the expanded build file
       -d  debug
       -t  print out all explicit targets before % expansion
       -T  print out all targets after % expansion
       -h  this help
       `)
    return [0, tStdout(), tStderr()]
  }

  // Split bajelfile into variables and tasks
  const tasks = new Tasks(bajelfile, tConsole)
  const variables = new Variables(bajelfile)

  if (tasks.explicitTargets().length === 0) {
    const targetsStr = JSON.stringify(tasks.targets())
    tConsole.error(`No explicit targets in ${targetsStr}`)
    return [1, tStdout(), tStderr()]
  }

  if (options.t) {
    tConsole.log(tasks.explicitTargets().join(' '))
    return [0, tStdout(), tStderr()]
  }

  const dryRun = options.n
  const start = options._.length > 0
    ? options._[0]
    : tasks.explicitTargets()[0]

  /**
 * @param {string} target being built
 * @returns {[errorCode, number, recipeHappened]} whether succeeded and timestamp in ms of latest file change
 * */
  const recurse = async (prevTargets, target) => {
    const debugOut = f => {
      if (options.debug) {
        tConsole.log(`target "${target}" ${f()}`)
      }
    }

    let recipeHappened = false
    const targetTime = await timestamp(target)
    if (!tasks.has(target) && targetTime === 0) {
      tConsole.warn(target,
        'is not a file and is not one of the build targets:',
        tasks.targets().sort())
      return [1]
    }
    const task = tasks.get(target)

    // Check for recursion
    if (prevTargets.includes(target)) {
      throw new Error(`infinite loop ${prevTargets.join(' → ')} → ${target}`)
    }
    prevTargets = [...prevTargets, target]

    let lastDepsTime = 0
    for (const dep of task.theDeps()) {
      const [depCode, depTime, depRecipeHappened] = await recurse(prevTargets, dep)
      recipeHappened = recipeHappened || depRecipeHappened
      if (depCode !== 0) {
        debugOut(() => `-- execution of dep target "${dep}" failed. Stopping.`)
        return [depCode]
      }
      if (depTime > lastDepsTime) {
        lastDepsTime = depTime
      }
    }

    debugOut(() => `${ago(targetTime)} and its most recent deps ${ago(lastDepsTime)}`)
    if (task.hasRecipe() && (targetTime === 0 || targetTime < lastDepsTime)) {
      debugOut(() => targetTime === 0
        ? 'does not exist and has a recipe'
        : 'is older than the most recent dep and has a recipe'
      )
      const callHappened = task.doCall(tConsole)
      recipeHappened = recipeHappened || callHappened
      if (!callHappened) {
        const code = await task.doExec(variables, dryRun, tConsole)
        recipeHappened = true
        if (code !== 0) {
          tConsole.error('FAILED call', task.toString())
          return [code]
        }
      }
    } else {
      debugOut(() => !task.hasRecipe()
        ? 'has no recipe'
        : (lastDepsTime === 0
          ? 'exists and there are no deps so ignoring recipe'
          : 'is more recent than the most recent dep so ignoring recipe'
        )
      )
    }
    const updatedTime = Math.max(lastDepsTime, await timestamp(target))
    return [0, updatedTime, recipeHappened]
  }

  const expandDeps = () => {
    const files = []
    walkDir('.', f => { files.push(f) })
    const toAdd = {}
    const toRemove = []
    let expansionHappened = false
    tasks.forTask(task => {
      const fromPattern = task.removePatternDep()
      if (!fromPattern) {
        if (task.target().includes('%')) {
          throw new Error(
            `Target "${task.target()}" has replacement pattern, but deps have no percents: ${task.toString()}`)
        }
        return
      }
      let matchHappened
      for (const file of [...files, ...tasks.targets()]) {
        const match = fromPattern.match(file)
        if (match) {
          const expand = x => x.split('%').join(match)
          matchHappened = expansionHappened = true
          toRemove.push(task.target())
          const expandedTask = task.expanded(file, match, expand)
          expandedTask.infiniteLoopCheck(target => tasks.has(target))
          toAdd[expandedTask.target()] = expandedTask
        }
      }
      if (!matchHappened) {
        tConsole.warn(`No match for "${task.target()}"`)
      }
    })
    tasks.removeAll(toRemove)
    tasks.addAll(toAdd)
    return expansionHappened
  }

  try {
    while (expandDeps()) { }
  } catch (e) {
    tConsole.error('Problem expanding percents: ' + e)
    if (options.p) {
      tConsole.log(bajelfile)
    }
    return [1, tStdout(), tStderr()]
  }
  if (options.T) {
    tConsole.log(tasks.targets().join(' '))
    return [0, tStdout(), tStderr()]
  }
  if (options.p) {
    tConsole.log(bajelfile)
    return [0, tStdout(), tStderr()]
  }

  try {
    const [code, ts, recipeHappened] = await recurse([], start)

    if (code !== 0) {
      tConsole.error(`bajel: recipe for target '${start}' failed\nbajel: *** [error] Error ${code}`)
      return [code, tStdout(), tStderr()]
    }
    if (dryRun) {
      return [0, tStdout(), tStderr()]
    }
    const phony = (await timestamp(start) === 0)
    if (phony && !recipeHappened) {
      tConsole.log(`bajel: Nothing to be done for "${start}".`)
    }
    if (!phony && !recipeHappened) {
      tConsole.log(`bajel: '${start}' is up to date. (${ago(ts)})`)
    }
    return [0, tStdout(), tStderr()]
  } catch (e) {
    tConsole.error(e.toString())
    return [1, tStdout(), tStderr()]
  }
}
