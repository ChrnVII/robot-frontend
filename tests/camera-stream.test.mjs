import { readFileSync } from 'node:fs'
import vm from 'node:vm'
import assert from 'node:assert/strict'
import test from 'node:test'

const source = readFileSync(new URL('../src/composables/useCameraStream.js', import.meta.url), 'utf8')
  .replace(/import[\s\S]*?from ['"][^'"]+['"]/g, '')
  .replace('export function useCameraStream', 'function useCameraStream')

test('preview waits for keyframes after startup, overflow, server reset and reconnect', () => {
  const sockets = [], decoders = []
  const context = vm.createContext({
    console, ArrayBuffer, DataView, Uint8Array, performance, Date,
    ref: value => ({ value }), reactive: value => value, readonly: value => value,
    computed: fn => ({ get value() { return fn() } }), onBeforeUnmount() {},
    FRAME_FLAG: { KEY: 1, CONFIG: 2, RESET: 4 }, FRAME_HEADER_LENGTH: 9,
    cameraStreamBlockReason: () => '', getCameraPreviewUrl: () => 'ws://localhost/test',
    window: { requestAnimationFrame: () => 1, cancelAnimationFrame() {},
      setTimeout: () => 1, clearTimeout() {} },
    WebSocket: class {
      constructor() { sockets.push(this) }
      close() {}
    },
    EncodedVideoChunk: class { constructor(data) { Object.assign(this, data) } },
    VideoDecoder: class {
      constructor() { this.state = 'unconfigured'; this.decodeQueueSize = 0; this.chunks = []; decoders.push(this) }
      configure() { this.state = 'configured' }
      close() { this.state = 'closed' }
      decode(chunk) { assert.equal(this.state, 'configured'); this.chunks.push(chunk) }
    }
  })
  vm.runInContext(source + '\nglobalThis.createStream = useCameraStream', context)
  const stream = context.createStream()
  stream.attach({ getContext: () => ({ drawImage() {} }) })
  function config() {
    sockets.at(-1).onmessage({ data: JSON.stringify({ t: 'config', codec: 'avc1.64001F', t0: 1, size: [640, 480] }) })
  }
  function send(flags, size = 10) {
    const data = new ArrayBuffer(size)
    new DataView(data).setUint8(0, flags)
    sockets.at(-1).onmessage({ data })
  }
  config()
  send(0)
  assert.equal(decoders.at(-1).chunks.length, 0)
  send(1)
  assert.equal(decoders.at(-1).chunks[0].type, 'key')
  const first = decoders.at(-1)
  first.decodeQueueSize = 9
  send(0)
  first.decodeQueueSize = 0
  send(0) // dependent frames must remain blocked even after queue shrinks
  assert.equal(first.chunks.length, 1)
  send(1)
  assert.notEqual(decoders.at(-1), first)
  send(5)
  assert.equal(decoders.at(-1).chunks.length, 1)
  send(0, 2) // malformed header must be ignored
  stream.reconnect()
  config() // same codec must still wait for a fresh keyframe
  const previous = decoders.at(-1)
  send(0)
  assert.equal(previous.chunks.length, 1)
  send(1)
  assert.notEqual(decoders.at(-1), previous)
  stream.dispose()
  assert.equal(decoders.at(-1).state, 'closed')
})
