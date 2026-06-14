const isBar = location.hash === "#bar" || (!location.hash || location.hash === "")
const isPanel = location.hash === "#panel"
const isAdvice = location.hash === "#advice"
let state = { guide: false, tts: true, webSearch: true, mic: false, visible: true, stealthEnabled: true, chatWindowVisible: true, captureSystemAudio: false, silenceTimeout: 2000, screenshotInterval: 20000 }
let dictationActive = false
let lastAssistantText = ""
let _lastSentText = ""
let _appendText = ""
let currentTTSAudio = null

function el(id) { return document.getElementById(id) }

function toggleClass(el, cls, force) {
  if (force === undefined) el.classList.toggle(cls)
  else el.classList.toggle(cls, force)
}

let audioUnlocked = false

document.addEventListener("click", () => {
  if (!audioUnlocked) {
    audioUnlocked = true
    new Audio("data:audio/wav;base64,UklGRiQAAABXQVZFZm10IBAAAAABAAEARKwAAIhYAQACABAAZGF0YQAAAAA=").play().catch(() => {})
  }
}, { once: true })

let micStream = null, micCtx = null, micNode = null, micExt = null
let dictationFromBar = false
let logC = 0

const indicator = document.createElement("div")
indicator.className = "ct-indicator hidden"
indicator.textContent = "Click-through — Esc to exit"
document.body.appendChild(indicator)

// --- Cursor Follower ---
const CURSOR_ICONS = {
  default: '<svg width="16" height="20" viewBox="0 0 16 20" fill="white" stroke="#222" stroke-width="1"><path d="M3 2v16l4-4h6L7 2z"/></svg>',
  pointer: '<svg width="16" height="20" viewBox="0 0 16 20" fill="white" stroke="#222" stroke-width="1"><path d="M7 1v11l-3-3-2 2 5 5 3 3 5-5-3-3-3 3V1z"/></svg>',
  text: '<svg width="16" height="20" viewBox="0 0 16 20" fill="white" stroke="#222" stroke-width="1"><line x1="8" y1="2" x2="8" y2="18"/><line x1="4" y1="2" x2="12" y2="2"/><line x1="4" y1="18" x2="12" y2="18"/></svg>',
  crosshair: '<svg width="20" height="20" viewBox="0 0 20 20" fill="white" stroke="#222" stroke-width="1"><circle cx="10" cy="10" r="3" fill="none"/><line x1="10" y1="1" x2="10" y2="6"/><line x1="10" y1="14" x2="10" y2="19"/><line x1="1" y1="10" x2="6" y2="10"/><line x1="14" y1="10" x2="19" y2="10"/></svg>',
  move: '<svg width="20" height="20" viewBox="0 0 20 20" fill="white" stroke="#222" stroke-width="1"><polygon points="10,2 14,8 6,8"/><polygon points="10,18 14,12 6,12"/><polygon points="2,10 8,6 8,14"/><polygon points="18,10 12,6 12,14"/></svg>',
  "col-resize": '<svg width="16" height="20" viewBox="0 0 16 20" fill="white" stroke="#222" stroke-width="1"><line x1="8" y1="2" x2="8" y2="18"/><polygon points="3,10 7,6 7,14"/><polygon points="13,10 9,6 9,14"/></svg>',
  "row-resize": '<svg width="20" height="16" viewBox="0 0 20 16" fill="white" stroke="#222" stroke-width="1"><line x1="2" y1="8" x2="18" y2="8"/><polygon points="10,3 6,7 14,7"/><polygon points="10,13 6,9 14,9"/></svg>',
  "nwse-resize": '<svg width="16" height="16" viewBox="0 0 16 16" fill="white" stroke="#222" stroke-width="1"><line x1="2" y1="2" x2="14" y2="14"/><polygon points="2,2 8,1 1,8"/><polygon points="14,14 8,15 15,8"/></svg>',
  "nesw-resize": '<svg width="16" height="16" viewBox="0 0 16 16" fill="white" stroke="#222" stroke-width="1"><line x1="14" y1="2" x2="2" y2="14"/><polygon points="14,2 8,1 15,8"/><polygon points="2,14 8,15 1,8"/></svg>',
  "not-allowed": '<svg width="16" height="16" viewBox="0 0 16 16" fill="white" stroke="#222" stroke-width="1"><circle cx="8" cy="8" r="7" fill="none"/><line x1="4" y1="4" x2="12" y2="12"/></svg>',
  wait: '<svg width="16" height="18" viewBox="0 0 16 18" fill="white" stroke="#222" stroke-width="1"><rect x="3" y="1" width="10" height="4" rx="1"/><rect x="3" y="13" width="10" height="4" rx="1"/><line x1="8" y1="5" x2="8" y2="13"/></svg>',
  grab: '<svg width="16" height="18" viewBox="0 0 16 18" fill="white" stroke="#222" stroke-width="1"><path d="M5 9V4a1.5 1.5 0 0 1 3 0v5M8 9V3a1.5 1.5 0 0 1 3 0v6M11 9V5a1.5 1.5 0 0 1 3 0v4c0 4-3 6-6 6-2 0-4-1-5-2l-2-2c-.7-.7-.4-1.8.4-2.3l.2-.1c.7-.4 1.6-.2 2.1.5L5 10V5a1.5 1.5 0 0 1 3 0v4"/></svg>',
}

