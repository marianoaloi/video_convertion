import { test } from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { defaultStatePath, parseCliArgs, usage } from '../../src/cli/args.js'
import type { ParsedCli } from '../../src/cli/args.js'
import { DEFAULTS } from '../../src/types.js'
import type { RunConfig } from '../../src/types.js'
import { DEFAULT_VIDEO_EXTENSIONS } from '../../src/core/videoFiles.js'

const CWD = path.resolve('work', 'dir')
const parse = (args: string[], env: NodeJS.ProcessEnv = {}): ParsedCli => parseCliArgs(args, env, CWD)

function run(args: string[], env: NodeJS.ProcessEnv = {}): RunConfig {
  const p = parse(args, env)
  assert.equal(p.kind, 'run', p.kind === 'error' ? p.message : undefined)
  return (p as Extract<ParsedCli, { kind: 'run' }>).config
}

function errorOf(args: string[]): string {
  const p = parse(args)
  assert.equal(p.kind, 'error', `expected an error for ${args.join(' ')}`)
  return (p as Extract<ParsedCli, { kind: 'error' }>).message
}

test('defaults equal DEFAULTS', () => {
  const c = run(['videos'])
  assert.deepEqual(c.inputs, [path.resolve(CWD, 'videos')])
  assert.equal(c.recursive, false)
  assert.equal(c.source, DEFAULTS.source)
  assert.deepEqual(c.extensions, [...DEFAULT_VIDEO_EXTENSIONS])
  assert.equal(c.parallel, DEFAULTS.parallel)
  assert.equal(c.ffmpegPath, null)
  assert.equal(c.ffprobePath, null)
  assert.deepEqual(c.encoders, [...DEFAULTS.encoders])
  assert.equal(c.hwaccel, DEFAULTS.hwaccel)
  assert.equal(c.maxSide, DEFAULTS.maxSide)
  assert.equal(c.maxRateKbps, DEFAULTS.maxRateKbps)
  assert.equal(c.minOutputBytes, DEFAULTS.minOutputBytes)
  assert.equal(c.existing, DEFAULTS.existing)
  assert.equal(c.deleteMode, DEFAULTS.deleteMode)
  assert.equal(c.deleteOriginal, false)
  assert.equal(c.failureLog, true)
  assert.equal(c.upload, null)
  assert.equal(c.output, 'tty')
  assert.deepEqual(c.jobDefaults, { size: null, rate: null, crop: null, bright: null, contrast: null, transpose: null, convert: false })
})

test('every flag', () => {
  const c = run([
    '-r', '--source', 'json', '--ext', 'mp4,mkv', '-j', '4', '--ffmpeg', 'bin', '--ffprobe', 'bin2',
    '--encoders', 'libx264', '--hwaccel', 'auto', '--same-size', '--max-side', '720', '--max-rate', '900',
    '--min-output-bytes', '10', '--keep-parts', '--ignore-errors', '--verbose-ffmpeg', '--size', '640X360',
    '--rate', '700', '--crop', '1:2:300:200', '--bright', '-0.5', '--contrast', '1.5', '--transpose', '-90',
    '--convert-first', '--existing', 'replace', '--delete-original', '--delete-mode', 'permanent',
    '--upload', 'rclone copy {outputs} "remote:my videos"', '--upload-all', 'echo {outputs}', '--move-orphans',
    '--state', 's.txt', '--log-file', 'l.txt', '--no-failure-log', '--dry-run', '--list', '--plain', '-q', 'a', 'b'
  ])
  assert.deepEqual(c.inputs, [path.resolve(CWD, 'a'), path.resolve(CWD, 'b')])
  assert.equal(c.recursive, true)
  assert.equal(c.source, 'json')
  assert.deepEqual(c.extensions, ['.mp4', '.mkv'])
  assert.equal(c.parallel, 4)
  assert.equal(c.ffmpegPath, path.resolve(CWD, 'bin'))
  assert.equal(c.ffprobePath, path.resolve(CWD, 'bin2'))
  assert.deepEqual(c.encoders, ['libx264'])
  assert.equal(c.hwaccel, 'auto')
  assert.equal(c.sameSize, true)
  assert.equal(c.maxSide, 720)
  assert.equal(c.maxRateKbps, 900)
  assert.equal(c.minOutputBytes, 10)
  assert.equal(c.keepParts && c.ignoreErrors && c.verboseFfmpeg, true)
  assert.deepEqual(c.jobDefaults, {
    size: '640x360', rate: 700, crop: { x: 1, y: 2, w: 300, h: 200 }, bright: -0.5, contrast: 1.5, transpose: -90, convert: true
  })
  assert.equal(c.existing, 'replace')
  assert.equal(c.deleteOriginal, true)
  assert.equal(c.deleteMode, 'permanent')
  assert.deepEqual(c.upload, { command: 'rclone', args: ['copy', '{outputs}', 'remote:my videos'] })
  assert.deepEqual(c.uploadAll, { command: 'echo', args: ['{outputs}'] })
  assert.equal(c.moveOrphans, true)
  assert.equal(c.stateFile, path.resolve(CWD, 's.txt'))
  assert.equal(c.logFile, path.resolve(CWD, 'l.txt'))
  assert.equal(c.failureLog, false)
  assert.equal(c.dryRun && c.listOnly && c.quiet, true)
  assert.equal(c.output, 'plain')
})

