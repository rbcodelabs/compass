import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";

export function ConfirmDialog({ trigger, title, description, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = false, onConfirm }: { trigger: ReactNode; title: ReactNode; description: ReactNode; confirmLabel?: string; cancelLabel?: string; destructive?: boolean; onConfirm: () => void }) {
  return <Dialog><DialogTrigger render={trigger as React.ReactElement} /><DialogContent><DialogHeader><DialogTitle>{title}</DialogTitle><DialogDescription>{description}</DialogDescription></DialogHeader><DialogFooter><DialogClose render={<Button variant="outline" />}>{cancelLabel}</DialogClose><DialogClose render={<Button variant={destructive ? "destructive" : "default"} onClick={onConfirm} />}>{confirmLabel}</DialogClose></DialogFooter></DialogContent></Dialog>;
}
