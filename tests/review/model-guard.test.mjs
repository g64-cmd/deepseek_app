import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import path from 'node:path'
import { before, test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { rspack } from '@rspack/core'

const root = fileURLToPath(new URL('../../', import.meta.url))
let api

before(async () => {
  // Compile the pure model registry for Node. It has no runtime imports
  // (type-only imports are erased), so no mocks are needed.
  const compiler = rspack({
    context: root,
    mode: 'development',
    target: 'node',
    devtool: false,
    entry: './tests/review/model-guard-entry.ts',
    output: {
      path: path.join(root, 'tmp/review-model-guard'),
      filename: 'review.cjs',
      library: { type: 'commonjs2' },
    },
    resolve: {
      extensions: ['.tsx', '.ts', '.js'],
      extensionAlias: { '.js': ['.ts', '.tsx', '.js'] },
    },
    module: {
      rules: [
        {
          test: /\.tsx?$/,
          exclude: /node_modules/,
          loader: 'builtin:swc-loader',
          options: {
            jsc: {
              parser: { syntax: 'typescript', tsx: true },
              transform: { react: { runtime: 'automatic' } },
              target: 'es2022',
            },
          },
        },
        { test: /\.css$/, type: 'asset/source' },
      ],
    },
  })
  await new Promise((resolve, reject) =>
    compiler.run((error, stats) => {
      compiler.close((closeError) => {
        if (error || closeError) reject(error ?? closeError)
        else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })))
        else resolve()
      })
    })
  )
  api = createRequire(import.meta.url)(path.join(root, 'tmp/review-model-guard/review.cjs'))
})

const image = { id: 'img', serverId: null, name: 'a.png', size: 1, isImage: true, mimeType: 'image/png' }
const document_ = { id: 'doc', serverId: null, name: 'b.pdf', size: 1, isImage: false, mimeType: 'application/pdf' }

test('findBlockedImages: vision model keeps everything, non-vision blocks images only', () => {
  const files = [image, document_]
  assert.deepEqual(api.findBlockedImages('deepseek-flash', files), [])
  assert.deepEqual(api.findBlockedImages('deepseek-flash', [image]), [])
  // 文档附件不拦：经 Files API 解析为文本输入，与视觉通道无关
  assert.deepEqual(api.findBlockedImages('deepseek-v4-pro', [document_]), [])
  assert.deepEqual(api.findBlockedImages('deepseek-v4-pro', files), [image])
})

test('model registry: every model has valid defaults and ordered pricing pairs', () => {
  for (const meta of Object.values(api.MODEL_METAS)) {
    assert.equal(meta.effortLevels.includes(meta.defaultEffort), true)
    for (const pair of [meta.pricing.cacheRead, meta.pricing.cacheMiss, meta.pricing.output]) {
      assert.equal(pair.length, 2)
      assert.equal(pair[0] > 0 && pair[1] >= pair[0], true, `${meta.id} pricing`)
    }
  }
  assert.equal(api.supportsVision('deepseek-flash'), true)
  assert.equal(api.supportsVision('deepseek-v4-pro'), false)
  assert.equal(api.DEFAULT_MODEL, 'deepseek-flash')
  assert.equal(api.DEFAULT_EFFORT, 'high')
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