function getCursor(target, e) {
  if (!target) return "default"
  const cs = window.getComputedStyle(target).cursor
  if (cs && cs !== "auto" && CURSOR_ICONS[cs]) return cs
  const tag = target.tagName.toLowerCase()
  if (["a", "button"].includes(tag) || target.closest("button,.btn")) return "pointer"
  if (["input", "textarea"].includes(tag) || target.closest("[contenteditable]")) return "text"
  if (isPanel) {
    const w = window.innerWidth, h = window.innerHeight
    const EDGE = 8
    const t = e.clientY <= EDGE, b = e.clientY >= h - EDGE
    const l = e.clientX <= EDGE, r = e.clientX >= w - EDGE
    if (t && l || b && r) return "nwse-resize"
    if (t && r || b && l) return "nesw-resize"
    if (t || b) return "row-resize"
    if (l || r) return "col-resize"
  }
  return "default"
}

document.addEventListener("mousemove", (e) => {
  if (!document.body.classList.contains("interactive")) return
  const el = document.getElementById("cursor-follower")
  if (!el) return
  const target = document.elementFromPoint(e.clientX, e.clientY)
  el.innerHTML = CURSOR_ICONS[getCursor(target, e)] || CURSOR_ICONS.default
  el.style.transform = `translate(${e.clientX - 10}px, ${e.clientY - 10}px)`
})

// --- Interactive Mode ---
window.companion.onInteractiveChanged((interactive) => {
  document.body.classList.toggle("interactive", interactive)
  document.body.classList.toggle("clickthrough", !interactive)
  if (isBar) {
    const ind = document.querySelector(".ct-indicator")
    if (ind) toggleClass(ind, "hidden", interactive)
  }
})

// --- Mic: system audio via electron-audio-loopback + optional user mic ---
async function startMicCapture(fromBar) {
  if (dictationActive) stopAudioCapture()
  dictationActive = true
  dictationFromBar = fromBar
  try {
    micExt = null
    try { micExt = await navigator.mediaDevices.getUserMedia({ audio: true }) } catch (e) {
      window.companion.log("Ext mic failed: " + (e.message || e))
      const btn = el(fromBar ? "btnMic" : "btnMicInput")
      if (btn) { btn.style.outline = "2px solid #f44"; setTimeout(() => btn.style.outline = "", 2000) }
    }
    await window.companion.enableLoopbackAudio()
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true })
    stream.getVideoTracks().forEach(t => { t.stop(); stream.removeTrack(t) })
    window.companion.disableLoopbackAudio().catch(() => {})
    setupAudioProcessing(stream, micExt)
    window.companion.sendAction("start_dictation", { fromBar, useMic: state.captureSystemAudio })
  } catch (e) {
    console.error("Mic capture failed:", e)
    if (micExt) { micExt.getTracks().forEach(t => t.stop()); micExt = null }
    dictationActive = false
    dictationFromBar = false
    window.companion.disableLoopbackAudio().catch(() => {})
    throw e
  }
}

