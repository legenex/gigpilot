"use client";

import type { ReactNode } from "react";
import { Button, Dialog, DialogContent } from "@gigpilot/ui";

/** Confirmation for consequential or terminal actions. Confirm button: data-testid="confirm-action". */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  tone = "secondary",
  loading,
  onConfirm,
  children,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  title: string;
  description?: ReactNode;
  confirmLabel: string;
  tone?: "primary" | "secondary" | "danger";
  loading?: boolean;
  onConfirm: () => void;
  children?: ReactNode;
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size="sm"
        title={title}
        description={description}
        footer={
          <>
            <Button variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button variant={tone} loading={loading} onClick={onConfirm} data-testid="confirm-action">
              {confirmLabel}
            </Button>
          </>
        }
      >
        {children}
      </DialogContent>
    </Dialog>
  );
}
