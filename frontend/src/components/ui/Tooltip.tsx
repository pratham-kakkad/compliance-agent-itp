import * as RT from "@radix-ui/react-tooltip";

export function TooltipProvider({ children }: { children: React.ReactNode }) {
  return (
    <RT.Provider delayDuration={400} skipDelayDuration={300}>
      {children}
    </RT.Provider>
  );
}

export function Tooltip({
  content,
  children,
  side = "top",
  delay,
  disabled,
}: {
  content: React.ReactNode;
  children: React.ReactElement;
  side?: "top" | "right" | "bottom" | "left";
  delay?: number;
  disabled?: boolean;
}) {
  if (disabled || !content) return children;
  return (
    <RT.Provider delayDuration={delay ?? 400} skipDelayDuration={300}>
      <RT.Root>
        <RT.Trigger asChild>{children}</RT.Trigger>
        <RT.Portal>
          <RT.Content
            side={side}
            sideOffset={6}
            collisionPadding={8}
            className="mc-tooltip z-[100] max-w-[280px] rounded-md px-2 py-1 text-xs font-medium shadow-md"
            style={{ background: "var(--tooltip-bg)", color: "var(--tooltip-fg)" }}
          >
            {content}
          </RT.Content>
        </RT.Portal>
      </RT.Root>
    </RT.Provider>
  );
}
