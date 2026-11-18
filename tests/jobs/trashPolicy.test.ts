import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { decideWindowsTrash, parseTrashFacts, type TrashFacts } from '../../src/jobs/trashPolicy.js'

const GIB = 1024 ** 3
const base: TrashFacts = {
  drive: 'C:\\',
  isUnc: false,
  driveType: 'Fixed',
  nukeOnDelete: null,
  maxCapacityMb: null,
  volumeSize: 1000 * GIB,
  freeBytes: 500 * GIB,
  fileSize: 100 * 1024 * 1024
}
const reason = (over: Partial<TrashFacts>): string => {
  const d = decideWindowsTrash({ ...base, ...over })
  return d.ok ? 'ok' : d.reason
}

describe('decideWindowsTrash', () => {
  it('accepts a small file on a fixed drive with default settings', () => {
    assert.equal(reason({}), 'ok')
  })

  it('refuses UNC paths and non-fixed drives', () => {
    assert.match(reason({ isUnc: true }), /network \(UNC\)/)
    assert.equal(reason({ driveType: 'Network' }), 'no Recycle Bin on Network drive')
    assert.equal(reason({ driveType: 'Removable' }), 'no Recycle Bin on Removable drive')
    assert.equal(reason({ driveType: 'CDRom' }), 'no Recycle Bin on CDRom drive')
  })

  it('refuses NukeOnDelete', () => {
    assert.match(reason({ nukeOnDelete: true }), /NukeOnDelete/)
    assert.equal(reason({ nukeOnDelete: false }), 'ok')
  })

  it('refuses a file larger than the configured MaxCapacity (MB)', () => {
    const text = reason({ maxCapacityMb: 50 })
    assert.match(text, /larger than the Recycle Bin of C:\\ \(50 MB\)/)
    assert.match(text, /--delete-mode permanent/)
    assert.equal(reason({ maxCapacityMb: 100 }), 'ok')
    assert.equal(reason({ maxCapacityMb: 200 }), 'ok')
  })

  it('assumes 5% of the volume when nothing is configured', () => {
    assert.match(reason({ fileSize: 60 * GIB }), /larger than the Recycle Bin/)
    assert.equal(reason({ fileSize: 40 * GIB }), 'ok')
  })

  it('never assumes more than the free space', () => {
    assert.match(reason({ freeBytes: 10 * 1024 * 1024, fileSize: 20 * 1024 * 1024 }), /larger than the Recycle Bin/)
  })

  it('parses the PowerShell facts JSON', () => {
    const text = JSON.stringify({
      drive: 'D:\\',
      isUnc: false,
      driveType: 'Fixed',
      nukeOnDelete: 1,
      maxCapacityMb: null,
      volumeSize: 10,
      freeBytes: 5,
      fileSize: 2
    })
    assert.deepEqual(parseTrashFacts(`${text}\n`), {
      drive: 'D:\\',
      isUnc: false,
      driveType: 'Fixed',
      nukeOnDelete: true,
      maxCapacityMb: null,
      volumeSize: 10,
      freeBytes: 5,
      fileSize: 2
    })
    assert.throws(() => parseTrashFacts('nope'))
  })
})
