import path from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtemp, rm } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { after } from 'node:test'
import { rspack } from '@rspack/core'

export const root = fileURLToPath(new URL('../../', import.meta.url))
const temporaryRoot = path.resolve(tmpdir())
const prefix = 'deepseek-app-tests-'
const outputs = new Set()

after(async () => {
  for (const output of outputs) {
    // 只删除本进程创建的专属目录，不能递归删除系统临时目录或仓库目录。
    if (path.dirname(output) !== temporaryRoot || !path.basename(output).startsWith(prefix)) {
      throw new Error(`Unexpected test output directory: ${output}`)
    }
    await rm(output, { recursive: true, force: true })
  }
})

/** 编译真实模块；替身只替换调用方明确列出的环境边界。产物在测试结束后自动移除。 */
export async function compile(entry, name, replacements = new Map()) {
  const output = await mkdtemp(path.join(temporaryRoot, `${prefix}${name}-`))
  outputs.add(output)
  const compiler = rspack({
    context: root,
    mode: 'development',
    target: 'node',
    devtool: false,
    entry,
    output: { path: output, filename: 'test.cjs', library: { type: 'commonjs2' } },
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
    plugins: [
      new rspack.DefinePlugin({ __API_ORIGIN__: JSON.stringify('https://fixture.invalid') }),
      new rspack.NormalModuleReplacementPlugin(/./, (resource) => {
        const target =
          replacements.get(resource.request) ??
          replacements.get(path.resolve(resource.context, resource.request))
        if (target) resource.request = target
      }),
    ],
  })
  await new Promise((resolve, reject) =>
    compiler.run((error, stats) =>
      compiler.close((closeError) => {
        if (error || closeError) reject(error ?? closeError)
        else if (stats.hasErrors()) reject(new Error(stats.toString({ all: false, errors: true })))
        else resolve()
      })
    )
  )
  return createRequire(import.meta.url)(path.join(output, 'test.cjs'))
}
