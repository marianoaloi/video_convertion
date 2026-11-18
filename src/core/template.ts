/**
 * Pure expansion of a hook command template (ADR-008) plus the command-line parser the CLI uses
 * to turn `--upload "cmd {file}"` into a `CommandTemplate`.
 *
 * - Placeholders: `{file}` `{files}` `{dir}` `{root}` `{md5}` `{outputs}`; `{{` and `}}` are literal braces.
 * - `args` are expanded per argv entry; an entry with a list placeholder (`{files}`, `{outputs}`)
 *   becomes one entry per value (the rest of the entry is repeated around each value).
 * - The command itself is expanded as text: list values are joined with a newline.
 * - Unknown placeholders, unbalanced braces and placeholders without a value are errors.
 */
import type { CommandTemplate, HookContext } from '../types.js'

export const LIST_PLACEHOLDERS = ['files', 'outputs'] as const
export const SCALAR_PLACEHOLDERS = ['file', 'dir', 'root', 'md5'] as const
type ListName = (typeof LIST_PLACEHOLDERS)[number]
type PlaceholderName = ListName | (typeof SCALAR_PLACEHOLDERS)[number]

export class HookExpansionError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HookExpansionError'
  }
}

export interface ExpandedCommand {
  readonly command: string
  readonly args: string[]
}

type Part = { readonly text: string } | { readonly placeholder: PlaceholderName }

function isListName(name: PlaceholderName): name is ListName {
  return (LIST_PLACEHOLDERS as readonly string[]).includes(name)
}

function isKnownName(name: string): name is PlaceholderName {
  return (
    (LIST_PLACEHOLDERS as readonly string[]).includes(name) ||
    (SCALAR_PLACEHOLDERS as readonly string[]).includes(name)
  )
}

function readPlaceholder(source: string, start: number): { name: PlaceholderName; end: number } {
  const close = source.indexOf('}', start)
  const inner = source.slice(start + 1, close)
  if (close < 0 || inner.includes('{')) {
    throw new HookExpansionError(`Unbalanced "{" in "${source}"`)
  }
  if (!isKnownName(inner)) throw new HookExpansionError(`Unknown placeholder {${inner}}`)
  return { name: inner, end: close + 1 }
}

/** Splits a template string into literal text and placeholders. */
export function parseTemplateString(source: string): Part[] {
  const parts: Part[] = []
  let text = ''
  let i = 0
  while (i < source.length) {
    const ch = source.charAt(i)
    const next = source.charAt(i + 1)
    if ((ch === '{' || ch === '}') && next === ch) {
      text += ch
      i += 2
    } else if (ch === '}') {
      throw new HookExpansionError(`Unbalanced "}" in "${source}"`)
    } else if (ch === '{') {
      const { name, end } = readPlaceholder(source, i)
      if (text.length > 0) parts.push({ text })
      text = ''
      parts.push({ placeholder: name })
      i = end
    } else {
      text += ch
      i += 1
    }
  }
  if (text.length > 0) parts.push({ text })
  return parts
}

function valueOf(context: HookContext, name: PlaceholderName): string | string[] {
  const value = context[name]
  if (value === undefined || (Array.isArray(value) && value.length === 0)) {
    throw new HookExpansionError(`Placeholder {${name}} has no value in this context`)
  }
  return value
}

function scalarOf(context: HookContext, name: PlaceholderName): string {
  const value = valueOf(context, name)
  return Array.isArray(value) ? value.join('\n') : value
}

/** Expands one `args` entry into one or more argv entries. */
export function expandArg(entry: string, context: HookContext): string[] {
  const parts = parseTemplateString(entry)
  const listNames = parts.flatMap((p) => ('placeholder' in p && isListName(p.placeholder) ? [p.placeholder] : []))
  if (listNames.length > 1) {
    throw new HookExpansionError(`Only one list placeholder per argument: "${entry}"`)
  }
  const render = (listValue: string): string =>
    parts
      .map((p) => {
        if ('text' in p) return p.text
        return isListName(p.placeholder) ? listValue : scalarOf(context, p.placeholder)
      })
      .join('')
  const listName = listNames[0]
  if (listName === undefined) return [render('')]
  const values = valueOf(context, listName)
  return (Array.isArray(values) ? values : [values]).map((v) => render(v))
}

/** Expands free text (the command): list values are joined with a newline. */
export function expandText(source: string, context: HookContext): string {
  return parseTemplateString(source)
    .map((p) => ('text' in p ? p.text : scalarOf(context, p.placeholder)))
    .join('')
}

/** Expands a whole template. Throws `HookExpansionError`. */
export function expandTemplate(template: CommandTemplate, context: HookContext): ExpandedCommand {
  const args = template.args.flatMap((entry) => expandArg(entry, context))
  return { command: expandText(template.command, context), args }
}

/** True when any entry (command or args) of the template contains `{name}`. */
export function templateReferences(template: CommandTemplate, name: string): boolean {
  const needle = `{${name}}`
  return [template.command, ...template.args].some((text) => text.includes(needle))
}

function readQuoted(text: string, open: number): { value: string; next: number } {
  const quote = text.charAt(open)
  let value = ''
  let i = open + 1
  while (i < text.length) {
    const ch = text.charAt(i)
    if (ch === quote) return { value, next: i + 1 }
    const after = text.charAt(i + 1)
    if (quote === '"' && ch === '\\' && (after === '"' || after === '\\')) {
      value += after
      i += 2
    } else {
      value += ch
      i += 1
    }
  }
  throw new Error(`Unterminated ${quote === '"' ? 'double' : 'single'} quote in "${text}"`)
}

/**
 * Splits ONE command-line string into argv. Whitespace separates; "double" and 'single' quotes
 * group (quotes removed); inside double quotes a backslash escapes only `"` and `\`; outside
 * double quotes backslashes are literal, so `C:\tools\up.exe` survives. Throws on an
 * unterminated quote.
 */
export function parseCommandLine(text: string): string[] {
  const argv: string[] = []
  let current = ''
  let started = false
  let i = 0
  while (i < text.length) {
    const ch = text.charAt(i)
    if (/\s/.test(ch)) {
      if (started) argv.push(current)
      current = ''
      started = false
      i += 1
    } else if (ch === '"' || ch === "'") {
      const quoted = readQuoted(text, i)
      current += quoted.value
      started = true
      i = quoted.next
    } else {
      current += ch
      started = true
      i += 1
    }
  }
  if (started) argv.push(current)
  return argv
}

/** `parseCommandLine` then `{command: argv[0], args: rest}`. Throws when the line is empty. */
export function parseCommandTemplate(text: string): CommandTemplate {
  const [command, ...args] = parseCommandLine(text)
  if (command === undefined) throw new Error('The command line is empty')
  return { command, args }
}
