import assert from 'node:assert/strict'
import { describe, it } from 'node:test'
import { parseH264Encoders, parseHwaccels, parseVersion, readToolsStatus } from '../../src/ffmpeg/tools.js'
import { findTestTools } from './fixtures.js'

describe('tools status parsers', () => {
  it('reads the version of ffmpeg and ffprobe', () => {
    assert.equal(parseVersion('ffmpeg version 6.1.1-essentials_build Copyright'), '6.1.1-essentials_build')
    assert.equal(parseVersion('ffprobe version n7.0 x'), 'n7.0')
    assert.equal(parseVersion('nothing'), null)
  })

  it('keeps the H.264 video encoders', () => {
    const text = [
      'Encoders:',
      ' V....D libx264              libx264 H.264 (codec h264)',
      ' V....D h264_nvenc           NVIDIA NVENC H.264 encoder',
      ' V....D libx265              libx265 H.265',
      ' A....D aac                  AAC',
      ' V....D libx264              duplicate'
    ].join('\n')
    assert.deepEqual(parseH264Encoders(text), ['libx264', 'h264_nvenc'])
  })

  it('lists the hwaccel methods', () => {
    assert.deepEqual(parseHwaccels('Hardware acceleration methods:\ncuda\r\ndxva2\n\n'), ['cuda', 'dxva2'])
    assert.deepEqual(parseHwaccels('nothing here'), [])
  })
})

describe('readToolsStatus', () => {
  it('reports a missing explicit ffmpeg without falling back to PATH', async () => {
    const status = await readToolsStatus({ ffmpegPath: '/definitely/not/here/ffmpeg', ffprobePath: null })
    assert.equal(status.ffmpeg, null)
    assert.match(status.error ?? '', /ffmpeg was not found/)
  })

  it('queries the real ffmpeg when present', { skip: findTestTools() === null }, async () => {
    const status = await readToolsStatus({ ffmpegPath: null, ffprobePath: null })
    assert.equal(status.error, null)
    assert.ok(status.ffmpeg?.version)
    assert.ok(status.h264Encoders.includes('libx264'))
  })
})
