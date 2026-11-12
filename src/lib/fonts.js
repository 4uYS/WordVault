const DB_NAME = 'wordvault-fonts'
const STORE = 'fonts'
const KEY = 'custom'

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1)
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE)
    }
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

async function withStore(mode, run) {
  const db = await openDB()
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode)
    const store = tx.objectStore(STORE)
    const req = run(store)
    req.onsuccess = () => resolve(req.result)
    req.onerror = () => reject(req.error)
  })
}

export async function saveCustomFont(file) {
  const buffer = await file.arrayBuffer()
  await withStore('readwrite', (store) => store.put({ name: file.name, size: file.size, buffer }, KEY))
  return { name: file.name, size: file.size }
}

export async function getCustomFont() {
  try {
    return await withStore('readonly', (store) => store.get(KEY))
  } catch {
    return null
  }
}

export async function deleteCustomFont() {
  try {
    await withStore('readwrite', (store) => store.delete(KEY))
  } catch {
    // Ignore deletion failures, the UI will fall back to the system font.
  }
}

let activeFace = null

export async function applyCustomFont() {
  const record = await getCustomFont()
  if (!record?.buffer) return null
  try {
    if (activeFace) document.fonts.delete(activeFace)
    const face = new FontFace('WordVaultCustom', record.buffer)
    await face.load()
    document.fonts.add(face)
    activeFace = face
    return record
  } catch {
    return null
  }
}

export function setAppFont(stack) {
  document.documentElement.style.setProperty('--app-font', stack)
}
