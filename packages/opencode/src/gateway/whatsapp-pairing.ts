import path from "path"
import fs from "fs/promises"
import { Global } from "../global"

export interface PairingResult {
  code: string
  qr?: string
  wait: () => Promise<void>
  cleanup: () => void
}

export async function startPairing(phone: string, baileysPath: string, usePairingCode = true): Promise<PairingResult> {
  const dir = path.join(Global.Path.state, "gateway", "whatsapp-session")

  await fs.rm(dir, { recursive: true, force: true })
  await fs.mkdir(dir, { recursive: true })

  const cacheModules = path.resolve(baileysPath, "..", "..")
  const [{ default: NodeCache }, { default: P }, baileys, qrcode] = await Promise.all([
    import(path.join(cacheModules, "@cacheable", "node-cache")),
    import(path.join(cacheModules, "pino")),
    import(baileysPath),
    import(path.join(cacheModules, "qrcode-terminal")).catch(() => ({ default: null })),
  ])

  const {
    default: makeWASocket,
    useMultiFileAuthState,
    DisconnectReason,
    Browsers,
    fetchLatestBaileysVersion,
    makeCacheableSignalKeyStore,
    DEFAULT_CONNECTION_CONFIG,
    proto,
  } = baileys

  const logDir = path.join(Global.Path.state, "gateway")
  await fs.mkdir(logDir, { recursive: true }).catch(() => {})
  const logger = P({
    level: "trace",
    transport: {
      targets: [
        {
          target: "pino/file",
          options: { destination: path.join(logDir, "wa-logs.txt") },
          level: "trace",
        },
      ],
    },
  })

  const { state, saveCreds } = await useMultiFileAuthState(dir)
  const { version, isLatest } = await fetchLatestBaileysVersion()
  logger.debug({ version: version.join("."), isLatest }, "using latest WA version")

  const msgRetryCounterCache = new NodeCache()

  const cleanPhone = phone.replace(/[^\d]/g, "")

  async function getMessage(key: any): Promise<any> {
    return undefined
  }

  return new Promise<PairingResult>((resolveOuter, rejectOuter) => {
    let currentSock: any = null
    let codeResolved = false
    let waitResolve: (() => void) | null = null
    let waitReject: ((err: Error) => void) | null = null
    let waitTimeout: ReturnType<typeof setTimeout> | null = null
    let qrCode: string | undefined

    async function createSocket() {
      const { state: st, saveCreds: sc } = await useMultiFileAuthState(dir)
      const { version: v } = await fetchLatestBaileysVersion()
      const msgRetryCounterCache = new NodeCache()

      const sock = makeWASocket({
        version: v,
        logger,
        waWebSocketUrl: DEFAULT_CONNECTION_CONFIG.waWebSocketUrl,
        auth: {
          creds: st.creds,
          keys: makeCacheableSignalKeyStore(st.keys, logger),
        },
        msgRetryCounterCache,
        generateHighQualityLinkPreview: true,
        syncFullHistory: false,
        markOnlineOnConnect: false,
        browser: Browsers.windows("Chrome"),
        getMessage,
      })

      currentSock = sock

      sock.ev.process(async (events: any) => {
        if (events["creds.update"]) {
          await sc()
        }

        if (events["connection.update"]) {
          const { connection, lastDisconnect, qr } = events["connection.update"]

          if (connection === "close") {
            const reason = (lastDisconnect?.error as any)?.output?.statusCode
            if (reason === DisconnectReason.loggedOut) {
              if (waitReject) {
                waitReject(new Error("Session invalid. Please re-pair."))
              } else if (!codeResolved) {
                rejectOuter(new Error("Session invalid. Please re-pair."))
              }
              return
            }

            if (!codeResolved) {
              rejectOuter(new Error("Connection failed before pairing could start. Please try again."))
              return
            }

            try { currentSock?.end() } catch {}
            await createSocket()
          }

          if (connection === "open") {
            if (waitResolve) {
              if (waitTimeout) clearTimeout(waitTimeout)
              waitResolve()
            }
          }

          if (qr && !sock.authState.creds.registered && !codeResolved) {
            if (usePairingCode) {
              codeResolved = true
              try {
                const pairingCode = await sock.requestPairingCode(cleanPhone)

                const waitPromise = new Promise<void>((res, rej) => {
                  waitResolve = res
                  waitReject = rej
                  waitTimeout = setTimeout(() => {
                    rej(new Error("Pairing timed out. Please try again."))
                  }, 180000)
                })

                resolveOuter({
                  code: pairingCode,
                  wait: async () => waitPromise,
                  cleanup: () => {
                    try { currentSock?.end() } catch {}
                    if (waitTimeout) clearTimeout(waitTimeout)
                  },
                })
              } catch (e: any) {
                rejectOuter(new Error(`Failed to generate pairing code: ${e.message}`))
              }
            } else {
              qrCode = qr
              codeResolved = true

              let qrArt = qr
              if (qrcode.default) {
                qrArt = await new Promise<string>((resolve) => {
                  qrcode.default.generate(qr, { small: true }, (art: string) => {
                    resolve(art)
                  })
                })
              }

              const waitPromise = new Promise<void>((res, rej) => {
                waitResolve = res
                waitReject = rej
                waitTimeout = setTimeout(() => {
                  rej(new Error("Pairing timed out. Please try again."))
                }, 180000)
              })

              resolveOuter({
                code: "",
                qr: qrArt,
                wait: async () => waitPromise,
                cleanup: () => {
                  try { currentSock?.end() } catch {}
                  if (waitTimeout) clearTimeout(waitTimeout)
                },
              })
            }
          }
        }
      })
    }

    createSocket()
  })
}
