import { Zip, ZipDeflate, ZipPassThrough, unzipSync } from "fflate"

/**
 * Bundle container: a standard zip.
 *
 *   manifest.json
 *   data/<Model>.<part>.ndjson one encoded row per line, split into parts
 *   blobs/artifact/<pathname>  private artifact store (HTML, thumbnails, doc images)
 *   blobs/research/<pathname>  private research store
 *   blobs/feedback/<rowId>     public feedback attachment bytes, keyed by FeedbackAttachment id
 */

export const BUNDLE_FORMAT_VERSION = 1

export type BlobStoreName = "artifact" | "research" | "feedback"

export type BundleManifest = {
  formatVersion: number
  exportId: string
  exportedAt: string
  tier: "core"
  source: { workspaceId: string; organizationId: string; slug: string; name: string }
  counts: Record<string, number>
  /** Users referenced by the data, matched by email on import. */
  users: { id: string; email: string; name: string | null }[]
  /** Org-level scoring models referenced by the data; kept only when the target org is the same. */
  scoringModels: { id: string; organizationId: string }[]
  blobs: { store: BlobStoreName; key: string; contentType: string }[]
  warnings: string[]
}

export const dataEntry = (model: string, part = 0) => `data/${model}.${String(part).padStart(4, "0")}.ndjson`
export const dataPrefix = (model: string) => `data/${model}.`
export const blobEntry = (store: BlobStoreName, key: string) => `blobs/${store}/${key}`

/** Pull-style zip writer: add entries, drain produced chunks between awaits so memory stays bounded. */
export class BundleWriter {
  private chunks: Uint8Array[] = []
  private zip: Zip
  private failure: Error | null = null

  constructor() {
    this.zip = new Zip((err, chunk) => {
      if (err) this.failure = err
      else this.chunks.push(chunk)
    })
  }

  add(name: string, bytes: Uint8Array, compress = true) {
    const file = compress ? new ZipDeflate(name, { level: 6 }) : new ZipPassThrough(name)
    this.zip.add(file)
    file.push(bytes, true)
    if (this.failure) throw this.failure
  }

  addText(name: string, text: string) {
    this.add(name, new TextEncoder().encode(text))
  }

  drain(): Uint8Array[] {
    const out = this.chunks
    this.chunks = []
    return out
  }

  end(): Uint8Array[] {
    this.zip.end()
    if (this.failure) throw this.failure
    return this.drain()
  }
}

export class BundleReader {
  private cache = new Map<string, Uint8Array>()
  private names: Set<string>

  constructor(private bytes: Uint8Array) {
    const names = new Set<string>()
    // Names only: the filter never returns true, so nothing is inflated here.
    unzipSync(bytes, {
      filter: (f) => {
        names.add(f.name)
        return false
      },
    })
    this.names = names
  }

  has(name: string) {
    return this.names.has(name)
  }

  list(prefix = ""): string[] {
    return [...this.names].filter((n) => n.startsWith(prefix))
  }

  read(name: string): Uint8Array | null {
    if (!this.names.has(name)) return null
    const cached = this.cache.get(name)
    if (cached) return cached
    const files = unzipSync(this.bytes, { filter: (f) => f.name === name })
    return files[name] ?? null
  }

  readText(name: string): string | null {
    const b = this.read(name)
    return b ? new TextDecoder().decode(b) : null
  }

  manifest(): BundleManifest {
    const text = this.readText("manifest.json")
    if (!text) throw new Error("Not a Compass workspace bundle: manifest.json is missing")
    const m = JSON.parse(text) as BundleManifest
    if (m.formatVersion !== BUNDLE_FORMAT_VERSION) {
      throw new Error(`Unsupported bundle format version ${m.formatVersion}`)
    }
    return m
  }

  /** Rows of a model as raw encoded objects. */
  *rows(model: string): Generator<Record<string, unknown>> {
    for (const name of this.list(dataPrefix(model)).sort()) {
      const text = this.readText(name)
      if (!text) continue
      for (const line of text.split("\n")) if (line) yield JSON.parse(line)
    }
  }
}