// --- Shared audio processing ---
function setupAudioProcessing(primary, secondary) {
  if (micNode) { micNode.disconnect(); micNode = null }
  if (micCtx) { micCtx.close(); micCtx = null }
  if (micStream && micStream !== primary) { micStream.getTracks().forEach(t => t.stop()) }
  if (micExt && micExt !== secondary) { micExt.getTracks().forEach(t => t.stop()) }
  micStream = primary
  micCtx = new AudioContext({ sampleRate: 16000 })
  const sysSrc = micCtx.createMediaStreamSource(primary)
  let inputNode = sysSrc
  if (secondary) {
    const micSrc = micCtx.createMediaStreamSource(secondary)
    const merger = micCtx.createChannelMerger(2)
    sysSrc.connect(merger, 0, 0)
    micSrc.connect(merger, 0, 1)
    inputNode = merger
  }
  const ch = secondary ? 2 : 1
  micNode = micCtx.createScriptProcessor(4096, ch, 1)
  micNode.onaudioprocess = (e) => {
    const c0 = e.inputBuffer.getChannelData(0)
    const pcm0 = new Int16Array(c0.length)
    for (let i = 0; i < c0.length; i++)
      pcm0[i] = Math.max(-32768, Math.min(32767, Math.round(c0[i] * 32768)))
    window.companion.sendAction("stt_audio_sys", { data: Array.from(pcm0) })
    if (e.inputBuffer.numberOfChannels === 2 && state.captureSystemAudio) {
      const c1 = e.inputBuffer.getChannelData(1)
      const pcm1 = new Int16Array(c1.length)
      for (let i = 0; i < c1.length; i++)
        pcm1[i] = Math.max(-32768, Math.min(32767, Math.round(c1[i] * 32768)))
      window.companion.sendAction("stt_audio_mic", { data: Array.from(pcm1) })
    }
  }
  inputNode.connect(micNode)
  micNode.connect(micCtx.destination)
}

function stopAudioProcessing() {
  if (micNode) { micNode.disconnect(); micNode = null }
  if (micCtx) { micCtx.close(); micCtx = null }
  if (micStream) { micStream.getTracks().forEach(t => t.stop()); micStream = null }
  if (micExt) { micExt.getTracks().forEach(t => t.stop()); micExt = null }
}

function stopAudioCapture() {
  dictationActive = false
  dictationFromBar = false
  _appendText = ""
  stopAudioProcessing()
  window.companion.sendAction("stop_dictation")
  window.companion.disableLoopbackAudio().catch(() => {})
}

// --- Shared settings (both bar and panel) ---
window.companion.onSettings((msg) => {
  if (msg.captureSystemAudio !== undefined) {
    const prev = state.captureSystemAudio
    state.captureSystemAudio = msg.captureSystemAudio
    const chk = el("chkExternalAudio")
    if (chk) chk.checked = msg.captureSystemAudio
    window.companion.sendAction("voice_debug", { msg: `onSettings capSys prev=${prev} new=${msg.captureSystemAudio} restart=${prev !== msg.captureSystemAudio && dictationActive}` })
    if (prev !== msg.captureSystemAudio && dictationActive) {
      const wasBar = dictationFromBar
      stopAudioCapture()
      startMicCapture(wasBar)
    }
  }
  if (msg.silenceTimeout !== undefined) {
    state.silenceTimeout = msg.silenceTimeout
    const inp = el("chkSilenceTimeout")
    if (inp) inp.value = msg.silenceTimeout
  }
  if (msg.screenshotInterval !== undefined) {
    state.screenshotInterval = msg.screenshotInterval
    const inp = el("chkScreenshotInterval")
    if (inp) inp.value = msg.screenshotInterval
  }
})

;["chkExternalAudio", "chkSilenceTimeout", "chkScreenshotInterval"].forEach(id => {
  const el = document.getElementById(id)
  if (!el) return
  el.addEventListener("change", () => {
    if (id === "chkExternalAudio") {
      state.captureSystemAudio = el.checked
      window.companion.sendSettings("captureSystemAudio", state.captureSystemAudio)
    } else if (id === "chkSilenceTimeout") {
      state.silenceTimeout = parseInt(el.value) || 2000
      window.companion.sendSettings("silenceTimeout", state.silenceTimeout)
    } else if (id === "chkScreenshotInterval") {
      state.screenshotInterval = parseInt(el.value) || 20000
      window.companion.sendSettings("screenshotInterval", state.screenshotInterval)
    }
  })
})

