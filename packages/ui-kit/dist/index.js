import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as React3 from 'react';
import { useState, useRef, useEffect, useMemo, useCallback } from 'react';
import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronDown, X, Search, ArrowUp, Check, Copy, Rows3, Rows2, Download, Info, AlertCircle, RefreshCw, Link, Link2, Share2, Clock, Inbox, ExternalLink as ExternalLink$1, List, LayoutGrid, Grid3x3, ChevronUp, Globe, BookOpen, Github, LayoutDashboard, Lock, AlertTriangle } from 'lucide-react';
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';
import { Command as Command$1 } from 'cmdk';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as HoverCardPrimitive from '@radix-ui/react-hover-card';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cva } from 'class-variance-authority';
import { Toaster as Toaster$1, toast } from 'sonner';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';

// src/lib/utils.ts
function cn(...inputs) {
  return twMerge(clsx(...inputs));
}
var Accordion = AccordionPrimitive.Root;
var AccordionItem = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  AccordionPrimitive.Item,
  {
    ref,
    className: cn("border-b", className),
    ...props
  }
));
AccordionItem.displayName = "AccordionItem";
var AccordionTrigger = React3.forwardRef(({ className, children, ...props }, ref) => /* @__PURE__ */ jsx(AccordionPrimitive.Header, { className: "flex", children: /* @__PURE__ */ jsxs(
  AccordionPrimitive.Trigger,
  {
    ref,
    className: cn(
      "flex flex-1 items-center justify-between py-4 text-sm font-medium cursor-pointer transition-all hover:underline text-left [&[data-state=open]>svg]:rotate-180",
      className
    ),
    ...props,
    children: [
      children,
      /* @__PURE__ */ jsx(ChevronDown, { className: "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200" })
    ]
  }
) }));
AccordionTrigger.displayName = AccordionPrimitive.Trigger.displayName;
var AccordionContent = React3.forwardRef(({ className, children, ...props }, ref) => /* @__PURE__ */ jsx(
  AccordionPrimitive.Content,
  {
    ref,
    className: "overflow-hidden text-sm data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down",
    ...props,
    children: /* @__PURE__ */ jsx("div", { className: cn("pb-4 pt-0", className), children })
  }
));
AccordionContent.displayName = AccordionPrimitive.Content.displayName;
var Dialog = DialogPrimitive.Root;
var DialogTrigger = DialogPrimitive.Trigger;
var DialogPortal = DialogPrimitive.Portal;
var DialogClose = DialogPrimitive.Close;
var DialogOverlay = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  DialogPrimitive.Overlay,
  {
    ref,
    className: cn(
      "fixed inset-0 z-50 bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    ),
    ...props
  }
));
DialogOverlay.displayName = DialogPrimitive.Overlay.displayName;
var DialogContent = React3.forwardRef(({ className, children, ...props }, ref) => /* @__PURE__ */ jsxs(DialogPortal, { children: [
  /* @__PURE__ */ jsx(DialogOverlay, {}),
  /* @__PURE__ */ jsxs(
    DialogPrimitive.Content,
    {
      ref,
      className: cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg",
        className
      ),
      ...props,
      children: [
        children,
        /* @__PURE__ */ jsxs(DialogPrimitive.Close, { className: "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background cursor-pointer transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground", children: [
          /* @__PURE__ */ jsx(X, { className: "h-4 w-4" }),
          /* @__PURE__ */ jsx("span", { className: "sr-only", children: "Close" })
        ] })
      ]
    }
  )
] }));
DialogContent.displayName = DialogPrimitive.Content.displayName;
var DialogHeader = ({
  className,
  ...props
}) => /* @__PURE__ */ jsx(
  "div",
  {
    className: cn(
      "flex flex-col space-y-1.5 text-center sm:text-left",
      className
    ),
    ...props
  }
);
DialogHeader.displayName = "DialogHeader";
var DialogFooter = ({
  className,
  ...props
}) => /* @__PURE__ */ jsx(
  "div",
  {
    className: cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    ),
    ...props
  }
);
DialogFooter.displayName = "DialogFooter";
var DialogTitle = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  DialogPrimitive.Title,
  {
    ref,
    className: cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    ),
    ...props
  }
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;
var DialogDescription = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  DialogPrimitive.Description,
  {
    ref,
    className: cn("text-sm text-muted-foreground", className),
    ...props
  }
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
var Command = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  Command$1,
  {
    ref,
    className: cn(
      "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
      className
    ),
    ...props
  }
));
Command.displayName = Command$1.displayName;
var CommandDialog = ({ children, ...props }) => {
  return /* @__PURE__ */ jsx(Dialog, { ...props, children: /* @__PURE__ */ jsx(DialogContent, { className: "overflow-hidden p-0 max-w-[calc(100vw-2rem)] sm:max-w-lg", children: /* @__PURE__ */ jsx(Command, { className: "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5", children }) }) });
};
var CommandInput = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxs("div", { className: "flex items-center border-b px-3", "cmdk-input-wrapper": "", children: [
  /* @__PURE__ */ jsx(Search, { className: "mr-2 h-4 w-4 shrink-0 opacity-50" }),
  /* @__PURE__ */ jsx(
    Command$1.Input,
    {
      ref,
      className: cn(
        "flex h-10 w-full rounded-md bg-transparent py-3 text-sm outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
        className
      ),
      ...props
    }
  )
] }));
CommandInput.displayName = Command$1.Input.displayName;
var CommandList = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  Command$1.List,
  {
    ref,
    className: cn("max-h-[300px] overflow-y-auto overflow-x-hidden", className),
    ...props
  }
));
CommandList.displayName = Command$1.List.displayName;
var CommandEmpty = React3.forwardRef((props, ref) => /* @__PURE__ */ jsx(
  Command$1.Empty,
  {
    ref,
    className: "py-6 text-center text-sm",
    ...props
  }
));
CommandEmpty.displayName = Command$1.Empty.displayName;
var CommandGroup = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  Command$1.Group,
  {
    ref,
    className: cn(
      "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
      className
    ),
    ...props
  }
));
CommandGroup.displayName = Command$1.Group.displayName;
var CommandSeparator = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  Command$1.Separator,
  {
    ref,
    className: cn("-mx-1 h-px bg-border", className),
    ...props
  }
));
CommandSeparator.displayName = Command$1.Separator.displayName;
var CommandItem = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  Command$1.Item,
  {
    ref,
    className: cn(
      "relative flex cursor-default gap-2 select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
      className
    ),
    ...props
  }
));
CommandItem.displayName = Command$1.Item.displayName;
var CommandShortcut = ({
  className,
  ...props
}) => {
  return /* @__PURE__ */ jsx(
    "span",
    {
      className: cn(
        "ml-auto text-xs tracking-widest text-muted-foreground",
        className
      ),
      ...props
    }
  );
};
CommandShortcut.displayName = "CommandShortcut";
var HoverCard = HoverCardPrimitive.Root;
var HoverCardTrigger = HoverCardPrimitive.Trigger;
var HoverCardContent = React3.forwardRef(({ className, align = "center", sideOffset = 4, ...props }, ref) => /* @__PURE__ */ jsx(
  HoverCardPrimitive.Content,
  {
    ref,
    align,
    sideOffset,
    className: cn(
      "z-50 w-64 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-hover-card-content-transform-origin)",
      className
    ),
    ...props
  }
));
HoverCardContent.displayName = HoverCardPrimitive.Content.displayName;
var Popover = PopoverPrimitive.Root;
var PopoverTrigger = PopoverPrimitive.Trigger;
var PopoverAnchor = PopoverPrimitive.Anchor;
var PopoverContent = React3.forwardRef(({ className, align = "center", sideOffset = 4, ...props }, ref) => /* @__PURE__ */ jsx(PopoverPrimitive.Portal, { children: /* @__PURE__ */ jsx(
  PopoverPrimitive.Content,
  {
    ref,
    align,
    sideOffset,
    className: cn(
      "z-50 w-72 rounded-md border bg-popover p-4 text-popover-foreground shadow-md outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-popover-content-transform-origin)",
      className
    ),
    ...props
  }
) }));
PopoverContent.displayName = PopoverPrimitive.Content.displayName;
var Sheet = DialogPrimitive.Root;
var SheetTrigger = DialogPrimitive.Trigger;
var SheetClose = DialogPrimitive.Close;
var SheetPortal = DialogPrimitive.Portal;
var SheetOverlay = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  DialogPrimitive.Overlay,
  {
    className: cn(
      "fixed inset-0 z-50 bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    ),
    ...props,
    ref
  }
));
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName;
var sheetVariants = cva(
  "fixed z-50 gap-4 bg-background p-6 shadow-lg transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out",
  {
    variants: {
      side: {
        top: "inset-x-0 top-0 border-b data-[state=closed]:slide-out-to-top data-[state=open]:slide-in-from-top",
        bottom: "inset-x-0 bottom-0 border-t data-[state=closed]:slide-out-to-bottom data-[state=open]:slide-in-from-bottom",
        left: "inset-y-0 left-0 h-full w-3/4 border-r data-[state=closed]:slide-out-to-left data-[state=open]:slide-in-from-left sm:max-w-sm",
        right: "inset-y-0 right-0 h-full w-3/4 border-l data-[state=closed]:slide-out-to-right data-[state=open]:slide-in-from-right sm:max-w-sm"
      }
    },
    defaultVariants: {
      side: "right"
    }
  }
);
var SheetContent = React3.forwardRef(({ side = "right", className, children, ...props }, ref) => /* @__PURE__ */ jsxs(SheetPortal, { children: [
  /* @__PURE__ */ jsx(SheetOverlay, {}),
  /* @__PURE__ */ jsxs(
    DialogPrimitive.Content,
    {
      ref,
      className: cn(sheetVariants({ side }), className),
      ...props,
      children: [
        /* @__PURE__ */ jsxs(DialogPrimitive.Close, { className: "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background cursor-pointer transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary", children: [
          /* @__PURE__ */ jsx(X, { className: "h-4 w-4" }),
          /* @__PURE__ */ jsx("span", { className: "sr-only", children: "Close" })
        ] }),
        children
      ]
    }
  )
] }));
SheetContent.displayName = DialogPrimitive.Content.displayName;
var SheetHeader = ({
  className,
  ...props
}) => /* @__PURE__ */ jsx(
  "div",
  {
    className: cn(
      "flex flex-col space-y-2 text-center sm:text-left",
      className
    ),
    ...props
  }
);
SheetHeader.displayName = "SheetHeader";
var SheetFooter = ({
  className,
  ...props
}) => /* @__PURE__ */ jsx(
  "div",
  {
    className: cn(
      "flex flex-col-reverse sm:flex-row sm:justify-end sm:space-x-2",
      className
    ),
    ...props
  }
);
SheetFooter.displayName = "SheetFooter";
var SheetTitle = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  DialogPrimitive.Title,
  {
    ref,
    className: cn("text-lg font-semibold text-foreground", className),
    ...props
  }
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;
var SheetDescription = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  DialogPrimitive.Description,
  {
    ref,
    className: cn("text-sm text-muted-foreground", className),
    ...props
  }
));
SheetDescription.displayName = DialogPrimitive.Description.displayName;
var Toaster = ({ ...props }) => {
  return /* @__PURE__ */ jsx(
    Toaster$1,
    {
      className: "toaster group",
      toastOptions: {
        classNames: {
          toast: "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground"
        }
      },
      ...props
    }
  );
};
var TooltipProvider = TooltipPrimitive.Provider;
var Tooltip = TooltipPrimitive.Root;
var TooltipTrigger = TooltipPrimitive.Trigger;
var TooltipContent = React3.forwardRef(({ className, sideOffset = 4, ...props }, ref) => /* @__PURE__ */ jsx(TooltipPrimitive.Portal, { children: /* @__PURE__ */ jsx(
  TooltipPrimitive.Content,
  {
    ref,
    sideOffset,
    className: cn(
      "z-50 overflow-hidden rounded-md bg-primary px-3 py-1.5 text-xs text-primary-foreground animate-in fade-in-0 zoom-in-95 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-tooltip-content-transform-origin)",
      className
    ),
    ...props
  }
) }));
TooltipContent.displayName = TooltipPrimitive.Content.displayName;
function Skeleton({ className = "h-4 w-full" }) {
  return /* @__PURE__ */ jsx("div", { className: `animate-pulse rounded bg-surface-2 ${className}` });
}

