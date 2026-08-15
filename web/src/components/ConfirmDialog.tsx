import type { ReactNode } from "react";
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from "@mui/material";
import type { SxProps, Theme } from "@mui/material/styles";

interface ConfirmDialogProps {
  open: boolean;
  title: string;
  description?: string;
  children?: ReactNode;
  cancelLabel?: string;
  confirmLabel?: string;
  confirmColor?: "error" | "warning";
  onCancel: () => void;
  onConfirm: () => void;
  extraAction?: ReactNode;
  sx?: SxProps<Theme>;
  maxWidth?: false | "xs" | "sm" | "md" | "lg" | "xl";
  fullWidth?: boolean;
}

export function ConfirmDialog({
  open,
  title,
  description,
  children,
  cancelLabel = "cancel",
  confirmLabel = "confirm",
  confirmColor = "error",
  onCancel,
  onConfirm,
  extraAction,
  sx,
  maxWidth,
  fullWidth,
}: ConfirmDialogProps) {
  return (
    <Dialog
      open={open}
      onClose={onCancel}
      sx={sx}
      maxWidth={maxWidth}
      fullWidth={fullWidth}
    >
      <DialogTitle>{title}</DialogTitle>
      <DialogContent>
        {description && <DialogContentText>{description}</DialogContentText>}
        {children}
      </DialogContent>
      <DialogActions>
        {extraAction}
        <Button onClick={onCancel}>{cancelLabel}</Button>
        <Button variant="contained" color={confirmColor} onClick={onConfirm}>
          {confirmLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
