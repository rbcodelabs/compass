/** The storage operations Compass needs from a private object store. */
export interface ArtifactStorage {
  /**
   * `overwrite: false` refuses to replace an existing object: the result carries `created: false` and the existing
   * bytes are untouched. Imports use it so a crafted bundle can never clobber another workspace's files.
   */
  put(
    pathname: string,
    bytes: Uint8Array,
    contentType?: string,
    options?: { overwrite?: boolean },
  ): Promise<{ pathname: string; created?: boolean }>
  get(pathname: string): Promise<Uint8Array | null>
  /**
   * Streaming read: the object is never buffered here, so a large file (a 4.5 MB design-system bundle, say) is
   * not subject to the memory or response-size limits of reading it whole. `size` is the stored length when the
   * backend knows it. Null when the object does not exist. Optional so a backend that cannot stream is still valid;
   * callers must handle its absence.
   */
  getStream?(pathname: string): Promise<{ stream: ReadableStream<Uint8Array>; size: number | null } | null>
  /** Reserve a staging receipt across concurrent requests. Release only after a failed commit. */
  claimStagedUpload?(pathname: string): Promise<() => Promise<void>>
  del(pathname: string): Promise<void>
}