// src/lib/format.ts
function classNames(...parts) {
  return parts.filter(Boolean).join(" ");
}
function isUsableTimestamp(iso) {
  if (!iso) return false;
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return false;
  return t > 9466848e5;
}
function formatRelative(iso) {
  if (!isUsableTimestamp(iso)) return "\u2014";
  const t = Date.parse(iso);
  const diff = Date.now() - t;
  const abs = Math.abs(diff);
  const past = diff >= 0;
  let value;
  let unit;
  if (abs < 6e4) {
    value = Math.max(1, Math.round(abs / 1e3));
    unit = "s";
  } else if (abs < 36e5) {
    value = Math.round(abs / 6e4);
    unit = "m";
  } else if (abs < 864e5) {
    value = Math.round(abs / 36e5);
    unit = "h";
  } else {
    value = Math.round(abs / 864e5);
    unit = "d";
  }
  return past ? `${value}${unit} ago` : `in ${value}${unit}`;
}
function isStaleFreshness(iso, thresholdMs = 12 * 60 * 6e4) {
  if (!isUsableTimestamp(iso)) return true;
  return Date.now() - Date.parse(iso) > thresholdMs;
}
function formatFreshness(updatedAt, windowLabel) {
  const parts = [];
  if (updatedAt) {
    const t = new Date(updatedAt);
    if (!Number.isNaN(t.getTime())) {
      const diffMs = Date.now() - t.getTime();
      parts.push(`updated ${relative(diffMs)}`);
    }
  }
  if (windowLabel) parts.push(`${windowLabel} window`);
  return parts.length ? parts.join(" \xB7 ") : null;
}
function formatFreshnessAbsolute(updatedAt) {
  if (!updatedAt) return null;
  const t = new Date(updatedAt);
  if (Number.isNaN(t.getTime())) return null;
  return t.toLocaleString();
}
function relative(diffMs) {
  const sec = Math.max(0, Math.round(diffMs / 1e3));
  if (sec < 60) return `${sec}s ago`;
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 48) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  return `${day}d ago`;
}
function AccentBand({
  children,
  pattern = false,
  className,
  innerClassName
}) {
  return /* @__PURE__ */ jsxs(
    "section",
    {
      className: classNames(
        // Full-bleed without using 100vw — escape the <main> padding only.
        // `-mx-4 md:-mx-10` matches AppShell's <main> padding so the band
        // reaches the viewport edges without ever exceeding document width.
        "mg-accent-band relative -mx-4 md:-mx-10",
        className
      ),
      children: [
        pattern ? /* @__PURE__ */ jsx(
          "div",
          {
            className: "mg-dot-grid absolute inset-0 opacity-40 pointer-events-none",
            "aria-hidden": true
          }
        ) : null,
        /* @__PURE__ */ jsx(
          "div",
          {
            className: classNames(
              "relative max-w-shell-max mx-auto px-4 md:px-8 py-14 md:py-20",
              innerClassName
            ),
            children
          }
        )
      ]
    }
  );
}
var defaultFormat = (n) => new Intl.NumberFormat("en-US").format(Math.round(n));
function prefersReducedMotion() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;
}
function AnimatedNumber({
  value,
  format = defaultFormat,
  fallback = "\u2014",
  duration = 600,
  flashOnChange = true,
  className
}) {
  const safe = typeof value === "number" && Number.isFinite(value) ? value : null;
  const [display, setDisplay] = useState(safe);
  const [flash, setFlash] = useState("");
  const fromRef = useRef(safe);
  const rafRef = useRef(null);
  useEffect(() => {
    if (safe === null) {
      setDisplay(null);
      fromRef.current = null;
      return;
    }
    const from = fromRef.current;
    if (from === null || prefersReducedMotion() || from === safe) {
      setDisplay(safe);
      fromRef.current = safe;
      return;
    }
    if (flashOnChange) {
      setFlash(safe > from ? "mg-flash-up" : "mg-flash-down");
      window.setTimeout(() => setFlash(""), 720);
    }
    const start = performance.now();
    const delta = safe - from;
    const step = (now) => {
      const t = Math.min(1, (now - start) / duration);
      const eased = 1 - Math.pow(1 - t, 3);
      setDisplay(from + delta * eased);
      if (t < 1) rafRef.current = requestAnimationFrame(step);
      else fromRef.current = safe;
    };
    rafRef.current = requestAnimationFrame(step);
    return () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
  }, [safe, duration, flashOnChange]);
  return /* @__PURE__ */ jsx(
    "span",
    {
      className: classNames(
        "tabular-nums inline-block px-0.5",
        flash,
        className
      ),
      children: display === null ? fallback : format(display)
    }
  );
}
function BackToTop({ threshold = 600 }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onScroll() {
      setVisible(window.scrollY > threshold);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  const onClick = () => {
    if (typeof window === "undefined") return;
    const reduced = window.matchMedia?.(
      "(prefers-reduced-motion: reduce)"
    )?.matches;
    window.scrollTo({ top: 0, left: 0, behavior: reduced ? "auto" : "smooth" });
    const main = document.querySelector("main");
    if (main) {
      const hadTabIndex = main.hasAttribute("tabindex");
      if (!hadTabIndex) main.setAttribute("tabindex", "-1");
      main.focus({ preventScroll: true });
      if (!hadTabIndex) {
        setTimeout(() => main.removeAttribute("tabindex"), 0);
      }
    }
  };
  return /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      onClick,
      "aria-label": "Back to top",
      "aria-hidden": !visible,
      tabIndex: visible ? 0 : -1,
      className: classNames(
        "fixed z-40 bottom-5 right-5 md:bottom-7 md:right-7",
        "inline-flex items-center gap-1.5 rounded-full border border-border bg-card/95 backdrop-blur",
        "px-3 py-2 text-[11px] font-mono uppercase tracking-widest text-ink-strong",
        "shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)] hover:border-accent/60 hover:text-accent",
        "transition-[opacity,transform,border-color,color] duration-200",
        visible ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 translate-y-2 pointer-events-none"
      ),
      children: [
        /* @__PURE__ */ jsx(ArrowUp, { className: "size-3.5" }),
        /* @__PURE__ */ jsx("span", { className: "hidden sm:inline", children: "Top" })
      ]
    }
  );
}
var THEME_STORAGE_KEY = "mg-theme";
function normalizeThemeChoice(value) {
  return value === "light" || value === "dark" || value === "system" ? value : "system";
}
function resolveTheme(choice, prefersDark) {
  return choice === "system" ? prefersDark ? "dark" : "light" : choice;
}
function systemPrefersDark() {
  if (typeof window === "undefined") return false;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ?? false;
}
function readChoice() {
  if (typeof window === "undefined") return "system";
  try {
    return normalizeThemeChoice(window.localStorage.getItem(THEME_STORAGE_KEY));
  } catch {
    return "system";
  }
}
function apply(choice) {
  if (typeof document === "undefined") return "light";
  const resolved = resolveTheme(choice, systemPrefersDark());
  const root = document.documentElement;
  root.classList.toggle("dark", resolved === "dark");
  root.dataset.theme = resolved;
  return resolved;
}
function useTheme() {
  const [choice, setChoiceState] = useState(() => readChoice());
  const [resolved, setResolved] = useState("light");
  useEffect(() => {
    setResolved(apply(choice));
    if (choice !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(apply("system"));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);
  const setChoice = useCallback((next) => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.add("theme-transition");
      window.setTimeout(
        () => document.documentElement.classList.remove("theme-transition"),
        220
      );
    }
    try {
      window.localStorage.setItem(THEME_STORAGE_KEY, next);
    } catch {
    }
    setChoiceState(next);
  }, []);
  return { choice, resolved, setChoice };
}

// src/components/metagraphed/brand-overrides.ts
var viteEnv = import.meta.env;
var ICON_PROXY_URL = viteEnv?.VITE_ICON_PROXY_URL?.trim() || "https://api.metagraph.sh/api/v1/icon";
var BLOCKED_PROXY_TLDS = /* @__PURE__ */ new Set(["localhost", "local", "internal"]);
function isIpLiteral(host2) {
  if (host2.startsWith("[") && host2.endsWith("]")) return true;
  if (host2.includes(":")) return true;
  const parts = host2.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) return false;
  return parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}
