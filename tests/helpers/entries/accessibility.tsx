// Browser-only fixture: real components/React/DOM, isolated browser profile, offline data.
import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from '../../../src/app/App.js'
import { setupTheme } from '../../../src/app/theme.js'
import { Modal } from '../../../src/components/base/Modal.js'
import { Menu } from '../../../src/components/base/Menu.js'
import { Select } from '../../../src/components/base/Select.js'
import { closeTopModal } from '../../../src/components/base/modalStack.js'
import {
  useChatStore,
  selectMessageVersion,
  sendMessage,
} from '../../../src/services/chat/store.js'
import { useSettings, setLocale, setThemePreference } from '../../../src/services/settings.js'
import {
  closeSettings,
  openSettings,
} from '../../../src/components/settings/settingsDialogState.js'
import { openMobileSider } from '../../../src/components/sider/mobileSiderState.js'
import { ImageViewer } from '../../../src/components/messages/ImageViewer.js'
import { CitationLink } from '../../../src/components/search/CitationLink.js'
import { toggleSearchPanel } from '../../../src/components/search/searchPanelState.js'
import { Button } from '../../../src/components/base/Button.js'
import { setDraftText } from '../../../src/services/chat/drafts.js'
import '../../../src/app/theme.css'
import '../../../src/app/global.css'

setupTheme()
let setLayers: (open: boolean) => void
let setImage: (file: File | null) => void
const Fixture = () => {
  const [layers, showLayers] = useState(false)
  const [image, showImage] = useState<File | null>(null)
  const [nested, setNested] = useState(false)
  const [busy, setBusy] = useState(false)
  const [selected, setSelected] = useState('one')
  setLayers = showLayers
  setImage = showImage
  return (
    <>
      <button
        id="fixture-open"
        style={{ position: 'fixed', bottom: 0, right: 0 }}
        onClick={() => showLayers(true)}
      >
        Fixture
      </button>
      {layers ? (
        <Modal
          title="Outer"
          closable
          onClose={() => showLayers(false)}
          footer={
            <Button id="fixture-footer" variant="outlined" onClick={() => showLayers(false)}>
              Cancel
            </Button>
          }
        >
          <Menu
            options={['Alpha', 'Beta', 'Gamma'].map((label) => ({
              key: label,
              label,
              icon: null,
              onSelect: () => {
                window.__selected = label
              },
            }))}
          >
            {({ open, toggle }) => (
              <button
                id="fixture-menu"
                aria-label="Actions"
                aria-haspopup="menu"
                aria-expanded={open}
                onClick={toggle}
              >
                Actions
              </button>
            )}
          </Menu>
          <Select
            value={selected}
            options={[
              { value: 'one', label: 'One' },
              { value: 'two', label: 'Two' },
            ]}
            ariaLabel="Choice"
            onChange={setSelected}
          />
          <button id="fixture-nested" onClick={() => setNested(true)}>
            Nested
          </button>
          <input
            id="fixture-field"
            aria-label="Fixture field"
            style={{ display: 'block', marginTop: 180 }}
          />
          <a id="fixture-outer-link" href="https://outer.invalid" target="_blank" rel="noreferrer">
            Outer link{' '}
            <CitationLink
              source={{
                index: 1,
                title: 'Cited source',
                url: 'https://source.invalid',
                date: null,
                snippet: '',
              }}
            />
          </a>
        </Modal>
      ) : null}
      {nested ? (
        <Modal
          title="Inner"
          closable
          onClose={() => {
            if (!busy) setNested(false)
          }}
        >
          <button id="fixture-busy" onClick={() => setBusy((value) => !value)}>
            {busy ? 'Busy' : 'Idle'}
          </button>
          <button id="fixture-inner-last" onClick={() => {}}>
            Last
          </button>
        </Modal>
      ) : null}
      {image ? (
        <ImageViewer source={image} name={image.name} onClose={() => showImage(null)} />
      ) : null}
    </>
  )
}

const now = Date.now()
const base = {
  id: 'c2-session',
  title: 'C2 test conversation',
  createdAt: now,
  updatedAt: now,
  messages: [
    { id: 'c2-user', role: 'user', content: '可访问性问题', files: [], createdAt: now },
    {
      id: 'c2-assistant',
      role: 'assistant',
      model: null,
      status: 'done',
      prefix: false,
      thinking: true,
      createdAt: now,
      blocks: [
        { type: 'thinking', thinking: '一些思考。', elapsedSeconds: 1 },
        {
          type: 'text',
          text: '回答内容。\n\n' + '支持中文和 English 的长正文，应当正常换行。'.repeat(30),
        },
      ],
    },
  ],
}
window.c2 = {
  seed() {
    closeSettings()
    setLocale('zh-CN')
    setThemePreference('light')
    useSettings.setState({ apiKey: null })
    useChatStore.setState({
      sessions: [base, { ...base, id: 'c2-second', title: 'Second conversation' }],
      sessionCache: { [base.id]: base, 'c2-second': { ...base, id: 'c2-second' } },
      activeId: base.id,
      ready: true,
      streaming: {},
    })
  },
  layers: () => setLayers(true),
  async image(name = 'fixture.png') {
    const canvas = document.createElement('canvas')
    canvas.width = 240
    canvas.height = 120
    const context = canvas.getContext('2d')!
    context.fillStyle = '#d33'
    context.fillRect(0, 0, 240, 120)
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((value) => resolve(value!), 'image/png')
    )
    setImage(new File([blob], name, { type: 'image/png' }))
  },
  historyBranches() {
    const question = { ...base.messages[0], parentId: null, selectedChildId: 'history-done' }
    const answers = ['done', 'error', 'stopped'].map((status) => ({
      ...base.messages[1],
      id: `history-${status}`,
      parentId: question.id,
      status,
    }))
    const session = { ...base, rootMessageId: question.id, messages: [question, ...answers] }
    useChatStore.setState({ sessionCache: { [base.id]: session }, streaming: {} })
  },
  selectHistory: (status: string) => selectMessageVersion(base.id, `history-${status}`),
  fastFailure(newSession = false) {
    setDraftText(newSession ? null : base.id, 'offline test')
    return sendMessage(newSession ? null : base.id)
  },
  closeTopModal,
  openSettings,
  closeSettings,
  openMobileSider,
  sources: () =>
    toggleSearchPanel('c2-sources', [
      { index: 1, title: 'Offline source', url: 'https://source.invalid', snippet: 'Summary' },
    ]),
  setThemePreference,
  transition(status: string, text = 'answer') {
    const live = status === 'pending' || status === 'streaming'
    const session = {
      ...base,
      messages: [
        ...base.messages.slice(0, 1),
        { ...base.messages[1], id: 'c2-active-answer', status, blocks: [{ type: 'text', text }] },
      ],
    }
    useChatStore.setState({
      sessionCache: { [base.id]: session },
      streaming: live ? { [base.id]: {} } : {},
    })
  },
}
createRoot(document.getElementById('root')!).render(
  <>
    <App />
    <Fixture />
  </>
)
