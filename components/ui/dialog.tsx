"use client"

import * as React from "react"
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog"

import { cn } from "@/lib/utils"
import { Button } from "@/components/ui/button"
import { XIcon } from "lucide-react"

function Dialog({ ...props }: DialogPrimitive.Root.Props) {
  return <DialogPrimitive.Root data-slot="dialog" {...props} />
}

function DialogTrigger({ ...props }: DialogPrimitive.Trigger.Props) {
  return <DialogPrimitive.Trigger data-slot="dialog-trigger" {...props} />
}

function DialogPortal({ ...props }: DialogPrimitive.Portal.Props) {
  return <DialogPrimitive.Portal data-slot="dialog-portal" {...props} />
}

function DialogClose({ ...props }: DialogPrimitive.Close.Props) {
  return <DialogPrimitive.Close data-slot="dialog-close" {...props} />
}

function DialogOverlay({
  className,
  // Base UI suppresses a *nested* dialog's backdrop by default
  // (`enabled: forceRender || !nested` in DialogBackdrop) so a stacked-dialog
  // treatment can keep the parent visible behind the child. Entity detail
  // panels are built on Sheet, which is itself a Base UI Dialog, so every
  // dialog opened from inside a panel ("Link existing task", "Add evidence",
  // "Add solution") counts as nested — and shipped with no scrim at all. The
  // panel behind an open modal was neither dimmed nor pointer-blocked; a
  // production hit-test over the panel returned panel content, not a scrim.
  //
  // Forcing the dialog's own backdrop is the right fix rather than raising the
  // Sheet's backdrop while a child dialog is open, because:
  //   - the dialog owns its scrim, so the fix lives with the thing whose
  //     modality is being asserted, and works from any surface — not just from
  //     a Sheet that happens to know a child is open;
  //   - it lands exactly on the dialog rung (70) of the ladder in
  //     app/globals.css, already above the panel rung (60). Raising the Sheet
  //     backdrop would need a new rung between 60 and 70 and would make the
  //     Sheet responsible for scrimming a surface it does not own;
  //   - it is a documented Base UI prop, not a reach into `data-nested-dialog-
  //     open` internals plus a `:has()` selector.
  // It does not double-darken: the Sheet's own backdrop sits at 50, under the
  // opaque panel content at 60, so the two scrims never overlap on screen.
  // `forceRender` only overrides the *nested* suppression — the backdrop is
  // still `hidden` while the dialog is closed.
  forceRender = true,
  ...props
}: DialogPrimitive.Backdrop.Props) {
  return (
    <DialogPrimitive.Backdrop
      data-slot="dialog-overlay"
      forceRender={forceRender}
      className={cn(
        // Dialog layer (70) — see the stacking-layer ladder in app/globals.css.
        // Backdrop and content share the layer; content wins on DOM order.
        // Must clear the panel layer (60): entity detail panels open dialogs
        // ("Link existing task", "Add evidence"), and at z-50 both the scrim
        // and the dialog itself painted under the panel that opened them.
        "fixed inset-0 isolate z-[70] bg-black/10 duration-100 supports-backdrop-filter:backdrop-blur-xs data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0",
        className
      )}
      {...props}
    />
  )
}

function DialogContent({
  className,
  children,
  showCloseButton = true,
  overlayClassName,
  ...props
}: DialogPrimitive.Popup.Props & {
  showCloseButton?: boolean
  overlayClassName?: string
}) {
  return (
    <DialogPortal>
      <DialogOverlay className={overlayClassName} />
      <DialogPrimitive.Popup
        data-slot="dialog-content"
        className={cn(
          // Dialog layer (70) — see app/globals.css.
          "fixed top-1/2 left-1/2 z-[70] grid w-full max-w-[calc(100%-2rem)] -translate-x-1/2 -translate-y-1/2 gap-4 rounded-xl bg-popover p-4 text-sm text-popover-foreground ring-1 ring-foreground/10 duration-100 outline-none sm:max-w-sm data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
          className
        )}
        {...props}
      >
        {children}
        {showCloseButton && (
          <DialogPrimitive.Close
            data-slot="dialog-close"
            render={
              <Button
                variant="ghost"
                className="absolute top-2 right-2"
                size="icon-sm"
              />
            }
          >
            <XIcon
            />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        )}
      </DialogPrimitive.Popup>
    </DialogPortal>
  )
}

function DialogHeader({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="dialog-header"
      className={cn("flex flex-col gap-2", className)}
      {...props}
    />
  )
}

function DialogFooter({
  className,
  showCloseButton = false,
  children,
  ...props
}: React.ComponentProps<"div"> & {
  showCloseButton?: boolean
}) {
  return (
    <div
      data-slot="dialog-footer"
      className={cn(
        "-mx-4 -mb-4 flex flex-col-reverse gap-2 rounded-b-xl border-t bg-muted/50 p-4 sm:flex-row sm:justify-end",
        className
      )}
      {...props}
    >
      {children}
      {showCloseButton && (
        <DialogPrimitive.Close render={<Button variant="outline" />}>
          Close
        </DialogPrimitive.Close>
      )}
    </div>
  )
}

function DialogTitle({ className, ...props }: DialogPrimitive.Title.Props) {
  return (
    <DialogPrimitive.Title
      data-slot="dialog-title"
      className={cn(
        "text-base leading-none font-medium",
        className
      )}
      {...props}
    />
  )
}

function DialogDescription({
  className,
  ...props
}: DialogPrimitive.Description.Props) {
  return (
    <DialogPrimitive.Description
      data-slot="dialog-description"
      className={cn(
        "text-sm text-muted-foreground *:[a]:underline *:[a]:underline-offset-3 *:[a]:hover:text-foreground",
        className
      )}
      {...props}
    />
  )
}

export {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogOverlay,
  DialogPortal,
  DialogTitle,
  DialogTrigger,
}
