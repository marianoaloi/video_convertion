import { describe, it } from 'node:test'
import { expect } from './expect.js'
import { parseCommandLine, parseCommandTemplate } from '../../src/core/template.js'

describe('parseCommandLine', () => {
  it('splits on whitespace and drops empty entries', () => {
    expect(parseCommandLine('  up  --x   {file} ')).toEqual(['up', '--x', '{file}'])
    expect(parseCommandLine('')).toEqual([])
    expect(parseCommandLine('   ')).toEqual([])
  })

  it('keeps Windows paths with literal backslashes', () => {
    expect(parseCommandLine(String.raw`C:\tools\up.exe --dir D:\a\b {file}`)).toEqual([
      String.raw`C:\tools\up.exe`,
      '--dir',
      String.raw`D:\a\b`,
      '{file}'
    ])
    expect(parseCommandLine(String.raw`"C:\Program Files\up.exe" x`)).toEqual([String.raw`C:\Program Files\up.exe`, 'x'])
  })

  it('groups with double and single quotes and removes them', () => {
    expect(parseCommandLine(`cp "a b" 'c d' e`)).toEqual(['cp', 'a b', 'c d', 'e'])
    expect(parseCommandLine('--name="a b"')).toEqual(['--name=a b'])
    expect(parseCommandLine('a""b')).toEqual(['ab'])
    expect(parseCommandLine('"" x')).toEqual(['', 'x'])
    expect(parseCommandLine(`"it's" 'say "hi"'`)).toEqual(["it's", 'say "hi"'])
  })

  it('escapes only quote and backslash inside double quotes', () => {
    expect(parseCommandLine(String.raw`"say \"hi\"" x`)).toEqual(['say "hi"', 'x'])
    expect(parseCommandLine(String.raw`"a\\b"`)).toEqual([String.raw`a\b`])
    expect(parseCommandLine(String.raw`"C:\dir\n"`)).toEqual([String.raw`C:\dir\n`])
    expect(parseCommandLine(String.raw`'a\"b'`)).toEqual([String.raw`a\"b`])
  })

  it('throws on an unterminated quote', () => {
    expect(() => parseCommandLine('a "b c')).toThrow(/Unterminated double quote/)
    expect(() => parseCommandLine("a 'b c")).toThrow(/Unterminated single quote/)
    expect(() => parseCommandLine(String.raw`"a\"`)).toThrow(/Unterminated/)
  })

  it('parseCommandTemplate gives command + args and rejects an empty line', () => {
    expect(parseCommandTemplate('up --in {file} "{dir}/x y"')).toEqual({
      command: 'up',
      args: ['--in', '{file}', '{dir}/x y']
    })
    expect(parseCommandTemplate('solo')).toEqual({ command: 'solo', args: [] })
    expect(() => parseCommandTemplate('  ')).toThrow(/empty/)
  })
})
