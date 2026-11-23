/** C0 v1: deterministic offline data; no credentials or network operations. */
export const FIXTURE_VERSION = 'c0-v1'
export const FIXTURE_SEED = 0xc0ffee
export const FIXTURE_TIME = Date.parse('2026-11-22T00:00:00Z')
export const PREFIX = `${FIXTURE_VERSION}-`
const DAY = 86_400_000
const filler =
  '用于性能测量的中文与 English 混排段落，包含数字 12345、标识符 getMessageUsage 和标点。'
const text = (i) => `第 ${i} 轮。\n\n${Array(6).fill(filler).join('\n\n')}`
const code = (i) =>
  `第 ${i} 轮。\n\n\`\`\`ts\n${Array.from(
    { length: 200 },
    (_, n) =>
      `export function handler${i}_${n}(input: PipelineInput): PipelineOutput {\n` +
      `  const value = transform(input, ${n});\n` +
      '  return validate(value) ? value : fallback(input);\n}'
  ).join('\n')}\n\`\`\``
const math = (i) =>
  Array.from(
    { length: 8 },
    (_, n) =>
      `$$\nE_{${i},${n}} = \\sum_{k=1}^{\\infty} \\frac{(-1)^k x^{2k}}{(2k)!} + \\frac{1}{${n + 1}}\n$$`
  ).join('\n\n')
const mermaid = (i) =>
  `\`\`\`mermaid\nflowchart TD\n${Array.from(
    { length: 30 },
    (_, n) => `N${n}["步骤 ${i}-${n}"]`
  ).join(
    '\n'
  )}\n${Array.from({ length: 29 }, (_, n) => `N${n} --> N${n + 1}`).join('\n')}\nN0 --> N29\n\`\`\``

const user = (id, n, files = []) => ({
  id: PREFIX + id,
  role: 'user',
  content: `问题 ${n}：${filler}`,
  files,
  createdAt: FIXTURE_TIME - DAY + n * 1000,
})
const assistant = (id, n, content) => ({
  id: PREFIX + id,
  role: 'assistant',
  createdAt: FIXTURE_TIME - DAY + n * 1000,
  model: 'deepseek-flash',
  thinking: false,
  search: false,
  prefix: true,
  status: 'done',
  blocks: [{ type: 'text', text: content }],
  stopReason: 'end_turn',
  usage: {
    input_tokens: 2000 + n,
    cache_creation_input_tokens: 500,
    cache_read_input_tokens: 4000,
    output_tokens: 300 + n,
  },
})
const linear = (id, title, messages) => ({
  id: PREFIX + id,
  title,
  createdAt: messages[0].createdAt,
  updatedAt: messages.at(-1).createdAt,
  rootMessageId: messages[0].id,
  messages: messages.map((message, i) => ({
    ...message,
    parentId: messages[i - 1]?.id ?? null,
    selectedChildId: messages[i + 1]?.id,
  })),
})
const rounds = (id, count, body) =>
  linear(
    id,
    `C0 ${id}`,
    Array.from({ length: count }, (_, n) => [
      user(`${id}-u${n}`, n * 2),
      assistant(`${id}-a${n}`, n * 2 + 1, body(n)),
    ]).flat()
  )

export const summaryOf = (session) => ({
  id: session.id,
  title: session.title,
  createdAt: session.createdAt,
  updatedAt: session.updatedAt,
  fileIds: [
    ...new Set(
      session.messages.flatMap((m) => (m.role === 'user' ? m.files.map((f) => f.id) : []))
    ),
  ],
})

/** Pure builders also run in Node tests; asset generation is deliberately separate. */
export function buildFixture() {
  const mixed = rounds('mixed', 150, (n) => [text, code, math, mermaid, text][n % 5](n))
  for (let n = 0; n < 150; n += 5) {
    mixed.messages[n * 2 + 1].thinking = true
    mixed.messages[n * 2 + 1].blocks.unshift({
      type: 'thinking',
      thinking: `思考 ${n}：${filler.repeat(40)}`,
      elapsedSeconds: 20,
    })
  }
  const images = rounds('images', 5, text)
  const branches = rounds('branches', 3, text)
  const alternate = rounds('alternate', 2, text).messages
  alternate[0].parentId = branches.messages[1].id
  branches.messages.push(...alternate)
  const backup = rounds('backup', 1, text)
  // 单条长回答：开头两条公式远离视口（保持门控源码形态），长正文之后以一条
  // 可见公式与文字收尾——覆盖“尾部可见就绪不应等待屏外门控块”的探针口径。
  const longtail = linear('longtail', 'C0 longtail', [
    user('longtail-u0', 0),
    assistant(
      'longtail-a0',
      1,
      '$$\nA_{offscreen,1} = \\alpha + \\frac{\\beta}{\\gamma}\n$$\n\n' +
        '$$\nA_{offscreen,2} = \\sum_{k=0}^{n} q_k x^k\n$$\n\n' +
        Array(60).fill(filler).join('\n\n') +
        '\n\n$$\nZ_{visible} = \\int_0^1 f(x)\\,dx\n$$\n\n' +
        filler
    ),
  ])
  const list = Array.from({ length: 1000 }, (_, n) => {
    const session = rounds(`list-${String(n).padStart(4, '0')}`, 1, text)
    session.createdAt = FIXTURE_TIME - DAY * 2 - n * 60_000
    session.updatedAt = session.createdAt
    return session
  })
  return {
    version: FIXTURE_VERSION,
    seed: FIXTURE_SEED,
    now: FIXTURE_TIME,
    sessions: [
      rounds('text', 150, text),
      mixed,
      rounds('heavy', 25, (n) => (n % 2 ? math(n) : mermaid(n))),
      images,
      branches,
      longtail,
      backup,
      ...list,
    ],
    files: [],
  }
}

/** xorshift32, with a separate fixed seed per image. */
export function randomBytes(length, seed = FIXTURE_SEED) {
  const bytes = new Uint8Array(length)
  let value = seed >>> 0
  for (let n = 0; n < length; n++) {
    value ^= value << 13
    value ^= value >>> 17
    value ^= value << 5
    bytes[n] = value & 255
  }
  return bytes
}

async function png(index) {
  const canvas = document.createElement('canvas')
  canvas.width = 2048
  canvas.height = 1536
  const context = canvas.getContext('2d')
  const pixels = context.createImageData(canvas.width, canvas.height)
  // Opaque seeded RGB noise; encoder bytes are hashed in the measured browser.
  pixels.data.set(randomBytes(pixels.data.length, FIXTURE_SEED + index))
  for (let n = 3; n < pixels.data.length; n += 4) {
    pixels.data[n] = 255
  }
  context.putImageData(pixels, 0, 0)
  const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
  if (!blob) {
    throw new Error('PNG generation failed')
  }
  return blob
}

/** One-page PDF padded with comments before xref; never uploaded. */
function largePdf() {
  const objects = [
    '%PDF-1.4\n',
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n',
  ]
  const offsets = objects.map((_, n) => objects.slice(0, n).join('').length)
  const comment = '%' + 'c'.repeat(1024 * 1024 - 2) + '\n'
  const parts = [...objects, ...Array(64).fill(comment)]
  const xref = parts.reduce((size, part) => size + part.length, 0)
  parts.push(
    'xref\n0 4\n0000000000 65535 f \n' +
      offsets
        .slice(1)
        .map((offset) => `${String(offset).padStart(10, '0')} 00000 n \n`)
        .join('') +
      `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  )
  return new Blob(parts, { type: 'application/pdf' })
}

export async function materializeAssets(fixture) {
  if (fixture.files.length) {
    throw new Error('Assets already materialized')
  }
  const imageSession = fixture.sessions.find((s) => s.id === PREFIX + 'images')
  const backupSession = fixture.sessions.find((s) => s.id === PREFIX + 'backup')
  for (let n = 0; n < 5; n++) {
    const blob = await png(n)
    const id = `${PREFIX}image-${n}`
    const attachment = {
      id,
      serverId: null,
      name: `c0-image-${n}.png`,
      size: blob.size,
      isImage: true,
      mimeType: blob.type,
    }
    fixture.files.push({ id, blob })
    imageSession.messages[n * 2].files.push(attachment)
    // Shared originals intentionally appear in two sessions, exercising backup deduplication.
    backupSession.messages[0].files.push({ ...attachment })
  }
  const blob = largePdf()
  const id = PREFIX + 'pdf'
  fixture.files.push({ id, blob })
  backupSession.messages[0].files.push({
    id,
    serverId: null,
    name: 'c0-large.pdf',
    size: blob.size,
    isImage: false,
    mimeType: blob.type,
  })
  return fixture
}

export function describeFixture(fixture) {
  const encoder = new TextEncoder()
  return {
    version: fixture.version,
    seed: fixture.seed,
    now: fixture.now,
    sessions: fixture.sessions.map((s) => {
      const bodies = s.messages
        .filter((m) => m.role === 'assistant')
        .flatMap((m) => m.blocks.filter((b) => b.type === 'text').map((b) => b.text))
      const codeBlocks = bodies.flatMap((body) => [...body.matchAll(/```ts\n([\s\S]*?)\n```/g)])
      return {
        id: s.id,
        messages: s.messages.length,
        users: s.messages.filter((m) => m.role === 'user').length,
        assistants: bodies.length,
        codeBlocks: codeBlocks.length,
        codeLines: codeBlocks.reduce((n, match) => n + match[1].split('\n').length, 0),
        displayMath: bodies.reduce(
          (n, body) => n + [...body.matchAll(/(?:^|\n)\$\$\n[\s\S]*?\n\$\$/g)].length,
          0
        ),
        mermaid: bodies.reduce((n, body) => n + [...body.matchAll(/```mermaid\n/g)].length, 0),
        textBytes: encoder.encode(JSON.stringify(s.messages)).byteLength,
      }
    }),
    files: fixture.files.map(({ id, blob }) => ({
      id,
      bytes: blob.size,
      mimeType: blob.type,
      ...(blob.type === 'image/png' ? { width: 2048, height: 1536 } : {}),
    })),
    originalBytes: fixture.files.reduce((n, f) => n + f.blob.size, 0),
  }
}

/** Refuse any existing record, including staging; all fixture writes share one transaction. */
export async function installFixture(db, fixture) {
  const stores = ['sessions', 'sessionSummaries', 'files', 'sessionsStaging', 'filesStaging']
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, 'readwrite')
    let remaining = stores.length
    let failure
    for (const name of stores) {
      const request = tx.objectStore(name).count()
      request.onsuccess = () => {
        if (request.result !== 0) {
          failure = new Error(`C0 requires an empty isolated database: ${name}`)
          tx.abort()
          return
        }
        if (--remaining === 0) {
          for (const session of fixture.sessions) {
            tx.objectStore('sessions').add(session)
            tx.objectStore('sessionSummaries').add(summaryOf(session))
          }
          for (const file of fixture.files) {
            tx.objectStore('files').add(file)
          }
        }
      }
    }
    tx.oncomplete = () => resolve(describeFixture(fixture))
    tx.onerror = () => reject(failure ?? tx.error)
    tx.onabort = () => reject(failure ?? tx.error ?? new Error('Fixture transaction aborted'))
  })
}