function normalizePublicProxyHost(host2) {
  const normalized = String(host2 ?? "").trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
  if (!normalized || normalized.length > 253) return null;
  if (isIpLiteral(normalized)) return null;
  const labels = normalized.split(".");
  if (labels.length < 2) return null;
  const tld = labels[labels.length - 1];
  if (!tld || BLOCKED_PROXY_TLDS.has(tld)) return null;
  const ok = labels.every(
    (l) => l.length > 0 && l.length <= 63 && /^[a-z0-9-]+$/.test(l) && !l.startsWith("-") && !l.endsWith("-")
  );
  return ok ? normalized : null;
}
function buildProxyIconUrl(host2, size, theme = "light") {
  const safeHost = normalizePublicProxyHost(host2);
  if (!safeHost) return null;
  const u = new URL(ICON_PROXY_URL);
  u.searchParams.set("host", safeHost);
  u.searchParams.set("size", String(size));
  u.searchParams.set("theme", theme);
  return u.toString();
}
function pickIconSource(src, theme) {
  if (!src) return null;
  if (typeof src === "string") return src;
  if (theme === "dark" && src.dark) return src.dark;
  return src.light;
}
var PROVIDER_ICONS = {
  // Subnet teams with strong GH org presence
  bitmind: "https://github.com/BitMind-AI.png?size=192",
  chutes: "https://github.com/chutesai.png?size=192",
  "compute-horde": "https://github.com/backend-developers-ltd.png?size=192",
  desearch: "https://github.com/Desearch-ai.png?size=192",
  macrocosmos: "https://github.com/macrocosm-os.png?size=192",
  taostats: {
    light: "https://github.com/taostats.png?size=192",
    dark: "https://github.com/taostats.png?size=192"
  },
  tensorplex: "https://github.com/tensorplex-labs.png?size=192",
  datura: "https://github.com/Datura-ai.png?size=192",
  nineteen: "https://github.com/namoray.png?size=192",
  corcel: "https://github.com/corcel-api.png?size=192",
  targon: "https://github.com/manifold-inc.png?size=192",
  manifold: "https://github.com/manifold-inc.png?size=192",
  "cortex-t": "https://github.com/corcel-api.png?size=192",
  allways: "https://github.com/allways-ai.png?size=192",
  gittensor: "https://github.com/eden-network.png?size=192",
  bitads: "https://github.com/FirstTensorLabs.png?size=192",
  academia: "https://github.com/fx-integral.png?size=192",
  adtao: "https://github.com/ippcteam.png?size=192",
  bitrecs: "https://github.com/bitrecs.png?size=192",
  cacheon: "https://github.com/latent-to.png?size=192",
  chipforge: "https://github.com/TatsuProject.png?size=192",
  coldint: "https://github.com/coldint.png?size=192",
  compelle: "https://github.com/compelle.png?size=192",
  connito: "https://github.com/Connito-AI.png?size=192",
  djinn: "https://github.com/Djinn-Inc.png?size=192",
  // Infra / data providers
  dwellir: "https://github.com/Dwellir.png?size=192",
  blockmachine: "https://github.com/blockmachine-io.png?size=192",
  "opentensor-foundation": "https://github.com/opentensor.png?size=192",
  opentensor: "https://github.com/opentensor.png?size=192",
  bittensor: "https://github.com/opentensor.png?size=192"
};
var SUBNET_ICONS_BY_NETUID = {
  "0": "https://github.com/opentensor.png?size=192"
};
var SUBNET_ICONS_BY_SLUG = {};
function normaliseKey(value) {
  if (value === null || value === void 0) return null;
  const str = String(value).trim().toLowerCase();
  return str || null;
}
function resolveBrandOverride(lookup, theme = "light") {
  const providerKey = normaliseKey(lookup.providerSlug);
  if (providerKey && PROVIDER_ICONS[providerKey]) {
    return pickIconSource(PROVIDER_ICONS[providerKey], theme);
  }
  const netuidKey = normaliseKey(lookup.netuid);
  if (netuidKey && SUBNET_ICONS_BY_NETUID[netuidKey]) {
    return pickIconSource(SUBNET_ICONS_BY_NETUID[netuidKey], theme);
  }
  const subnetKey = normaliseKey(lookup.subnetSlug);
  if (subnetKey && SUBNET_ICONS_BY_SLUG[subnetKey]) {
    return pickIconSource(SUBNET_ICONS_BY_SLUG[subnetKey], theme);
  }
  if (subnetKey && PROVIDER_ICONS[subnetKey]) {
    return pickIconSource(PROVIDER_ICONS[subnetKey], theme);
  }
  return null;
}
function isProxiedIcon(candidate) {
  return Boolean(
    candidate && ICON_PROXY_URL && candidate.startsWith(ICON_PROXY_URL)
  );
}
var failedUrls = /* @__PURE__ */ new Set();
var loadedUrls = /* @__PURE__ */ new Set();
var prefetched = /* @__PURE__ */ new Set();
var winnerByHost = /* @__PURE__ */ new Map();
var isDarkLogo = /* @__PURE__ */ new Map();
function extractHost(input) {
  if (!input) return null;
  const raw = String(input).trim();
  if (!raw) return null;
  try {
    const u = new URL(raw.includes("://") ? raw : `https://${raw}`);
    return u.hostname.replace(/^www\./, "") || null;
  } catch {
    return null;
  }
}
function githubOrgFromUrl(input) {
  if (!input) return null;
  try {
    const u = new URL(input.includes("://") ? input : `https://${input}`);
    const host2 = u.hostname.toLowerCase();
    if (host2 !== "github.com" && !host2.endsWith(".github.com")) return null;
    const seg = u.pathname.split("/").filter(Boolean);
    return seg[0] ?? null;
  } catch {
    return null;
  }
}
function githubAvatarUrl(org, size = 192) {
  return `https://github.com/${encodeURIComponent(org)}.png?size=${size}`;
}
var LOCAL_HOSTNAMES = /* @__PURE__ */ new Set(["localhost", "localhost.localdomain"]);
function normaliseImageHostname(hostname) {
  return hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
}
function isBlockedIpv4(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : null;
  });
  if (octets.some((v) => v === null)) return false;
  const [a, b] = octets;
  return a === 0 || a === 10 || a === 127 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 0 || a === 192 && b === 168 || a === 198 && (b === 18 || b === 19) || a === 198 && b === 51 && octets[2] === 100 || a === 203 && b === 0 && octets[2] === 113 || a >= 224;
}
function isBlockedIpv6(hostname) {
  if (!hostname.includes(":")) return false;
  return hostname === "" || hostname === "::" || hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe8") || hostname.startsWith("fe9") || hostname.startsWith("fea") || hostname.startsWith("feb") || hostname.startsWith("ff") || hostname.startsWith("::ffff:");
}
function safeImageUrl(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:")
      return null;
    if (parsed.username || parsed.password) return null;
    const hostname = normaliseImageHostname(parsed.hostname);
    if (!hostname) return null;
    if (LOCAL_HOSTNAMES.has(hostname)) return null;
    if (hostname.endsWith(".localhost") || hostname.endsWith(".local"))
      return null;
    if (isBlockedIpv4(hostname) || isBlockedIpv6(hostname)) return null;
    return parsed.toString();
  } catch {
    return null;
  }
}
function isDirectIconUrlCandidate(candidate, iconUrl, theme) {
  if (!candidate) return false;
  const directIcon = safeImageUrl(pickIconSource(iconUrl, theme));
  return Boolean(
    directIcon && candidate === directIcon && !isProxiedIcon(candidate)
  );
}
function shouldUseAnonymousCors(candidate, iconUrl, theme) {
  return isProxiedIcon(candidate) || isDirectIconUrlCandidate(candidate, iconUrl, theme);
}
function buildCandidateChain({
  url,
  iconUrl,
  repoUrl,
  lookup,
  theme,
  size
}) {
  const out = [];
  const push = (u) => {
    const safe = safeImageUrl(u);
    if (!safe) return;
    if (failedUrls.has(safe)) return;
    if (!out.includes(safe)) out.push(safe);
  };
  push(pickIconSource(iconUrl, theme));
  if (lookup) push(resolveBrandOverride(lookup, theme));
  const host2 = extractHost(url);
  if (host2) push(buildProxyIconUrl(host2, size * 2, theme));
  const repoOrg = githubOrgFromUrl(repoUrl);
  if (repoOrg) push(githubAvatarUrl(repoOrg, 192));
  return out;
}
function prefetchBrandIcon(url, size = 32, extra) {
  if (typeof window === "undefined") return;
  const chain = buildCandidateChain({
    url,
    iconUrl: extra?.iconUrl,
    repoUrl: extra?.repoUrl,
    lookup: extra?.lookup,
    theme: extra?.theme ?? "light",
    size
  });
  const first = chain[0];
  if (!first) return;
  if (prefetched.has(first) || failedUrls.has(first) || loadedUrls.has(first))
    return;
  prefetched.add(first);
  try {
    const img = new Image();
    img.decoding = "async";
    img.referrerPolicy = "no-referrer";
    if (shouldUseAnonymousCors(first, extra?.iconUrl, extra?.theme ?? "light")) {
      img.crossOrigin = "anonymous";
    }
    img.onload = () => loadedUrls.add(first);
    img.onerror = () => failedUrls.add(first);
    img.src = first;
  } catch {
  }
}
function monogramFor(name, fallback) {
  const source = typeof name === "string" ? name.trim() : "";
  if (source) {
    const parts = source.split(/\s+/).filter(Boolean);
    if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
    return source.slice(0, 2).toUpperCase();
  }
  if (fallback !== void 0 && fallback !== null) {
    return String(fallback).slice(0, 2).toUpperCase();
  }
  return "\xB7\xB7";
}
function analyseLogoLuminance(img) {
  try {
    const w = 16;
    const h = 16;
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return null;
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const { data } = ctx.getImageData(0, 0, w, h);
    let weighted = 0;
    let totalAlpha = 0;
    for (let i = 0; i < data.length; i += 4) {
      const r = data[i];
      const g = data[i + 1];
      const b = data[i + 2];
      const a = data[i + 3] / 255;
      if (a < 0.05) continue;
      const luma = (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
      weighted += luma * a;
      totalAlpha += a;
    }
    if (totalAlpha === 0) return null;
    return weighted / totalAlpha;
  } catch {
    return null;
  }
}
function BrandIcon({
  url,
  iconUrl,
  repoUrl,
  name,
  fallback,
  size = 32,
  className,
  decorative = true,
  providerSlug,
  subnetSlug,
  netuid
}) {
  const { resolved: theme } = useTheme();
  const host2 = useMemo(() => extractHost(url), [url]);
  const lookup = useMemo(
    () => ({ providerSlug, subnetSlug, netuid }),
    [providerSlug, subnetSlug, netuid]
  );
  const chain = useMemo(
    () => buildCandidateChain({ url, iconUrl, repoUrl, lookup, theme, size }),
    [url, iconUrl, repoUrl, lookup, theme, size]
  );
  const initialIndex = useMemo(() => {
    if (!host2) return 0;
    const winner = winnerByHost.get(host2);
    if (!winner) return 0;
    const idx = chain.indexOf(winner);
    return idx >= 0 ? idx : 0;
  }, [host2, chain]);
  const [index, setIndex] = useState(initialIndex);
  const [loaded, setLoaded] = useState(false);
  const [needsContrastTile, setNeedsContrastTile] = useState(false);
  useEffect(() => {
    setIndex(initialIndex);
    setLoaded(false);
    setNeedsContrastTile(false);
  }, [initialIndex, chain]);
  const candidate = chain[index] ?? null;
  const exhausted = !candidate;
  useEffect(() => {
    if (candidate && loadedUrls.has(candidate)) setLoaded(true);
    if (candidate && isDarkLogo.has(candidate)) {
      setNeedsContrastTile(theme === "dark" && isDarkLogo.get(candidate));
    }
  }, [candidate, theme]);
  const advance = useCallback(() => {
    setIndex((i) => i + 1);
    setLoaded(false);
    setNeedsContrastTile(false);
  }, []);
  const onImgError = useCallback(() => {
    if (candidate) failedUrls.add(candidate);
    advance();
  }, [candidate, advance]);
  const onImgLoad = useCallback(
    (e) => {
      const img = e.currentTarget;
      const min = isProxiedIcon(candidate) ? 16 : Math.max(16, Math.floor(size * 0.9));
      if (img.naturalWidth > 0 && img.naturalWidth < min) {
        if (candidate) failedUrls.add(candidate);
        advance();
        return;
      }
      if (candidate) {
        loadedUrls.add(candidate);
        if (host2) winnerByHost.set(host2, candidate);
        if (!isDarkLogo.has(candidate)) {
          const luma = analyseLogoLuminance(img);
          if (luma !== null) isDarkLogo.set(candidate, luma < 0.55);
        }
        const isDark = isDarkLogo.get(candidate);
        setNeedsContrastTile(theme === "dark" && isDark === true);
      }
      setLoaded(true);
    },
    [candidate, advance, host2, size, theme]
  );
  const baseClasses = classNames(
    "relative inline-flex items-center justify-center shrink-0 overflow-hidden",
    "rounded-md border border-border",
    needsContrastTile ? "bg-white/95" : "bg-surface",
    className
  );
  const style = { width: size, height: size };
  const labelText = name ?? (fallback != null ? String(fallback) : "");
  const ariaLabel = decorative ? void 0 : labelText ? `${labelText} icon` : "icon";
  const ariaHidden = decorative ? true : void 0;
  if (exhausted) {
    return /* @__PURE__ */ jsx(
      "span",
      {
        className: classNames(baseClasses, "bg-accent/10 text-ink-strong"),
        style,
        role: decorative ? void 0 : "img",
        "aria-hidden": ariaHidden,
        "aria-label": ariaLabel,
        title: decorative ? void 0 : labelText || void 0,
        children: /* @__PURE__ */ jsx(
          "span",
          {
            className: "font-display font-semibold tabular-nums leading-none",
            style: { fontSize: Math.max(10, Math.round(size * 0.42)) },
            "aria-hidden": "true",
            children: monogramFor(name, fallback)
          }
        )
      }
    );
  }
  return /* @__PURE__ */ jsxs(
    "span",
    {
      className: baseClasses,
      style,
      role: decorative ? void 0 : "img",
      "aria-hidden": ariaHidden,
      "aria-label": ariaLabel,
      title: decorative ? void 0 : labelText || void 0,
      children: [
        !loaded ? /* @__PURE__ */ jsx(
          "span",
          {
            "aria-hidden": "true",
            className: "absolute inset-0 flex items-center justify-center bg-accent/10 text-ink-muted/70",
            children: /* @__PURE__ */ jsx(
              "span",
              {
                className: "font-display font-semibold tabular-nums leading-none",
                style: { fontSize: Math.max(10, Math.round(size * 0.42)) },
                children: monogramFor(name, fallback)
              }
            )
          }
        ) : null,
        /* @__PURE__ */ jsx(
          "img",
          {
            src: candidate,
            alt: "",
            width: size,
            height: size,
            loading: "lazy",
            decoding: "async",
            referrerPolicy: "no-referrer",
            crossOrigin: shouldUseAnonymousCors(candidate, iconUrl, theme) ? "anonymous" : void 0,
            className: classNames(
              "relative block transition-opacity duration-150",
              loaded ? "opacity-100" : "opacity-0"
            ),
            style: {
              width: size,
              height: size,
              objectFit: "contain",
              imageRendering: "-webkit-optimize-contrast"
            },
            onLoad: onImgLoad,
            onError: onImgError
          },
          candidate ?? "x"
        )
      ]
    }
  );
}
var STATE_LABEL = {
  ok: "OK",
  warn: "Degraded",
  degraded: "Degraded",
  down: "Down",
  offline: "Offline",
  unknown: "Unknown"
};
var STATE_COLOR = {
  ok: "bg-health-ok",
  warn: "bg-health-warn",
  degraded: "bg-health-warn",
  down: "bg-health-down",
  offline: "bg-health-down",
  unknown: "bg-health-unknown"
};
function normalize(state) {
  const s = state ?? "unknown";
  return STATE_COLOR[s] ? s : "unknown";
}
function HealthDot({
  state,
  variant = "dot",
  className
}) {
  const key = normalize(state);
  const color = STATE_COLOR[key];
  const label = STATE_LABEL[key];
  const shouldPulse = key === "warn" || key === "degraded" || key === "down" || key === "offline";
  const dot = /* @__PURE__ */ jsx(
    "span",
    {
      role: "img",
      "aria-label": `Health: ${label.toLowerCase()}`,
      title: label,
      className: classNames(
        "relative inline-block size-2 rounded-full shrink-0",
        color,
        shouldPulse && "mg-pulse",
        className
      )
    }
  );
  if (variant === "dot") return dot;
  return /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
    dot,
    /* @__PURE__ */ jsx("span", { className: "text-[11px] font-medium text-ink", children: label })
  ] });
}
function HealthPill({
  state,
  label
}) {
  if (label) {
    return /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
      /* @__PURE__ */ jsx(HealthDot, { state }),
      /* @__PURE__ */ jsx("span", { className: "text-[11px] font-medium text-ink", children: label })
    ] });
  }
  return /* @__PURE__ */ jsx(HealthDot, { state, variant: "label" });
}
var curationLabel = {
  native: "Native",
  "candidate-discovered": "Candidate",
  "community-seeded": "Community",
  "machine-verified": "Machine",
  "maintainer-reviewed": "Reviewed",
  "adapter-backed": "Adapter"
};
var curationCls = {
  native: "bg-transparent text-ink-strong border-ink-strong/40",
  "candidate-discovered": "bg-transparent text-ink-muted border-dashed border-ink-subtle",
  "community-seeded": "bg-transparent text-curation-seeded border-curation-seeded/40",
  "machine-verified": "bg-transparent text-ink-muted border-border",
  "maintainer-reviewed": "bg-primary-soft text-curation-verified border-accent/40",
  "adapter-backed": "bg-primary-soft text-curation-pilot border-accent/50"
};
var authorityLabel = {
  official: "Official",
  "registry-observed": "Observed",
  "provider-claimed": "Claimed",
  community: "Community",
  "native-chain": "Native"
};
var authorityCls = {
  official: curationCls["maintainer-reviewed"],
  "registry-observed": curationCls["machine-verified"],
  "provider-claimed": curationCls["adapter-backed"],
  community: curationCls["candidate-discovered"],
  "native-chain": curationCls["native"]
};
function CurationChip({ level }) {
  const key = String(level ?? "");
  const label = Object.hasOwn(curationLabel, key) ? curationLabel[key] : Object.hasOwn(authorityLabel, key) ? authorityLabel[key] : level ? key : "\u2014";
  const cls = Object.hasOwn(curationCls, key) ? curationCls[key] : Object.hasOwn(authorityCls, key) ? authorityCls[key] : curationCls["candidate-discovered"];
  return /* @__PURE__ */ jsx(
    "span",
    {
      className: classNames(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        cls
      ),
      children: label
    }
  );
}
var reviewLabel = {
  "maintainer-reviewed": "Reviewed",
  rejected: "Rejected"
};
var reviewCls = {
  "maintainer-reviewed": curationCls["maintainer-reviewed"],
  rejected: "bg-transparent text-ink-muted border-ink-subtle line-through"
};
function ReviewChip({ state }) {
  const key = String(state ?? "");
  if (!Object.hasOwn(reviewLabel, key)) return null;
  return /* @__PURE__ */ jsx(
    "span",
    {
      className: classNames(
        "inline-flex items-center rounded border px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider",
        reviewCls[key]
      ),
      title: `Maintainer review: ${key}`,
      children: reviewLabel[key]
    }
  );
}
function CandidateChip() {
  return /* @__PURE__ */ jsx("span", { className: "inline-flex items-center rounded border border-dashed border-ink-subtle bg-transparent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-muted", children: "Unverified" });
}
function truncateCopyPreview(value, max = 64) {
  return value.length > max ? value.slice(0, max) + "\u2026" : value;
}
function copySuccessTitle(label) {
  return label ? `Copied ${label}` : "Copied to clipboard";
}
function copyErrorDescription(err) {
  return err instanceof Error ? err.message : "Clipboard unavailable";
}
function shouldUseNavigatorClipboard(navigatorValue) {
  return typeof navigatorValue !== "undefined" && !!navigatorValue.clipboard;
}
function useCopy(opts = {}) {
  const { label, resetAfter = 1400, toastOnSuccess = true } = opts;
  const [copied, setCopied] = useState(false);
  const timer = useRef(null);
  const copy = useCallback(
    async (value) => {
      if (!value) return false;
      try {
        if (shouldUseNavigatorClipboard(
          typeof navigator !== "undefined" ? navigator : void 0
        )) {
          await navigator.clipboard.writeText(value);
        } else if (typeof document !== "undefined") {
          const ta = document.createElement("textarea");
          ta.value = value;
          ta.style.position = "fixed";
          ta.style.opacity = "0";
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          document.body.removeChild(ta);
        }
        setCopied(true);
        if (toastOnSuccess) {
          toast.success(copySuccessTitle(label), {
            description: truncateCopyPreview(value),
            duration: 1800
          });
        }
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), resetAfter);
        return true;
      } catch (err) {
        toast.error("Copy failed", {
          description: copyErrorDescription(err)
        });
        return false;
      }
    },
    [label, resetAfter, toastOnSuccess]
  );
  return { copied, copy };
}
var SIZE_CLASS = {
  3: "size-3",
  3.5: "size-3.5"
};
function CopyIconToggle({ copied, size = 3, className }) {
  const sizeClass = SIZE_CLASS[size];
  return /* @__PURE__ */ jsxs(
    "span",
    {
      className: classNames(
        "relative inline-flex shrink-0 items-center justify-center",
        sizeClass
      ),
      "aria-hidden": true,
      children: [
        /* @__PURE__ */ jsx(
          Check,
          {
            className: classNames(
              "absolute text-health-ok transition-all duration-150",
              sizeClass,
              copied ? "scale-100 opacity-100" : "scale-50 opacity-0"
            )
          }
        ),
        /* @__PURE__ */ jsx(
          Copy,
          {
            className: classNames(
              "absolute transition-all duration-150",
              sizeClass,
              copied ? "scale-50 opacity-0" : "scale-100 opacity-100",
              className
            )
          }
        )
      ]
    }
  );
}
function CopyButton({
  value,
  label,
  className
}) {
  const { copied, copy } = useCopy({ label });
  return /* @__PURE__ */ jsx(
    "button",
    {
      type: "button",
      onClick: () => copy(value),
      "aria-label": copied ? "Copied" : `Copy ${label ?? "value"}`,
      title: copied ? "Copied!" : `Copy ${label ?? "value"}`,
      className: classNames(
        "shrink-0 inline-flex items-center justify-center rounded p-1 text-ink-muted hover:text-ink-strong transition-colors",
        className
      ),
      children: /* @__PURE__ */ jsx(CopyIconToggle, { copied })
    }
  );
}
function CopyableCode({
  value,
  label,
  className,
  truncate = true
}) {
  const { copied, copy } = useCopy({ label: label ?? "value" });
  return /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      onClick: () => copy(value),
      title: value,
      "aria-label": copied ? "Copied" : `Copy ${label ?? "value"}`,
      className: classNames(
        "group inline-flex min-w-0 items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-left font-mono text-[11px] text-ink hover:border-ink/30 transition-colors",
        className
      ),
      children: [
        label ? /* @__PURE__ */ jsx("span", { className: "shrink-0 text-ink-muted uppercase tracking-wider text-[10px]", children: label }) : null,
        /* @__PURE__ */ jsx(
          "code",
          {
            className: classNames(
              "min-w-0 text-ink-strong",
              truncate ? "truncate" : "truncate sm:whitespace-normal sm:break-all"
            ),
            children: value
          }
        ),
        /* @__PURE__ */ jsxs(
          "span",
          {
            className: "relative inline-flex size-3 shrink-0 items-center justify-center",
            "aria-hidden": true,
            children: [
              /* @__PURE__ */ jsx(
                Check,
                {
                  className: classNames(
                    "absolute size-3 text-health-ok transition-all duration-150",
                    copied ? "scale-100 opacity-100" : "scale-50 opacity-0"
                  )
                }
              ),
              /* @__PURE__ */ jsx(
                Copy,
                {
                  className: classNames(
                    "absolute size-3 text-ink-muted group-hover:text-ink transition-all duration-150",
                    copied ? "scale-50 opacity-0" : "scale-100 opacity-100"
                  )
                }
              )
            ]
          }
        )
      ]
    }
  );
}
function DensityToggle({
  value,
  onChange,
  className
}) {
  const options = [
    { value: "comfortable", label: "Comfortable", Icon: Rows3 },
    { value: "compact", label: "Compact", Icon: Rows2 }
  ];
  return /* @__PURE__ */ jsx(
    "div",
    {
      role: "tablist",
      "aria-label": "Row density",
      className: classNames(
        "inline-flex items-center rounded-md border border-border bg-card p-0.5",
        className
      ),
      children: options.map(({ value: v, label, Icon }) => {
        const active = v === value;
        return /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": active,
            "aria-label": `${label} row density`,
            title: `${label} rows`,
            onClick: () => onChange(v),
            className: classNames(
              "inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors min-h-8",
              active ? "bg-surface text-ink-strong" : "text-ink-muted hover:text-ink-strong"
            ),
            children: [
              /* @__PURE__ */ jsx(Icon, { className: "size-3.5" }),
              /* @__PURE__ */ jsx("span", { className: "hidden sm:inline", children: label })
            ]
          },
          v
        );
      })
    }
  );
}
function buildCsvDownloadUrl(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("format", "csv");
  return parsed.toString();
}
function DownloadCsvButton({
  url,
  label = "Download CSV",
  className
}) {
  const exportUrl = buildCsvDownloadUrl(url);
  const onClick = () => {
    window.location.href = exportUrl;
  };
  return /* @__PURE__ */ jsxs(
    "button",
    {
      type: "button",
      onClick,
      "aria-label": label,
      title: label,
      className: classNames(
        "inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink hover:border-ink/30 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        className
      ),
      children: [
        /* @__PURE__ */ jsx(Download, { className: "size-3 text-ink-muted", "aria-hidden": true }),
        label
      ]
    }
  );
}
var ELIGIBILITY_LABEL = {
  "proxy-enabled": "Proxy",
  "pool-member": "Pool",
  "archive-capable": "Archive",
  unassigned: "Unassigned"
};
var TONE = {
  "proxy-enabled": "border-accent/50 text-curation-pilot before:bg-accent",
  "pool-member": "border-curation-machine/50 text-curation-machine before:bg-curation-machine",
  "archive-capable": "border-curation-verified/50 text-curation-verified before:bg-curation-verified",
  unassigned: "border-border text-ink-muted before:bg-ink-subtle"
};
var RULE = {
  "proxy-enabled": "Routable through the Metagraphed pool when proxy is enabled backend-side. Routing remains future-scoped.",
  "pool-member": "Curated member of an RPC pool \u2014 eligible for routing once proxy is enabled.",
  "archive-capable": "Historical block data supported \u2014 suitable for archival reads beyond head depth.",
  unassigned: "Not assigned to any pool yet. Eligible for pooling once verification metadata is added."
};
function EligibilityChip({
  eligibility,
  size = "sm"
}) {
  return /* @__PURE__ */ jsx(TooltipProvider, { delayDuration: 120, children: /* @__PURE__ */ jsxs(Tooltip, { children: [
    /* @__PURE__ */ jsx(TooltipTrigger, { asChild: true, children: /* @__PURE__ */ jsx(
      "span",
      {
        tabIndex: 0,
        className: classNames(
          "inline-flex items-center gap-1.5 rounded-full border bg-transparent font-mono uppercase tracking-wider whitespace-nowrap cursor-help transition-colors",
          "before:content-[''] before:size-1.5 before:rounded-full",
          "hover:bg-surface/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          size === "xs" ? "px-2 py-0 text-[9px] h-5" : "px-2.5 py-0 text-[10px] h-6",
          TONE[eligibility]
        ),
        children: ELIGIBILITY_LABEL[eligibility]
      }
    ) }),
    /* @__PURE__ */ jsxs(
      TooltipContent,
      {
        side: "top",
        className: "max-w-[240px] text-[11px] leading-relaxed",
        children: [
          /* @__PURE__ */ jsx("div", { className: "font-mono uppercase tracking-widest text-[9px] opacity-70 mb-1", children: ELIGIBILITY_LABEL[eligibility] }),
          RULE[eligibility]
        ]
      }
    )
  ] }) });
}
var SAFE_EXTERNAL_PROTOCOLS = /* @__PURE__ */ new Set(["http:", "https:"]);
function isBlockedIpv42(hostname) {
  const parts = hostname.split(".");
  if (parts.length !== 4) return false;
  const octets = parts.map((part) => {
    if (!/^\d{1,3}$/.test(part)) return null;
    const value = Number(part);
    return value >= 0 && value <= 255 ? value : null;
  });
  if (octets.some((value) => value === null)) return false;
  const [a, b, c] = octets;
  return a === 0 || a === 10 || a === 127 || a === 100 && b >= 64 && b <= 127 || a === 169 && b === 254 || a === 172 && b >= 16 && b <= 31 || a === 192 && b === 0 || a === 192 && b === 168 || a === 198 && (b === 18 || b === 19) || a === 198 && b === 51 && c === 100 || a === 203 && b === 0 && c === 113 || a >= 224;
}
function isBlockedIpv62(hostname) {
  if (!hostname.includes(":")) return false;
  return hostname === "" || hostname === "::" || hostname === "::1" || hostname.startsWith("fc") || hostname.startsWith("fd") || hostname.startsWith("fe8") || hostname.startsWith("fe9") || hostname.startsWith("fea") || hostname.startsWith("feb") || hostname.startsWith("ff") || hostname.startsWith("::ffff:");
}
function isPrivateHostname(hostname) {
  const normalized = hostname.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized.endsWith(".localhost") || normalized.endsWith(".local")) {
    return true;
  }
  return isBlockedIpv42(normalized) || isBlockedIpv62(normalized);
}
function safeExternalUrl(href) {
  if (!href) return void 0;
  try {
    const url = new URL(href.trim());
    if (!SAFE_EXTERNAL_PROTOCOLS.has(url.protocol) || url.username || url.password || isPrivateHostname(url.hostname)) {
      return void 0;
    }
    return url.href;
  } catch {
    return void 0;
  }
}
function ExternalLink({
  href,
  children,
  authRequired,
  publicSafe = true,
  className
}) {
  const safeHref = safeExternalUrl(href);
  const content = /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("span", { className: "truncate", children }),
    safeHref ? /* @__PURE__ */ jsx(ExternalLink$1, { className: "size-3 shrink-0 text-ink-muted" }) : null,
    authRequired ? /* @__PURE__ */ jsxs(
      "span",
      {
        title: "Authentication required",
        className: "inline-flex items-center gap-0.5 rounded border border-border bg-surface px-1 text-[9px] uppercase tracking-wider text-ink-muted",
        children: [
          /* @__PURE__ */ jsx(Lock, { className: "size-2.5" }),
          " auth"
        ]
      }
    ) : null,
    !publicSafe ? /* @__PURE__ */ jsxs(
      "span",
      {
        title: "Not public-safe \u2014 handle with care",
        className: "inline-flex items-center gap-0.5 rounded border border-health-warn/30 bg-health-warn/5 px-1 text-[9px] uppercase tracking-wider text-health-warn",
        children: [
          /* @__PURE__ */ jsx(AlertTriangle, { className: "size-2.5" }),
          " private"
        ]
      }
    ) : null
  ] });
  const classes = classNames(
    "inline-flex items-center gap-1 underline decoration-ink/30 underline-offset-2 text-ink-strong",
    safeHref ? "hover:decoration-ink" : "cursor-default decoration-transparent",
    className
  );
  if (!safeHref) {
    return /* @__PURE__ */ jsx("span", { className: classes, title: "Blocked unsafe external URL", children: content });
  }
  return /* @__PURE__ */ jsx(
    "a",
    {
      href: safeHref,
      target: "_blank",
      rel: "noopener noreferrer",
      className: classes,
      children: content
    }
  );
}
function freshnessTierLabel(tier) {
  return tier === "realtime" ? "Live" : "Daily rollup";
}
function freshnessDotClass(at, thresholdMs) {
  const missing = at == null;
  const stale = !missing && isStaleFreshness(at, thresholdMs);
  return missing ? "bg-health-unknown" : stale ? "bg-health-warn" : "bg-health-ok";
}
function freshnessBadgeTimeCopy(at, mounted = true) {
  if (!mounted) return { absolutePhrase: null, relative: "" };
  const absolute = formatFreshnessAbsolute(at);
  return {
    absolutePhrase: absolute ? `as of ${absolute}` : null,
    relative: formatRelative(at)
  };
}
function tierChipClass(tier) {
  return tier === "realtime" ? "border-accent/35 bg-accent/10 text-accent" : "border-border bg-surface/50 text-ink-muted";
}
function FreshnessBadge({ at, tier, thresholdMs, className }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const missing = at == null;
  const stale = !missing && isStaleFreshness(at, thresholdMs);
  const dotCls = freshnessDotClass(at, thresholdMs);
  const { absolutePhrase, relative: relative2 } = freshnessBadgeTimeCopy(at, mounted);
  const title = missing ? "No freshness data" : !mounted ? void 0 : stale ? `Stale \u2014 ${absolutePhrase ?? "unknown time"} (${relative2})` : `Fresh \u2014 ${absolutePhrase ?? "unknown time"} (${relative2})`;
  return /* @__PURE__ */ jsxs(
    "span",
    {
      className: classNames(
        "inline-flex flex-wrap items-center gap-1.5",
        className
      ),
      title,
      suppressHydrationWarning: true,
      children: [
        /* @__PURE__ */ jsx(
          "span",
          {
            className: classNames(
              "inline-flex items-center rounded-full border px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.16em]",
              tierChipClass(tier)
            ),
            children: freshnessTierLabel(tier)
          }
        ),
        /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
          /* @__PURE__ */ jsx(
            "span",
            {
              className: classNames("size-1.5 shrink-0 rounded-full", dotCls)
            }
          ),
          /* @__PURE__ */ jsxs(
            "span",
            {
              className: "font-mono text-[10px] text-ink-muted",
              suppressHydrationWarning: true,
              children: [
                absolutePhrase ? /* @__PURE__ */ jsxs(Fragment, { children: [
                  /* @__PURE__ */ jsx("span", { children: absolutePhrase }),
                  /* @__PURE__ */ jsx("span", { className: "text-ink-muted/70", children: " \xB7 " })
                ] }) : null,
                /* @__PURE__ */ jsx("span", { children: relative2 })
              ]
            }
          )
        ] })
      ]
    }
  );
}
function InfoTooltip({
  label,
  className
}) {
  return /* @__PURE__ */ jsx(TooltipProvider, { delayDuration: 150, children: /* @__PURE__ */ jsxs(Tooltip, { children: [
    /* @__PURE__ */ jsx(TooltipTrigger, { asChild: true, children: /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        "aria-label": label,
        className: "inline-flex items-center text-ink-muted hover:text-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded " + (className ?? ""),
        children: /* @__PURE__ */ jsx(Info, { className: "size-3.5" })
      }
    ) }),
    /* @__PURE__ */ jsx(
      TooltipContent,
      {
        side: "top",
        className: "max-w-xs text-[11px] leading-relaxed",
        children: label
      }
    )
  ] }) });
}
function FreshnessIndicator({
  at,
  thresholdMs,
  className,
  dotOnly
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const missing = at == null;
  const stale = !missing && isStaleFreshness(at, thresholdMs);
  const cls = missing ? "bg-health-unknown" : stale ? "bg-health-warn" : "bg-health-ok";
  const rel = mounted ? formatRelative(at) : "";
  const title = missing ? "No freshness data" : !mounted ? void 0 : stale ? `Stale \u2014 last updated ${rel}` : `Fresh \u2014 updated ${rel}`;
  return /* @__PURE__ */ jsxs(
    "span",
    {
      className: classNames("inline-flex items-center gap-1.5", className),
      title,
      suppressHydrationWarning: true,
      children: [
        /* @__PURE__ */ jsx("span", { className: classNames("size-1.5 rounded-full", cls) }),
        !dotOnly ? /* @__PURE__ */ jsx(
          "span",
          {
            className: "font-mono text-[10px] text-ink-muted",
            suppressHydrationWarning: true,
            children: rel
          }
        ) : null
      ]
    }
  );
}
function DailyRollupFreshness({
  at,
  className
}) {
  const label = at == null ? "No freshness data" : `Daily rollup snapshot \u2014 updated ${formatRelative(at)}`;
  return /* @__PURE__ */ jsxs("span", { className: classNames("inline-flex items-center gap-1", className), children: [
    /* @__PURE__ */ jsx(FreshnessIndicator, { at, dotOnly: true }),
    /* @__PURE__ */ jsx(InfoTooltip, { label })
  ] });
}
function HoverPreview({
  children,
  content,
  className,
  focusable
}) {
  const [open, setOpen] = useState(false);
  return /* @__PURE__ */ jsxs(
    "span",
    {
      className: classNames("relative inline-flex", className),
      tabIndex: focusable ? 0 : void 0,
      onMouseEnter: () => setOpen(true),
      onMouseLeave: () => setOpen(false),
      onFocus: () => setOpen(true),
      onBlur: () => setOpen(false),
      children: [
        children,
        open ? /* @__PURE__ */ jsx(
          "span",
          {
            role: "tooltip",
            className: "absolute left-0 top-full z-40 mt-1.5 w-72 max-w-[80vw] rounded border border-border bg-card p-3 shadow-lg text-[11px] text-ink leading-relaxed",
            children: content
          }
        ) : null
      ]
    }
  );
}
function Kbd({
  children,
  className
}) {
  return /* @__PURE__ */ jsx(
    "kbd",
    {
      className: classNames(
        "inline-flex items-center justify-center rounded border border-border bg-paper px-1.5 min-w-[1.25rem] h-5 font-mono text-[10px] text-ink-muted shadow-[inset_0_-1px_0_var(--border)]",
        className
      ),
      children
    }
  );
}
function KeyChip({
  value,
  label = "value",
  head = 8,
  tail = 6,
  className
}) {
  const { copied, copy } = useCopy({ label });
  const short = value.length > head + tail + 1 ? `${value.slice(0, head)}\u2026${value.slice(-tail)}` : value;
  return /* @__PURE__ */ jsxs(Tooltip, { delayDuration: 120, children: [
    /* @__PURE__ */ jsx(TooltipTrigger, { asChild: true, children: /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick: () => copy(value),
        "aria-label": copied ? `${label} copied` : `Copy ${label}: ${value}`,
        className: classNames(
          "group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 text-left font-mono text-[11px] text-ink-strong hover:border-ink/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-card transition-colors",
          className
        ),
        children: [
          /* @__PURE__ */ jsx("span", { className: "truncate tabular-nums", children: short }),
          /* @__PURE__ */ jsx(
            CopyIconToggle,
            {
              copied,
              className: "text-ink-muted group-hover:text-ink"
            }
          )
        ]
      }
    ) }),
    /* @__PURE__ */ jsxs(
      TooltipContent,
      {
        side: "top",
        className: "max-w-[90vw] break-all font-mono text-[11px]",
        children: [
          /* @__PURE__ */ jsx("span", { className: "mr-1 uppercase tracking-widest text-[9px] opacity-70", children: label }),
          value
        ]
      }
    )
  ] });
}
function ListShell({
  filters,
  cards,
  table,
  footer,
  empty,
  isEmpty,
  isStale,
  /** When true, the rendered table can stick its <thead> at top-sticky-offset
   *  (just under the sticky filter bar) because outer wrappers avoid
   *  creating a vertical scroll container. */
  stickyHeader = true
}) {
  const tableScroll = stickyHeader ? "overflow-x-auto overflow-y-clip" : "overflow-x-auto";
  return /* @__PURE__ */ jsxs("div", { children: [
    /* @__PURE__ */ jsx(
      "div",
      {
        className: classNames(
          // Sticky filter bar. Offset matches header height (h-nav).
          "sticky top-nav z-20 -mx-4 md:mx-0 mb-3",
          "bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80",
          "border-b border-border md:border md:rounded md:bg-card",
          "px-3 py-2 md:p-2.5"
        ),
        children: /* @__PURE__ */ jsx("div", { className: "flex flex-wrap items-center gap-2", children: filters })
      }
    ),
    isEmpty ? empty : /* @__PURE__ */ jsxs("div", { className: isStale ? "opacity-70 transition-opacity" : void 0, children: [
      cards ? /* @__PURE__ */ jsx("div", { className: "md:hidden space-y-2", children: cards }) : null,
      /* @__PURE__ */ jsx("div", { className: cards ? "hidden md:block" : void 0, children: /* @__PURE__ */ jsxs("div", { className: "rounded border border-border bg-card overflow-hidden", children: [
        /* @__PURE__ */ jsx("div", { className: tableScroll, children: table }),
        footer
      ] }) }),
      cards && footer ? /* @__PURE__ */ jsx("div", { className: "md:hidden mt-3", children: footer }) : null
    ] })
  ] });
}
function ListCard({
  to,
  onClick,
  children
}) {
  const cls = "block rounded border border-border bg-card p-3 min-h-11 hover:border-ink/30 active:bg-surface transition-colors";
  if (to) {
    return /* @__PURE__ */ jsx("a", { href: to, className: cls, children });
  }
  return /* @__PURE__ */ jsx(
    "button",
    {
      type: "button",
      onClick,
      className: `${cls} text-left w-full`,
      children
    }
  );
}
function LoadMore({
  hasMore,
  isLoading,
  onLoadMore,
  shown,
  total,
  error,
  cursorInvalid
}) {
  if (isLoading) {
    return /* @__PURE__ */ jsxs(
      "div",
      {
        className: "border-t border-border bg-surface/30 p-3 space-y-1.5",
        "aria-live": "polite",
        "aria-busy": "true",
        children: [
          /* @__PURE__ */ jsx("span", { className: "sr-only", children: "Loading more results\u2026" }),
          /* @__PURE__ */ jsx(Skeleton, { className: "h-7 w-full" }),
          /* @__PURE__ */ jsx(Skeleton, { className: "h-7 w-full" }),
          /* @__PURE__ */ jsx(Skeleton, { className: "h-7 w-3/4" })
        ]
      }
    );
  }
  if (error) {
    return /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between gap-3 border-t border-health-down/30 bg-health-down/5 px-4 py-2 text-[11px]", children: [
      /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-1.5 text-health-down", children: [
        /* @__PURE__ */ jsx(AlertCircle, { className: "size-3" }),
        "Couldn\u2019t load more \u2014 ",
        error.message || "network error",
        "."
      ] }),
      /* @__PURE__ */ jsxs(
        "button",
        {
          type: "button",
          onClick: onLoadMore,
          className: "inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1 font-medium hover:border-ink/30 min-h-9",
          children: [
            /* @__PURE__ */ jsx(RefreshCw, { className: "size-3" }),
            " Retry"
          ]
        }
      )
    ] });
  }
  if (cursorInvalid) {
    return /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between gap-3 border-t border-health-warn/30 bg-health-warn/5 px-4 py-2 text-[11px] text-health-warn", children: [
      /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
        /* @__PURE__ */ jsx(AlertCircle, { className: "size-3" }),
        "Pagination stopped \u2014 the server returned an invalid next cursor."
      ] }),
      /* @__PURE__ */ jsxs("span", { className: "font-mono text-ink-muted", children: [
        shown,
        total != null ? ` / ${total}` : ""
      ] })
    ] });
  }
  return /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between gap-3 border-t border-border bg-surface/30 px-4 py-2 text-[11px] font-mono text-ink-muted", children: [
    /* @__PURE__ */ jsxs("span", { children: [
      shown,
      total != null ? ` of ${total}` : ""
    ] }),
    hasMore ? /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        onClick: onLoadMore,
        className: "inline-flex items-center rounded border border-border bg-card px-3 py-1.5 text-[11px] font-medium hover:border-ink/30 min-h-9",
        children: "Load more"
      }
    ) : /* @__PURE__ */ jsx("span", { className: "opacity-60", children: "end of list" })
  ] });
}
function PageHero({
  eyebrow,
  live,
  title,
  description,
  actions,
  kpis,
  aside,
  caption = "registry / v1",
  className
}) {
  return /* @__PURE__ */ jsxs(
    "section",
    {
      className: classNames(
        "mg-hero-slab relative mb-12 md:mb-16 pt-12 md:pt-20 pb-10 md:pb-14",
        className
      ),
      children: [
        caption ? /* @__PURE__ */ jsx("div", { className: "absolute right-0 top-4 hidden md:block", children: /* @__PURE__ */ jsx("span", { className: "mg-hero-caption", children: caption }) }) : null,
        /* @__PURE__ */ jsxs("div", { className: "grid gap-10 md:grid-cols-[minmax(0,1fr)_auto] md:items-end", children: [
          /* @__PURE__ */ jsxs("div", { className: "min-w-0 max-w-3xl", children: [
            eyebrow ? /* @__PURE__ */ jsxs("div", { className: "mg-fade-in font-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted inline-flex items-center gap-2", children: [
              live ? /* @__PURE__ */ jsx("span", { className: "mg-live-dot" }) : null,
              eyebrow
            ] }) : null,
            /* @__PURE__ */ jsx("h1", { className: "mg-fade-in mg-fade-in-delay-1 mt-4 font-display text-[2.5rem] sm:text-5xl md:text-[3.75rem] font-semibold leading-[1.02] tracking-[-0.025em] text-ink-strong", children: title }),
            description ? /* @__PURE__ */ jsx("p", { className: "mg-fade-in mg-fade-in-delay-2 mt-5 max-w-xl text-base md:text-lg text-ink-muted leading-relaxed", children: description }) : null,
            actions ? /* @__PURE__ */ jsx("div", { className: "mg-fade-in mg-fade-in-delay-3 mt-6 flex flex-wrap items-center gap-2", children: actions }) : null
          ] }),
          aside ? /* @__PURE__ */ jsx("div", { className: "mg-fade-in mg-fade-in-delay-2 hidden md:block shrink-0", children: aside }) : null
        ] }),
        kpis && kpis.length > 0 ? /* @__PURE__ */ jsx("div", { className: "mg-fade-in mg-fade-in-delay-3 mg-kpi-strip mt-12 md:mt-16", children: kpis.map((k) => /* @__PURE__ */ jsxs("div", { children: [
          /* @__PURE__ */ jsx("div", { className: "font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted", children: k.label }),
          /* @__PURE__ */ jsxs("div", { className: "mt-1.5 flex items-baseline gap-2", children: [
            /* @__PURE__ */ jsx("span", { className: "font-display text-2xl md:text-[1.75rem] font-semibold tabular-nums text-ink-strong leading-none tracking-[-0.01em]", children: k.value }),
            k.hint ? /* @__PURE__ */ jsx("span", { className: "font-mono text-[11px] text-ink-muted", children: k.hint }) : null
          ] }),
          k.chart ? /* @__PURE__ */ jsx("div", { className: "mt-2.5 -ml-0.5", children: k.chart }) : null
        ] }, k.label)) }) : null
      ]
    }
  );
}
function PageSection({
  eyebrow,
  title,
  description,
  actions,
  toolbar,
  id,
  className,
  divider = "hairline",
  tone = "default",
  children
}) {
  const hasHeader = !!(eyebrow || title || actions);
  return /* @__PURE__ */ jsxs(
    "section",
    {
      id,
      "data-section-anchor": id ? "" : void 0,
      className: classNames(
        "mg-section",
        tone === "muted" && "rounded-2xl bg-surface-2/40 px-5 md:px-8 py-8 md:py-10",
        className
      ),
      children: [
        hasHeader ? /* @__PURE__ */ jsxs(
          "header",
          {
            className: classNames(
              "grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end",
              divider === "hairline" && tone !== "muted" && "mg-section-rule pt-8",
              "pb-6"
            ),
            children: [
              /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
                eyebrow ? /* @__PURE__ */ jsx("div", { className: "font-mono text-[10px] uppercase tracking-[0.22em] text-ink-muted inline-flex items-center gap-2", children: eyebrow }) : null,
                title ? /* @__PURE__ */ jsxs("h2", { className: "group/anchor mt-2 flex items-baseline gap-2 font-display text-2xl md:text-[1.875rem] font-semibold tracking-[-0.02em] text-ink-strong", children: [
                  /* @__PURE__ */ jsx("span", { children: title }),
                  id ? /* @__PURE__ */ jsx(
                    "a",
                    {
                      href: `#${id}`,
                      "aria-label": "Permalink",
                      className: "mg-anchor-btn -mb-0.5 inline-flex size-5 items-center justify-center rounded text-ink-muted hover:text-accent",
                      children: /* @__PURE__ */ jsx(Link, { className: "size-3.5" })
                    }
                  ) : null
                ] }) : null,
                description ? /* @__PURE__ */ jsx("p", { className: "mt-2 max-w-2xl text-sm text-ink-muted leading-relaxed", children: description }) : null
              ] }),
              actions ? /* @__PURE__ */ jsx("div", { className: "flex flex-wrap items-center gap-2 md:justify-end", children: actions }) : null
            ]
          }
        ) : null,
        toolbar ? /* @__PURE__ */ jsx("div", { className: "mb-6 -mt-2 flex flex-wrap items-center gap-2 border-b border-border pb-4", children: toolbar }) : null,
        /* @__PURE__ */ jsx("div", { className: hasHeader || toolbar ? "" : "", children })
      ]
    }
  );
}
function ScrollReveal({
  children,
  className = "",
  delay = 0
}) {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      el.setAttribute("data-revealed", "true");
      return;
    }
    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            window.setTimeout(
              () => el.setAttribute("data-revealed", "true"),
              delay
            );
            io.disconnect();
          }
        }
      },
      { rootMargin: "0px 0px -10% 0px", threshold: 0.05 }
    );
    io.observe(el);
    return () => io.disconnect();
  }, [delay]);
  return /* @__PURE__ */ jsx("div", { ref, className: `mg-reveal ${className}`, children });
}
var TONE_CLASS = {
  accent: "before:bg-accent",
  warn: "before:bg-health-warn",
  ink: "before:bg-ink-strong",
  muted: "before:bg-border"
};
function SectionAnchor({
  id,
  title,
  subtitle,
  info,
  right,
  tone,
  children
}) {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.hash = id;
    history.replaceState(null, "", url.toString());
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      toast.success("Link copied", { description: `#${id}` });
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.message("Link updated", { description: `#${id}` });
    }
  };
  return /* @__PURE__ */ jsxs(
    "section",
    {
      id,
      "data-section-anchor": true,
      className: classNames(
        "mg-section scroll-mt-32",
        tone && classNames(
          "relative pl-3 before:content-[''] before:absolute before:left-0 before:top-1 before:bottom-1 before:w-[2px] before:rounded-full before:opacity-70",
          TONE_CLASS[tone]
        )
      ),
      children: [
        /* @__PURE__ */ jsxs("div", { className: "mb-3 flex items-baseline gap-3", children: [
          /* @__PURE__ */ jsxs("div", { className: "min-w-0 flex-1", children: [
            /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-1.5", children: [
              /* @__PURE__ */ jsx("h2", { className: "font-display text-sm font-semibold uppercase tracking-wider text-ink-strong", children: title }),
              info ? /* @__PURE__ */ jsx(InfoTooltip, { label: info }) : null,
              /* @__PURE__ */ jsx(
                "button",
                {
                  type: "button",
                  onClick: onCopy,
                  "aria-label": `Copy link to ${typeof title === "string" ? title : id} section`,
                  className: "mg-anchor-btn inline-flex items-center text-ink-muted hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded p-0.5",
                  children: copied ? /* @__PURE__ */ jsx(Check, { className: "size-3.5 text-accent" }) : /* @__PURE__ */ jsx(Link2, { className: "size-3.5" })
                }
              )
            ] }),
            subtitle ? /* @__PURE__ */ jsx("p", { className: "mt-0.5 text-[11px] text-ink-muted", children: subtitle }) : null
          ] }),
          right ? /* @__PURE__ */ jsx("div", { className: "shrink-0", children: right }) : null
        ] }),
        children
      ]
    }
  );
}
function SectionHeading({
  title,
  intro,
  right,
  className,
  id
}) {
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: classNames(
        "mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between",
        className
      ),
      children: [
        /* @__PURE__ */ jsxs("div", { className: "max-w-2xl", children: [
          /* @__PURE__ */ jsx(
            "h2",
            {
              id,
              className: "font-display text-sm font-semibold uppercase tracking-wider text-ink-strong",
              children: title
            }
          ),
          intro ? /* @__PURE__ */ jsx("p", { className: "mt-1.5 text-sm leading-relaxed text-ink-muted", children: intro }) : null
        ] }),
        right ? /* @__PURE__ */ jsx("div", { className: "flex shrink-0 items-center gap-2", children: right }) : null
      ]
    }
  );
}
function ShareButton({ url, label = "Share view", className }) {
  const { copied, copy } = useCopy({ toastOnSuccess: false });
  const [announcement, setAnnouncement] = useState("");
  useEffect(() => {
    if (!copied) setAnnouncement("");
  }, [copied]);
  const onClick = async () => {
    const href = url ?? (typeof window !== "undefined" ? window.location.href : "");
    if (!href) return;
    const ok = await copy(href);
    if (ok) {
      toast.success("Link copied", {
        description: "Filters, sort, and pagination are preserved in the URL."
      });
      setAnnouncement(`Link copied to clipboard: ${href}`);
    } else {
      setAnnouncement("Couldn't copy link to clipboard.");
    }
  };
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick,
        "aria-label": "Copy link with current filters, sort, and page",
        title: "Copy link with current filters, sort, and page",
        className: classNames(
          "inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink hover:border-ink/30 transition-colors",
          className
        ),
        children: [
          copied ? /* @__PURE__ */ jsx(Check, { className: "size-3 text-health-ok" }) : /* @__PURE__ */ jsx(Share2, { className: "size-3 text-ink-muted" }),
          copied ? "Link copied" : label
        ]
      }
    ),
    /* @__PURE__ */ jsx("span", { role: "status", "aria-live": "polite", className: "sr-only", children: announcement })
  ] });
}
function timeAgoAbsoluteTitle(at) {
  if (!isUsableTimestamp(at)) return void 0;
  return formatFreshnessAbsolute(at) ?? void 0;
}
function TimeAgo({
  at,
  className,
  fallback = "\u2014"
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  const text = !at ? fallback : mounted ? formatRelative(at) : "";
  return /* @__PURE__ */ jsx(
    "span",
    {
      className,
      title: timeAgoAbsoluteTitle(at),
      suppressHydrationWarning: true,
      children: text
    }
  );
}
function hasApiErrorShape(err) {
  return typeof err === "object" && err !== null && typeof err.status === "number" && typeof err.url === "string";
}
function TableState({
  variant,
  title,
  description,
  generatedAt,
  cta,
  onRetry,
  error,
  className
}) {
  const tone = {
    empty: "border-border",
    stale: "border-health-warn/40",
    error: "border-health-down/40"
  }[variant];
  const Icon = { empty: Inbox, stale: Clock, error: AlertCircle }[variant];
  const iconCls = {
    empty: "text-accent",
    stale: "text-health-warn",
    error: "text-health-down"
  }[variant];
  const apiErr = hasApiErrorShape(error) ? error : null;
  const status = apiErr?.status;
  const url = apiErr?.url;
  const message = variant === "error" ? error?.message ?? "Unknown error" : void 0;
  return /* @__PURE__ */ jsxs(
    "div",
    {
      role: variant === "error" ? "alert" : void 0,
      className: classNames(
        "rounded-xl border bg-card px-8 py-16 text-center",
        tone,
        className
      ),
      children: [
        /* @__PURE__ */ jsx("div", { className: "mx-auto inline-flex size-10 items-center justify-center rounded-full border border-border bg-paper", children: /* @__PURE__ */ jsx(Icon, { className: classNames("size-4", iconCls) }) }),
        /* @__PURE__ */ jsx("h3", { className: "mt-4 font-display text-base font-semibold text-ink-strong tracking-tight", children: title }),
        description ? /* @__PURE__ */ jsx("p", { className: "mx-auto mt-1.5 max-w-md text-sm text-ink-muted leading-relaxed", children: description }) : null,
        variant === "stale" && generatedAt ? /* @__PURE__ */ jsxs("p", { className: "mt-3 font-mono text-[11px] text-ink-muted", children: [
          "Last verified ",
          /* @__PURE__ */ jsx(TimeAgo, { at: generatedAt })
        ] }) : null,
        message ? /* @__PURE__ */ jsxs("p", { className: "mx-auto mt-3 max-w-md font-mono text-[11px] text-ink-muted", children: [
          status ? /* @__PURE__ */ jsxs("span", { className: "text-health-down", children: [
            "HTTP ",
            status,
            " \xB7 "
          ] }) : null,
          message
        ] }) : null,
        cta || onRetry || url ? /* @__PURE__ */ jsxs("div", { className: "mt-5 flex flex-wrap items-center justify-center gap-2", children: [
          onRetry ? /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              onClick: onRetry,
              className: "inline-flex items-center gap-1.5 rounded-full border border-border bg-paper px-3.5 py-1.5 text-[12px] font-medium text-ink hover:border-accent/50 hover:text-accent transition-colors",
              children: [
                /* @__PURE__ */ jsx(RefreshCw, { className: "size-3" }),
                " Retry"
              ]
            }
          ) : null,
          cta ? /* @__PURE__ */ jsxs(
            "a",
            {
              href: cta.href,
              ...cta.external ? { target: "_blank", rel: "noopener noreferrer" } : {},
              className: "inline-flex items-center gap-1.5 rounded-full bg-ink-strong px-3.5 py-1.5 text-[12px] font-medium text-paper hover:opacity-90 transition-opacity",
              children: [
                cta.label,
                cta.external ? /* @__PURE__ */ jsx(ExternalLink$1, { className: "size-3" }) : null
              ]
            }
          ) : null,
          url ? /* @__PURE__ */ jsxs(
            "a",
            {
              href: url,
              target: "_blank",
              rel: "noopener noreferrer",
              className: "inline-flex items-center gap-1.5 text-[11px] font-mono text-ink-muted hover:text-ink-strong",
              children: [
                "View API URL ",
                /* @__PURE__ */ jsx(ExternalLink$1, { className: "size-3" })
              ]
            }
          ) : null
        ] }) : null
      ]
    }
  );
}
var OPTIONS = [
  { value: "table", label: "Table", Icon: List },
  { value: "grid", label: "Grid", Icon: LayoutGrid },
  { value: "matrix", label: "Matrix", Icon: Grid3x3 }
];
function ViewModeToggle({
  value,
  onChange,
  options = ["table", "grid", "matrix"],
  className
}) {
  const available = OPTIONS.filter((o) => options.includes(o.value));
  return /* @__PURE__ */ jsx(
    "div",
    {
      role: "tablist",
      "aria-label": "View mode",
      className: classNames(
        "inline-flex items-center rounded-md border border-border bg-card p-0.5",
        className
      ),
      children: available.map(({ value: v, label, Icon }) => {
        const active = v === value;
        return /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            role: "tab",
            "aria-selected": active,
            "aria-label": `Switch to ${label.toLowerCase()} view`,
            title: label,
            onClick: () => onChange(v),
            className: classNames(
              "inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors min-h-8",
              active ? "bg-surface text-ink-strong" : "text-ink-muted hover:text-ink-strong"
            ),
            children: [
              /* @__PURE__ */ jsx(Icon, { className: "size-3.5" }),
              /* @__PURE__ */ jsx("span", { className: "hidden sm:inline", children: label })
            ]
          },
          v
        );
      })
    }
  );
}
function Wordmark({ className }) {
  return /* @__PURE__ */ jsxs(
    "svg",
    {
      className,
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: "-5.00 -5.00 1190.44 164.29",
      fill: "none",
      role: "img",
      "aria-label": "Metagraphed",
      children: [
        /* @__PURE__ */ jsx(
          "path",
          {
            transform: "translate(0,0.000) scale(0.26813)",
            d: "M 315.5,1.1999999999999886 C 313.40000000000003,1.6999999999999886 281.7,32.799999999999955 206.5,107.89999999999998 C 146.5,167.89999999999998 99.30000000000001,214.39999999999998 97.7,215.0 C 95.9,215.6 79.4,216.0 52.300000000000004,216.0 C 11.4,216.0 9.600000000000001,216.1 6.5,218.0 C -0.4,222.29999999999998 0.0,215.79999999999998 0.0,328.7 C 0.0,428.5 0.0,430.6 2.0,433.8 C 6.0,440.3 12.9,442.5 19.5,439.4 C 21.3,438.6 70.9,389.4 130.6,329.3 C 223.9,235.5 239.20000000000002,220.39999999999998 243.8,218.39999999999998 C 249.0,216.0 249.5,216.0 281.8,216.0 C 312.40000000000003,216.0 314.70000000000005,216.1 317.70000000000005,218.0 C 319.40000000000003,219.0 321.5,220.89999999999998 322.20000000000005,222.2 C 323.20000000000005,224.0 323.6,245.1 324.0,328.0 L 324.5,431.5 L 326.8,434.8 C 331.0,440.6 338.1,442.6 343.8,439.6 C 345.3,438.8 395.8,388.8 456.0,328.5 C 516.2,268.2 566.7,218.2 568.2,217.39999999999998 C 570.4,216.29999999999998 577.3000000000001,216.0 605.2,216.0 C 637.4000000000001,216.0 639.7,216.1 642.7,218.0 C 644.4000000000001,219.0 646.5,220.89999999999998 647.2,222.2 C 648.2,224.0 648.6,245.7 649.0,331.7 C 649.5,438.1 649.5,438.9 651.6,441.7 C 654.8000000000001,446.1 659.7,448.2 665.0,447.5 C 669.4000000000001,447.0 670.6,445.9 707.3000000000001,409.2 C 728.1,388.5 745.8000000000001,370.3 746.6,368.8 C 747.8000000000001,366.5 748.0,354.9 748.0,295.79999999999995 C 748.0,228.0 747.9000000000001,225.39999999999998 746.0,222.29999999999998 C 742.5,216.5 742.6,216.5 703.3000000000001,216.0 C 668.7,215.5 667.0,215.39999999999998 664.3000000000001,213.39999999999998 C 662.8000000000001,212.29999999999998 660.7,209.79999999999998 659.8000000000001,207.89999999999998 C 658.1,204.7 658.0,197.89999999999998 658.0,107.79999999999995 C 658.0,-0.7000000000000455 658.4000000000001,5.7999999999999545 650.8000000000001,1.8999999999999773 C 646.6,-0.20000000000004547 643.4000000000001,-0.5 639.3000000000001,1.099999999999966 C 637.7,1.6999999999999886 590.2,48.599999999999966 529.9,109.09999999999997 L 423.3,216.1 L 382.70000000000005,215.79999999999998 C 343.5,215.5 342.1,215.39999999999998 339.3,213.39999999999998 C 337.8,212.29999999999998 335.70000000000005,209.79999999999998 334.8,207.89999999999998 C 333.1,204.7 333.0,197.89999999999998 333.0,107.69999999999999 C 333.0,4.099999999999966 333.20000000000005,8.199999999999989 328.1,3.599999999999966 C 325.6,1.2999999999999545 319.5,0.0999999999999659 315.5,1.1999999999999886",
            fill: "#30FFC0"
          }
        ),
        /* @__PURE__ */ jsxs(
          "g",
          {
            transform: "translate(216.673,120.000) scale(0.171429,-0.171429)",
            fill: "currentColor",
            children: [
              /* @__PURE__ */ jsx(
                "path",
                {
                  transform: "translate(0,0)",
                  d: "M296 -14Q222 -14 165.5 17.5Q109 49 77.5 106.5Q46 164 46 242V254Q46 332 77.0 389.5Q108 447 164.0 478.5Q220 510 294 510Q367 510 421.0 477.5Q475 445 505.0 387.5Q535 330 535 254V211H174Q176 160 212.0 128.0Q248 96 300 96Q353 96 378.0 119.0Q403 142 416 170L519 116Q505 90 478.5 59.5Q452 29 408.0 7.5Q364 -14 296 -14ZM175 305H407Q403 348 372.5 374.0Q342 400 293 400Q242 400 212.0 374.0Q182 348 175 305Z"
                }
              ),
              /* @__PURE__ */ jsx(
                "path",
                {
                  transform: "translate(577,0)",
                  d: "M260 0Q211 0 180.5 30.5Q150 61 150 112V392H26V496H150V650H276V496H412V392H276V134Q276 104 304 104H400V0Z"
                }
              ),
              /* @__PURE__ */ jsx(
                "path",
                {
                  transform: "translate(1033,0)",
                  d: "M224 -14Q171 -14 129.0 4.5Q87 23 62.5 58.5Q38 94 38 145Q38 196 62.5 230.5Q87 265 130.5 282.5Q174 300 230 300H366V328Q366 363 344.0 385.5Q322 408 274 408Q227 408 204.0 386.5Q181 365 174 331L58 370Q70 408 96.5 439.5Q123 471 167.5 490.5Q212 510 276 510Q374 510 431.0 461.0Q488 412 488 319V134Q488 104 516 104H556V0H472Q435 0 411.0 18.0Q387 36 387 66V67H368Q364 55 350.0 35.5Q336 16 306.0 1.0Q276 -14 224 -14ZM246 88Q299 88 332.5 117.5Q366 147 366 196V206H239Q204 206 184.0 191.0Q164 176 164 149Q164 122 185.0 105.0Q206 88 246 88Z"
                }
              ),
              /* @__PURE__ */ jsx(
                "path",
                {
                  transform: "translate(1611,0)",
                  d: "M46 246V262Q46 340 77.0 395.5Q108 451 159.5 480.5Q211 510 272 510Q340 510 375.0 486.0Q410 462 426 436H444V496H568V-88Q568 -139 538.0 -169.5Q508 -200 458 -200H126V-90H414Q442 -90 442 -60V69H424Q414 53 396.0 36.5Q378 20 348.0 9.0Q318 -2 272 -2Q211 -2 159.5 27.5Q108 57 77.0 112.5Q46 168 46 246ZM308 108Q366 108 405.0 145.0Q444 182 444 249V259Q444 327 405.5 363.5Q367 400 308 400Q250 400 211.0 363.5Q172 327 172 259V249Q172 182 211.0 145.0Q250 108 308 108Z"
                }
              ),
              /* @__PURE__ */ jsx(
                "path",
                {
                  transform: "translate(2249,0)",
                  d: "M70 0V496H194V440H212Q223 470 248.5 484.0Q274 498 308 498H368V386H306Q258 386 227.0 360.5Q196 335 196 282V0Z"
                }
              ),
              /* @__PURE__ */ jsx(
                "path",
                {
                  transform: "translate(2645,0)",
                  d: "M224 -14Q171 -14 129.0 4.5Q87 23 62.5 58.5Q38 94 38 145Q38 196 62.5 230.5Q87 265 130.5 282.5Q174 300 230 300H366V328Q366 363 344.0 385.5Q322 408 274 408Q227 408 204.0 386.5Q181 365 174 331L58 370Q70 408 96.5 439.5Q123 471 167.5 490.5Q212 510 276 510Q374 510 431.0 461.0Q488 412 488 319V134Q488 104 516 104H556V0H472Q435 0 411.0 18.0Q387 36 387 66V67H368Q364 55 350.0 35.5Q336 16 306.0 1.0Q276 -14 224 -14ZM246 88Q299 88 332.5 117.5Q366 147 366 196V206H239Q204 206 184.0 191.0Q164 176 164 149Q164 122 185.0 105.0Q206 88 246 88Z"
                }
              ),
              /* @__PURE__ */ jsx(
                "path",
                {
                  transform: "translate(3223,0)",
                  d: "M70 -200V496H194V436H212Q229 465 265.0 487.5Q301 510 368 510Q428 510 479.0 480.5Q530 451 561.0 394.0Q592 337 592 256V240Q592 159 561.0 102.0Q530 45 479.0 15.5Q428 -14 368 -14Q323 -14 292.5 -3.5Q262 7 243.5 23.5Q225 40 214 57H196V-200ZM330 96Q389 96 427.5 133.5Q466 171 466 243V253Q466 325 427.0 362.5Q388 400 330 400Q272 400 233.0 362.5Q194 325 194 253V243Q194 171 233.0 133.5Q272 96 330 96Z"
                }
              ),
              /* @__PURE__ */ jsx(
                "path",
                {
                  transform: "translate(3861,0)",
                  d: "M70 0V700H196V435H214Q222 451 239.0 467.0Q256 483 284.5 493.5Q313 504 357 504Q415 504 458.5 477.5Q502 451 526.0 404.5Q550 358 550 296V0H424V286Q424 342 396.5 370.0Q369 398 318 398Q260 398 228.0 359.5Q196 321 196 252V0Z"
                }
              ),
              /* @__PURE__ */ jsx(
                "path",
                {
                  transform: "translate(4477,0)",
                  d: "M296 -14Q222 -14 165.5 17.5Q109 49 77.5 106.5Q46 164 46 242V254Q46 332 77.0 389.5Q108 447 164.0 478.5Q220 510 294 510Q367 510 421.0 477.5Q475 445 505.0 387.5Q535 330 535 254V211H174Q176 160 212.0 128.0Q248 96 300 96Q353 96 378.0 119.0Q403 142 416 170L519 116Q505 90 478.5 59.5Q452 29 408.0 7.5Q364 -14 296 -14ZM175 305H407Q403 348 372.5 374.0Q342 400 293 400Q242 400 212.0 374.0Q182 348 175 305Z"
                }
              ),
              /* @__PURE__ */ jsx(
                "path",
                {
                  transform: "translate(5054,0)",
                  d: "M270 -14Q211 -14 159.5 15.5Q108 45 77.0 102.0Q46 159 46 240V256Q46 337 77.0 394.0Q108 451 159.0 480.5Q210 510 270 510Q315 510 345.5 499.5Q376 489 395.0 473.0Q414 457 424 439H442V700H568V0H444V60H426Q409 32 373.5 9.0Q338 -14 270 -14ZM308 96Q366 96 405.0 133.5Q444 171 444 243V253Q444 325 405.5 362.5Q367 400 308 400Q250 400 211.0 362.5Q172 327 172 253V243Q172 171 211.0 133.5Q250 96 308 96Z"
                }
              )
            ]
          }
        )
      ]
    }
  );
}
function DiscordIcon({ className, ...props }) {
  return /* @__PURE__ */ jsx(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "currentColor",
      "aria-hidden": "true",
      className,
      ...props,
      children: /* @__PURE__ */ jsx("path", { d: "M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" })
    }
  );
}
var SCOPES = [
  { key: "all", label: "All" },
  { key: "subnet", label: "Subnets" },
  { key: "surface", label: "Surfaces" },
  { key: "endpoint", label: "Endpoints" },
  { key: "provider", label: "Providers" },
  { key: "schema", label: "Schemas" }
];
function SearchScopeChip({
  value,
  onChange
}) {
  const current = SCOPES.find((s) => s.key === value) ?? SCOPES[0];
  return /* @__PURE__ */ jsxs(Popover, { children: [
    /* @__PURE__ */ jsx(PopoverTrigger, { asChild: true, children: /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        "aria-label": `Search scope: ${current.label}`,
        className: "inline-flex items-center gap-1 rounded-full border border-border bg-paper px-2.5 py-1 text-[11px] font-mono uppercase tracking-widest text-ink-muted hover:text-ink-strong hover:border-accent/40 transition-colors shrink-0",
        children: [
          current.label,
          /* @__PURE__ */ jsx(ChevronDown, { className: "size-3 opacity-70" })
        ]
      }
    ) }),
    /* @__PURE__ */ jsx(PopoverContent, { align: "start", className: "w-44 p-1", children: /* @__PURE__ */ jsx("ul", { children: SCOPES.map((s) => /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        onClick: () => onChange(s.key),
        className: classNames(
          "w-full text-left px-2 py-1.5 rounded text-[12px] transition-colors",
          s.key === value ? "bg-surface text-ink-strong" : "text-ink hover:bg-surface/60"
        ),
        children: s.label
      }
    ) }, s.key)) }) })
  ] });
}
var PREVIEW_COUNT = 24;
function visibleTools(tools, open) {
  return open ? tools : tools.slice(0, PREVIEW_COUNT);
}
function McpToolsList({
  tools
}) {
  const [open, setOpen] = useState(false);
  const hasMore = tools.length > PREVIEW_COUNT;
  return /* @__PURE__ */ jsxs("div", { className: "mt-2", children: [
    /* @__PURE__ */ jsx("div", { className: "flex flex-wrap gap-1.5", children: visibleTools(tools, open).map((t) => /* @__PURE__ */ jsx(
      "span",
      {
        title: t.title,
        className: "inline-flex items-center rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-ink-muted",
        children: t.name
      },
      t.name
    )) }),
    hasMore ? /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        onClick: () => setOpen((v) => !v),
        "aria-expanded": open,
        className: classNames(
          "mt-2 inline-flex items-center gap-1 font-mono text-[10px] text-ink-muted",
          "hover:text-accent transition-colors"
        ),
        children: open ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx(ChevronUp, { className: "size-3" }),
          " Show fewer"
        ] }) : /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx(ChevronDown, { className: "size-3" }),
          " Show all ",
          tools.length,
          " tools"
        ] })
      }
    ) : null
  ] });
}

