import { useState } from "react";
import clsx from "clsx";
import { SegmentedControl } from "../../ui";

/**
 * The e-mail as the person receives it (HTML) or as plain text. The HTML goes in a sandboxed iframe with no
 * scripts and no access to the app, and always shows on the light mail background, like a real inbox would.
 */
export function PreviewFrame({
  subject,
  html,
  text,
  heightClass = "h-[420px]",
  className,
}: {
  subject?: string;
  html: string;
  text: string;
  /** Tailwind height classes for the frame, e.g. "h-[360px] lg:h-[560px]". */
  heightClass?: string;
  className?: string;
}) {
  const [mode, setMode] = useState<"html" | "text">("html");
  return (
    <div className={clsx("flex flex-col gap-2 min-w-0", className)}>
      <div className="flex items-center justify-between gap-2 flex-wrap">
        {subject !== undefined ? (
          <p className="text-[13px] min-w-0 truncate" title={subject}>
            <span className="text-ink2">Subject: </span>
            <span className="font-semibold text-ink">{subject || "(no subject)"}</span>
          </p>
        ) : (
          <span />
        )}
        <SegmentedControl<"html" | "text">
          aria-label="Preview format"
          size="sm"
          value={mode}
          onChange={setMode}
          options={[
            { value: "html", label: "E-mail" },
            { value: "text", label: "Plain text" },
          ]}
        />
      </div>
      {mode === "html" ? (
        <iframe
          title="E-mail preview"
          sandbox=""
          srcDoc={html}
          className={clsx("w-full rounded-lg border border-line bg-white", heightClass)}
        />
      ) : (
        <pre
          className={clsx("w-full overflow-auto rounded-lg border border-line bg-panel2 p-3 text-[13px] leading-5 text-ink whitespace-pre-wrap font-mono", heightClass)}
        >
          {text}
        </pre>
      )}
    </div>
  );
}
