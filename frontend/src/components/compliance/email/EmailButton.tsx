import { useState } from "react";
import { Mail, type LucideIcon } from "lucide-react";
import { useCanEmail, type TemplateKind } from "../../../lib/emailTemplates";
import type { BatchStatus } from "../../../lib/emailTemplates";
import { Button, IconButton, type ButtonVariant } from "../../ui";
import { SendEmailDialog, type EmailTarget } from "./SendEmailDialog";

/**
 * An "Email" action that opens the send dialog. It renders nothing for people who may not e-mail about
 * compliance (the server checks each recipient too). `target` is read when the button is clicked.
 */
export function EmailButton({
  target,
  label = "Email",
  icon: Icon = Mail,
  variant = "secondary",
  size = "md",
  iconOnly,
  disabled,
  className,
  onDone,
}: {
  target: () => EmailTarget;
  label?: string;
  icon?: LucideIcon;
  variant?: ButtonVariant;
  size?: "sm" | "md" | "lg";
  /** A compact icon button (the label becomes its tooltip) for table rows. */
  iconOnly?: boolean;
  disabled?: boolean;
  className?: string;
  onDone?: (b: BatchStatus) => void;
}) {
  const can = useCanEmail();
  const [snap, setSnap] = useState<EmailTarget | null>(null);
  if (!can) return null;
  const go = (e: React.MouseEvent) => {
    e.stopPropagation();
    setSnap(target());
  };
  return (
    <>
      {iconOnly ? (
        <IconButton icon={Icon} label={label} size="sm" disabled={disabled} onClick={go} className={className} />
      ) : (
        <Button variant={variant} size={size} leadingIcon={Icon} disabled={disabled} onClick={go} className={className}>
          {label}
        </Button>
      )}
      {snap && <SendEmailDialog open onOpenChange={(o) => !o && setSnap(null)} target={snap} onDone={onDone} />}
    </>
  );
}

export type { EmailTarget, TemplateKind };
