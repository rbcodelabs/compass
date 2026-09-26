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

/**
 * Inbound (parent → sandbox) and outbound (sandbox → parent) message `type`
 * values for the element-picking/anchor-resolution extension of the preview
 * handshake. Kept distinct from the legacy `state` field (`READY`/
 * `NAVIGATING`) used by the original readiness handshake so existing parent
 * listeners that only understand `state` continue to ignore these safely.
 */
export const ARTIFACT_PICK_MESSAGE_TYPES = {
  ENTER_PICK_MODE: "ENTER_PICK_MODE",
  EXIT_PICK_MODE: "EXIT_PICK_MODE",
  PICK_MODE_EXITED: "PICK_MODE_EXITED",
  ELEMENT_PICKED: "ELEMENT_PICKED",
  RESOLVE_ANCHORS: "RESOLVE_ANCHORS",
  ANCHOR_RESULTS: "ANCHOR_RESULTS",
} as const

const ARTIFACT_POLICY_PREFIX = `<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_CSP}"><meta name="referrer" content="no-referrer">`

export function buildSandboxedHtml(html: string): string {
  return `${ARTIFACT_POLICY_PREFIX}${html}`
}

/**
 * Installs a non-privileged authenticated lifecycle reporter before uploaded
 * bytes can execute. The token remains in this closure and the script removes
 * its DOM node before the parser resumes into untrusted content.
 *
 * Beyond the original READY/NAVIGATING readiness handshake, this also wires
 * an element-picking and anchor-resolution channel used by the native
 * artifact feedback feature (see components/artifact-sandboxed-frame.tsx):
 *
 *  - `ENTER_PICK_MODE`/`EXIT_PICK_MODE`: toggles a click-capturing highlight
 *    overlay. A pick's click is always swallowed (`preventDefault` +
 *    `stopPropagation`) so the uploaded prototype's own handlers never fire —
 *    the reviewer means "comment on this", not "activate this". Mirrors the
 *    same swallow-the-click contract already shipped and tested in the embed
 *    widget (`public/embed/widget.js`'s `onPickClick`).
 *  - `ELEMENT_PICKED`: emitted once, with a best-effort CSS selector
 *    (`cssPath`) and a document-relative geometry/text fingerprint
 *    (`fingerprintOf`) — both ported from the embed widget's already-shipped,
 *    tested implementation rather than re-derived.
 *  - `RESOLVE_ANCHORS`/`ANCHOR_RESULTS`: given a batch of stored anchors, the
 *    sandbox tries each anchor's selector first (the live truth, if it still
 *    resolves) and otherwise collects same-tag candidate elements for the
 *    parent to score against the stored fingerprint (see
 *    lib/artifact-anchor-match.ts) — the sandbox only ever *collects*
 *    geometry; it never decides what counts as a good enough match, so that
 *    decision stays in ordinary, unit-tested TypeScript instead of untestable
 *    injected JS.
 *
 * Never sends credentials of any kind — only click/element geometry data.
 */
