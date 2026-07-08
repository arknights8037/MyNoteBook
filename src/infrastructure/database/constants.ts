export const DATABASE_FILENAME = 'editor.db'
export const DATABASE_URL = `sqlite:${DATABASE_FILENAME}`

export function getDatabaseUrl(dataDirectory: string | null): string {
  if (!dataDirectory) return DATABASE_URL

  const normalizedDirectory = dataDirectory.replace(/\\/g, '/').replace(/\/+$/, '')
  return `sqlite:${normalizedDirectory}/${DATABASE_FILENAME}`
}