// --- BAR WINDOW (toolbar) ---
  if (isBar) {
    el("panel").classList.add("hidden")
     window.companion.onSettings((msg) => {
       if (msg.guide !== undefined) { state.guide = msg.guide; updateModeBtn() }
       if (msg.tts !== undefined) { state.tts = msg.tts; toggleClass(el("btnTTS"), "active", msg.tts) }
       if (msg.webSearch !== undefined) { state.webSearch = msg.webSearch; toggleClass(el("btnWeb"), "active", msg.webSearch) }
       if (msg.mic !== undefined) { state.mic = msg.mic; toggleClass(el("btnMic"), "active", msg.mic) }
        if (msg.stealthMode !== undefined) { state.stealthEnabled = msg.stealthMode; updateStealthBtn() }
            if (msg.chatWindowVisible !== undefined) { state.chatWindowVisible = msg.chatWindowVisible; updateChatToggleBtn() }
        if (msg.adviceDuration !== undefined) { /* handled in main process */ }
       if (msg.screenshotInterval !== undefined) { /* handled in main process */ }
        if (msg.systemAudioDevice !== undefined) { /* handled in main process */ }
     })


  let dragging = false
  let ox = 0, oy = 0
  el("bar").addEventListener("mousedown", (e) => {
    if (e.target.closest(".btn")) return
    dragging = true
    ox = e.screenX
    oy = e.screenY
    e.preventDefault()
  })
  document.addEventListener("mousemove", (e) => {
    if (!dragging) return
    window.companion.sendAction("drag_move", {
      deltaX: e.screenX - ox,
      deltaY: e.screenY - oy,
    })
    ox = e.screenX
    oy = e.screenY
  })
  document.addEventListener("mouseup", () => { dragging = false })

  el("btnScreenshot").onclick = () => window.companion.sendAction("screenshot")
  el("btnMic").onclick = async () => {
    if (state.mic) {
      stopAudioCapture()
      state.mic = false
      toggleClass(el("btnMic"), "active", false)
      window.companion.sendSettings("mic", false)
    } else {
      toggleClass(el("btnMic"), "active", true)
      state.mic = true
      window.companion.sendSettings("mic", true)
      try { await startMicCapture(true) }
      catch (e) {
        toggleClass(el("btnMic"), "active", false)
        state.mic = false
        window.companion.sendSettings("mic", false)
      }
    }
  }
  el("btnMode").onclick = () => {
    state.guide = !state.guide
    updateModeBtn()
    window.companion.sendSettings("guide", state.guide)
    window.companion.sendAction("guide_mode", { active: state.guide })
  }
  el("btnWeb").onclick = () => {
    state.webSearch = !state.webSearch
    toggleClass(el("btnWeb"), "active", state.webSearch)
    window.companion.sendSettings("webSearch", state.webSearch)
  }
  el("btnTTS").onclick = () => {
    state.tts = !state.tts
    toggleClass(el("btnTTS"), "active", state.tts)
    window.companion.sendSettings("tts", state.tts)
  }
  el("btnSettings").onclick = () => {
    el("settingsPane").classList.toggle("hidden")
    window.companion.sendAction("resize_bar", { height: el("settingsPane").classList.contains("hidden") ? 44 : 250 })
  }
   
    // Stealth mode toggle
    el("btnStealth").onclick = () => {
      state.stealthEnabled = !state.stealthEnabled
      toggleClass(el("btnStealth"), "active", !state.stealthEnabled)
      window.companion.sendSettings("stealthMode", state.stealthEnabled)
      window.companion.sendAction("stealth_toggle", { enabled: state.stealthEnabled })
    }
   
    // Chat window toggle
    el("btnChatToggle").onclick = () => {
      state.chatWindowVisible = !state.chatWindowVisible
      toggleClass(el("btnChatToggle"), "active", state.chatWindowVisible)
      window.companion.sendSettings("chatWindowVisible", state.chatWindowVisible)
    }
   
   // Save conversation
   el("btnSave").onclick = () => {
     window.companion.sendAction("save_conversation")
   }
  el("btnClose").onclick = () => window.companion.sendAction("close")

   function updateModeBtn() {
     const btn = el("btnMode")
     const txt = btn.querySelector(".mode-text")
     txt.textContent = state.guide ? "Guide" : "Wait"
     btn.className = "btn " + (state.guide ? "mode-guide" : "mode-wait")
   }
   
    function updateStealthBtn() {
      const btn = el("btnStealth")
      // Open eye when exposed/visible, closed eye when stealth-hidden
      btn.innerHTML = state.stealthEnabled ? '<span class="btn-icon">🙈</span>' : '<span class="btn-icon">👁️</span>'
      toggleClass(btn, "active", !state.stealthEnabled)
    }
   
    function updateChatToggleBtn() {
      const btn = el("btnChatToggle")
      // Active when chat is visible
      toggleClass(btn, "active", state.chatWindowVisible)
    }
    

  }

