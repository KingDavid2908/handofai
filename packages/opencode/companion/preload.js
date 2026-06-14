const { contextBridge, ipcRenderer } = require("electron")

contextBridge.exposeInMainWorld("companion", {
  onResponse: (cb) => ipcRenderer.on("response", (_e, msg) => cb(msg)),
  onStreamChunk: (cb) => ipcRenderer.on("stream_chunk", (_e, msg) => cb(msg)),
  onStreamEnd: (cb) => ipcRenderer.on("stream_end", (_e, msg) => cb(msg)),
  onUserMsg: (cb) => ipcRenderer.on("user_msg", (_e, msg) => cb(msg)),
  onSettings: (cb) => ipcRenderer.on("settings", (_e, msg) => cb(msg)),
  onConversation: (cb) => ipcRenderer.on("conversation", (_e, msg) => cb(msg)),
  onInteractiveChanged: (cb) => ipcRenderer.on("interaction_mode", (_e, v) => cb(v)),
  onTranscript: (cb) => ipcRenderer.on("transcript", (_e, msg) => cb(msg)),
  onTTSAudio: (cb) => ipcRenderer.on("tts_audio", (_e, msg) => cb(msg)),
  onAdvice: (cb) => ipcRenderer.on("advice", (_e, msg) => cb(msg)),
  sendAction: (name, data) => ipcRenderer.send("action", name, data),
  log: (msg) => ipcRenderer.send("action", "renderer_log", { msg }),
  sendChat: (text) => ipcRenderer.send("chat", text),
  sendSettings: (key, value) => ipcRenderer.send("settings_change", key, value),
  toggleVisibility: () => ipcRenderer.send("toggle_visibility"),
  setClickable: (active) => ipcRenderer.send("clickable_area", active),
  enableLoopbackAudio: () => ipcRenderer.invoke('enable-loopback-audio'),
  disableLoopbackAudio: () => ipcRenderer.invoke('disable-loopback-audio'),
  onEndOfSpeech: (cb) => ipcRenderer.on("end_of_speech", (_e, msg) => cb(msg)),
  onTTsStop: (cb) => ipcRenderer.on("tts_stop", () => cb()),
})
