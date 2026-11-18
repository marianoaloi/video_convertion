/**
 * Scenario 10: graceful stop and abort with real ffmpeg, at the `startRun` level (config built by
 * the CLI's own parser), plus a real console Ctrl+C sent to the CLI on Windows.
 */
import assert from 'node:assert/strict'
import { execFile, spawn } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { promisify } from 'node:util'
import { parseCliArgs } from '../../src/cli/args.js'
import { detectConsoleIsolation } from '../../src/ffmpeg/isolation.js'
import { startRun } from '../../src/jobs/run.js'
import type { RunController, RunEvent } from '../../src/types.js'
import {
  CLI,
  CPU,
  IS_WIN,
  SKIP,
  TOOLS,
  assertCountersConsistent,
  clip,
  isolatedEnv,
  makeTmp,
  names,
  ofType,
  parseEvents,
  put,
  summaryOf,
  type Tmp
} from './helpers.js'

const execFileP = promisify(execFile)

let tmp: Tmp
beforeEach(async () => {
  tmp = await makeTmp()
})
afterEach(() => tmp.cleanup())

/** Six 20 s 1280x720 clips: each conversion takes about a second, long enough to interrupt. */
async function sixLongClips(dir: string): Promise<void> {
  for (let i = 1; i <= 6; i++) await clip(path.join(dir, `c${i}.mp4`), { w: 1280, h: 720, seconds: 20 })
}

