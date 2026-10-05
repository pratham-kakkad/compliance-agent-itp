import { useState } from "react";
import { Button } from "../../ui";
import { useOverlay } from "../../Modal";
import { errText } from "../common";

function ConfirmDialog({
  title,
  description,
  confirm,
  cancel,
  tone,
  alternate,
  onConfirm,
}: {
  title: string;
  description?: React.ReactNode;
  confirm: string;
  cancel: string;
  tone: "primary" | "danger";
  /** An extra middle choice (e.g. "Keep my settings"). */
  alternate?: { label: string; onChoose: () => void };
  onConfirm: () => Promise<unknown> | void;
}) {
  const { close } = useOverlay();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function go() {
    setBusy(true);
    setError(null);
    try {
      await onConfirm();
      close();
    } catch (e) {
      setError(errText(e));
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4 pr-6" role="alertdialog" aria-label={title}>
      <div>
        <h2 className="text-lg font-semibold text-ink">{title}</h2>
        {description && <div className="text-sm text-ink2 mt-1.5 leading-[21px]">{description}</div>}
      </div>
      {error && <p className="text-sm text-crit" role="alert">{error}</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button onClick={close} disabled={busy}>{cancel}</Button>
        {alternate && (
          <Button
            onClick={() => {
              alternate.onChoose();
              close();
            }}
            disabled={busy}
          >
            {alternate.label}
          </Button>
        )}
        <Button variant={tone === "danger" ? "danger" : "primary"} loading={busy} onClick={() => void go()} autoFocus>
          {confirm}
        </Button>
      </div>
    </div>
  );
}

export interface ConfirmOptions {
  title: string;
  description?: React.ReactNode;
  confirm: string;
  cancel?: string;
  tone?: "primary" | "danger";
  alternate?: { label: string; onChoose: () => void };
  /** Runs when confirmed; the dialog stays open (showing the message) if it throws. */
  onConfirm: () => Promise<unknown> | void;
}

/** Opens a small "are you sure?" dialog. */
export function useConfirm() {
  const { openModal } = useOverlay();
  return (o: ConfirmOptions) =>
    openModal(
      <ConfirmDialog
        title={o.title}
        description={o.description}
        confirm={o.confirm}
        cancel={o.cancel ?? "Cancel"}
        tone={o.tone ?? "primary"}
        alternate={o.alternate}
        onConfirm={o.onConfirm}
      />
    );
}