// src/components/metagraphed/yield-format.ts
function fmtYield(v) {
  if (v == null || !Number.isFinite(v)) return "\u2014";
  if (v === 0) return "0%";
  const pct = v * 100;
  if (Math.abs(pct) >= 1) return `${pct.toFixed(2)}%`;
  if (Math.abs(pct) >= 1e-3) return `${pct.toPrecision(5)}%`;
  return `${pct.toExponential(2)}%`;
}

// src/components/metagraphed/yield-percentile-layout.ts
var YIELD_PERCENTILE_STRIP_CONTAINER_CLASS = "@container rounded-xl border border-border bg-card p-4";
var YIELD_PERCENTILE_STRIP_GRID_CLASS = "grid grid-cols-2 gap-3 @min-[28rem]:grid-cols-4";
var YIELD_PERCENTILE_LABEL_CLASS = "font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted";
var YIELD_PERCENTILE_VALUE_CLASS = "mt-1 min-w-0 truncate font-display text-sm font-semibold tabular-nums text-ink-strong leading-none @min-[20rem]:text-base @min-[28rem]:text-lg";
var PERCENTILE_LABELS = {
  p25: "p25",
  median: "Median",
  p75: "p75",
  p90: "p90"
};
function buildYieldPercentileData(input) {
  const { formatYield } = input;
  return ["p25", "median", "p75", "p90"].map((key) => ({
    key,
    label: PERCENTILE_LABELS[key],
    value: formatYield(
      key === "p25" ? input.p25_yield : key === "median" ? input.median_yield : key === "p75" ? input.p75_yield : input.p90_yield
    )
  }));
}
function PercentileFact({ label, value }) {
  return /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
    /* @__PURE__ */ jsx("div", { className: YIELD_PERCENTILE_LABEL_CLASS, children: label }),
    /* @__PURE__ */ jsx("div", { className: YIELD_PERCENTILE_VALUE_CLASS, children: value })
  ] });
}
function YieldPercentileStrip({
  p25_yield,
  median_yield,
  p75_yield,
  p90_yield,
  data
}) {
  const tiles = data ?? buildYieldPercentileData({
    p25_yield,
    median_yield,
    p75_yield,
    p90_yield,
    formatYield: fmtYield
  });
  return /* @__PURE__ */ jsx(
    "section",
    {
      className: YIELD_PERCENTILE_STRIP_CONTAINER_CLASS,
      "aria-label": "Yield percentile distribution",
      children: /* @__PURE__ */ jsx("div", { className: YIELD_PERCENTILE_STRIP_GRID_CLASS, children: tiles.map((tile) => /* @__PURE__ */ jsx(
        PercentileFact,
        {
          label: tile.label,
          value: tile.value
        },
        tile.key
      )) })
    }
  );
}
function host(url) {
  if (!url) return "";
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return url;
  }
}
function PrimaryLinksRail({
  website,
  docs,
  repo,
  dashboard,
  extras
}) {
  const items = [
    { label: "Website", href: website, icon: Globe },
    { label: "Docs", href: docs, icon: BookOpen },
    { label: "Repository", href: repo, icon: Github },
    { label: "Dashboard", href: dashboard, icon: LayoutDashboard },
    ...(extras ?? []).map((e) => ({
      label: e.label,
      href: e.href,
      icon: e.icon ?? Globe
    }))
  ].filter((i) => safeExternalUrl(i.href));
  if (items.length === 0) return null;
  return /* @__PURE__ */ jsx("div", { className: "flex flex-wrap items-center gap-2", children: items.map((it) => {
    const Icon = it.icon;
    const href = safeExternalUrl(it.href);
    return /* @__PURE__ */ jsxs(
      "a",
      {
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        className: "group inline-flex items-center gap-2 rounded border border-border bg-card px-2.5 py-1.5 text-xs font-medium text-ink-strong hover:border-ink/30 transition-colors",
        children: [
          /* @__PURE__ */ jsx(Icon, { className: "size-3.5 text-ink-muted" }),
          /* @__PURE__ */ jsx("span", { children: it.label }),
          /* @__PURE__ */ jsx("span", { className: "hidden sm:inline font-mono text-[10px] text-ink-muted", children: host(href) }),
          /* @__PURE__ */ jsx(ExternalLink$1, { className: "size-3 text-ink-muted opacity-60 group-hover:opacity-100" })
        ]
      },
      it.label + href
    );
  }) });
}
function ProfileHero({
  eyebrow,
  title,
  subtitle,
  description,
  chips,
  links,
  stats,
  banner,
  icon
}) {
  const visibleStats = (stats ?? []).filter(
    (s) => s.value !== void 0 && s.value !== null && s.value !== ""
  );
  return /* @__PURE__ */ jsxs("header", { className: "mg-hero-slab relative pt-8 md:pt-12 pb-8 md:pb-10 mb-6", children: [
    banner ? /* @__PURE__ */ jsx("div", { className: "mb-5", children: banner }) : null,
    /* @__PURE__ */ jsxs("div", { className: "grid gap-6 md:grid-cols-[minmax(0,1fr)_auto] md:items-start", children: [
      /* @__PURE__ */ jsxs("div", { className: "flex items-start gap-4 min-w-0", children: [
        icon ? /* @__PURE__ */ jsx("div", { className: "shrink-0 mt-1", children: icon }) : null,
        /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
          eyebrow ? /* @__PURE__ */ jsx("div", { className: "font-mono text-[10px] uppercase tracking-[0.2em] text-ink-muted mb-2", children: eyebrow }) : null,
          /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-baseline gap-x-4 gap-y-1", children: [
            /* @__PURE__ */ jsx("h1", { className: "font-display text-3xl md:text-4xl font-semibold tracking-[-0.01em] text-ink-strong", children: title }),
            subtitle ? /* @__PURE__ */ jsx("span", { className: "font-mono text-xs md:text-sm text-ink-muted", children: subtitle }) : null
          ] }),
          description ? /* @__PURE__ */ jsx("p", { className: "mt-3 text-sm md:text-base text-ink-muted max-w-3xl leading-relaxed", children: description }) : null
        ] })
      ] }),
      chips ? /* @__PURE__ */ jsx("div", { className: "flex flex-wrap items-center gap-1.5 md:justify-end shrink-0 max-w-md", children: chips }) : null
    ] }),
    links ? /* @__PURE__ */ jsx("div", { className: "mt-6", children: links }) : null,
    visibleStats.length > 0 ? /* @__PURE__ */ jsx("div", { className: "mg-kpi-strip mt-8 md:mt-10", children: visibleStats.map((s) => /* @__PURE__ */ jsxs("div", { children: [
      /* @__PURE__ */ jsx("div", { className: "font-mono text-[10px] uppercase tracking-[0.18em] text-ink-muted", children: s.label }),
      /* @__PURE__ */ jsx("div", { className: "mt-1.5 font-display text-xl md:text-2xl font-semibold text-ink-strong tabular-nums leading-none", children: s.value }),
      s.hint ? /* @__PURE__ */ jsx("div", { className: "mt-1 text-[10px] text-ink-muted", children: s.hint }) : null
    ] }, s.label)) }) : null
  ] });
}
function MethodologyCallout({
  generatedAt,
  windowLabel
}) {
  const [open, setOpen] = useState(false);
  const freshLine = formatFreshness(generatedAt, windowLabel);
  const freshAbs = formatFreshnessAbsolute(generatedAt);
  return /* @__PURE__ */ jsxs(
    "aside",
    {
      "aria-label": "Data freshness and methodology",
      className: "mb-6 rounded-lg border border-border bg-card/60",
      children: [
        /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            onClick: () => setOpen((o) => !o),
            "aria-expanded": open,
            className: "flex w-full items-start gap-2 px-3 py-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            children: [
              /* @__PURE__ */ jsx(Info, { className: "mt-0.5 size-3.5 shrink-0 text-accent" }),
              /* @__PURE__ */ jsxs("span", { className: "min-w-0 flex-1", children: [
                /* @__PURE__ */ jsx("span", { className: "block font-mono text-[10px] uppercase tracking-widest text-ink-muted", children: "Data freshness & methodology" }),
                freshLine ? /* @__PURE__ */ jsx(
                  "span",
                  {
                    className: "mt-0.5 block font-mono text-[10px] text-ink-muted/80",
                    title: freshAbs ?? void 0,
                    children: freshLine
                  }
                ) : null
              ] }),
              /* @__PURE__ */ jsx(
                ChevronDown,
                {
                  className: classNames(
                    "mt-0.5 size-3.5 shrink-0 text-ink-muted transition-transform",
                    open && "rotate-180"
                  )
                }
              )
            ]
          }
        ),
        open ? /* @__PURE__ */ jsxs("div", { className: "grid gap-3 border-t border-border px-3 py-3 text-[11.5px] leading-relaxed text-ink-muted md:grid-cols-2", children: [
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("div", { className: "font-mono text-[10px] uppercase tracking-widest text-ink-strong", children: "Sparklines" }),
            /* @__PURE__ */ jsx("p", { className: "mt-1", children: "Uptime & latency sparklines plot the active health window (7d default, switchable to 30d). Each point is the mean across every tracked endpoint in that bucket \u2014 gaps mean no probe landed in the window, not zero." })
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("div", { className: "font-mono text-[10px] uppercase tracking-widest text-ink-strong", children: "Donuts & mosaics" }),
            /* @__PURE__ */ jsx("p", { className: "mt-1", children: "Pool ratio comes from on-chain AMM reserves; endpoint topology counts tracked public surfaces by kind. The mosaic in Operational status colors one cell per endpoint by its last probe result." })
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("div", { className: "font-mono text-[10px] uppercase tracking-widest text-ink-strong", children: "Staleness" }),
            /* @__PURE__ */ jsxs("p", { className: "mt-1", children: [
              "Tiles show a ",
              /* @__PURE__ */ jsx("span", { className: "text-health-warn-text", children: "stale" }),
              " ",
              "chip when the snapshot is older than the refresh budget. Visuals still render with the last known values; retry buttons re-fetch just the affected panel. Each tile carries its own",
              " ",
              /* @__PURE__ */ jsx("span", { className: "text-ink-strong", children: "updated \xB7 window" }),
              " stamp so you can tell stale from missing at a glance."
            ] })
          ] }),
          /* @__PURE__ */ jsxs("div", { children: [
            /* @__PURE__ */ jsx("div", { className: "font-mono text-[10px] uppercase tracking-widest text-ink-strong", children: "Verified vs. candidate" }),
            /* @__PURE__ */ jsx("p", { className: "mt-1", children: "Only curated surfaces feed donuts and the topology breakdown. Unverified leads live in the Candidates tab and never count toward health, completeness, or pool ratios." })
          ] })
        ] }) : null
      ]
    }
  );
}

