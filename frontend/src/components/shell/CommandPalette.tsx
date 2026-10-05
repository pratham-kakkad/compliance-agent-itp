import { useEffect, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Command } from "cmdk";
import { CornerDownLeft, Earth, LogOut, MoonStar, Search, Sparkles, Sun, UploadCloud } from "lucide-react";
import { useAuth } from "../../auth/AuthContext";
import { useTheme } from "../../lib/useTheme";
import { usePersonModal } from "../PersonModal";
import { Avatar, Kbd } from "../ui";
import { ALL_NAV } from "./nav";
import { useVisibleNav } from "./useVisibleNav";

function isEditable(el: EventTarget | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  return el.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(el.tagName);
}

export const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

let openPalette: () => void = () => {};
export function showCommandPalette() {
  openPalette();
}

const itemCls =
  "flex items-center gap-3 h-9 px-3 mx-1.5 rounded-md text-sm text-ink cursor-pointer select-none data-[selected=true]:bg-panel2 transition-colors duration-75";
const groupCls =
  "[&_[cmdk-group-heading]]:px-4 [&_[cmdk-group-heading]]:pt-3 [&_[cmdk-group-heading]]:pb-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-ink2";

export function CommandPalette() {
  const [open, setOpen] = useState(false);
  const navigate = useNavigate();
  const { directory, logout } = useAuth();
  const { theme, toggle } = useTheme();
  const openPerson = usePersonModal();
  const pages = useVisibleNav(ALL_NAV);

  useEffect(() => {
    openPalette = () => setOpen(true);
    const onKey = (e: KeyboardEvent) => {
      if ((e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setOpen((o) => !o);
      } else if (e.key === "/" && !isEditable(e.target) && !e.metaKey && !e.ctrlKey) {
        e.preventDefault();
        setOpen(true);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };

  return (
    <Command.Dialog
      open={open}
      onOpenChange={setOpen}
      label="Command palette"
      overlayClassName="mc-scrim fixed inset-0 z-[60] bg-[var(--scrim)]"
      contentClassName="mc-dialog fixed inset-x-0 mx-auto top-[12vh] z-[61] w-[640px] max-w-[calc(100vw-24px)] rounded-xl border border-line bg-panel shadow-lg overflow-hidden"
    >
      <div className="flex items-center gap-3 px-4 border-b border-line">
        <Search size={16} className="text-ink3 flex-none" aria-hidden />
        <Command.Input
          autoFocus
          placeholder="Search pages, people and actions…"
          className="flex-1 h-12 bg-transparent text-[15px] text-ink placeholder:text-ink3 outline-none focus-visible:outline-none"
        />
        <Kbd>Esc</Kbd>
      </div>
      <Command.List className="max-h-[min(60vh,380px)] overflow-y-auto pb-2 scroll-py-2">
        <Command.Empty className="py-10 text-center text-sm text-ink2">No results found.</Command.Empty>
        <Command.Group heading="Pages" className={groupCls}>
          {pages.flatMap((s) => s.items).map((item) => (
            <Command.Item key={item.to} value={`page ${item.label} ${item.to}`} onSelect={() => run(() => navigate(item.to))} className={itemCls}>
              <item.icon size={16} className="text-ink2" aria-hidden />
              <span className="flex-1">{item.label}</span>
              <span className="text-xs text-ink3">{(() => { const s = pages.find((x) => x.items.includes(item)); return s?.label ?? s?.paletteLabel ?? "Overview"; })()}</span>
            </Command.Item>
          ))}
        </Command.Group>
        {directory.length > 0 && (
          <Command.Group heading="People" className={groupCls}>
            {directory.map((p) => (
              <Command.Item key={p.email} value={`person ${p.name} ${p.email} ${p.title}`} onSelect={() => run(() => openPerson(p.email))} className={itemCls}>
                <Avatar name={p.name} size={20} />
                <span className="flex-1 truncate">{p.name}</span>
                <span className="text-xs text-ink3 truncate max-w-[45%]">{p.title}</span>
              </Command.Item>
            ))}
          </Command.Group>
        )}
        <Command.Group heading="Actions" className={groupCls}>
          <Command.Item value="action toggle theme dark light mode" onSelect={() => run(toggle)} className={itemCls}>
            {theme === "dark" ? <Sun size={16} className="text-ink2" /> : <MoonStar size={16} className="text-ink2" />}
            <span className="flex-1">Switch to {theme === "dark" ? "light" : "dark"} theme</span>
          </Command.Item>
          <Command.Item value="action ask assistant chat" onSelect={() => run(() => navigate("/assistant"))} className={itemCls}>
            <Sparkles size={16} className="text-ink2" />
            <span className="flex-1">Ask the assistant</span>
          </Command.Item>
          <Command.Item value="action import punch logs upload" onSelect={() => run(() => navigate("/attendance/import"))} className={itemCls}>
            <UploadCloud size={16} className="text-ink2" />
            <span className="flex-1">Import punch logs</span>
          </Command.Item>
          <Command.Item value="action change time zone timezone settings" onSelect={() => run(() => navigate("/settings"))} className={itemCls}>
            <Earth size={16} className="text-ink2" />
            <span className="flex-1">Change time zone</span>
          </Command.Item>
          <Command.Item value="action sign out logout" onSelect={() => run(() => logout())} className={itemCls}>
            <LogOut size={16} className="text-ink2" />
            <span className="flex-1">Sign out</span>
          </Command.Item>
        </Command.Group>
      </Command.List>
      <div className="flex items-center gap-4 px-4 h-10 border-t border-line bg-panel2 text-xs text-ink2">
        <span className="flex items-center gap-1.5"><Kbd>↑</Kbd><Kbd>↓</Kbd> to navigate</span>
        <span className="flex items-center gap-1.5"><Kbd><CornerDownLeft size={11} /></Kbd> to select</span>
        <span className="flex items-center gap-1.5"><Kbd>Esc</Kbd> to close</span>
      </div>
    </Command.Dialog>
  );
}