test('aliases --force and --cpu, --json output, size forms', () => {
  assert.equal(run(['--force', 'x']).source, 'force')
  assert.equal(run(['--cpu', 'x']).hwaccel, 'none')
  assert.equal(run(['--json', 'x']).output, 'json')
  assert.equal(run(['--size', '-1', 'x']).jobDefaults.size, '-1')
  assert.equal(run(['--size', '640:360', 'x']).jobDefaults.size, '640x360')
  assert.match(errorOf(['--force', '--source', 'json', 'x']), /conflicts/)
  assert.match(errorOf(['--cpu', '--hwaccel', 'cuda', 'x']), /conflicts/)
})

test('env fallbacks, flags win', () => {
  const env = { VCONV_FFMPEG: path.resolve('opt', 'ff'), VCONV_FFPROBE: path.resolve('opt', 'fp') }
  const c = run(['x'], env)
  assert.equal(c.ffmpegPath, env.VCONV_FFMPEG)
  assert.equal(c.ffprobePath, env.VCONV_FFPROBE)
  assert.equal(run(['--ffmpeg', 'mine', 'x'], env).ffmpegPath, path.resolve(CWD, 'mine'))
})

test('invalid values give errors that name the flag', () => {
  const cases: Array<[string[], RegExp]> = [
    [['-j', '0', 'x'], /--parallel/],
    [['-j', '33', 'x'], /--parallel/],
    [['-j', 'two', 'x'], /--parallel/],
    [['--hwaccel', 'gpu', 'x'], /--hwaccel/],
    [['--source', 'x', 'y'], /--source/],
    [['--existing', 'x', 'y'], /--existing/],
    [['--delete-mode', 'x', 'y'], /--delete-mode/],
    [['--size', '640', 'x'], /--size/],
    [['--size', '0x10', 'x'], /--size/],
    [['--crop', '1:2:3', 'x'], /--crop/],
    [['--crop', '0:0:0:5', 'x'], /--crop/],
    [['--bright', '2', 'x'], /--bright/],
    [['--contrast', '-5', 'x'], /--contrast/],
    [['--transpose', '45', 'x'], /--transpose/],
    [['--encoders', 'a;b', 'x'], /--encoders/],
    [['--max-side', '1', 'x'], /--max-side/],
    [['--upload', '"open', 'x'], /--upload/],
    [['--bogus', 'x'], /bogus/]
  ]
  for (const [args, re] of cases) assert.match(errorOf(args), re, args.join(' '))
})

test('missing input is an error, except --tools/--help/--version', () => {
  assert.match(errorOf([]), /no input/)
  assert.equal(parse(['--help']).kind, 'help')
  assert.equal(parse(['-h']).kind, 'help')
  assert.equal(parse(['-v']).kind, 'version')
  assert.deepEqual(parse(['--tools', '--json', '--ffmpeg', 'f']), {
    kind: 'tools', tools: { ffmpegPath: path.resolve(CWD, 'f'), ffprobePath: null }, json: true
  })
})

