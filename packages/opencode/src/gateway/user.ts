import path from "path"
import fs from "fs/promises"
import { Global } from "../global"
import { Log } from "../util/log"

const log = Log.create({ service: "gateway-user" })

const USERS_FILE = path.join(Global.Path.state, "gateway-users.json")

export interface GatewayUser {
  platform_user_id: string
  platform_username?: string
  first_seen: number
  last_seen: number
  message_count: number
}

interface GatewayUsersData {
  [platform: string]: {
    [platformUserId: string]: GatewayUser
  }
}

let cache: GatewayUsersData | null = null

async function load(): Promise<GatewayUsersData> {
  if (cache) return cache
  try {
    const data = await fs.readFile(USERS_FILE, "utf-8")
    cache = JSON.parse(data)
  } catch {
    cache = {}
  }
  return cache as GatewayUsersData
}

async function save(data: GatewayUsersData): Promise<void> {
  cache = data
  await fs.writeFile(USERS_FILE, JSON.stringify(data, null, 2))
}

export async function track(platform: string, platformUserId: string, platformUsername?: string): Promise<void> {
  const data = await load()
  if (!data[platform]) data[platform] = {}
  
  const existing = data[platform][platformUserId]
  const now = Date.now()
  
  if (existing) {
    existing.last_seen = now
    existing.message_count++
    if (platformUsername) existing.platform_username = platformUsername
  } else {
    data[platform][platformUserId] = {
      platform_user_id: platformUserId,
      platform_username: platformUsername,
      first_seen: now,
      last_seen: now,
      message_count: 1,
    }
  }
  
  await save(data)
}

export async function list(platform?: string): Promise<GatewayUser[]> {
  const data = await load()
  const users: GatewayUser[] = []
  
  if (platform) {
    const platUsers = data[platform]
    if (platUsers) {
      users.push(...Object.values(platUsers))
    }
  } else {
    for (const platUsers of Object.values(data)) {
      users.push(...Object.values(platUsers))
    }
  }
  
  return users.sort((a, b) => b.last_seen - a.last_seen)
}

export async function get(platform: string, platformUserId: string): Promise<GatewayUser | undefined> {
  const data = await load()
  return data[platform]?.[platformUserId]
}

export async function clearPlatform(platform: string): Promise<void> {
  const data = await load()
  delete data[platform]
  await save(data)
}
