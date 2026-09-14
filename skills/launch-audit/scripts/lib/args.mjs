import { readFileSync } from 'node:fs'

const BUILTINS = new Set(['help', 'json', 'config'])

function splitList(v) {
  return String(v).split(',').map((s) => s.trim()).filter((s) => s.length > 0)
}

function coerce(type, raw, flagName) {
  if (type === 'number') {
    const n = Number(raw)
    if (!Number.isFinite(n)) return { error: `--${flagName} expects a number` }
    return { value: n }
  }
  return { value: raw }
}

export function defineArgs(spec) {
  const { name, description, flags: flagsSpec = {} } = spec
  // Null-prototype copy: lookups like flags['constructor'] or flags['__proto__']
  // must never resolve to an inherited Object.prototype property.
  const flags = Object.assign(Object.create(null), flagsSpec)
  for (const k of Object.keys(flags)) {
    if (BUILTINS.has(k)) throw new Error(`flag "${k}" collides with a reserved built-in`)
  }

  function loadConfigFile(path) {
    let text
    try {
      text = readFileSync(path, 'utf8')
    } catch (e) {
      return { error: `--config ${path}: ${e.message}` }
    }
    try {
      return { value: JSON.parse(text) }
    } catch (e) {
      return { error: `--config ${path}: ${e.message}` }
    }
  }

  function parse(argv, opts = {}) {
    const errors = []
    const cli = {}
    const listAccum = {}
    let configPath = null
    let help = false
    let json = false
    const positionals = []

    for (let i = 0; i < argv.length; i++) {
      const tok = argv[i]
      if (typeof tok !== 'string' || !tok.startsWith('--')) {
        positionals.push(tok)
        continue
      }

      let flagPart = tok.slice(2)
      let inlineValue = null
      const eq = flagPart.indexOf('=')
      if (eq !== -1) {
        inlineValue = flagPart.slice(eq + 1)
        flagPart = flagPart.slice(0, eq)
      }

      // handle --no-<flag> for booleans
      let negated = false
      let flagName = flagPart
      if (flagPart.startsWith('no-') && flags[flagPart.slice(3)]?.type === 'boolean') {
        negated = true
        flagName = flagPart.slice(3)
      }

      if (flagName === 'help') {
        help = true
        continue
      }
      if (flagName === 'json') {
        json = true
        continue
      }
      if (flagName === 'config') {
        let val = inlineValue
        if (val === null) {
          const next = argv[i + 1]
          if (next !== undefined && !(typeof next === 'string' && next.startsWith('--'))) {
            val = next
            i++
          } else {
            errors.push('--config requires a value')
            continue
          }
        }
        configPath = val
        continue
      }

      const def = flags[flagName]
      if (!def) {
        errors.push(`unknown flag --${tok.slice(2).split('=')[0]}`)
        continue
      }

      if (def.type === 'boolean') {
        if (inlineValue !== null) {
          cli[flagName] = inlineValue !== 'false' && inlineValue !== '0'
        } else {
          cli[flagName] = !negated
        }
        continue
      }

      let raw = inlineValue
      if (raw === null) {
        const next = argv[i + 1]
        if (next !== undefined && !(typeof next === 'string' && next.startsWith('--'))) {
          raw = next
          i++
        } else {
          errors.push(`--${flagName} requires a value`)
          continue
        }
      }

      if (def.type === 'list') {
        const items = splitList(raw)
        listAccum[flagName] = (listAccum[flagName] || []).concat(items)
        continue
      }

      const { value, error } = coerce(def.type, raw, flagName)
      if (error) {
        errors.push(error)
        continue
      }
      cli[flagName] = value
    }

    for (const p of positionals) {
      errors.push(`unexpected argument "${p}"`)
    }

    // merge order: config file values, then {config} option object, then CLI flags
    let merged = {}
    if (configPath !== null) {
      const { value, error } = loadConfigFile(configPath)
      if (error) {
        errors.push(error)
      } else {
        merged = { ...merged, ...value }
      }
    }
    if (opts.config && typeof opts.config === 'object') {
      merged = { ...merged, ...opts.config }
    }
    merged = { ...merged, ...cli }

    const values = { help, json, config: configPath }

    for (const [flagName, def] of Object.entries(flags)) {
      if (def.type === 'list') {
        const fromMerge = merged[flagName]
        let list
        if (listAccum[flagName]) {
          list = listAccum[flagName]
        } else if (fromMerge !== undefined) {
          list = Array.isArray(fromMerge) ? fromMerge : splitList(fromMerge)
        } else if (def.default !== undefined) {
          list = def.default
        } else {
          list = []
        }
        if (def.required && list.length === 0 && def.default === undefined) {
          errors.push(`--${flagName} is required`)
        }
        values[flagName] = list
        continue
      }

      if (Object.prototype.hasOwnProperty.call(merged, flagName)) {
        let v = merged[flagName]
        // values coming from config/opts may be raw (unvalidated) types; coerce numbers
        if (def.type === 'number' && typeof v !== 'number') {
          const { value, error } = coerce('number', v, flagName)
          if (error) {
            errors.push(error)
            continue
          }
          v = value
        }
        values[flagName] = v
      } else if (def.default !== undefined) {
        values[flagName] = def.default
      } else if (def.required) {
        errors.push(`--${flagName} is required`)
      } else {
        values[flagName] = undefined
      }
    }

    return { values, errors, help: helpText() }
  }

  function helpText() {
    const lines = [`${name} - ${description}`, '']
    const renderFlag = (flagName, def) => {
      let line = `  --${flagName} <${def.type}>`
      const parts = []
      if (def.help) parts.push(def.help)
      if (def.default !== undefined) parts.push(`(default: ${Array.isArray(def.default) ? JSON.stringify(def.default) : def.default})`)
      if (def.required) parts.push('(required)')
      if (parts.length) line += `   ${parts.join(' ')}`
      return line
    }
    for (const [flagName, def] of Object.entries(flags)) {
      lines.push(renderFlag(flagName, def))
    }
    lines.push('  --config <path>   load flag values from a JSON file (default: none)')
    lines.push('  --json   output machine-readable JSON (default: false)')
    lines.push('  --help   show this help text (default: false)')
    return lines.join('\n')
  }

  return { parse, helpText }
}