test('Windows paths with spaces and -- handling', () => {
  const win = 'D:\\My Videos\\clips'
  const c = run(['--', win, '-weird.mp4'])
  assert.equal(c.inputs.length, 2)
  assert.equal(c.inputs[0], path.resolve(CWD, win))
  assert.equal(c.inputs[1], path.resolve(CWD, '-weird.mp4'))
  assert.equal(run(['~/vids']).inputs[0], path.resolve(CWD, '~/vids'))
})

test('verbose is reported separately', () => {
  const p = parse(['--verbose', 'x'])
  assert.equal(p.kind === 'run' && p.verbose, true)
})

test('usage documents the main options, exit codes and examples', () => {
  const text = usage()
  for (const s of ['--delete-original', '--parallel', '{outputs}', 'EXIT CODES', 'PowerShell', '--list']) {
    assert.ok(text.includes(s), s)
  }
})

test('default state file per platform, --state and --no-state', () => {
  const win = parseCliArgs(['x'], { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, CWD, 'win32')
  assert.equal(win.kind === 'run' && win.config.stateFile, 'C:\\Users\\u\\AppData\\Local\\vconv\\state.jsonl')
  assert.equal(defaultStatePath({ USERPROFILE: 'C:\\Users\\u' }, 'win32', 'H'), 'C:\\Users\\u\\AppData\\Local\\vconv\\state.jsonl')
  assert.equal(defaultStatePath({ XDG_STATE_HOME: '/xdg' }, 'linux', '/h'), '/xdg/vconv/state.jsonl')
  assert.equal(defaultStatePath({ HOME: '/home/u' }, 'linux', '/h'), '/home/u/.local/state/vconv/state.jsonl')
  assert.equal(defaultStatePath({}, 'linux', '/h'), '/h/.local/state/vconv/state.jsonl')
  assert.equal(defaultStatePath({ HOME: '/Users/u' }, 'darwin', '/h'), '/Users/u/Library/Application Support/vconv/state.jsonl')
  assert.equal(run(['--no-state', 'x']).stateFile, null)
  assert.match(errorOf(['--state', 's', '--no-state', 'x']), /--no-state/)
  assert.equal(typeof run(['x']).stateFile, 'string')
})

test('hook templates are validated at parse time', () => {
  assert.match(errorOf(['--upload', 'echo {nope}', 'x']), /--upload.*nope/)
  assert.match(errorOf(['--upload', 'echo {outputs', 'x']), /--upload/)
  assert.match(errorOf(['--upload-all', 'echo {file}', 'x']), /--upload-all.*file/)
  assert.match(errorOf(['--upload-all', 'echo {md5}', 'x']), /--upload-all/)
  assert.equal(run(['--upload', 'echo {file} {md5} {root} {dir} {outputs}', 'x']).upload?.command, 'echo')
  assert.equal(run(['--upload-all', 'echo {files} {outputs} {dir}', 'x']).uploadAll?.command, 'echo')
})

test('stall and hook timeouts', () => {
  assert.equal(run(['x']).stallTimeoutMs, DEFAULTS.stallTimeoutMs)
  assert.equal(run(['--stall-timeout', '5', '--hook-timeout', '30', 'x']).stallTimeoutMs, 300_000)
  assert.equal(run(['--stall-timeout', '5', '--hook-timeout', '30', 'x']).hookTimeoutMs, 30_000)
  assert.match(errorOf(['--stall-timeout', 'a', 'x']), /--stall-timeout/)
})

test('.bat and .cmd hook commands are rejected, any case', () => {
  assert.match(errorOf(['--upload', 'upload.BAT {file}', 'x']), /batch files/)
  assert.match(errorOf(['--upload-all', 'C:/tools/up.cmd {outputs}', 'x']), /powershell/)
  assert.equal(run(['--upload', 'powershell -NoProfile -File up.ps1 {outputs}', 'x']).upload?.command, 'powershell')
})
