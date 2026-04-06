import path from "path"
import os from "os"
import fs from "fs/promises"

export interface BrowserProfile {
  id: string
  name: string
  chromePath: string
  extensionLoaded: boolean
  lastUsed: string
}

export interface BrowserProfiles {
  profiles: BrowserProfile[]
  defaultProfileId: string
}

const PROFILES_PATH = path.resolve(os.homedir(), ".config/handofai/browser-profiles.json")

export async function loadProfiles(): Promise<BrowserProfiles> {
  try {
    const content = await fs.readFile(PROFILES_PATH, "utf-8")
    return JSON.parse(content)
  } catch {
    return { profiles: [], defaultProfileId: "" }
  }
}

export async function saveProfiles(profiles: BrowserProfiles): Promise<void> {
  await fs.writeFile(PROFILES_PATH, JSON.stringify(profiles, null, 2))
}

export async function getDefaultProfile(): Promise<BrowserProfile | null> {
  const data = await loadProfiles()
  if (!data.defaultProfileId) return null
  return data.profiles.find(p => p.id === data.defaultProfileId) ?? null
}

export async function setDefaultProfile(id: string): Promise<void> {
  const data = await loadProfiles()
  if (!data.profiles.find(p => p.id === id)) {
    throw new Error(`Profile "${id}" not found`)
  }
  data.defaultProfileId = id
  await saveProfiles(data)
}

export async function addProfile(profile: Omit<BrowserProfile, "id" | "lastUsed">): Promise<BrowserProfile> {
  const data = await loadProfiles()
  const id = profile.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")
  if (data.profiles.find(p => p.id === id)) {
    throw new Error(`Profile "${id}" already exists`)
  }
  const newProfile: BrowserProfile = {
    ...profile,
    id,
    lastUsed: new Date().toISOString(),
  }
  data.profiles.push(newProfile)
  if (!data.defaultProfileId) {
    data.defaultProfileId = id
  }
  await saveProfiles(data)
  return newProfile
}

export async function removeProfile(id: string): Promise<void> {
  const data = await loadProfiles()
  data.profiles = data.profiles.filter(p => p.id !== id)
  if (data.defaultProfileId === id) {
    data.defaultProfileId = data.profiles[0]?.id ?? ""
  }
  await saveProfiles(data)
}
