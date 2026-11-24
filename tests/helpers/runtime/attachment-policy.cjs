Object.assign(exports, require('./settings.cjs'))
exports.useVoiceInput = () => ({ status: 'idle', seconds: 0, available: false, cancel() {} })
exports.useFileDrop = () => false
exports.ensureApiKey = () => true
exports.stopReadAloud = () => {}
exports.useReplyView = () => ({ steps: [], sources: [], searchResults: [], answer: null })
exports.useSearchPanel = () => ({ entry: null })
exports.IconButton =
  exports.Menu =
  exports.Tooltip =
  exports.DraftAttachments =
  exports.VoiceButton =
  exports.Spectrum =
  exports.Markdown =
  exports.ReplyArea =
  exports.BranchSwitcher =
    function Stub() {}
