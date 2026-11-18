import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { access, readdir, readFile, rm } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, beforeEach, describe, it } from 'node:test'
import { removeFile, trashFreedesktop } from '../../src/jobs/trash.js'
import { makeTmp, write } from './kit.js'

let tmp: Awaited<ReturnType<typeof makeTmp>>
beforeEach(async () => {
  tmp = await makeTmp()
})
afterEach(() => tmp.cleanup())

const exists = (f: string): Promise<boolean> => access(f).then(() => true, () => false)

const facts = (over: object = {}): string =>
  JSON.stringify({
    drive: 'C:\\',
    isUnc: false,
    driveType: 'Fixed',
    nukeOnDelete: null,
    maxCapacityMb: null,
    volumeSize: 1e12,
    freeBytes: 5e11,
    fileSize: 2000,
    ...over
  })

function realExec(command: string, args: string[], env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { env }, (error, out) => (error ? reject(error) : resolve(out)))
  })
}

describe('removeFile', () => {
  it('permanent removes the file and throws when it is missing', async () => {
    const file = await write(path.join(tmp.dir, 'a.mp4'))
    await removeFile(file, 'permanent')
    assert.ok(!(await exists(file)))
    await assert.rejects(removeFile(file, 'permanent'))
  })

  it('win32: reads the facts first, then deletes; the path only travels in the environment', async () => {
    const file = await write(path.join(tmp.dir, "we ird; $(name) 'q'.mp4"))
    const calls: { command: string; args: string[]; env: NodeJS.ProcessEnv }[] = []
    await assert.rejects(
      removeFile(file, 'trash', {
        platform: 'win32',
        exec: async (command, args, env) => {
          calls.push({ command, args, env })
          return calls.length === 1 ? facts() : ''
        }
      }),
      /still there/ // the fake delete removes nothing, so the post-check must fire
    )
    assert.equal(calls.length, 2)
    for (const call of calls) {
      assert.equal(call.command, 'powershell.exe')
      assert.equal(call.env['VCONV_TRASH_PATH'], path.resolve(file))
      assert.ok(call.args.every((a) => !a.includes('ird') && !a.includes(tmp.dir)))
    }
    assert.match(calls[1]?.args.at(-1) ?? '', /SendToRecycleBin/)
  })

  it('win32: a refusing decision never reaches the delete call and keeps the file', async () => {
    const file = await write(path.join(tmp.dir, 'big.mp4'))
    let calls = 0
    await assert.rejects(
      removeFile(file, 'trash', {
        platform: 'win32',
        exec: async () => {
          calls += 1
          return facts({ maxCapacityMb: 1, fileSize: 50 * 1024 * 1024 })
        }
      }),
      /larger than the Recycle Bin/
    )
    assert.equal(calls, 1)
    assert.ok(await exists(file))
  })

  it('win32: unreadable facts keep the file', async () => {
    const file = await write(path.join(tmp.dir, 'a.mp4'))
    await assert.rejects(
      removeFile(file, 'trash', { platform: 'win32', exec: async () => 'not json' }),
      /Cannot check the Recycle Bin/
    )
    assert.ok(await exists(file))
  })

  it('trash propagates failures and never falls back to a permanent delete', async () => {
    const file = await write(path.join(tmp.dir, 'a.mp4'))
    await assert.rejects(
      removeFile(file, 'trash', { platform: 'win32', exec: async () => Promise.reject(new Error('no recycle bin')) }),
      /no recycle bin/
    )
    assert.ok(await exists(file))
    await assert.rejects(removeFile(file, 'trash', { platform: 'freebsd' as NodeJS.Platform }), /not supported/)
    assert.ok(await exists(file))
  })

  it('linux uses gio, and the freedesktop spec when gio is missing', async () => {
    const file = await write(path.join(tmp.dir, 'a.mp4'))
    const commands: string[] = []
    await removeFile(file, 'trash', {
      platform: 'linux',
      exec: async (command, args) => {
        commands.push(`${command} ${args[0]}`)
        await rm(file)
      }
    })
    assert.deepEqual(commands, ['gio trash'])

    await write(file)
    const dataHome = path.join(tmp.dir, 'data')
    await removeFile(file, 'trash', {
      platform: 'linux',
      env: { XDG_DATA_HOME: dataHome },
      exec: async () => Promise.reject(Object.assign(new Error('spawn gio ENOENT'), { code: 'ENOENT' }))
    })
    assert.ok(!(await exists(file)))
    assert.deepEqual(await readdir(path.join(dataHome, 'Trash', 'files')), ['a.mp4'])
    const info = await readFile(path.join(dataHome, 'Trash', 'info', 'a.mp4.trashinfo'), 'utf8')
    assert.match(info, /^\[Trash Info\]\nPath=.*a\.mp4\nDeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/)
  })

  it('linux: a gio that reports success without removing the file is an error', async () => {
    const file = await write(path.join(tmp.dir, 'a.mp4'))
    await assert.rejects(removeFile(file, 'trash', { platform: 'linux', exec: async () => '' }), /still there/)
  })

  it('freedesktop trash picks a unique name and encodes the path', async () => {
    const dataHome = path.join(tmp.dir, 'data')
    const one = await write(path.join(tmp.dir, 'sub dir', 'a b.mp4'))
    await trashFreedesktop(one, { XDG_DATA_HOME: dataHome })
    const two = await write(one)
    await trashFreedesktop(two, { XDG_DATA_HOME: dataHome })
    assert.deepEqual((await readdir(path.join(dataHome, 'Trash', 'files'))).sort(), ['a b.mp4', 'a b.mp4.1'])
    const info = await readFile(path.join(dataHome, 'Trash', 'info', 'a b.mp4.trashinfo'), 'utf8')
    assert.match(info, /a%20b\.mp4/)
  })

  it('really sends a small file to the Recycle Bin on win32', { skip: process.platform !== 'win32' }, async () => {
    const file = await write(path.join(tmp.dir, "to recycle; $x 'q'.mp4"))
    await removeFile(file, 'trash')
    assert.ok(!(await exists(file)))
  })

  it('win32: the real facts script works, and a too-big verdict keeps the file', { skip: process.platform !== 'win32' }, async () => {
    const file = await write(path.join(tmp.dir, 'real.mp4'))
    let deleteCalls = 0
    await assert.rejects(
      removeFile(file, 'trash', {
        exec: async (command, args, env) => {
          if (deleteCalls > 0 || args.at(-1)?.includes('DeleteFile')) {
            deleteCalls += 1
            throw new Error('delete must not be called')
          }
          const real = JSON.parse(await realExec(command, args, env)) as Record<string, unknown>
          assert.equal(real['isUnc'], false)
          assert.equal(real['fileSize'], 2000)
          assert.equal(typeof real['volumeSize'], 'number')
          return JSON.stringify({ ...real, maxCapacityMb: 1, fileSize: 10 * 1024 * 1024 * 1024 })
        }
      }),
      /larger than the Recycle Bin/
    )
    assert.equal(deleteCalls, 0)
    assert.ok(await exists(file))
  })
})