/** Command lines of running ffmpeg processes that mention `dir`. */
async function ffmpegUsing(dir: string): Promise<string[]> {
  if (IS_WIN) {
    const script = "Get-CimInstance Win32_Process -Filter \"Name='ffmpeg.exe'\" | ForEach-Object { $_.CommandLine }"
    const { stdout } = await execFileP('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true })
    return stdout.split(/\r?\n/).filter((l) => l.includes(dir))
  }
  const { stdout } = await execFileP('ps', ['-eo', 'args'])
  return stdout.split('\n').filter((l) => /ffmpeg/.test(l) && l.includes(dir))
}

async function runWith(dir: string, onEvent: (e: RunEvent, controller: RunController) => void) {
  const parsed = parseCliArgs([...CPU, '-j', '2', dir], isolatedEnv(), dir)
  assert.equal(parsed.kind, 'run')
  if (parsed.kind !== 'run') throw new Error('unreachable')
  const ffmpeg = TOOLS.ffmpeg as string
  const spawnPolicy = await detectConsoleIsolation(ffmpeg)
  const events: RunEvent[] = []
  let controller: RunController | null = null
  const run = startRun({ ...parsed.config, output: 'json' }, { ffmpeg, ffprobe: TOOLS.ffprobe as string, spawn: spawnPolicy }, (e) => {
    events.push(e)
    if (controller !== null) onEvent(e, controller)
  })
  controller = run.controller
  const summary = await run.done
  return { events, summary }
}

describe('stopping a run (startRun, real ffmpeg)', { skip: SKIP }, () => {
  it('stopLaunching(): running jobs finish, queued ones are cancelled, no .part.mp4 is left', async () => {
    await sixLongClips(tmp.dir)
    let stopped = false
    const { events, summary } = await runWith(tmp.dir, (e, c) => {
      if (!stopped && e.type === 'counters' && e.counters.processing === 2) {
        stopped = true
        c.stopLaunching()
      }
    })
    assert.ok(stopped)
    assert.equal(summary.interrupted, true)
    const final = assertCountersConsistent(events)
    assert.deepEqual([final.done, final.cancelled, final.failed], [2, 4, 0])
    assert.equal(ofType(events, 'started').length, 2)
    const files = await names(tmp.dir)
    assert.equal(files.filter((n) => n.endsWith('.0.mp4')).length, 2, files.join(', '))
    assert.ok(files.every((n) => !n.includes('.part.')), files.join(', '))
  })

  it('abortAll() while ffmpeg runs: running jobs end cancelled, no partial output or .part.mp4 remains', async () => {
    await sixLongClips(tmp.dir)
    let aborted = false
    const { events, summary } = await runWith(tmp.dir, (e, c) => {
      if (!aborted && e.type === 'progress' && (e.outTimeMs ?? 0) > 0) {
        aborted = true
        c.abortAll()
      }
    })
    assert.ok(aborted)
    assert.equal(summary.interrupted, true)
    const final = assertCountersConsistent(events)
    assert.deepEqual([final.done, final.failed, final.cancelled], [0, 0, 6])
    const files = await names(tmp.dir)
    assert.deepEqual(files, ['c1.mp4', 'c2.mp4', 'c3.mp4', 'c4.mp4', 'c5.mp4', 'c6.mp4'])
    assert.deepEqual(await ffmpegUsing(tmp.dir), [], 'no ffmpeg may outlive the abort')
  })

  it('stopLaunching() during the scan cancels everything before any ffmpeg starts', async () => {
    await sixLongClips(tmp.dir)
    const { events, summary } = await runWith(tmp.dir, (e, c) => {
      if (e.type === 'scan-done') c.stopLaunching()
    })
    assert.equal(ofType(events, 'started').length, 0)
    assert.equal(summary.counters.cancelled, 6)
    assert.equal(summary.interrupted, true)
  })
})

// ---- a real console Ctrl+C (Windows) ----------------------------------------------------------

/** Starts the CLI in its own hidden console with Ctrl+C enabled; prints `exit=<code>` at the end. */
const LAUNCH_PS1 = String.raw`param([string]$Node, [string]$Cli, [string]$OutFile, [string]$ErrFile, [string]$PidFile, [string]$CliArgs)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace VconvIt -Name Launch -MemberDefinition '[DllImport("kernel32.dll")] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool add);'
# Children inherit "ignore Ctrl+C" (e.g. from Git Bash): clear it so the CLI gets a real Ctrl+C.
[void][VconvIt.Launch]::SetConsoleCtrlHandler([IntPtr]::Zero, $false)
$quoted = @($Cli) + $CliArgs.Split('|') | ForEach-Object { '"' + $_ + '"' }
$p = Start-Process -FilePath $Node -ArgumentList $quoted -RedirectStandardOutput $OutFile -RedirectStandardError $ErrFile -WindowStyle Hidden -PassThru
$null = $p.Handle
Set-Content -LiteralPath $PidFile -Value $p.Id
$p.WaitForExit()
Write-Output ("exit=" + $p.ExitCode)
`

/** Waits until `$OutFile` contains `$Trigger`, attaches to the CLI's console and sends Ctrl+C `$Count` times. */
const SEND_PS1 = String.raw`param([string]$PidFile, [string]$OutFile, [string]$Trigger, [int]$Count = 1)
$ErrorActionPreference = 'Stop'
Add-Type -Namespace VconvIt -Name Con -MemberDefinition @'
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool FreeConsole();
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool AttachConsole(uint pid);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool SetConsoleCtrlHandler(System.IntPtr h, bool add);
[DllImport("kernel32.dll", SetLastError=true)] public static extern bool GenerateConsoleCtrlEvent(uint ev, uint group);
'@
$deadline = (Get-Date).AddSeconds(60)
$ready = $false
while (-not $ready -and (Get-Date) -lt $deadline) {
  if ((Test-Path -LiteralPath $PidFile) -and (Test-Path -LiteralPath $OutFile)) {
    try { $fs = [IO.File]::Open($OutFile, 'Open', 'Read', 'ReadWrite'); $text = (New-Object IO.StreamReader($fs)).ReadToEnd(); $fs.Close() } catch { $text = '' }
    if ($text.Contains($Trigger)) { $ready = $true }
  }
  if (-not $ready) { Start-Sleep -Milliseconds 50 }
}
if (-not $ready) { exit 5 }
$target = [uint32]([IO.File]::ReadAllText($PidFile).Trim())
[void][VconvIt.Con]::FreeConsole()
if (-not [VconvIt.Con]::AttachConsole($target)) { exit 3 }
[void][VconvIt.Con]::SetConsoleCtrlHandler([IntPtr]::Zero, $true)
for ($i = 0; $i -lt $Count; $i++) {
  if (-not [VconvIt.Con]::GenerateConsoleCtrlEvent(0, 0)) { exit 4 }
  Start-Sleep -Milliseconds 300
}
[void][VconvIt.Con]::FreeConsole()
exit 0
`

function powershell(script: string, args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script, ...args], {
      windowsHide: true,
      env: isolatedEnv(), // the CLI started by Start-Process inherits it
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let out = ''
    child.stdout.on('data', (c: Buffer) => (out += c.toString()))
    child.stderr.on('data', (c: Buffer) => (out += c.toString()))
    child.on('error', reject)
    child.on('close', (code) => resolve({ code, out }))
  })
}