export { AccentBand, Accordion, AccordionContent, AccordionItem, AccordionTrigger, AnimatedNumber, BackToTop, BrandIcon, CandidateChip, Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut, CopyButton, CopyIconToggle, CopyableCode, CurationChip, DailyRollupFreshness, DensityToggle, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger, DiscordIcon, DownloadCsvButton, EligibilityChip, ExternalLink, FreshnessBadge, FreshnessIndicator, HealthDot, HealthPill, HoverCard, HoverCardContent, HoverCardTrigger, HoverPreview, InfoTooltip, Kbd, KeyChip, ListCard, ListShell, LoadMore, McpToolsList, MethodologyCallout, PageHero, PageSection, Popover, PopoverAnchor, PopoverContent, PopoverTrigger, PrimaryLinksRail, ProfileHero, ReviewChip, SCOPES, ScrollReveal, SearchScopeChip, SectionAnchor, SectionHeading, ShareButton, Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetOverlay, SheetPortal, SheetTitle, SheetTrigger, Skeleton, TableState, TimeAgo, Toaster, Tooltip, TooltipContent, TooltipProvider, TooltipTrigger, ViewModeToggle, Wordmark, YieldPercentileStrip, buildCsvDownloadUrl, cn, fmtYield, freshnessBadgeTimeCopy, freshnessDotClass, freshnessTierLabel, prefetchBrandIcon, safeExternalUrl, timeAgoAbsoluteTitle, visibleTools };