export function injectArtifactPreviewHandshake(sandboxedHtml: string, token: string): string {
  const protectedHtml = sandboxedHtml.startsWith(ARTIFACT_POLICY_PREFIX)
    ? sandboxedHtml
    : buildSandboxedHtml(sandboxedHtml)
  const t = JSON.stringify(ARTIFACT_PICK_MESSAGE_TYPES)
  const bootstrap = `<script>(function(){
const token=${JSON.stringify(token)};
const scope=${JSON.stringify(ARTIFACT_PREVIEW_MESSAGE_SCOPE)};
const types=${t};
const send=window.parent.postMessage.bind(window.parent);
let navigating=false;
const emit=(state)=>send({scope,token,state},"*");
const emitTyped=(payload)=>send(Object.assign({scope,token},payload),"*");
const leaving=()=>{if(!navigating){navigating=true;emit("NAVIGATING")}};
window.addEventListener("beforeunload",leaving,{capture:true});
window.addEventListener("pagehide",leaving,{capture:true});
const ready=()=>{if(!navigating)emit("READY")};
if(document.readyState==="loading")document.addEventListener("DOMContentLoaded",ready,{once:true,capture:true});
else queueMicrotask(ready);
const own=document.currentScript;
if(own)own.remove();

/* Element picking + anchor resolution (native artifact feedback). */
let picking=false;
let highlightEl=null;
const MAX_SELECTOR_LENGTH=1000;
const MAX_CANDIDATES=300;
function isFiniteNumber(v){return typeof v==="number"&&isFinite(v)}
function scrollLeftPx(){return typeof window.scrollX==="number"?window.scrollX:window.pageXOffset||0}
function scrollTopPx(){return typeof window.scrollY==="number"?window.scrollY:window.pageYOffset||0}
function docWidth(){const el=document.documentElement;return Math.max((el&&el.scrollWidth)||0,1)}
function docHeight(){const el=document.documentElement;return Math.max((el&&el.scrollHeight)||0,1)}
function textOf(el){return (el.textContent||"").replace(/\\s+/g," ").trim()}
function fingerprintOf(el){
  const rect=el.getBoundingClientRect();
  const dw=docWidth(),dh=docHeight();
  const out={tag:String(el.tagName||"").toLowerCase().slice(0,40)};
  const text=textOf(el);
  if(text)out.text=text.slice(0,200);
  const rx=(rect.left+scrollLeftPx())/dw,ry=(rect.top+scrollTopPx())/dh,rw=rect.width/dw,rh=rect.height/dh;
  if(isFiniteNumber(rx))out.rectXRatio=rx;
  if(isFiniteNumber(ry))out.rectYRatio=ry;
  if(isFiniteNumber(rw))out.rectWRatio=rw;
  if(isFiniteNumber(rh))out.rectHRatio=rh;
  return out;
}
/* Where el sits in THIS document's own current viewport, in CSS pixels.
   Never persisted (fingerprintOf's document-relative ratios are what get
   stored) - this is only for the parent to add to the iframe element's own
   getBoundingClientRect() so it can absolute-position a pin over content it
   cannot otherwise see into (opaque origin, cross-frame). */
function geometryOf(el){
  const rect=el.getBoundingClientRect();
  return {left:rect.left,top:rect.top,width:rect.width,height:rect.height};
}
function cssPath(target){
  try{
    const parts=[];let node=target;let depth=0;
    while(node&&node.nodeType===1&&depth<10){
      const id=node.getAttribute("id");
      if(id&&/^[A-Za-z][\\w-]*$/.test(id)){parts.unshift("#"+id);break}
      let piece=node.tagName.toLowerCase();
      const parent=node.parentElement;
      if(parent){
        const siblings=[];const kids=parent.children;
        for(let i=0;i<kids.length;i++){if(kids[i].tagName===node.tagName)siblings.push(kids[i])}
        if(siblings.length>1)piece+=":nth-of-type("+(siblings.indexOf(node)+1)+")";
      }
      parts.unshift(piece);node=parent;depth++;
    }
    const selector=parts.join(" > ");
    return selector&&selector.length<=MAX_SELECTOR_LENGTH?selector:null;
  }catch(err){void err;return null}
}
function isPickable(target){
  return Boolean(target)&&target.nodeType===1&&target!==document.documentElement&&target!==document.body;
}
function ensureHighlight(){
  if(highlightEl)return highlightEl;
  highlightEl=document.createElement("div");
  highlightEl.setAttribute("data-compass-pick-highlight","");
  highlightEl.style.cssText="position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #6366f1;background:rgba(99,102,241,0.15);display:none;";
  document.documentElement.appendChild(highlightEl);
  return highlightEl;
}
function showHighlight(target){
  const el=ensureHighlight();const rect=target.getBoundingClientRect();
  el.style.left=Math.round(rect.left)+"px";el.style.top=Math.round(rect.top)+"px";
  el.style.width=Math.round(rect.width)+"px";el.style.height=Math.round(rect.height)+"px";
  el.style.display="block";
}
function hideHighlight(){if(highlightEl)highlightEl.style.display="none"}
function onPickMove(event){const target=event.target;if(!isPickable(target))return;showHighlight(target)}
function onPickClick(event){
  const target=event.target;
  if(!isPickable(target))return;
  event.preventDefault();event.stopPropagation();
  if(typeof event.stopImmediatePropagation==="function")event.stopImmediatePropagation();
  const selector=cssPath(target);const fingerprint=fingerprintOf(target);
  stopPicking();
  emitTyped({type:types.ELEMENT_PICKED,selector,fingerprint});
}
function onPickEscape(event){
  if(event.key!=="Escape"||!picking)return;
  stopPicking();
  emitTyped({type:types.PICK_MODE_EXITED});
}
function startPicking(){
  if(picking)return;picking=true;
  document.addEventListener("mousemove",onPickMove,true);
  document.addEventListener("click",onPickClick,true);
  document.addEventListener("keydown",onPickEscape,true);
  document.documentElement.style.cursor="crosshair";
}
function stopPicking(){
  if(!picking)return;picking=false;
  document.removeEventListener("mousemove",onPickMove,true);
  document.removeEventListener("click",onPickClick,true);
  document.removeEventListener("keydown",onPickEscape,true);
  document.documentElement.style.cursor="";
  hideHighlight();
}
function resolveOne(anchor){
  const commentId=anchor.commentId;
  const selector=anchor.elementSelector;
  if(selector){
    try{
      const found=document.querySelector(selector);
      if(found&&found.nodeType===1&&found!==document.documentElement&&found!==document.body){
        return {commentId,matched:true,geometry:geometryOf(found)};
      }
    }catch(err){void err}
  }
  const fp=anchor.elementFingerprint;
  const tag=fp&&fp.tag;
  if(!tag)return {commentId,matched:false,candidates:[]};
  let found2;
  try{found2=document.getElementsByTagName(tag)}catch(err){void err;found2=[]}
  const candidates=[];
  for(let i=0;i<found2.length&&candidates.length<MAX_CANDIDATES;i++){
    candidates.push({fingerprint:fingerprintOf(found2[i]),geometry:geometryOf(found2[i])});
  }
  return {commentId,matched:false,candidates};
}
function onParentMessage(event){
  if(event.source!==window.parent)return;
  const message=event.data;
  if(!message||message.scope!==scope||message.token!==token||!message.type)return;
  if(message.type===types.ENTER_PICK_MODE){startPicking();return}
  if(message.type===types.EXIT_PICK_MODE){stopPicking();return}
  if(message.type===types.RESOLVE_ANCHORS){
    const anchors=Array.isArray(message.anchors)?message.anchors:[];
    const results=anchors.map(resolveOne);
    emitTyped({type:types.ANCHOR_RESULTS,results});
  }
}
window.addEventListener("message",onParentMessage);
})();</script>`
  return `${ARTIFACT_POLICY_PREFIX}${bootstrap}${protectedHtml.slice(ARTIFACT_POLICY_PREFIX.length)}`
}
