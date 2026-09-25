"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { put } from "@vercel/blob/client";

import {
  discardFeedbackAttachment,
  prepareFeedbackAttachment,
  type PrepareFeedbackAttachmentResult,
  type UploadedFeedbackAttachment,
} from "@/app/[orgSlug]/[workspaceSlug]/feedback/actions";
import {
  FEEDBACK_ATTACHMENT_MAX_COUNT,
  IN_APP_RECEIPT_GRACE_MS,
  feedbackAttachmentRejection,
} from "@/lib/feedback-attachment-rules";
import type { DraftAttachment } from "@/lib/feedback-draft";

export type ComposerAttachment = {
  /** Stable client-side key; never sent to the server. */
  localId: string;
  filename: string;
  fileType: string;
  fileSize: number;
  status: "uploading" | "done" | "error";
  /** 0–100 while uploading. */
  progress: number;
  error?: string;
  /** Object URL (fresh upload) or the public blob URL (restored draft). */
  previewUrl?: string;
  url?: string;
  receipt?: string;
  restorableUntil?: number;
};

/** The three side effects, injectable so the hook can be tested without Blob. */
export type AttachmentTransport = {
  prepare: (file: { filename: string; fileType: string; fileSize: number }) => Promise<PrepareFeedbackAttachmentResult>;
  upload: (
    pathname: string,
    file: File,
    options: { token: string; contentType: string; onProgress: (percentage: number) => void; signal: AbortSignal },
  ) => Promise<{ url: string }>;
  discard: (upload: UploadedFeedbackAttachment) => Promise<unknown>;
};

export function defaultAttachmentTransport(orgSlug: string, workspaceSlug: string): AttachmentTransport {
  return {
    prepare: (file) => prepareFeedbackAttachment(orgSlug, workspaceSlug, file),
    upload: (pathname, file, { token, contentType, onProgress, signal }) =>
      put(pathname, file, {
        access: "public",
        token,
        contentType,
        abortSignal: signal,
        onUploadProgress: ({ percentage }) => onProgress(percentage),
      }),
    discard: (upload) => discardFeedbackAttachment(orgSlug, workspaceSlug, upload),
  };
}

let nextId = 0;
const newLocalId = () => `att-${Date.now().toString(36)}-${(nextId++).toString(36)}`;

function fromDraft(saved: DraftAttachment): ComposerAttachment {
  return {
    localId: newLocalId(),
    filename: saved.filename,
    fileType: saved.fileType,
    fileSize: saved.fileSize,
    status: "done",
    progress: 100,
    previewUrl: saved.fileType.startsWith("image/") ? saved.url : undefined,
    url: saved.url,
    receipt: saved.receipt,
    restorableUntil: saved.restorableUntil,
  };
}

/** The finished uploads, in the shape the draft store persists. */
export function toDraftAttachments(items: ComposerAttachment[]): DraftAttachment[] {
  return items.flatMap((item) =>
    item.status === "done" && item.url && item.receipt && item.restorableUntil
      ? [{
          url: item.url,
          receipt: item.receipt,
          filename: item.filename,
          fileType: item.fileType,
          fileSize: item.fileSize,
          restorableUntil: item.restorableUntil,
        }]
      : [],
  );
}

/**
 * Upload state for the feedback composer's attachment tray.
 *
 * Files upload the moment they are added — dropped, pasted or picked — so by
 * the time the user presses Submit the slow part is already done and creation
 * is a single server write. Each file is a chip with its own progress, error
 * and retry, so one bad file never blocks or discards the others.
 */