// --- PANEL WINDOW (chat) ---
  if (isPanel) {
    el("bar").classList.add("hidden")
    const msgs = el("messages")
  const placeholder = el("placeholder")
  el("inputArea").classList.remove("hidden")
  let msgId = 0

   function addMsg(role, text) {
     toggleClass(placeholder, "hidden", true)
     const msgDiv = document.createElement("div")
     msgDiv.className = `msg msg-${role}`
     msgDiv.dataset.text = text
     msgDiv.dataset.id = String(msgId++)
     
      // Message content with formatting
      const contentDiv = document.createElement("div")
      contentDiv.className = "msg-content"
      // If text is an [Image N] marker, add a clickable image icon
      const imgMatch = text.match(/^\[Image (\d+)\]$/)
      if (imgMatch) {
        contentDiv.innerHTML = `<span style="cursor:pointer;font-size:20px" title="Screenshot ${imgMatch[1]}">🖼️ [Image ${imgMatch[1]}]</span>`
      } else {
        contentDiv.innerHTML = formatMessageContent(text)
      }
     
     // Action buttons
     const actionsDiv = document.createElement("div")
     actionsDiv.className = "msg-actions"
     
     // Copy button (always)
     const copyBtn = document.createElement("button")
     copyBtn.className = "btn-action copy"
     copyBtn.title = "Copy message"
     copyBtn.innerHTML = "📋"
     copyBtn.onclick = () => {
       navigator.clipboard.writeText(text)
       copyBtn.innerHTML = "✅"
       setTimeout(() => copyBtn.innerHTML = "📋", 1500)
     }
     
     // Edit button (user messages only)
     if (role === "user") {
       const editBtn = document.createElement("button")
       editBtn.className = "btn-action edit"
       editBtn.title = "Edit and resend"
       editBtn.innerHTML = "✏️"
       editBtn.onclick = () => {
         // Populate input field
         el("chatInput").value = text
         el("chatInput").focus()
         
         // Remove this message and all subsequent ones
         const msgId = parseInt(msgDiv.dataset.id || "0")
         const msgs = Array.from(el("messages").children)
         msgs
           .filter(msg => parseInt(msg.dataset.id || "0") >= msgId)
           .forEach(msg => msg.remove())
         
         // Focus input for editing
         el("chatInput").value = text
       }
       actionsDiv.appendChild(editBtn)
     }
     
     // Speaker button (assistant messages only)
     if (role === "assistant") {
       const speakerBtn = document.createElement("button")
       speakerBtn.className = "btn-action speaker"
       speakerBtn.title = "Speak this response"
       speakerBtn.innerHTML = "🔊"
       speakerBtn.onclick = () => {
         window.companion.sendAction("tts_synthesize", { text })
       }
       actionsDiv.appendChild(speakerBtn)
     }
     
     actionsDiv.appendChild(copyBtn)
     
     msgDiv.appendChild(contentDiv)
     msgDiv.appendChild(actionsDiv)
     
     msgs.appendChild(msgDiv)
     msgs.scrollTop = msgs.scrollHeight
     if (role === "assistant") lastAssistantText = text
   }
   
    function formatMessageContent(text) {
      let blocks = []
      text = text.replace(/```(\w*)\n?([\s\S]*?)```/g, (_, lang, code) => {
        const i = blocks.length
        blocks.push({ lang: lang || "text", code: escapeHtml(code) })
        return `%%CB${i}%%`
      })
      let links = []
      text = text.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_, t, u) => {
        const i = links.length
        links.push({ text: escapeHtml(t), url: escapeHtml(u) })
        return `%%LK${i}%%`
      })
      text = escapeHtml(text)
      text = text.replace(/%%LK(\d+)%%/g, (_, i) => {
        const l = links[parseInt(i)]
        return `<a href="${l.url}" target="_blank" rel="noopener noreferrer">${l.text}</a>`
      })
      text = text.replace(/^### (.+)$/gm, "<h3>$1</h3>")
      text = text.replace(/^## (.+)$/gm, "<h2>$1</h2>")
      text = text.replace(/^# (.+)$/gm, "<h1>$1</h1>")
      text = text.replace(/((?:^- .+\n?)+)/gm, m => {
        const items = m.trim().split("\n").filter(l => l.startsWith("- "))
        return "<ul>" + items.map(item => "<li>" + item.slice(2) + "</li>").join("") + "</ul>"
      })
      text = text.replace(/`([^`]+)`/g, "<code>$1</code>")
      text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>")
      text = text.replace(/\n/g, "<br>")
      text = text.replace(/%%CB(\d+)%%/g, (_, i) => {
        const b = blocks[parseInt(i)]
        const id = "cb-" + Date.now() + "-" + i
        return `<div class="code-block-wrap"><button class="code-copy-btn" data-target="${id}">Copy</button><pre><code id="${id}">${b.code}</code></pre></div>`
      })
      return text
    }
    
    function escapeHtml(text) {
     return text
       .replace(/&/g, "&amp;")
       .replace(/</g, "&lt;")
       .replace(/>/g, "&gt;")
       .replace(/"/g, "&quot;")
       .replace(/'/g, "&#039;")
   }
   
   // Copy button for code blocks (delegated)
   document.addEventListener("click", (e) => {
     const btn = e.target.closest(".code-copy-btn")
     if (!btn) return
     const el = document.getElementById(btn.dataset.target)
     if (el) {
       navigator.clipboard.writeText(el.textContent)
       btn.textContent = "Copied!"
       setTimeout(() => btn.textContent = "Copy", 2000)
     }
   })

  window.companion.onUserMsg((msg) => addMsg("user", msg.text))
  window.companion.onResponse((msg) => addMsg("assistant", msg.text))
  window.companion.onConversation((msg) => {
    msgs.innerHTML = ""
    if (msg.messages && msg.messages.length) {
      toggleClass(placeholder, "hidden", true)
      msg.messages.forEach((m) => addMsg(m.role, m.text))
    } else {
      toggleClass(placeholder, "hidden", false)
    }
  })
  window.companion.onStreamChunk((msg) => {
    toggleClass(placeholder, "hidden", true)
    let last = msgs.lastElementChild
    if (!last || !last.classList.contains("msg-streaming")) {
      last = document.createElement("div")
      last.className = "msg msg-assistant msg-streaming"
      msgs.appendChild(last)
    }
    last.textContent = msg.text
    lastAssistantText = msg.text
    msgs.scrollTop = msgs.scrollHeight
  })
  window.companion.onStreamEnd(() => {
    const last = msgs.lastElementChild
    if (last && last.classList.contains("msg-streaming")) last.remove()
    addMsg("assistant", lastAssistantText)
  })

  window.companion.onTranscript((msg) => {
    const input = el("chatInput")
    if (msg.startOfSpeech) {
      clearTimeout(window._autoTimer)
    } else if (msg.isFinal) {
      input.value = msg.fromBar ? msg.text : _appendText + (_appendText && msg.text ? " " : "") + msg.text
      input.placeholder = "Ask your companion..."
    } else {
      input.placeholder = "🎤 " + msg.text
    }
  })

  window.companion.onEndOfSpeech((msg) => {
    if (!msg.fromBar) return
    const input = el("chatInput")
    clearTimeout(window._autoTimer)
    window._autoTimer = setTimeout(() => {
      const t = msg.text.trim()
      if (t && t !== _lastSentText) { window.companion.sendChat(t); window.companion.sendAction("clear_mic_committed"); input.value = ""; _lastSentText = t }
    }, state.silenceTimeout || 2000)
  })

  window.companion.onTTSAudio((msg) => {
    if (!msg?.data) return
    if (currentTTSAudio) { currentTTSAudio.pause(); currentTTSAudio = null }
    window.companion.log("TTS: received " + msg.data.length + " bytes")
    try {
      const audio = new Audio("data:audio/wav;base64," + msg.data)
      currentTTSAudio = audio
      audio.play().then(() => window.companion.log("TTS: playback started"))
        .catch(e => window.companion.log("TTS: play error: " + e.message))
    } catch (e) {
      window.companion.log("TTS: playback error: " + (e.message || e))
    }
  })

  window.companion.onTTsStop(() => {
    if (currentTTSAudio) { currentTTSAudio.pause(); currentTTSAudio = null }
  })

   el("btnSend").onclick = () => {
     const input = el("chatInput")
     const text = input.value.trim()
     if (!text) return
     input.value = ""
     input.placeholder = "Ask your companion..."
     window.companion.sendChat(text)
   }
   
     el("btnMicInput").onclick = async () => {
       if (dictationActive) {
         stopAudioCapture()
         el("btnMicInput").classList.remove("active")
         el("btnMicInput").title = "Dictate your question"
       } else {
         _appendText = el("chatInput").value
         el("btnMicInput").classList.add("active")
         el("btnMicInput").title = "Click to stop dictation"
         try { await startMicCapture(false) }
        catch (e) {
          el("btnMicInput").classList.remove("active")
          el("btnMicInput").title = "Dictate your question"
        }
      }
    }
   
   el("chatInput").onkeydown = (e) => {
     if (e.key === "Enter") el("btnSend").click()
   }

   // Panel drag
   let draggingP = false
   let px = 0, py = 0
   el("messages").addEventListener("mousedown", (e) => {
     if (e.target.closest(".btn") || e.target.closest("#inputArea")) return
     draggingP = true
     px = e.screenX
     py = e.screenY
     e.preventDefault()
   })
   document.addEventListener("mousemove", (e) => {
     if (!draggingP) return
     window.companion.sendAction("panel_drag_move", {
       deltaX: e.screenX - px,
        deltaY: e.screenY - py,
     })
     px = e.screenX
     py = e.screenY
   })
    document.addEventListener("mouseup", () => { draggingP = false })
    
    // Custom edge resize for panel (transparent windows can't use native resize on Windows)
    let resizingP = false
    let resizeEdge = ""
    let startX = 0, startY = 0, startW = 500, startH = 600
    let startWX = 0, startWY = 0
    const EDGE = 8
    
    function detectEdge(e) {
      const w = window.innerWidth, h = window.innerHeight
      const top = e.clientY <= EDGE, bot = e.clientY >= h - EDGE
      const left = e.clientX <= EDGE, right = e.clientX >= w - EDGE
      if (top && left) return "nw"
      if (top && right) return "ne"
      if (bot && left) return "sw"
      if (bot && right) return "se"
      if (top) return "n"
      if (bot) return "s"
      if (left) return "w"
      if (right) return "e"
      return ""
    }
    
    let resizeThrottle = 0
    document.addEventListener("mousemove", (e) => {
      if (resizingP) {
        const now = Date.now()
        if (now - resizeThrottle < 33) return
        resizeThrottle = now
        const dx = e.screenX - startX, dy = e.screenY - startY
        let nw = startW, nh = startH
        if (resizeEdge.includes("e")) nw = Math.max(300, startW + dx)
        if (resizeEdge.includes("w")) nw = Math.max(300, startW - dx)
        if (resizeEdge.includes("s")) nh = Math.max(300, startH + dy)
        if (resizeEdge.includes("n")) nh = Math.max(300, startH - dy)
        window.companion.sendAction("resize_panel", { edge: resizeEdge, width: nw, height: nh, startW, startH, startWX, startWY })
        return
      }
      if (draggingP) return
    })
    
    document.addEventListener("mousedown", (e) => {
      const edge = detectEdge(e)
      if (!edge) return
      resizingP = true
      resizeEdge = edge
      startX = e.screenX
      startY = e.screenY
      startW = window.innerWidth
      startH = window.innerHeight
      startWX = window.screenX
      startWY = window.screenY
      e.preventDefault()
    })
    
    document.addEventListener("mouseup", () => { resizingP = false })

  }
