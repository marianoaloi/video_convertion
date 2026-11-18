import assert from 'node:assert/strict'
import { rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { after, before, describe, it } from 'node:test'
import { normaliseRotation, parseFrameRate, probeMedia, toMediaInfo } from '../../src/ffmpeg/probe.js'
import { findTestTools, generateAudio, generateImage, generateVideo, makeTempDir } from './fixtures.js'

describe('parseFrameRate / normaliseRotation', () => {
  it('parses fractions and rejects 0/0', () => {
    assert.equal(parseFrameRate('25/1'), 25)
    assert.ok(Math.abs((parseFrameRate('30000/1001') ?? 0) - 29.97) < 0.01)
    assert.equal(parseFrameRate('0/0'), null)
    assert.equal(parseFrameRate('1/0'), null)
    assert.equal(parseFrameRate(undefined), null)
  })
  it('normalises to (-180, 180]', () => {
    assert.equal(normaliseRotation(270), -90)
    assert.equal(normaliseRotation(-90), -90)
    assert.equal(normaliseRotation(180), 180)
    assert.equal(normaliseRotation(-180), 180)
    assert.equal(normaliseRotation(360), 0)
    assert.equal(normaliseRotation(450), 90)
  })
})

describe('toMediaInfo (pure)', () => {
  it('maps a typical H.264 + AAC file', () => {
    const info = toMediaInfo('/v/a.mp4', {
      streams: [
        {
          codec_type: 'video',
          codec_name: 'h264',
          width: 1280,
          height: 720,
          pix_fmt: 'yuv420p',
          avg_frame_rate: '30000/1001',
          bit_rate: '900000'
        },
        { codec_type: 'audio', codec_name: 'aac', channels: 2 }
      ],
      format: { format_name: 'mov,mp4,m4a,3gp,3g2,mj2', duration: '12.3456', size: '1048576', bit_rate: '1234567' }
    })
    assert.deepEqual(
      { ...info, fps: undefined },
      {
        path: '/v/a.mp4',
        container: 'mov,mp4,m4a,3gp,3g2,mj2',
        formatLongName: null,
        durationMs: 12345,
        sizeBytes: 1048576,
        bitrateKbps: 1234,
        hasVideo: true,
        width: 1280,
        height: 720,
        displayWidth: 1280,
        displayHeight: 720,
        rotation: 0,
        fps: undefined,
        videoCodec: 'h264',
        pixFmt: 'yuv420p',
        hasAudio: true,
        audioCodec: 'aac',
        audioChannels: 2,
        streamCount: 2
      }
    )
    assert.ok(Math.abs((info.fps ?? 0) - 29.97) < 0.01)
  })

  it('swaps the display size for a 90 degree rotation (side data)', () => {
    const info = toMediaInfo('/v/r.mp4', {
      streams: [
        {
          codec_type: 'video',
          width: 1920,
          height: 1080,
          side_data_list: [{ side_data_type: 'Display Matrix', rotation: -90 }]
        }
      ],
      format: { duration: '1' }
    })
    assert.equal(info.rotation, -90)
    assert.deepEqual([info.displayWidth, info.displayHeight], [1080, 1920])
    assert.deepEqual([info.width, info.height], [1920, 1080])
  })

  it('converts the old clockwise tags.rotate and falls back to the stream bitrate/duration', () => {
    const info = toMediaInfo('/v/old.mp4', {
      streams: [
        { codec_type: 'video', width: 640, height: 360, duration: '2.5', bit_rate: '500000', tags: { rotate: '90' } }
      ],
      format: {}
    })
    assert.equal(info.rotation, -90)
    assert.equal(info.durationMs, 2500)
    assert.equal(info.bitrateKbps, 500)
  })

  it('ignores cover art and reports audio-only files', () => {
    const info = toMediaInfo('/v/song.mp3', {
      streams: [
        { codec_type: 'audio', codec_name: 'mp3', channels: 2 },
        { codec_type: 'video', codec_name: 'mjpeg', width: 500, height: 500, disposition: { attached_pic: 1 } }
      ],
      format: { duration: '3' }
    })
    assert.equal(info.hasVideo, false)
    assert.equal(info.width, 0)
    assert.equal(info.bitrateKbps, null)
    assert.equal(info.hasAudio, true)
  })

  it('fails without streams and on a wrong shape', () => {
    assert.throws(() => toMediaInfo('/v/x.bin', { streams: [], format: {} }), /no streams/)
    assert.throws(() => toMediaInfo('/v/x.bin', 'nope'), /unexpected shape/)
    assert.throws(() => toMediaInfo('/v/x.bin', { streams: {} }), /unexpected shape/)
  })
})

const tools = findTestTools()

describe('probeMedia (real ffprobe)', { skip: tools === null }, () => {
  let dir = ''
  before(async () => {
    dir = await makeTempDir('probe')
  })
  after(async () => {
    await rm(dir, { recursive: true, force: true })
  })
  const ffprobePath = tools?.ffprobe ?? ''

  it('probes a generated H.264/AAC clip', async () => {
    if (tools === null) return
    const file = await generateVideo(tools, dir, 'clip.mp4')
    const info = await probeMedia(file, { ffprobePath })
    assert.equal(info.path, file)
    assert.deepEqual([info.width, info.height], [320, 240])
    assert.ok(Math.abs((info.fps ?? 0) - 25) < 0.1)
    assert.ok(info.durationMs > 2800 && info.durationMs < 3300)
    assert.equal(info.videoCodec, 'h264')
    assert.equal(info.audioCodec, 'aac')
    assert.equal(info.rotation, 0)
    assert.ok(info.container.includes('mp4'))
    assert.ok((info.bitrateKbps ?? 0) > 0)
  })

  it('reads rotation from the display matrix and swaps the display size', async () => {
    if (tools === null) return
    const file = await generateVideo(tools, dir, 'rot.mp4', { seconds: 1, rotate: 90 })
    const info = await probeMedia(file, { ffprobePath })
    assert.equal(Math.abs(info.rotation), 90)
    assert.deepEqual([info.displayWidth, info.displayHeight], [240, 320])
  })

  it('probes a silent video, an image and an audio-only file', async () => {
    if (tools === null) return
    const silent = await generateVideo(tools, dir, 'silent.mp4', { seconds: 1, audio: false })
    assert.equal((await probeMedia(silent, { ffprobePath })).hasAudio, false)
    const image = await probeMedia(await generateImage(tools, dir, 'pic.png'), { ffprobePath })
    assert.deepEqual([image.hasVideo, image.width, image.height], [true, 64, 48])
    const audio = await probeMedia(await generateAudio(tools, dir, 'tone.wav'), { ffprobePath })
    assert.deepEqual([audio.hasVideo, audio.hasAudio], [false, true])
  })

  it('rejects a corrupt file, a missing file, a bad ffprobe path and an aborted probe', async () => {
    const bad = path.join(dir, 'garbage.mp4')
    await writeFile(bad, Buffer.from('this is not a media file at all'))
    await assert.rejects(probeMedia(bad, { ffprobePath }))
    await assert.rejects(probeMedia(path.join(dir, 'missing.mp4'), { ffprobePath }))
    await assert.rejects(
      probeMedia(bad, { ffprobePath: path.join(dir, 'no-ffprobe') }),
      /could not be started/
    )
    const ac = new AbortController()
    ac.abort()
    await assert.rejects(probeMedia(bad, { ffprobePath, signal: ac.signal }), /cancelled/)
  })
})
