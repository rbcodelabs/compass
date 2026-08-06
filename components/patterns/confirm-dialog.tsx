import type { ReactNode } from "react";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle, AlertDialogTrigger } from "@/components/ui/alert-dialog";

export function ConfirmDialog({ trigger, title, description, confirmLabel = "Confirm", cancelLabel = "Cancel", destructive = false, onConfirm }: { trigger: ReactNode; title: ReactNode; description: ReactNode; confirmLabel?: string; cancelLabel?: string; destructive?: boolean; onConfirm: () => void }) {
  return <AlertDialog><AlertDialogTrigger render={trigger as React.ReactElement} /><AlertDialogContent><AlertDialogHeader><AlertDialogTitle>{title}</AlertDialogTitle><AlertDialogDescription>{description}</AlertDialogDescription></AlertDialogHeader><AlertDialogFooter><AlertDialogCancel>{cancelLabel}</AlertDialogCancel><AlertDialogAction variant={destructive ? "destructive" : "default"} onClick={onConfirm}>{confirmLabel}</AlertDialogAction></AlertDialogFooter></AlertDialogContent></AlertDialog>;
}
