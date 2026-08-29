export const ARTIFACT_CSP = [
  "default-src 'none'",
  "script-src 'unsafe-inline' blob:",
  "style-src 'unsafe-inline'",
  "img-src data: blob:",
  "font-src data: blob:",
  "media-src data: blob:",
  "connect-src 'none'",
  "form-action 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "frame-src 'none'",
  "worker-src 'none'",
  "manifest-src 'none'",
].join("; ")

export const ARTIFACT_PREVIEW_MESSAGE_SCOPE = "COMPASS_ARTIFACT_PREVIEW_V1" as const

const ARTIFACT_POLICY_PREFIX = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta name="referrer" content="no-referrer">`

export function buildSandboxedHtml(html: string): string {
  return `${ARTIFACT_POLICY_PREFIX}${html}`
}

/**
 * Installs a non-privileged authenticated lifecycle reporter before uploaded
 * bytes can execute. The token remains in this closure and the script removes
 * its DOM node before the parser resumes into untrusted content.
 */
export function injectArtifactPreviewHandshake(sandboxedHtml: string, token: string): string {
  const protectedHtml = sandboxedHtml.startsWith(ARTIFACT_POLICY_PREFIX)
    ? sandboxedHtml
    : buildSandboxedHtml(sandboxedHtml)
  const bootstrap = `<script>(function(){const token=${JSON.stringify(token)};const send=window.parent.postMessage.bind(window.parent);let navigating=false;const emit=(state)=>send({scope:${JSON.stringify(ARTIFACT_PREVIEW_MESSAGE_SCOPE)},token,state},"*");const leaving=()=>{if(!navigating){navigating=true;emit("NAVIGATING")}};window.addEventListener("beforeunload",leaving,{capture:true});window.addEventListener("pagehide",leaving,{capture:true});const ready=()=>{if(!navigating)emit("READY")};if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ready,{once:true,capture:true});else queueMicrotask(ready);const own=document.currentScript;if(own)own.remove()})();</script>`
  return `${ARTIFACT_POLICY_PREFIX}${bootstrap}${protectedHtml.slice(ARTIFACT_POLICY_PREFIX.length)}`
}
