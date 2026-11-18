import { describe, it } from 'node:test'
import { expect } from './expect.js'
import type { CommandTemplate } from '../../src/types.js'
import { HookExpansionError, expandArg, expandTemplate, parseTemplateString, templateReferences } from '../../src/core/template.js'

const tpl = (over: Partial<CommandTemplate>): CommandTemplate => ({ command: 'x', args: [], ...over })

describe('hookArgs', () => {
  it('substitutes scalars per argv entry without splitting spaces', () => {
    const r = expandTemplate(tpl({ args: ['--in={file}', '{dir}'] }), {
      file: 'C:\\a b\\c d.mp4',
      dir: 'C:\\a b'
    })
    expect(r.args).toEqual(['--in=C:\\a b\\c d.mp4', 'C:\\a b'])
  })

  it('expands a list placeholder to one argv entry per value', () => {
    expect(expandArg('{files}', { files: ['/a', '/b c'] })).toEqual(['/a', '/b c'])
    expect(expandArg('-i={outputs}', { outputs: ['/a', '/b'] })).toEqual(['-i=/a', '-i=/b'])
  })

  it('expands the command as text; list values are joined with a newline', () => {
    const r = expandTemplate(tpl({ command: '{dir}/up', args: ['{files}'] }), { files: ['/a', '/b'], dir: '/d' })
    expect(r.command).toBe('/d/up')
    expect(r.args).toEqual(['/a', '/b'])
    expect(expandTemplate(tpl({ command: '{files}' }), { files: ['/a', '/b'] }).command).toBe('/a\n/b')
  })

  it('treats doubled braces as literals', () => {
    expect(expandArg('{{x}} {file}', { file: '/f' })).toEqual(['{x} /f'])
    expect(parseTemplateString('}}')).toEqual([{ text: '}' }])
  })

  it('rejects unknown, unbalanced and valueless placeholders', () => {
    expect(() => expandArg('{nope}', {})).toThrow(HookExpansionError)
    expect(() => expandArg('{file', { file: '/f' })).toThrow(/Unbalanced/)
    expect(() => expandArg('a}', {})).toThrow(/Unbalanced/)
    expect(() => expandArg('{file}', {})).toThrow(/no value/)
    expect(() => expandArg('{files}', { files: [] })).toThrow(/no value/)
    expect(() => expandArg('{files}{outputs}', { files: ['a'], outputs: ['b'] })).toThrow(/one list/)
  })

  it('does not reinterpret substituted values', () => {
    expect(expandArg('{file}', { file: '/a/{dir}' })).toEqual(['/a/{dir}'])
  })

  it('templateReferences finds a placeholder in the command or any arg', () => {
    expect(templateReferences(tpl({ args: ['--hash={md5}'] }), 'md5')).toBe(true)
    expect(templateReferences(tpl({ command: '{md5}' }), 'md5')).toBe(true)
    expect(templateReferences(tpl({ args: ['{file}'] }), 'md5')).toBe(false)
  })
})
