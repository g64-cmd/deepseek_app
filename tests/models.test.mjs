import assert from 'node:assert/strict'
import { compile } from './helpers/compile.mjs'
import { before, test } from 'node:test'

let api

before(async () => {
  // Compile the pure model registry for Node. It has no runtime imports
  // (type-only imports are erased), so no mocks are needed.
  api = await compile('./tests/helpers/entries/models.ts', 'models')
})

const image = {
  id: 'img',
  serverId: null,
  name: 'a.png',
  size: 1,
  isImage: true,
  mimeType: 'image/png',
}
const document_ = {
  id: 'doc',
  serverId: null,
  name: 'b.pdf',
  size: 1,
  isImage: false,
  mimeType: 'application/pdf',
}

test('findBlockedImages: vision model keeps everything, non-vision blocks images only', () => {
  const files = [image, document_]
  assert.deepEqual(api.findBlockedImages('deepseek-flash', files), [])
  assert.deepEqual(api.findBlockedImages('deepseek-flash', [image]), [])
  // 文档附件不拦：经 Files API 解析为文本输入，与视觉通道无关
  assert.deepEqual(api.findBlockedImages('deepseek-v4-pro', [document_]), [])
  assert.deepEqual(api.findBlockedImages('deepseek-v4-pro', files), [image])
})

test('value guards: reject unknown persisted model and effort values', () => {
  assert.equal(api.isChatModel('deepseek-flash'), true)
  assert.equal(api.isChatModel('deepseek-v4-pro'), true)
  assert.equal(api.isChatModel('deepseek-chat'), false)
  assert.equal(api.isChatModel('__proto__'), false)
  assert.equal(api.isEffortLevel('low'), true)
  assert.equal(api.isEffortLevel('max'), true)
  assert.equal(api.isEffortLevel('medium'), false)
  assert.equal(api.isEffortLevel('high '), false)
})
