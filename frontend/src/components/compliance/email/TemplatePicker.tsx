import { useMemo } from "react";
import { ChevronDown, FilePenLine } from "lucide-react";
import { KIND_ORDER, type EmailTemplate } from "../../../lib/emailTemplates";
import { Menu } from "../../ui";
import { KindChip } from "./KindChip";

/** Picks a template, grouped by kind, each with its coloured kind chip. `null` means "write my own". */
export function TemplatePicker({
  templates,
  value,
  onChange,
  id,
}: {
  templates: EmailTemplate[];
  value: string | null;
  onChange: (id: string | null) => void;
  id?: string;
}) {
  const selected = templates.find((t) => t.id === value) ?? null;
  const groups = useMemo(
    () =>
      KIND_ORDER.map((kind) => ({ kind, items: templates.filter((t) => t.kind === kind) })).filter((g) => g.items.length > 0),
    [templates]
  );

  return (
    <Menu.Root>
      <Menu.Trigger asChild>
        <button
          id={id}
          type="button"
          aria-label={selected ? `Template: ${selected.name}` : "Choose a template"}
          className="field h-9 w-full px-3 flex items-center gap-2 text-left text-sm cursor-pointer"
        >
          {selected ? (
            <>
              <span className="font-medium text-ink truncate">{selected.name}</span>
              <KindChip kind={selected.kind} size="sm" />
            </>
          ) : (
            <span className="flex items-center gap-2 text-ink2">
              <FilePenLine size={15} aria-hidden /> Write my own message
            </span>
          )}
          <ChevronDown size={16} className="ml-auto text-ink2 flex-none" aria-hidden />
        </button>
      </Menu.Trigger>
      <Menu.Content align="start" className="w-[min(420px,92vw)] max-h-[min(420px,60vh)] overflow-y-auto">
        <Menu.Item onSelect={() => onChange(null)}>
          <FilePenLine size={14} aria-hidden /> Write my own message
        </Menu.Item>
        {groups.map((g) => (
          <Menu.Group key={g.kind}>
            <Menu.Separator />
            <div className="px-2 pt-1 pb-1">
              <KindChip kind={g.kind} size="sm" />
            </div>
            {g.items.map((t) => (
              <Menu.Item key={t.id} onSelect={() => onChange(t.id)} className="!h-auto py-1.5 items-start">
                <span className="min-w-0">
                  <span className="block text-sm text-ink font-medium">{t.name}</span>
                  {t.description && <span className="block text-xs text-ink2 whitespace-normal leading-4">{t.description}</span>}
                </span>
              </Menu.Item>
            ))}
          </Menu.Group>
        ))}
      </Menu.Content>
    </Menu.Root>
  );
}