export function useFeedbackAttachmentUploads({
  transport,
  initial = [],
}: {
  transport: AttachmentTransport;
  initial?: DraftAttachment[];
}) {
  const [items, setItems] = useState<ComposerAttachment[]>(() => initial.map(fromDraft));
  /** Files rejected before upload (wrong type, too big, over the limit). */
  const [notice, setNotice] = useState<string | null>(null);
  const files = useRef(new Map<string, File>());
  const controllers = useRef(new Map<string, AbortController>());
  const objectUrls = useRef(new Map<string, string>());
  // Handlers read the latest values through refs so they can stay stable
  // (the editor captures `add` once). Synced after commit, before any event.
  const itemsRef = useRef(items);
  const transportRef = useRef(transport);
  useEffect(() => {
    itemsRef.current = items;
    transportRef.current = transport;
  }, [items, transport]);

  const patch = useCallback((localId: string, next: Partial<ComposerAttachment>) => {
    setItems((current) => current.map((item) => (item.localId === localId ? { ...item, ...next } : item)));
  }, []);

  const start = useCallback(
    async (localId: string, file: File) => {
      const controller = new AbortController();
      controllers.current.set(localId, controller);
      patch(localId, { status: "uploading", progress: 0, error: undefined });
      try {
        const prepared = await transportRef.current.prepare({
          filename: file.name,
          fileType: file.type,
          fileSize: file.size,
        });
        if (!prepared.ok) throw new Error(prepared.error);
        if (controller.signal.aborted) return;
        const blob = await transportRef.current.upload(prepared.upload.pathname, file, {
          token: prepared.upload.clientToken,
          contentType: file.type,
          signal: controller.signal,
          onProgress: (percentage) => patch(localId, { progress: Math.min(99, Math.round(percentage)) }),
        });
        if (controller.signal.aborted) return;
        patch(localId, {
          status: "done",
          progress: 100,
          url: blob.url,
          receipt: prepared.upload.receipt,
          restorableUntil: prepared.upload.expiresAt + IN_APP_RECEIPT_GRACE_MS,
        });
      } catch (error) {
        if (controller.signal.aborted) return;
        patch(localId, {
          status: "error",
          error: error instanceof Error && error.message ? error.message : "Upload failed.",
        });
      } finally {
        if (controllers.current.get(localId) === controller) controllers.current.delete(localId);
      }
    },
    [patch],
  );

  const add = useCallback(
    (incoming: File[] | FileList) => {
      const list = Array.from(incoming);
      if (list.length === 0) return;
      const room = FEEDBACK_ATTACHMENT_MAX_COUNT - itemsRef.current.length;
      const problems: string[] = [];
      const accepted: File[] = [];
      for (const file of list) {
        const rejection = feedbackAttachmentRejection(file);
        if (rejection) problems.push(rejection);
        else if (accepted.length >= room) {
          problems.push(`You can attach up to ${FEEDBACK_ATTACHMENT_MAX_COUNT} files.`);
          break;
        } else accepted.push(file);
      }
      setNotice(problems.length ? problems.join(" ") : null);
      if (accepted.length === 0) return;

      const created = accepted.map((file) => {
        const localId = newLocalId();
        files.current.set(localId, file);
        let previewUrl: string | undefined;
        if (file.type.startsWith("image/") && typeof URL.createObjectURL === "function") {
          previewUrl = URL.createObjectURL(file);
          objectUrls.current.set(localId, previewUrl);
        }
        const item: ComposerAttachment = {
          localId,
          filename: file.name,
          fileType: file.type,
          fileSize: file.size,
          status: "uploading",
          progress: 0,
          previewUrl,
        };
        return item;
      });
      setItems((current) => [...current, ...created]);
      for (const item of created) void start(item.localId, files.current.get(item.localId)!);
    },
    [start],
  );

  const releaseLocal = useCallback((localId: string) => {
    controllers.current.get(localId)?.abort();
    controllers.current.delete(localId);
    files.current.delete(localId);
    const objectUrl = objectUrls.current.get(localId);
    if (objectUrl) URL.revokeObjectURL?.(objectUrl);
    objectUrls.current.delete(localId);
  }, []);

  const remove = useCallback(
    (localId: string) => {
      const item = itemsRef.current.find((candidate) => candidate.localId === localId);
      releaseLocal(localId);
      setItems((current) => current.filter((candidate) => candidate.localId !== localId));
      setNotice(null);
      // Best effort: an orphaned blob is untidy, not user-visible.
      if (item?.status === "done" && item.url && item.receipt) {
        void transportRef.current.discard({ url: item.url, receipt: item.receipt }).catch(() => undefined);
      }
    },
    [releaseLocal],
  );

  const retry = useCallback(
    (localId: string) => {
      const file = files.current.get(localId);
      if (file) void start(localId, file);
    },
    [start],
  );

  /** Flag an already-uploaded file the server refused at submit time. */
  const markFailed = useCallback((url: string, message: string) => {
    setItems((current) =>
      current.map((item) => (item.url === url ? { ...item, status: "error", error: message } : item)),
    );
  }, []);

  /**
   * Forget everything without deleting blobs — used after a successful submit
   * (the blobs now belong to the new feedback item) and after a confirmed
   * discard (where `discardAll` has already been called).
   */
  const reset = useCallback(() => {
    for (const localId of Array.from(files.current.keys())) releaseLocal(localId);
    setItems([]);
    setNotice(null);
  }, [releaseLocal]);

  /** Delete every finished upload, then reset. For "Discard draft". */
  const discardAll = useCallback(() => {
    for (const item of itemsRef.current) {
      if (item.status === "done" && item.url && item.receipt) {
        void transportRef.current.discard({ url: item.url, receipt: item.receipt }).catch(() => undefined);
      }
    }
    reset();
  }, [reset]);

  // Unmount (panel closed): stop uploads and free previews. Finished uploads
  // survive in the persisted draft; in-flight ones are lost by design.
  useEffect(() => {
    const controllerMap = controllers.current;
    const urlMap = objectUrls.current;
    return () => {
      for (const controller of controllerMap.values()) controller.abort();
      for (const objectUrl of urlMap.values()) URL.revokeObjectURL?.(objectUrl);
    };
  }, []);

  const uploading = items.some((item) => item.status === "uploading");
  const failed = items.some((item) => item.status === "error");

  /** Only files picked in this session can be re-sent; restored ones cannot. */
  const canRetry = useCallback((localId: string) => files.current.has(localId), []);

  return {
    items,
    notice,
    uploading,
    failed,
    add,
    remove,
    retry,
    canRetry,
    markFailed,
    reset,
    discardAll,
    dismissNotice: () => setNotice(null),
  };
}
