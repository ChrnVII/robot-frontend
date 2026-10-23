import assert from 'node:assert/strict'
import test from 'node:test'
import { cameraCommandError, ptzSpeedRatio } from '../src/utils/cameraControl.js'

test('PTZ speed percentages map to the backend 0-1 range', () => {
  assert.equal(ptzSpeedRatio(1), 0.01)
  assert.equal(ptzSpeedRatio(30), 0.3)
  assert.equal(ptzSpeedRatio(100), 1)
  assert.throws(() => ptzSpeedRatio(120), RangeError)
})

test('camera command rejection details are surfaced to the UI', () => {
  assert.equal(cameraCommandError({ state: 'succeeded' }), '')
  assert.equal(
    cameraCommandError({ state: 'rejected', rejectReason: 'camera offline' }),
    '云台指令失败：camera offline'
  )
})
