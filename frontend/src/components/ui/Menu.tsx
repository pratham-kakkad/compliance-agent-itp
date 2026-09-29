import { forwardRef } from "react";
import clsx from "clsx";
import * as DM from "@radix-ui/react-dropdown-menu";
import * as HC from "@radix-ui/react-hover-card";
import { Check } from "lucide-react";

const Content = forwardRef<HTMLDivElement, DM.DropdownMenuContentProps>(function Content({ className, sideOffset = 6, align = "end", ...rest }, ref) {
  return (
    <DM.Portal>
      <DM.Content
        ref={ref}
        sideOffset={sideOffset}
        align={align}
        collisionPadding={8}
        className={clsx("mc-pop z-[80] min-w-[220px] rounded-xl border border-line bg-panel p-1.5 shadow-md", className)}
        {...rest}
      />
    </DM.Portal>
  );
});

const Item = forwardRef<HTMLDivElement, DM.DropdownMenuItemProps & { danger?: boolean }>(function Item({ className, danger, ...rest }, ref) {
  return (
    <DM.Item
      ref={ref}
      className={clsx(
        "flex items-center gap-2 h-8 px-2 rounded-md text-sm cursor-pointer outline-none select-none",
        "data-[highlighted]:bg-panel2 data-[disabled]:opacity-50",
        danger ? "text-crit" : "text-ink",
        className
      )}
      {...rest}
    />
  );
});

const RadioItem = forwardRef<HTMLDivElement, DM.DropdownMenuRadioItemProps>(function RadioItem({ className, children, ...rest }, ref) {
  return (
    <DM.RadioItem
      ref={ref}
      className={clsx("flex items-center gap-2 h-8 pl-7 pr-2 rounded-md text-sm text-ink cursor-pointer outline-none relative data-[highlighted]:bg-panel2", className)}
      {...rest}
    >
      <DM.ItemIndicator className="absolute left-2 flex items-center">
        <Check size={14} />
      </DM.ItemIndicator>
      {children}
    </DM.RadioItem>
  );
});

function MenuLabel({ className, ...rest }: DM.DropdownMenuLabelProps) {
  return <DM.Label className={clsx("px-2 pt-1.5 pb-1 text-xs font-semibold text-ink2", className)} {...rest} />;
}

function Separator({ className, ...rest }: DM.DropdownMenuSeparatorProps) {
  return <DM.Separator className={clsx("my-1.5 h-px bg-line-soft -mx-1.5", className)} {...rest} />;
}

export const Menu = {
  Root: DM.Root,
  Trigger: DM.Trigger,
  Content,
  Item,
  RadioGroup: DM.RadioGroup,
  RadioItem,
  Label: MenuLabel,
  Separator,
  Group: DM.Group,
};

function HCContent({ className, sideOffset = 8, ...rest }: HC.HoverCardContentProps) {
  return (
    <HC.Portal>
      <HC.Content
        sideOffset={sideOffset}
        collisionPadding={8}
        className={clsx("mc-pop z-[80] w-72 rounded-xl border border-line bg-panel p-4 shadow-md", className)}
        {...rest}
      />
    </HC.Portal>
  );
}

function HCRoot(props: HC.HoverCardProps) {
  return <HC.Root openDelay={500} closeDelay={100} {...props} />;
}

export const HoverCard = { Root: HCRoot, Trigger: HC.Trigger, Content: HCContent };
