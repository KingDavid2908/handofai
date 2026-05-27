declare module "discord.js" {
  export const Client: any
  export const GatewayIntentBits: any
  export const Events: any
}

declare module "@whiskeysockets/baileys" {
  export const makeWASocket: any
  export const useMultiFileAuthState: any
  export const DisconnectReason: any
  export const downloadMediaMessage: any
  export const makeInMemoryStore: any
  export const fetchLatestBaileysVersion: any
  export const makeCacheableSignalKeyStore: any
  export const DEFAULT_CONNECTION_CONFIG: any
  export const proto: any
  export const Browsers: any
  export const generateMessageIDV2: any
  export const isJidNewsletter: any
}

declare module "@cacheable/node-cache" {
  const NodeCache: any
  export default NodeCache
}

declare module "pino" {
  const P: any
  export default P
}

declare module "@slack/web-api" {
  export const WebClient: any
}

declare module "@slack/socket-mode" {
  export const SocketModeClient: any
}

declare module "nodemailer" {
  const createTransport: any
  export { createTransport }
}

declare module "socket.io-client" {
  export const io: any
}
