"use client"

import { useState } from "react"

/**
 * A workspace image as `createDocImage` names it: `/api/docs/images/<workspaceId>/<uuid>.<ext>`.
 *
 * This is the ONLY image source the agent transcript will render. Markdown in a reply
 * is model output, and the model also reads untrusted web pages, so an `<img>` with an
 * arbitrary `src` is a zero-click exfiltration channel (the browser fetches it, query
 * string and all, the moment the message renders). Restricting to our own
 * membership-gated route removes that: the worst a crafted reply can do is request an
 * image the viewer could already open.
 */
const WORKSPACE_IMAGE_SRC =
  /^\/api\/docs\/images\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.(?:png|jpg|gif|webp)$/i

export function isWorkspaceImageSrc(src: unknown): src is string {
  return typeof src === "string" && WORKSPACE_IMAGE_SRC.test(src)
}

export function AgentImage({ src, alt }: { src?: string | Blob; alt?: string }) {
  const [failed, setFailed] = useState(false)
  if (!isWorkspaceImageSrc(src)) return alt ? <span>{alt}</span> : null
  if (failed) return <span className="text-text-secondary">[{alt || "image"} unavailable]</span>
  return (
    <a href={src} target="_blank" rel="noopener noreferrer" className="my-2 block w-fit max-w-full no-underline">
      {/* Plain <img>: the source is a private, session-authed route, which next/image's optimizer cannot fetch. */}
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img
        src={src}
        alt={alt ?? ""}
        loading="lazy"
        onError={() => setFailed(true)}
        className="max-h-96 max-w-full rounded-lg border border-default object-contain"
      />
    </a>
  )
}