async function ctrlC(dir: string, trigger: string, count: number) {
  const launch = await put(path.join(dir, 'ps', 'launch.ps1'), LAUNCH_PS1)
  const send = await put(path.join(dir, 'ps', 'send.ps1'), SEND_PS1)
  const files = { out: path.join(dir, 'ps', 'out.ndjson'), err: path.join(dir, 'ps', 'err.txt'), pid: path.join(dir, 'ps', 'pid.txt') }
  const sender = powershell(send, ['-PidFile', files.pid, '-OutFile', files.out, '-Trigger', trigger, '-Count', String(count)])
  await new Promise((r) => setTimeout(r, 1500)) // let the sender compile its interop type first
  const clips = path.join(dir, 'clips')
  const cliArgs = ['--json', ...CPU, '-j', '2', clips].join('|')
  const launcher = await powershell(launch, ['-Node', process.execPath, '-Cli', CLI, '-OutFile', files.out, '-ErrFile', files.err, '-PidFile', files.pid, '-CliArgs', cliArgs])
  const sent = await sender
  const exit = /exit=(-?\d+)/.exec(launcher.out)
  return {
    sent: sent.code,
    code: exit ? Number(exit[1]) : null,
    events: parseEvents(await readFile(files.out, 'utf8')),
    stderr: await readFile(files.err, 'utf8'),
    clipsDir: clips,
    launcherOut: launcher.out
  }
}

describe('a real console Ctrl+C (Windows)', { skip: !IS_WIN ? 'Windows only' : SKIP }, () => {
  beforeEach(async () => {
    await sixLongClips(path.join(tmp.dir, 'clips'))
  })

  it('once: no new jobs start, the running ones finish, exit code 130', async () => {
    const r = await ctrlC(tmp.dir, '"processing":2', 1)
    assert.equal(r.sent, 0, 'the Ctrl+C sender failed')
    assert.equal(r.code, 130, r.launcherOut + r.stderr)
    assert.match(r.stderr, /Stopping: no new jobs/)
    const s = summaryOf(r.events)
    assert.equal(s.interrupted, true)
    assert.deepEqual([s.counters.done, s.counters.cancelled, s.counters.failed], [2, 4, 0])
    const files = await names(r.clipsDir)
    assert.equal(files.filter((n) => n.endsWith('.0.mp4')).length, 2)
    assert.ok(files.every((n) => !n.includes('.part.')))
  })

  it('twice: the running ffmpeg processes are killed, nothing partial remains', async () => {
    const r = await ctrlC(tmp.dir, '"type":"progress"', 2)
    assert.equal(r.sent, 0, 'the Ctrl+C sender failed')
    assert.equal(r.code, 130, r.launcherOut + r.stderr)
    assert.match(r.stderr, /Killing the running jobs/)
    const s = summaryOf(r.events)
    assert.equal(s.counters.cancelled + s.counters.done, 6)
    assert.equal(s.counters.failed, 0)
    const files = await names(r.clipsDir)
    assert.ok(files.every((n) => !n.includes('.part.')), files.join(', '))
    assert.equal(files.filter((n) => n.endsWith('.0.mp4')).length, s.counters.done)
    assert.deepEqual(await ffmpegUsing(r.clipsDir), [])
  })
})
