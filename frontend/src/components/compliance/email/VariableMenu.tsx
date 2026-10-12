import { useMemo } from "react";
import { Braces } from "lucide-react";
import type { EmailVariable } from "../../../lib/emailTemplates";
import { Button, Menu } from "../../ui";

/** "Insert variable": a menu of {{variables}} grouped by what they describe; picking one calls `onInsert("{{name}}")`. */
export function InsertVariableMenu({
  variables,
  onInsert,
  onClosed,
  size = "sm",
}: {
  variables: EmailVariable[];
  onInsert: (token: string) => void;
  /** Runs when the menu closes, so the caller can put the focus back in the field. */
  onClosed?: () => void;
  size?: "sm" | "md";
}) {
  const groups = useMemo(() => {
    const m = new Map<string, EmailVariable[]>();
    for (const v of variables) m.set(v.group, [...(m.get(v.group) ?? []), v]);
    return Array.from(m);
  }, [variables]);

  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <Button size={size} leadingIcon={Braces} disabled={variables.length === 0}>
          Insert variable
        </Button>
      </Menu.Trigger>
      <Menu.Content
        align="end"
        className="w-[min(360px,92vw)] max-h-[min(380px,60vh)] overflow-y-auto"
        onCloseAutoFocus={(e) => {
          e.preventDefault();
          onClosed?.();
        }}
      >
        {groups.map(([group, vars], i) => (
          <Menu.Group key={group}>
            {i > 0 && <Menu.Separator />}
            <Menu.Label>{group}</Menu.Label>
            {vars.map((v) => (
              <Menu.Item key={v.name} onSelect={() => onInsert(v.token)} className="!h-auto py-1.5 items-start" title={v.description}>
                <span className="flex-1 min-w-0">
                  <span className="block text-sm text-ink">{v.label}</span>
                  <span className="block text-xs text-ink2 truncate">e.g. {v.example.split("\n")[0]}</span>
                </span>
                <code className="text-[11px] text-ink2 bg-panel2 border border-line rounded px-1.5 py-0.5 flex-none mt-0.5">{v.token}</code>
              </Menu.Item>
            ))}
          </Menu.Group>
        ))}
      </Menu.Content>
    </Menu.Root>
  );
}
