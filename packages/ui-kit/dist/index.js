import clsx from 'clsx';
import { twMerge } from 'tailwind-merge';
import * as React3 from 'react';
import { createContext, forwardRef, useId, useState, useMemo, useCallback, useRef, useEffect, useContext, useReducer, useLayoutEffect, Children, isValidElement } from 'react';
import * as AccordionPrimitive from '@radix-ui/react-accordion';
import { ChevronDown, X, Search, Check, ArrowUp, Copy, Download, AlertCircle, RefreshCw, Share2, ChevronLeft, ChevronRight, Clock, Inbox, ExternalLink as ExternalLink$1, ChevronUp, Columns3, RotateCcw, AlertTriangle, Filter, Loader2, Lock } from 'lucide-react';
import { jsx, jsxs, Fragment } from 'react/jsx-runtime';
import { Command as Command$1 } from 'cmdk';
import * as DialogPrimitive from '@radix-ui/react-dialog';
import * as PopoverPrimitive from '@radix-ui/react-popover';
import { cva } from 'class-variance-authority';
import { Toaster as Toaster$1, toast } from 'sonner';

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
      "flex flex-1 items-center justify-between py-4 text-13 font-medium cursor-pointer transition-all hover:underline text-left [&[data-state=open]>svg]:rotate-180",
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
    className: "overflow-hidden text-13 data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down",
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
      "fixed inset-0 z-[var(--mg-z-modal)] bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
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
        "fixed left-[50%] top-[50%] z-[var(--mg-z-modal)] grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded",
        className
      ),
      ...props,
      children: [
        children,
        /* @__PURE__ */ jsxs(DialogPrimitive.Close, { className: "absolute right-4 top-4 rounded opacity-70 ring-offset-background cursor-pointer transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground", children: [
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
    className: cn("text-16 font-semibold leading-none", className),
    ...props
  }
));
DialogTitle.displayName = DialogPrimitive.Title.displayName;
var DialogDescription = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  DialogPrimitive.Description,
  {
    ref,
    className: cn("text-13 text-muted-foreground", className),
    ...props
  }
));
DialogDescription.displayName = DialogPrimitive.Description.displayName;
var Command = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  Command$1,
  {
    ref,
    className: cn(
      "flex h-full w-full flex-col overflow-hidden rounded bg-popover text-popover-foreground",
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
        "flex h-10 w-full rounded bg-transparent py-3 text-13 outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
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
    className: "py-6 text-center text-13",
    ...props
  }
));
CommandEmpty.displayName = Command$1.Empty.displayName;
var CommandGroup = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  Command$1.Group,
  {
    ref,
    className: cn(
      "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-13 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
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
      "relative flex cursor-default gap-2 select-none items-center rounded px-2 py-1.5 text-13 outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
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
      className: cn("ml-auto text-13 text-muted-foreground", className),
      ...props
    }
  );
};
CommandShortcut.displayName = "CommandShortcut";
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
      "z-[var(--mg-z-modal)] w-72 rounded border bg-popover p-4 text-popover-foreground outline-none data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 origin-(--radix-popover-content-transform-origin)",
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
      "fixed inset-0 z-[var(--mg-z-modal)] bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    ),
    ...props,
    ref
  }
));
SheetOverlay.displayName = DialogPrimitive.Overlay.displayName;
var sheetVariants = cva(
  "fixed z-[var(--mg-z-modal)] gap-4 bg-background p-6 transition ease-in-out data-[state=closed]:duration-300 data-[state=open]:duration-500 data-[state=open]:animate-in data-[state=closed]:animate-out",
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
        /* @__PURE__ */ jsxs(DialogPrimitive.Close, { className: "absolute right-4 top-4 rounded opacity-70 ring-offset-background cursor-pointer transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary", children: [
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
    className: cn("text-16 font-semibold text-foreground", className),
    ...props
  }
));
SheetTitle.displayName = DialogPrimitive.Title.displayName;
var SheetDescription = React3.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsx(
  DialogPrimitive.Description,
  {
    ref,
    className: cn("text-13 text-muted-foreground", className),
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
          toast: "group toast group-[.toaster]:bg-background group-[.toaster]:text-foreground group-[.toaster]:border-border",
          description: "group-[.toast]:text-muted-foreground",
          actionButton: "group-[.toast]:bg-primary group-[.toast]:text-primary-foreground",
          cancelButton: "group-[.toast]:bg-muted group-[.toast]:text-muted-foreground"
        }
      },
      ...props
    }
  );
};
function Skeleton({ className = "h-4 w-full" }) {
  return /* @__PURE__ */ jsx("div", { className: `animate-pulse rounded bg-surface-2 ${className}` });
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
      setFlash(safe > from ? "" : "");
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
var BOTTOM_HIDE_GAP = 96;
function BackToTop({ threshold = 600 }) {
  const [visible, setVisible] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    function onScroll() {
      const scrolledPast = window.scrollY > threshold;
      const doc = document.documentElement;
      const distanceToBottom = doc.scrollHeight - (window.scrollY + window.innerHeight);
      setVisible(scrolledPast && distanceToBottom > BOTTOM_HIDE_GAP);
    }
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
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
        "fixed z-[var(--mg-z-overlay)] bottom-5 right-5 md:bottom-7 md:right-7",
        "inline-flex items-center gap-1.5 rounded border border-border",
        "px-3 py-2 text-11 text-ink-strong",
        "hover:border-accent/60 hover:text-accent",
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
function isIpLiteral(host) {
  if (host.startsWith("[") && host.endsWith("]")) return true;
  if (host.includes(":")) return true;
  const parts = host.split(".");
  if (parts.length !== 4 || parts.some((p) => !/^\d+$/.test(p))) return false;
  return parts.every((p) => {
    const n = Number(p);
    return Number.isInteger(n) && n >= 0 && n <= 255;
  });
}
function normalizePublicProxyHost(host) {
  const normalized = String(host ?? "").trim().toLowerCase().replace(/^www\./, "").replace(/\.$/, "");
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
function buildProxyIconUrl(host, size, theme = "light") {
  const safeHost = normalizePublicProxyHost(host);
  if (!safeHost) return null;
  const u = new URL(ICON_PROXY_URL);
  u.searchParams.set("host", safeHost);
  u.searchParams.set("size", String(size));
  u.searchParams.set("theme", theme);
  return u.toString();
}
var GITHUB_ORG_RE = /^[A-Za-z0-9](?:[A-Za-z0-9]|-(?=[A-Za-z0-9])){0,38}$/;
function githubOrgFromUrl(input) {
  if (!input) return null;
  try {
    const u = new URL(input.includes("://") ? input : `https://${input}`);
    const host = u.hostname.toLowerCase();
    if (host !== "github.com" && !host.endsWith(".github.com")) return null;
    const org = u.pathname.split("/").filter(Boolean)[0];
    return org && GITHUB_ORG_RE.test(org) ? org : null;
  } catch {
    return null;
  }
}
function buildProxyGithubAvatarUrl(repoUrl, size, theme = "light") {
  const org = githubOrgFromUrl(repoUrl);
  if (!org) return null;
  const u = new URL(ICON_PROXY_URL);
  u.searchParams.set("github_org", org);
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
  manifold: "https://github.com/manifold-inc.png?size=192",
  "cortex-t": "https://github.com/corcel-api.png?size=192",
  academia: "https://github.com/fx-integral.png?size=192",
  chipforge: "https://github.com/TatsuProject.png?size=192",
  coldint: "https://github.com/coldint.png?size=192",
  // Infra / data providers
  dwellir: "https://github.com/Dwellir.png?size=192",
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
function initialsSize(size) {
  if (size < 26) return 10;
  if (size < 32) return 11;
  if (size < 44) return 13;
  return 16;
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
function shouldUseAnonymousCors(candidate) {
  return isProxiedIcon(candidate);
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
  const host = extractHost(url);
  if (host) push(buildProxyIconUrl(host, size * 2, theme));
  push(buildProxyGithubAvatarUrl(repoUrl, 192, theme));
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
    if (shouldUseAnonymousCors(first)) {
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
  const host = useMemo(() => extractHost(url), [url]);
  const lookup = useMemo(
    () => ({ providerSlug, subnetSlug, netuid }),
    [providerSlug, subnetSlug, netuid]
  );
  const chain = useMemo(
    () => buildCandidateChain({ url, iconUrl, repoUrl, lookup, theme, size }),
    [url, iconUrl, repoUrl, lookup, theme, size]
  );
  const initialIndex = useMemo(() => {
    if (!host) return 0;
    const winner = winnerByHost.get(host);
    if (!winner) return 0;
    const idx = chain.indexOf(winner);
    return idx >= 0 ? idx : 0;
  }, [host, chain]);
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
        if (host) winnerByHost.set(host, candidate);
        if (!isDarkLogo.has(candidate)) {
          const luma = analyseLogoLuminance(img);
          if (luma !== null) isDarkLogo.set(candidate, luma < 0.55);
        }
        const isDark = isDarkLogo.get(candidate);
        setNeedsContrastTile(theme === "dark" && isDark === true);
      }
      setLoaded(true);
    },
    [candidate, advance, host, size, theme]
  );
  const baseClasses = classNames(
    "relative inline-flex items-center justify-center shrink-0 overflow-hidden",
    "rounded border border-border",
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
        children: /* @__PURE__ */ jsx(
          "span",
          {
            className: "font-display font-semibold tabular-nums leading-none",
            style: { fontSize: initialsSize(size) },
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
                style: { fontSize: initialsSize(size) },
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
            crossOrigin: shouldUseAnonymousCors(candidate) ? "anonymous" : void 0,
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
      className: classNames(
        "relative inline-block size-2 rounded-full mg-dot shrink-0",
        color,
        shouldPulse && "",
        className
      )
    }
  );
  if (variant === "dot") return dot;
  return /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
    dot,
    /* @__PURE__ */ jsx("span", { className: "text-13 font-medium text-ink", children: label })
  ] });
}
function HealthPill({
  state,
  label
}) {
  if (label) {
    return /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
      /* @__PURE__ */ jsx(HealthDot, { state }),
      /* @__PURE__ */ jsx("span", { className: "text-13 font-medium text-ink", children: label })
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
        "inline-flex items-center rounded border px-1.5 py-0.5 text-13 font-medium",
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
        "inline-flex items-center rounded border px-1.5 py-0.5 text-13 font-medium",
        reviewCls[key]
      ),
      title: `Maintainer review: ${key}`,
      children: reviewLabel[key]
    }
  );
}
function CandidateChip() {
  return /* @__PURE__ */ jsx("span", { className: "inline-flex items-center rounded border border-dashed border-ink-subtle bg-transparent px-1.5 py-0.5 text-13 font-medium text-ink-muted", children: "Unverified" });
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
function CopyStatusRegion({ children }) {
  return /* @__PURE__ */ jsx("span", { role: "status", "aria-live": "polite", className: "sr-only", children });
}
function CopyButton({
  value,
  label,
  className,
  compact
}) {
  const { copied, copy } = useCopy({ label });
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        onClick: () => copy(value),
        "aria-label": copied ? "Copied" : `Copy ${label ?? "value"}`,
        title: copied ? "Copied!" : `Copy ${label ?? "value"}`,
        className: classNames(
          // min-h-11 min-w-11 gives the icon-only button the same 44px minimum
          // touch target as every other header icon button in the shell (the
          // convention list-shell.tsx documents); p-1 keeps the icon itself compact
          // and centered within that hit area.
          "shrink-0 inline-flex items-center justify-center rounded p-1 min-h-11 min-w-11 text-ink-muted hover:text-ink-strong transition-colors",
          // Focus ring drawn inside the 44px box (ring-inset) so it stays visible
          // rather than clipping against a `compact` row's -my-3.5 fold or a
          // tight table cell. KeyChip's own ring-offset treatment can't be reused
          // verbatim here for that reason (#6371).
          "focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent/60",
          compact && "-my-3.5",
          className
        ),
        children: /* @__PURE__ */ jsx(CopyIconToggle, { copied })
      }
    ),
    /* @__PURE__ */ jsx(CopyStatusRegion, { children: copied ? `${label ?? "Value"} copied to clipboard` : "" })
  ] });
}
function CopyableCode({
  value,
  label,
  className,
  truncate = true
}) {
  const { copied, copy } = useCopy({ label: label ?? "value" });
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick: () => copy(value),
        title: value,
        "aria-label": copied ? "Copied" : `Copy ${label ?? "value"}`,
        className: classNames(
          "group inline-flex min-w-0 items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-left text-11 text-ink hover:border-ink/30 transition-colors",
          // `truncate={false}` means "wrap instead of truncate," which only
          // makes sense once the box is width-bound -- otherwise `inline-flex`
          // shrink-to-fit sizing lets it grow to its unwrapped content width
          // and overflow the parent instead of wrapping (#8113). Every
          // existing call site already compensated with its own `w-full`/
          // `max-w-full` className; make that the default instead of
          // something each caller has to remember.
          !truncate && "w-full",
          // Matches KeyChip's ring treatment -- this one is a bordered chip like
          // KeyChip (not an icon-only hit area), so the offset ring reads cleanly
          // against the card behind it (#6371).
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-card",
          className
        ),
        children: [
          label ? /* @__PURE__ */ jsx("span", { className: "shrink-0 text-ink-muted text-11", children: label }) : null,
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
    ),
    /* @__PURE__ */ jsx(CopyStatusRegion, { children: copied ? `${label ?? "Value"} copied to clipboard` : "" })
  ] });
}
function buildCsvDownloadUrl(url) {
  const parsed = new URL(url);
  parsed.searchParams.set("format", "csv");
  return parsed.toString();
}
function DownloadCsvButton({
  url,
  label = "Download CSV",
  className,
  bare
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
      className: classNames(
        bare ? "inline-flex items-center gap-1.5 rounded px-2 py-1 min-h-8 text-13 font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" : (
          // rounded-full matches the pill idiom shared by SectionBadge/FilterChip/
          // other compact header controls it commonly sits next to — a plain
          // `rounded` rectangle reads as a mismatched shape beside a pill.
          "inline-flex items-center gap-1.5 rounded border border-border bg-card p-1.5 text-13 font-medium text-ink hover:border-ink/30 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-2.5 sm:py-1"
        ),
        className
      ),
      children: [
        /* @__PURE__ */ jsx(Download, { className: "size-3 text-ink-muted", "aria-hidden": true }),
        /* @__PURE__ */ jsx("span", { className: "hidden sm:inline", children: label })
      ]
    }
  );
}
var DefinitionsContext = createContext({});
function DefinitionsProvider({
  definitions,
  children
}) {
  return /* @__PURE__ */ jsx(DefinitionsContext.Provider, { value: definitions, children });
}
function useDefinition(term) {
  return useContext(DefinitionsContext)[term];
}
function Definition({
  term,
  sentence,
  align = "start",
  className,
  children
}) {
  const fromGlossary = useDefinition(term);
  const text = sentence ?? fromGlossary;
  const id = useId();
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);
  const pointerType = useRef("mouse");
  const close = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event) => {
      if (event.key === "Escape") close();
    };
    const onPointerDown = (event) => {
      const root = rootRef.current;
      if (root && event.target instanceof Node && !root.contains(event.target))
        close();
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onPointerDown, true);
    };
  }, [open, close]);
  if (!text) return children ? /* @__PURE__ */ jsx(Fragment, { children }) : null;
  return /* @__PURE__ */ jsxs(
    "span",
    {
      ref: rootRef,
      className: ["mg-definition", className].filter(Boolean).join(" "),
      children: [
        /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            className: children ? "mg-definition-trigger" : "mg-definition-button",
            "aria-label": children ? void 0 : `What is ${term}`,
            "aria-describedby": open ? id : void 0,
            "aria-expanded": open,
            onPointerDown: (event) => {
              pointerType.current = event.pointerType || "mouse";
            },
            onPointerEnter: (event) => {
              if (event.pointerType !== "touch") setOpen(true);
            },
            onPointerLeave: (event) => {
              if (event.pointerType !== "touch") setOpen(false);
            },
            onFocus: () => setOpen(true),
            onBlur: () => setOpen(false),
            onClick: () => {
              if (pointerType.current === "touch") setOpen((v) => !v);
            },
            children: children ?? "?"
          }
        ),
        open ? /* @__PURE__ */ jsxs(
          "span",
          {
            id,
            role: "tooltip",
            className: "mg-definition-tip",
            "data-align": align,
            "data-mg-tooltip": "",
            children: [
              /* @__PURE__ */ jsx("strong", { children: term }),
              text
            ]
          }
        ) : null
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
  return /* @__PURE__ */ jsx(
    Definition,
    {
      term: ELIGIBILITY_LABEL[eligibility],
      sentence: RULE[eligibility],
      children: /* @__PURE__ */ jsx(
        "span",
        {
          className: classNames(
            "inline-flex items-center gap-1.5 rounded border bg-transparent whitespace-nowrap transition-colors",
            "mg-dot-before",
            "hover:bg-surface",
            size === "xs" ? "px-2 py-0 h-5 text-11" : "px-2.5 py-0 h-6 text-11",
            TONE[eligibility]
          ),
          children: ELIGIBILITY_LABEL[eligibility]
        }
      )
    }
  );
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
  className,
  bare,
  title,
  ariaLabel
}) {
  const safeHref = safeExternalUrl(href);
  if (bare) {
    if (!safeHref) {
      return /* @__PURE__ */ jsx("span", { className, children });
    }
    return /* @__PURE__ */ jsx(
      "a",
      {
        href: safeHref,
        target: "_blank",
        rel: "noopener noreferrer",
        "aria-label": ariaLabel,
        className,
        children
      }
    );
  }
  const content = /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("span", { className: "min-w-0 truncate", children }),
    safeHref ? /* @__PURE__ */ jsx(ExternalLink$1, { className: "size-3 shrink-0 text-ink-muted" }) : null,
    authRequired ? /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-0.5 rounded border border-border bg-surface px-1 text-10 text-ink-muted", children: [
      /* @__PURE__ */ jsx(Lock, { className: "size-2.5" }),
      " auth"
    ] }) : null,
    !publicSafe ? /* @__PURE__ */ jsxs("span", { className: "inline-flex items-center gap-0.5 rounded border border-health-warn/30 bg-health-warn/5 px-1 text-10 text-health-warn", children: [
      /* @__PURE__ */ jsx(AlertTriangle, { className: "size-2.5" }),
      " private"
    ] }) : null
  ] });
  const classes = classNames(
    "inline-flex max-w-full items-center gap-1 underline decoration-ink/30 underline-offset-2 text-ink-strong",
    safeHref ? "hover:decoration-ink" : "cursor-default decoration-transparent",
    className
  );
  if (!safeHref) {
    return /* @__PURE__ */ jsx("span", { className: classes, children: content });
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

// src/components/metagraphed/interaction/active-entity-logic.ts
function reduceActiveEntity(state, action) {
  switch (action.type) {
    case "set":
      return state.pinned ? state : { active: action.entity, pinned: false };
    case "pin":
      return state.pinned && state.active?.key === action.entity.key ? state : { active: action.entity, pinned: true };
    case "clear":
      if (state.pinned && !action.force) return state;
      return state.active === null && !state.pinned ? state : { active: null, pinned: false };
  }
}
function isRovingKey(key) {
  return key === "ArrowRight" || key === "ArrowDown" || key === "ArrowLeft" || key === "ArrowUp" || key === "Home" || key === "End";
}
function rovingTarget(key, index, length) {
  if (length < 2 || index < 0 || index >= length) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (index + 1) % length;
    case "ArrowLeft":
    case "ArrowUp":
      return (index - 1 + length) % length;
    case "Home":
      return 0;
    case "End":
      return length - 1;
  }
}
function tapIntent(pointerType, pinnedHere) {
  if (pointerType !== "touch") return "activate";
  return pinnedHere ? "activate" : "pin";
}
function markTabIndex(options) {
  if (options.disabled) return -1;
  return options.active || options.first ? 0 : -1;
}
var ActiveEntityContext = createContext(
  null
);
function ActiveEntityProvider({ children }) {
  const [state, dispatch] = useReducer(reduceActiveEntity, {
    active: null,
    pinned: false
  });
  const set = useCallback(
    (entity) => dispatch({ type: "set", entity }),
    []
  );
  const pin = useCallback(
    (entity) => dispatch({ type: "pin", entity }),
    []
  );
  const clear = useCallback(
    (options) => dispatch({ type: "clear", force: options?.force }),
    []
  );
  useEffect(() => {
    if (!state.pinned || !state.active) return;
    const key = state.active.key;
    const onPointerDown = (event) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      const mark = target.closest("[data-entity]");
      if (mark && mark.getAttribute("data-entity") === key) return;
      dispatch({ type: "clear", force: true });
    };
    document.addEventListener("pointerdown", onPointerDown, true);
    return () => document.removeEventListener("pointerdown", onPointerDown, true);
  }, [state.pinned, state.active]);
  const value = useMemo(
    () => ({ active: state.active, pinned: state.pinned, set, pin, clear }),
    [state.active, state.pinned, set, pin, clear]
  );
  return /* @__PURE__ */ jsx(ActiveEntityContext.Provider, { value, children });
}
var NOOP_CONTEXT = {
  active: null,
  pinned: false,
  set: () => {
  },
  pin: () => {
  },
  clear: () => {
  }
};
function useActiveEntity() {
  return useContext(ActiveEntityContext) ?? NOOP_CONTEXT;
}
function useIsActive(key) {
  return useActiveEntity().active?.key === key;
}
var MARKS_SELECTOR = "[data-marks]";
var MARK_SELECTOR = '[data-entity][role="button"]';
function siblingsOf(el) {
  const group = el.closest(MARKS_SELECTOR);
  if (!group) return [el];
  return Array.from(group.querySelectorAll(MARK_SELECTOR)).filter(
    (m) => m.getAttribute("aria-disabled") !== "true"
  );
}
function useEntityMark(key, opts = {}) {
  const ctx = useActiveEntity();
  const { source = "mark", label, data, onActivate, disabled = false } = opts;
  const elRef = useRef(null);
  const [isFirst, setIsFirst] = useState(false);
  const lastPointerType = useRef("mouse");
  const isActive = ctx.active?.key === key;
  const isPinnedHere = isActive && ctx.pinned;
  const ref = useCallback((el) => {
    elRef.current = el;
  }, []);
  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const group = el.closest(MARKS_SELECTOR);
    const head = group ? group.querySelector(MARK_SELECTOR) : null;
    setIsFirst(head === el || head === null);
  }, [key]);
  const entity = useCallback(
    () => ({ key, source, element: elRef.current, data }),
    [key, source, data]
  );
  const onPointerDown = useCallback((event) => {
    lastPointerType.current = event.pointerType || "mouse";
  }, []);
  const onPointerEnter = useCallback(
    (event) => {
      if (disabled || event.pointerType === "touch") return;
      ctx.set(entity());
    },
    [ctx, entity, disabled]
  );
  const onPointerLeave = useCallback(
    (event) => {
      if (event.pointerType === "touch") return;
      ctx.clear();
    },
    [ctx]
  );
  const onFocus = useCallback(() => {
    if (disabled) return;
    if (lastPointerType.current === "touch") return;
    ctx.set(entity());
  }, [ctx, entity, disabled]);
  const onBlur = useCallback(() => {
    ctx.clear();
  }, [ctx]);
  const onClick = useCallback(
    (event) => {
      if (disabled) {
        event.preventDefault();
        return;
      }
      if (tapIntent(lastPointerType.current, isPinnedHere) === "pin") {
        event.preventDefault();
        ctx.pin(entity());
        return;
      }
      onActivate?.();
    },
    [ctx, entity, disabled, isPinnedHere, onActivate]
  );
  const onKeyDown = useCallback(
    (event) => {
      const el = elRef.current;
      if (!el) return;
      if (event.key === "Escape") {
        ctx.clear({ force: true });
        event.stopPropagation();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        if (disabled) return;
        event.preventDefault();
        onActivate?.();
        return;
      }
      if (!isRovingKey(event.key)) return;
      const marks = siblingsOf(el);
      const target = rovingTarget(event.key, marks.indexOf(el), marks.length);
      if (target === null) return;
      event.preventDefault();
      marks[target].focus();
    },
    [ctx, disabled, onActivate]
  );
  return {
    ref,
    "data-entity": key,
    "data-active": isActive ? "true" : void 0,
    tabIndex: markTabIndex({ disabled, active: isActive, first: isFirst }),
    role: "button",
    "aria-label": label ?? key,
    "aria-disabled": disabled ? true : void 0,
    onPointerDown,
    onPointerEnter,
    onPointerLeave,
    onFocus,
    onBlur,
    onKeyDown,
    onClick
  };
}

// src/components/metagraphed/interaction/chart-tooltip-logic.ts
var TOOLTIP_GAP_PX = 8;
function placeTooltip(mark, container, width, gap = TOOLTIP_GAP_PX) {
  let left = mark.right - container.left + gap;
  if (left + width > container.width)
    left = mark.left - container.left - gap - width;
  return Math.max(0, Math.round(left));
}
function tooltipPlacement(viewportWidth) {
  return viewportWidth < 640 ? "static" : "float";
}
function useIsMobile() {
  const [mobile, setMobile] = useState(false);
  useLayoutEffect(() => {
    const update = () => setMobile(tooltipPlacement(window.innerWidth) === "static");
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return mobile;
}
function ChartTooltip({
  top = 110,
  fallback,
  className
}) {
  const { active } = useActiveEntity();
  const ref = useRef(null);
  const mobile = useIsMobile();
  const [left, setLeft] = useState(null);
  const [, mounted2] = useState(false);
  useLayoutEffect(() => mounted2(true), []);
  const host = useRef(null);
  const container = host.current?.parentElement ?? null;
  const anchored = active !== null && active.element !== null && container !== null && container.contains(active.element);
  useLayoutEffect(() => {
    if (!anchored || mobile || !ref.current || !active?.element || !container) {
      setLeft(null);
      return;
    }
    setLeft(
      placeTooltip(
        active.element.getBoundingClientRect(),
        container.getBoundingClientRect(),
        ref.current.offsetWidth
      )
    );
  }, [anchored, mobile, active, container]);
  const data = active ? active.data ?? fallback?.(active.key) ?? null : null;
  const show = anchored && data !== null;
  return /* @__PURE__ */ jsx("div", { ref: host, style: { display: "contents" }, "data-mg-tooltip-host": "", children: show && data ? /* @__PURE__ */ jsxs(
    "div",
    {
      ref,
      className: ["mg-chart-tooltip", className].filter(Boolean).join(" "),
      "data-placement": mobile ? "static" : "float",
      "data-rows": data.rows && data.rows.length > 0 ? "" : void 0,
      "data-mg-tooltip": "",
      role: "status",
      "aria-live": "polite",
      style: mobile ? void 0 : {
        top,
        left: left ?? 0,
        visibility: left === null ? "hidden" : void 0
      },
      children: [
        /* @__PURE__ */ jsxs("div", { className: "mg-chart-tooltip-head", children: [
          /* @__PURE__ */ jsx("strong", { children: data.title }),
          data.total ? /* @__PURE__ */ jsx("span", { children: data.total }) : null
        ] }),
        data.rows && data.rows.length > 0 ? /* @__PURE__ */ jsx("div", { className: "mg-chart-tooltip-divider" }) : null,
        data.rows?.map((row) => /* @__PURE__ */ jsxs(
          "div",
          {
            className: "mg-chart-tooltip-row",
            "data-current": row.key === active?.key ? "true" : void 0,
            "data-muted": active && data.rows?.some((r) => r.key === active.key) && row.key !== active.key ? "true" : void 0,
            children: [
              /* @__PURE__ */ jsxs("span", { children: [
                row.swatch ? /* @__PURE__ */ jsx(
                  "span",
                  {
                    className: "mg-chart-tooltip-swatch",
                    style: { "--swatch": row.swatch },
                    "aria-hidden": true
                  }
                ) : null,
                /* @__PURE__ */ jsx("span", { children: row.label })
              ] }),
              /* @__PURE__ */ jsx("b", { children: row.value })
            ]
          },
          row.key
        )),
        data.note ? /* @__PURE__ */ jsx("div", { className: "mg-chart-tooltip-note", children: data.note }) : null
      ]
    }
  ) : null });
}
function Raw({
  title = "Raw identifiers & sources",
  rows = [],
  children,
  defaultOpen,
  className,
  id
}) {
  return /* @__PURE__ */ jsxs(
    "details",
    {
      id,
      className: ["mg-raw", className].filter(Boolean).join(" "),
      open: defaultOpen,
      "data-mg-raw": "",
      children: [
        /* @__PURE__ */ jsxs("summary", { children: [
          title,
          /* @__PURE__ */ jsx("span", { className: "mg-raw-chip", "aria-hidden": true, children: "RAW" })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "mg-raw-body", children: [
          rows.length > 0 ? /* @__PURE__ */ jsx("dl", { children: rows.map((row) => /* @__PURE__ */ jsxs("div", { className: "mg-raw-row", children: [
            /* @__PURE__ */ jsx("dt", { children: row.label }),
            /* @__PURE__ */ jsx("dd", { children: row.href ? /* @__PURE__ */ jsx("a", { href: row.href, className: "text-accent hover:underline", children: /* @__PURE__ */ jsx("code", { title: row.value, children: row.value }) }) : /* @__PURE__ */ jsx("code", { title: row.value, children: row.value }) }),
            /* @__PURE__ */ jsx(
              CopyButton,
              {
                value: row.value,
                label: row.copyLabel ?? row.label,
                compact: true,
                className: "mg-raw-copy"
              }
            )
          ] }, row.label)) }) : null,
          children
        ] })
      ]
    }
  );
}
function RawCode({
  children,
  label
}) {
  return /* @__PURE__ */ jsxs("div", { className: "relative", children: [
    /* @__PURE__ */ jsx("pre", { className: "mg-raw-code", "aria-label": label, children: /* @__PURE__ */ jsx("code", { children }) }),
    /* @__PURE__ */ jsx(
      CopyButton,
      {
        value: children,
        label: label ?? "snippet",
        className: "absolute top-1 right-1"
      }
    )
  ] });
}
function provenanceSentence({
  source,
  windowLabel,
  updatedAt,
  staleness
}) {
  const fresh = formatFreshness(updatedAt, windowLabel);
  const freshAbs = formatFreshnessAbsolute(updatedAt);
  return [
    source.replace(/\.?$/, "."),
    staleness ? `Staleness: ${staleness.replace(/\.?$/, ".")}` : null,
    fresh || freshAbs ? `${fresh ?? ""}${freshAbs ? `${fresh ? " \xB7 " : ""}last checked ${freshAbs}` : ""}.` : null
  ].filter(Boolean).join(" ");
}
function Provenance({
  children,
  metric,
  source,
  windowLabel,
  updatedAt,
  staleness
}) {
  const term = windowLabel ? `${metric} \xB7 ${windowLabel}` : metric;
  return /* @__PURE__ */ jsx(
    Definition,
    {
      term,
      sentence: provenanceSentence({
        source,
        windowLabel,
        updatedAt,
        staleness
      }),
      children: /* @__PURE__ */ jsx("span", { className: "inline-flex max-w-full items-center", children })
    }
  );
}
function AnalyticsSection({
  id,
  name,
  question,
  visual,
  legend,
  footnote,
  controls,
  children,
  className
}) {
  const headingId = `${id}-heading`;
  return /* @__PURE__ */ jsxs(
    "section",
    {
      id,
      className: classNames("mg-section", className),
      "aria-labelledby": headingId,
      "data-mg-section": "",
      children: [
        /* @__PURE__ */ jsxs("div", { className: "mg-section-head", children: [
          /* @__PURE__ */ jsxs("h2", { id: headingId, className: "mg-section-h", children: [
            /* @__PURE__ */ jsx("strong", { children: typeof name === "string" ? name.replace(/\.?$/, ".") : name }),
            question ? /* @__PURE__ */ jsxs(Fragment, { children: [
              " ",
              question
            ] }) : null
          ] }),
          controls ? /* @__PURE__ */ jsx("div", { className: "mg-section-controls", children: controls }) : null
        ] }),
        visual ? /* @__PURE__ */ jsx("div", { className: "mg-section-visual", children: visual }) : null,
        children,
        legend ? /* @__PURE__ */ jsx("div", { className: "mg-section-legend", children: legend }) : null,
        footnote ? /* @__PURE__ */ jsx("p", { className: "mg-section-note", children: footnote }) : null
      ]
    }
  );
}
function SectionHead({
  id,
  name,
  question,
  controls,
  className
}) {
  return /* @__PURE__ */ jsxs("div", { className: classNames("mg-section-head", className), children: [
    /* @__PURE__ */ jsxs("h2", { id, className: "mg-section-h", children: [
      /* @__PURE__ */ jsx("strong", { children: typeof name === "string" ? name.replace(/\.?$/, ".") : name }),
      question ? /* @__PURE__ */ jsxs(Fragment, { children: [
        " ",
        question
      ] }) : null
    ] }),
    controls ? /* @__PURE__ */ jsx("div", { className: "mg-section-controls", children: controls }) : null
  ] });
}
function pickActiveSection(ids, visible, current) {
  return ids.find((id) => visible.has(id)) ?? current;
}
function useActiveSection(ids) {
  const [active, setActive] = useState(ids[0] ?? null);
  useEffect(() => {
    if (typeof IntersectionObserver === "undefined") return;
    const visible = /* @__PURE__ */ new Map();
    const observer = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) visible.set(e.target.id, e.intersectionRatio);
          else visible.delete(e.target.id);
        }
        setActive(
          (current) => pickActiveSection(ids, new Set(visible.keys()), current)
        );
      },
      { rootMargin: "-80px 0px -60% 0px", threshold: [0, 0.25, 0.5] }
    );
    for (const id of ids) {
      const el = document.getElementById(id);
      if (el) observer.observe(el);
    }
    return () => observer.disconnect();
  }, [ids]);
  return active;
}
function SectionNav({ items, link, className }) {
  const anchors = items.filter((i) => !i.href).map((i) => i.id);
  const active = useActiveSection(anchors);
  if (items.length === 0) return null;
  const LinkCmp = link ?? DefaultLink;
  return /* @__PURE__ */ jsx(
    "nav",
    {
      className: classNames("mg-section-nav", className),
      "aria-label": "Sections",
      "data-mg-section-nav": "",
      children: /* @__PURE__ */ jsx("ul", { children: items.map(
        (item) => item.href ? /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx(
          LinkCmp,
          {
            href: item.href,
            "aria-current": item.current ? "page" : void 0,
            children: item.name
          }
        ) }, item.id) : /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsx(
          "a",
          {
            href: `#${item.id}`,
            "aria-current": active === item.id ? "location" : void 0,
            children: item.name
          }
        ) }, item.id)
      ) })
    }
  );
}
var DefaultLink = ({ href, children, ...rest }) => /* @__PURE__ */ jsx("a", { href, ...rest, children });
var MAX_SECTIONS = 7;
function sectionItems(children) {
  const items = [];
  Children.forEach(children, (child) => {
    if (!isValidElement(child)) return;
    if (child.type === AnalyticsSection) {
      const props = child.props;
      items.push({
        id: props.id,
        name: typeof props.name === "string" ? props.name : props.id
      });
    }
  });
  return items;
}
function AnalyticsPage({
  hero,
  children,
  className
}) {
  const items = sectionItems(children);
  if (items.length > MAX_SECTIONS && process.env.NODE_ENV !== "production") {
    throw new Error(
      `AnalyticsPage: ${items.length} sections; a page answers at most ${MAX_SECTIONS} questions (#11607)`
    );
  }
  return /* @__PURE__ */ jsx(ActiveEntityProvider, { children: /* @__PURE__ */ jsxs("div", { className: classNames("mg-page", className), "data-mg-page": "", children: [
    hero,
    /* @__PURE__ */ jsx(SectionNav, { items }),
    children
  ] }) });
}
function FactStrip({
  cells,
  children,
  variant = "row",
  className
}) {
  return /* @__PURE__ */ jsxs(
    "dl",
    {
      className: classNames("mg-facts", className),
      "data-variant": variant,
      "data-count": cells?.length,
      children: [
        cells?.map((cell) => /* @__PURE__ */ jsx(FactCell, { ...cell }, cell.label)),
        children
      ]
    }
  );
}
function FactCell({
  label,
  value,
  delta,
  hint,
  className
}) {
  return /* @__PURE__ */ jsxs("div", { className: classNames("mg-fact", className), children: [
    /* @__PURE__ */ jsxs("dt", { children: [
      label,
      typeof hint === "string" ? /* @__PURE__ */ jsx(Definition, { term: label, sentence: hint }) : null
    ] }),
    /* @__PURE__ */ jsxs("dd", { children: [
      /* @__PURE__ */ jsx("span", { className: "mg-fact-value", children: value }),
      delta ? /* @__PURE__ */ jsx("span", { className: "mg-fact-delta", "data-tone": delta.tone, children: delta.text }) : null
    ] })
  ] });
}
function Fact({
  children,
  className
}) {
  return /* @__PURE__ */ jsx("span", { className: classNames("mg-fact-chip", className), children });
}
function FactSentence({ children, className }) {
  return /* @__PURE__ */ jsx("p", { className: classNames("mg-fact-sentence", className), children });
}
var LiveTickerContext = createContext(null);
function LiveTickerProvider({ children }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1e3);
    return () => clearInterval(id);
  }, []);
  return /* @__PURE__ */ jsx(LiveTickerContext.Provider, { value: tick, children });
}
function useLiveTicker() {
  return useContext(LiveTickerContext);
}
function timeAgoTickDelayMs(ageMs) {
  return ageMs < 6e4 ? 1e3 : 6e4;
}
function TimeAgo({
  at,
  className,
  fallback = "\u2014"
}) {
  const [mounted2, setMounted] = useState(false);
  const [, forceTick] = useState(0);
  const sharedTicker = useLiveTicker();
  const hasSharedTicker = sharedTicker !== null;
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!mounted2 || !at || hasSharedTicker) return void 0;
    const ts = new Date(at).getTime();
    if (!Number.isFinite(ts)) return void 0;
    let timeoutId;
    const schedule = () => {
      timeoutId = setTimeout(
        () => {
          forceTick((n) => n + 1);
          schedule();
        },
        timeAgoTickDelayMs(Date.now() - ts)
      );
    };
    schedule();
    return () => clearTimeout(timeoutId);
  }, [mounted2, at, hasSharedTicker]);
  const text = !at ? fallback : mounted2 ? formatRelative(at) : "";
  return /* @__PURE__ */ jsx("span", { className, suppressHydrationWarning: true, children: text });
}
var mounted = 0;
function LiveMeta({
  updatedAt,
  onRefresh,
  refreshing,
  source,
  className
}) {
  useEffect(() => {
    mounted += 1;
    if (mounted > 1 && process.env.NODE_ENV !== "production") {
      throw new Error("LiveMeta: only one liveness line per page (#11607)");
    }
    return () => {
      mounted -= 1;
    };
  }, []);
  return /* @__PURE__ */ jsxs("p", { className: classNames("mg-live-meta", className), "data-mg-live-meta": "", children: [
    updatedAt ? /* @__PURE__ */ jsxs(Fragment, { children: [
      "Updated ",
      /* @__PURE__ */ jsx(TimeAgo, { at: updatedAt })
    ] }) : "Updated \u2014",
    source ? /* @__PURE__ */ jsxs(Fragment, { children: [
      " \xB7 ",
      source
    ] }) : null,
    onRefresh ? /* @__PURE__ */ jsxs(Fragment, { children: [
      " \xB7 ",
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          onClick: onRefresh,
          disabled: refreshing,
          className: "mg-live-meta-refresh",
          children: refreshing ? "refreshing\u2026" : "refresh"
        }
      )
    ] }) : null
  ] });
}
function nextTabIndex(current, key, count) {
  if (count <= 0) return null;
  switch (key) {
    case "ArrowRight":
    case "ArrowDown":
      return (current + 1) % count;
    case "ArrowLeft":
    case "ArrowUp":
      return (current - 1 + count) % count;
    case "Home":
      return 0;
    case "End":
      return count - 1;
    default:
      return null;
  }
}
function rovingTabIndex(index, activeIndex) {
  return index === activeIndex ? 0 : -1;
}
function useRovingGroup(count, onSelect) {
  const refs = useRef([]);
  const itemRef = useCallback(
    (index) => (el) => {
      refs.current[index] = el;
    },
    []
  );
  const onKeyDown = useCallback(
    (index) => (e) => {
      const next = nextTabIndex(index, e.key, count);
      if (next == null) return;
      e.preventDefault();
      refs.current[next]?.focus();
      onSelect(next);
    },
    [count, onSelect]
  );
  return { itemRef, onKeyDown };
}
function RangeControl({
  options,
  value,
  onChange,
  label,
  className
}) {
  const id = useId();
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  const select = useCallback(
    (index) => {
      const next = options[index];
      if (next && next.value !== value) onChange(next.value);
    },
    [options, value, onChange]
  );
  const { itemRef, onKeyDown } = useRovingGroup(options.length, select);
  return /* @__PURE__ */ jsx(
    "div",
    {
      role: "radiogroup",
      "aria-label": label,
      id,
      className: classNames("mg-range", className),
      "data-mg-range": "",
      children: options.map((o, i) => /* @__PURE__ */ jsx(
        "button",
        {
          ref: itemRef(i),
          type: "button",
          role: "radio",
          "aria-checked": o.value === value,
          tabIndex: rovingTabIndex(i, activeIndex),
          onClick: () => select(i),
          onKeyDown: onKeyDown(i),
          className: "mg-range-option",
          children: o.label
        },
        o.value
      ))
    }
  );
}
function EntityHero({
  crumbs,
  name,
  avatar,
  action,
  secondary,
  sentence,
  cells,
  facts,
  live,
  className
}) {
  return /* @__PURE__ */ jsxs("header", { className: classNames("mg-hero", className), "data-mg-hero": "", children: [
    crumbs && crumbs.length > 0 ? /* @__PURE__ */ jsx("nav", { className: "mg-hero-crumbs", "aria-label": "Breadcrumb", children: crumbs.map((c, i) => /* @__PURE__ */ jsx("span", { className: "mg-hero-crumb", children: c.href ? /* @__PURE__ */ jsx("a", { href: c.href, children: c.label }) : c.label }, `${c.label}-${i}`)) }) : null,
    /* @__PURE__ */ jsxs("div", { className: "mg-hero-title", children: [
      avatar ? /* @__PURE__ */ jsx("span", { className: "mg-hero-avatar", children: avatar }) : null,
      /* @__PURE__ */ jsx("h1", { children: name }),
      action || secondary ? /* @__PURE__ */ jsxs("div", { className: "mg-hero-actions", children: [
        secondary,
        action
      ] }) : null
    ] }),
    sentence,
    cells ? /* @__PURE__ */ jsx(FactStrip, { cells }) : null,
    facts,
    live ? /* @__PURE__ */ jsx(LiveMeta, { ...live }) : null
  ] });
}

// src/components/metagraphed/charts/chart-aria.ts
function markAriaLabel(domain, total) {
  if (total === void 0 || total === null || total === "") return domain;
  return `${domain} \xB7 ${total} total`;
}
function momentumAriaLabel(unit, endValue, deltaLabel2, rangeLabel) {
  const noun = unit.charAt(0).toUpperCase() + unit.slice(1);
  if (endValue === null) return `${noun}: no data in the window`;
  const range = rangeLabel ? ` over ${rangeLabel}` : "";
  return `${noun}: ${endValue}, ${deltaLabel2}${range}`;
}
function Kbd({
  children,
  className
}) {
  return /* @__PURE__ */ jsx(
    "kbd",
    {
      className: classNames(
        "inline-flex items-center justify-center rounded border border-border bg-paper px-1.5 min-w-[1.25rem] h-5 text-10 text-ink-muted",
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
  return /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick: () => copy(value),
        title: value,
        "aria-label": copied ? `${label} copied` : `Copy ${label}: ${value}`,
        className: classNames(
          "group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 text-left text-11 text-ink-strong hover:border-ink/30 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-card transition-colors",
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
    ),
    /* @__PURE__ */ jsx(CopyStatusRegion, { children: copied ? `${label} copied to clipboard` : "" })
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
  viewportRef,
  stickyHeader = true
}) {
  const tableCard = "rounded border border-border bg-card overflow-hidden";
  const viewportClass = stickyHeader ? "mg-table-scroll mg-list-viewport" : "mg-table-scroll overflow-x-auto";
  return /* @__PURE__ */ jsxs("div", { children: [
    /* @__PURE__ */ jsx(
      "div",
      {
        className: classNames(
          // Sticky below `md`, in normal flow at and above it. Offset reads
          // --mg-sticky-offset (published by AppShell to match real header +
          // ticker height) with a fallback.
          //
          // The breakpoint is the same one that swaps cards for the table,
          // and that is the whole reason for it: a page-sticky filter bar and
          // a table header pinned inside a bounded viewport are in different
          // scroll contexts, so once the page scrolls far enough for the
          // table's top to pass under this bar, the bar covers the header --
          // the column labels disappear again, by a different mechanism than
          // the one they were just fixed for. Below `md` there is no table
          // (cards render instead), nothing to cover, and a filter bar that
          // follows a long list is genuinely useful, so it stays pinned.
          //
          // /subnets reached this conclusion first and encoded it as a
          // page-specific override in apps/ui/src/styles.css
          // (`#subnets-list > div > div:first-child { position: static }`,
          // at >=1024px only, which is why tablet still showed the overlap).
          // That override is deleted; this is the general rule.
          "sticky md:static z-[var(--mg-z-raised)] -mx-4 md:mx-0 mb-3",
          "bg-paper",
          "border-b border-border md:border md:rounded md:bg-card",
          "px-3 py-2 md:p-2.5"
        ),
        style: {
          top: "calc(var(--mg-sticky-offset, 3.5rem) + var(--mg-tabs-h, 0px))"
        },
        children: /* @__PURE__ */ jsx("div", { className: "flex flex-wrap items-center gap-2", children: filters })
      }
    ),
    isEmpty ? (
      // Marked so a test can tell "this list rendered nothing" apart from
      // "this list rendered fine". The responsive-overflow sweep only ever
      // asserted that nothing OVERFLOWS, and an empty page cannot overflow,
      // so a route whose fixture had gone stale rendered no rows at all and
      // still passed -- /chain/extrinsics sat like that undetected. This
      // attribute is what makes that state observable.
      /* @__PURE__ */ jsx("div", { "data-mg-list-empty": "", children: empty })
    ) : /* @__PURE__ */ jsxs("div", { className: isStale ? "opacity-70 transition-opacity" : void 0, children: [
      cards ? /* @__PURE__ */ jsx("div", { className: "md:hidden space-y-2", children: cards }) : null,
      /* @__PURE__ */ jsx("div", { className: cards ? "hidden md:block" : void 0, children: /* @__PURE__ */ jsxs("div", { className: tableCard, children: [
        /* @__PURE__ */ jsx("div", { ref: viewportRef, className: viewportClass, children: table }),
        footer
      ] }) }),
      cards && footer ? /* @__PURE__ */ jsx("div", { className: "md:hidden mt-3", children: footer }) : null
    ] })
  ] });
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
        className: "border-t border-border bg-surface p-3 space-y-1.5",
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
    return /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between gap-3 border-t border-health-down/30 bg-health-down/5 px-4 py-2 text-13", children: [
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
    return /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between gap-3 border-t border-health-warn/30 bg-health-warn/5 px-4 py-2 text-13 text-health-warn", children: [
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
  return /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between gap-3 border-t border-border bg-surface px-4 py-2 text-11 text-ink-muted", children: [
    /* @__PURE__ */ jsxs("span", { children: [
      shown,
      total != null ? ` of ${total}` : ""
    ] }),
    hasMore ? /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        onClick: onLoadMore,
        className: "inline-flex items-center rounded border border-border bg-card px-3 py-1.5 text-13 font-medium hover:border-ink/30 min-h-9",
        children: "Load more"
      }
    ) : /* @__PURE__ */ jsx("span", { className: "opacity-60", children: "end of list" })
  ] });
}
var SHARE_COPIED_EVENT = "mg:share-copied";
function ShareButton({
  url,
  label = "Share view",
  className,
  bare,
  iconOnly,
  connected
}) {
  const hideText = connected || iconOnly;
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
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(SHARE_COPIED_EVENT));
      }
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
        className: classNames(
          connected ? "inline-flex size-8 items-center justify-center text-ink-muted hover:bg-surface hover:text-ink-strong transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" : bare ? iconOnly ? "inline-flex items-center justify-center rounded p-1 min-h-8 text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" : (
            // #8467: px-1 sm:px-2 (not a flat px-2) so the button doesn't
            // carry text-sized padding once the label itself disappears
            // below sm -- see the label span's hidden/sm:inline pairing.
            "inline-flex items-center gap-1.5 rounded px-1 sm:px-2 py-1 min-h-8 text-13 font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          ) : iconOnly ? "inline-flex size-8 items-center justify-center rounded border border-border bg-card text-ink-muted hover:border-ink/30 hover:text-ink-strong transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" : "inline-flex items-center gap-1.5 rounded border border-border bg-card px-1.5 sm:px-2.5 py-1 text-13 font-medium text-ink hover:border-ink/30 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className
        ),
        children: [
          copied ? /* @__PURE__ */ jsx(
            Check,
            {
              className: connected || iconOnly && !bare ? "size-4 text-health-ok" : "size-3 text-health-ok"
            }
          ) : /* @__PURE__ */ jsx(
            Share2,
            {
              className: connected || iconOnly && !bare ? "size-4" : "size-3 text-ink-muted"
            }
          ),
          hideText ? null : /* @__PURE__ */ jsx("span", { className: "hidden sm:inline", children: copied ? "Link copied" : label })
        ]
      }
    ),
    /* @__PURE__ */ jsx(CopyStatusRegion, { children: announcement })
  ] });
}
function PagerBar({
  hasPrev,
  hasNext,
  onPrev,
  onNext,
  prevLabel = "Newer",
  nextLabel = "Older"
}) {
  const itemCls = "inline-flex items-center gap-1 rounded px-2.5 py-1.5 min-h-9 font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent disabled:hover:text-ink-muted";
  return /* @__PURE__ */ jsxs("div", { className: "mg-actions", children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick: onPrev,
        disabled: !hasPrev,
        className: itemCls,
        children: [
          /* @__PURE__ */ jsx(ChevronLeft, { className: "size-3" }),
          " ",
          prevLabel
        ]
      }
    ),
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick: onNext,
        disabled: !hasNext,
        className: itemCls,
        children: [
          nextLabel,
          " ",
          /* @__PURE__ */ jsx(ChevronRight, { className: "size-3" })
        ]
      }
    )
  ] });
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
        "rounded border bg-card px-8 py-16 text-center",
        tone,
        className
      ),
      children: [
        /* @__PURE__ */ jsx("div", { className: "mx-auto inline-flex size-10 items-center justify-center rounded border border-border bg-paper", children: /* @__PURE__ */ jsx(Icon, { className: classNames("size-4", iconCls) }) }),
        /* @__PURE__ */ jsx("h3", { className: "mt-4 font-display text-16 font-semibold text-ink-strong", children: title }),
        description ? /* @__PURE__ */ jsx("p", { className: "mx-auto mt-1.5 max-w-md text-13 text-ink-muted leading-relaxed", children: description }) : null,
        variant === "stale" && generatedAt ? /* @__PURE__ */ jsxs("p", { className: "mt-3 text-11 text-ink-muted", children: [
          "Last verified ",
          /* @__PURE__ */ jsx(TimeAgo, { at: generatedAt })
        ] }) : null,
        message ? /* @__PURE__ */ jsxs("p", { className: "mx-auto mt-3 max-w-md text-11 text-ink-muted", children: [
          status ? /* @__PURE__ */ jsxs("span", { className: "text-health-down", children: [
            "HTTP ",
            status,
            " \xB7 "
          ] }) : null,
          message
        ] }) : null,
        cta || onRetry || url ? /* @__PURE__ */ jsxs("div", { className: "mt-4 flex flex-wrap items-center justify-center gap-2", children: [
          onRetry ? /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              onClick: onRetry,
              className: "inline-flex items-center gap-1.5 rounded border border-border bg-paper px-3.5 py-1.5 text-13 font-medium text-ink hover:border-accent/50 hover:text-accent transition-colors",
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
              className: "inline-flex items-center gap-1.5 rounded bg-ink-strong px-3.5 py-1.5 text-13 font-medium text-paper hover:opacity-90 transition-opacity",
              children: [
                cta.label,
                cta.external ? /* @__PURE__ */ jsx(ExternalLink$1, { className: "size-3" }) : null
              ]
            }
          ) : null,
          url ? /* @__PURE__ */ jsxs(
            ExternalLink,
            {
              bare: true,
              href: url,
              className: "inline-flex items-center gap-1.5 text-11 text-ink-muted hover:text-ink-strong",
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
  {
    value: "table",
    label: "Table"
  },
  {
    value: "grid",
    label: "Grid"
  },
  {
    value: "matrix",
    label: "Matrix"
  }
];
function ViewModeToggle({
  value,
  onChange,
  options = ["table", "grid", "matrix"],
  className
}) {
  const available = OPTIONS.filter((o) => options.includes(o.value));
  return /* @__PURE__ */ jsx(
    RangeControl,
    {
      options: available,
      value,
      onChange,
      label: "View mode",
      className
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
function ClaudeIcon({ className, ...props }) {
  return /* @__PURE__ */ jsx(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "var(--claude-brand)",
      "aria-hidden": "true",
      className,
      ...props,
      children: /* @__PURE__ */ jsx("path", { d: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" })
    }
  );
}
function OpenAIIcon({ className, ...props }) {
  return /* @__PURE__ */ jsx(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "currentColor",
      "aria-hidden": "true",
      className,
      ...props,
      children: /* @__PURE__ */ jsx("path", { d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" })
    }
  );
}

// src/components/metagraphed/search-scope.tsx
var SCOPES = [
  { key: "all", label: "All" },
  { key: "subnet", label: "Subnets" },
  { key: "surface", label: "Surfaces" },
  { key: "endpoint", label: "Endpoints" },
  { key: "provider", label: "Providers" },
  { key: "schema", label: "Schemas" }
];
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
        className: "inline-flex items-center rounded border border-border bg-card px-1.5 py-0.5 text-10 text-ink-muted",
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
          "mt-2 inline-flex items-center gap-1 text-10 text-ink-muted",
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
var TONE_CLASSES = {
  default: "border-border bg-paper text-ink",
  ok: "border-health-ok/40 bg-health-ok/10 text-health-ok",
  warn: "border-health-warn/40 bg-health-warn/10 text-health-warn-text",
  down: "border-health-down/40 bg-health-down/10 text-health-down",
  accent: "border-accent/45 bg-primary-soft text-accent-text",
  muted: "border-border bg-surface-2 text-ink-muted"
};
function Chip({
  tone = "default",
  icon,
  dot,
  label,
  children,
  title,
  className,
  as = "span",
  onClick
}) {
  const Cmp = as;
  return /* @__PURE__ */ jsxs(
    Cmp,
    {
      title,
      onClick,
      className: classNames(
        "inline-flex items-center gap-1.5 rounded border px-2 py-0.5",
        "text-10 leading-none whitespace-nowrap transition-colors",
        onClick ? "mg-focus-ring hover:border-ink/30 cursor-pointer" : null,
        TONE_CLASSES[tone],
        className
      ),
      children: [
        dot ? /* @__PURE__ */ jsx(
          "span",
          {
            "aria-hidden": true,
            className: "mg-health-dot",
            style: { color: "currentColor" }
          }
        ) : icon ? /* @__PURE__ */ jsx(
          "span",
          {
            "aria-hidden": true,
            className: "inline-flex size-3 items-center justify-center",
            children: icon
          }
        ) : null,
        label ? /* @__PURE__ */ jsx("span", { className: "opacity-70", children: label }) : null,
        children != null ? /* @__PURE__ */ jsx("span", { className: "text-ink-strong normal-case", children }) : null
      ]
    }
  );
}
var STATUS_LABEL = {
  ok: "Healthy",
  warn: "Degraded",
  down: "Down",
  unknown: "Unknown"
};
var STATUS_TONE = {
  ok: "ok",
  warn: "warn",
  down: "down",
  unknown: "muted"
};
function StatusBadge({
  status,
  label,
  live,
  title,
  className
}) {
  return /* @__PURE__ */ jsx(
    Chip,
    {
      tone: STATUS_TONE[status],
      dot: live,
      title: title ?? STATUS_LABEL[status],
      className,
      children: label ?? STATUS_LABEL[status]
    }
  );
}
function Indicator({
  icon: Icon,
  label,
  value,
  hint,
  title,
  className,
  orientation = "row"
}) {
  const isRow = orientation === "row";
  return /* @__PURE__ */ jsxs(
    "span",
    {
      className: classNames(
        "inline-flex min-w-0",
        isRow ? "items-baseline gap-1.5" : "flex-col gap-0.5",
        className
      ),
      children: [
        /* @__PURE__ */ jsxs(
          "span",
          {
            className: classNames(
              "inline-flex items-center gap-1 text-10 text-ink-muted",
              isRow ? "self-center" : null
            ),
            children: [
              Icon ? /* @__PURE__ */ jsx(Icon, { className: "size-3", "aria-hidden": true }) : null,
              label
            ]
          }
        ),
        /* @__PURE__ */ jsxs("span", { className: "text-11 tabular-nums text-ink-strong truncate", children: [
          value,
          hint ? /* @__PURE__ */ jsx("span", { className: "ml-1 text-ink-muted normal-case", children: hint }) : null
        ] })
      ]
    }
  );
}
function FilterField({
  label,
  htmlFor,
  hint,
  children,
  className,
  grow
}) {
  return /* @__PURE__ */ jsxs(
    "label",
    {
      htmlFor,
      className: classNames(
        "flex flex-col gap-1 min-w-0",
        grow ? "flex-1 min-w-[180px]" : null,
        className
      ),
      children: [
        /* @__PURE__ */ jsxs("span", { className: "text-10 text-ink-muted inline-flex items-center gap-1.5", children: [
          label,
          hint ? /* @__PURE__ */ jsx("span", { className: "opacity-70", children: hint }) : null
        ] }),
        children
      ]
    }
  );
}
var CONTROL_CLASSES = "h-9 min-w-0 w-full rounded border border-border bg-card px-2.5 text-13text-ink-strong placeholder:text-ink-subtle-text mg-focus-ringhover:border-ink/25 transition-colors";
function FilterInput({
  className,
  leadingIcon = true,
  ...props
}) {
  if (!leadingIcon) {
    return /* @__PURE__ */ jsx("input", { ...props, className: classNames(CONTROL_CLASSES, className) });
  }
  return /* @__PURE__ */ jsxs("span", { className: "relative inline-flex w-full items-center", children: [
    /* @__PURE__ */ jsx(
      Search,
      {
        className: "pointer-events-none absolute left-2.5 size-3.5 text-ink-muted",
        "aria-hidden": true
      }
    ),
    /* @__PURE__ */ jsx(
      "input",
      {
        ...props,
        className: classNames(CONTROL_CLASSES, "pl-8", className)
      }
    )
  ] });
}
function FilterSelect({
  className,
  children,
  ...props
}) {
  return /* @__PURE__ */ jsx(
    "select",
    {
      ...props,
      className: classNames(CONTROL_CLASSES, "pr-6 appearance-none", className),
      children
    }
  );
}
function FilterToolbar({
  children,
  trailing,
  className
}) {
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: classNames(
        "flex w-full flex-wrap items-end gap-2 md:gap-3",
        className
      ),
      children: [
        /* @__PURE__ */ jsx("div", { className: "flex flex-1 flex-wrap items-end gap-2 md:gap-3 min-w-0", children }),
        trailing ? /* @__PURE__ */ jsx("div", { className: "flex flex-wrap items-center gap-1.5 shrink-0", children: trailing }) : null
      ]
    }
  );
}
function ColumnCustomizer({
  columns,
  isVisible,
  onToggle,
  onReset,
  className
}) {
  const [open, setOpen] = useState(false);
  const visibleCount = columns.filter((c) => isVisible(c.id)).length;
  return /* @__PURE__ */ jsxs("div", { className: classNames("relative", className), children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick: () => setOpen((v) => !v),
        "aria-haspopup": "menu",
        "aria-expanded": open,
        title: "Customize visible columns",
        className: "mg-focus-ring inline-flex items-center gap-1.5 h-9 rounded border border-border bg-card px-2.5 text-10 text-ink-muted hover:text-ink-strong hover:border-ink/25 transition-colors",
        children: [
          /* @__PURE__ */ jsx(Columns3, { className: "size-3", "aria-hidden": true }),
          /* @__PURE__ */ jsx("span", { className: "hidden sm:inline", children: "Columns" }),
          /* @__PURE__ */ jsxs("span", { className: "text-ink-strong tabular-nums normal-case", children: [
            visibleCount,
            "/",
            columns.length
          ] })
        ]
      }
    ),
    open ? /* @__PURE__ */ jsxs(Fragment, { children: [
      /* @__PURE__ */ jsx(
        "button",
        {
          type: "button",
          "aria-label": "Close column menu",
          className: "fixed inset-0 z-[var(--mg-z-overlay)] cursor-default",
          onClick: () => setOpen(false)
        }
      ),
      /* @__PURE__ */ jsxs(
        "div",
        {
          role: "menu",
          className: "absolute right-0 z-[var(--mg-z-overlay)] mt-1.5 w-64 rounded border border-border bg-card p-1",
          children: [
            /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between px-2 py-1.5", children: [
              /* @__PURE__ */ jsx("span", { className: "text-10 text-ink-muted", children: "Columns" }),
              /* @__PURE__ */ jsxs(
                "button",
                {
                  type: "button",
                  onClick: onReset,
                  className: "mg-focus-ring inline-flex items-center gap-1 text-10 text-ink-muted hover:text-ink-strong",
                  children: [
                    /* @__PURE__ */ jsx(RotateCcw, { className: "size-3", "aria-hidden": true }),
                    " Reset"
                  ]
                }
              )
            ] }),
            /* @__PURE__ */ jsx("div", { className: "max-h-72 overflow-y-auto py-0.5", children: columns.map((c) => {
              const checked = isVisible(c.id);
              return /* @__PURE__ */ jsxs(
                "label",
                {
                  className: classNames(
                    "flex items-center gap-2 rounded px-2 py-1.5 text-13 text-ink hover:bg-surface-2 cursor-pointer",
                    c.required ? "opacity-60 cursor-not-allowed" : null
                  ),
                  children: [
                    /* @__PURE__ */ jsx(
                      "input",
                      {
                        type: "checkbox",
                        checked,
                        disabled: c.required,
                        onChange: () => onToggle(c.id),
                        className: "accent-accent size-3.5"
                      }
                    ),
                    /* @__PURE__ */ jsx("span", { className: "flex-1 truncate", children: c.label }),
                    c.required ? /* @__PURE__ */ jsx("span", { className: "text-10 text-ink-subtle-text", children: "Locked" }) : null
                  ]
                },
                c.id
              );
            }) })
          ]
        }
      )
    ] }) : null
  ] });
}
var STORAGE_PREFIX = "mg:cols:v1:";
function readPersisted(key) {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return null;
    return parsed.filter((v) => typeof v === "string");
  } catch {
    return null;
  }
}
function writePersisted(key, visible) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(visible));
  } catch {
  }
}
function defaultVisible(columns) {
  return columns.filter((c) => c.required || c.defaultVisible !== false).map((c) => c.id);
}
function useColumnVisibility(pageKey, columns) {
  const initial = useMemo(() => defaultVisible(columns), [columns]);
  const [visible, setVisible] = useState(initial);
  useEffect(() => {
    const persisted = readPersisted(pageKey);
    if (!persisted) return;
    const set = new Set(persisted);
    for (const c of columns) if (c.required) set.add(c.id);
    const known = new Set(columns.map((c) => c.id));
    setVisible(Array.from(set).filter((id) => known.has(id)));
  }, [pageKey, columns]);
  useEffect(() => {
    writePersisted(pageKey, visible);
  }, [pageKey, visible]);
  const isVisible = useCallback(
    (id) => visible.includes(id),
    [visible]
  );
  const toggle = useCallback(
    (id) => {
      const col = columns.find((c) => c.id === id);
      if (col?.required) return;
      setVisible(
        (prev) => prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]
      );
    },
    [columns]
  );
  const reset = useCallback(() => {
    setVisible(defaultVisible(columns));
  }, [columns]);
  return { visible, isVisible, toggle, reset, setVisible };
}
function TableColGroup({ widths }) {
  const total = widths.reduce((sum, w) => sum + w, 0);
  return /* @__PURE__ */ jsx("colgroup", { children: widths.map((w, i) => (
    // Positional by definition: a <col> IS its index in the row.
    /* @__PURE__ */ jsx(
      "col",
      {
        style: { width: `${(w / total * 100).toFixed(3)}%` }
      },
      `col-${i}`
    )
  )) });
}
function columnWidths(columns, isVisible, leading = []) {
  return [
    ...leading,
    ...columns.filter((c) => isVisible(c.id)).map((c) => c.width ?? 100)
  ];
}
function Panel({
  title,
  action,
  caption,
  flush,
  className,
  bodyClassName,
  children,
  ...rest
}) {
  const hasHeader = title != null || action != null || caption != null;
  return /* @__PURE__ */ jsxs("section", { ...rest, className: classNames("min-w-0", className), children: [
    hasHeader ? /* @__PURE__ */ jsxs("header", { className: "flex items-start justify-between gap-3 mg-panel-pad pb-2", children: [
      /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
        title != null ? /* @__PURE__ */ jsx("h3", { className: "text-13 font-semibold text-ink-strong", children: title }) : null,
        caption != null ? /* @__PURE__ */ jsx("p", { className: "mt-1 text-13 text-ink-muted", children: caption }) : null
      ] }),
      action != null ? /* @__PURE__ */ jsx("div", { className: "shrink-0 flex items-center gap-2", children: action }) : null
    ] }) : null,
    /* @__PURE__ */ jsx(
      "div",
      {
        className: classNames(
          flush ? "mg-panel-pad-flush" : "mg-panel-pad",
          bodyClassName
        ),
        children
      }
    )
  ] });
}
var VARIANT_ICON = {
  empty: Inbox,
  filtered: Filter,
  error: AlertTriangle,
  stale: RotateCcw
};
var VARIANT_TONE = {
  empty: "text-ink-muted",
  filtered: "text-ink-muted",
  error: "text-health-down",
  stale: "text-health-warn-text"
};
function EmptyState({
  variant = "empty",
  title,
  hint,
  action,
  evidenceHref,
  evidenceLabel = "Source",
  icon,
  className,
  dense
}) {
  const Icon = icon ?? VARIANT_ICON[variant];
  return /* @__PURE__ */ jsxs(
    "div",
    {
      role: variant === "error" ? "alert" : "status",
      "aria-live": variant === "error" ? "assertive" : "polite",
      className: classNames(
        "flex flex-col items-center justify-center text-center gap-3",
        dense ? "py-8" : "py-16",
        className
      ),
      children: [
        /* @__PURE__ */ jsx(
          "span",
          {
            "aria-hidden": true,
            className: classNames(
              "inline-flex size-10 items-center justify-center rounded border border-border bg-surface-2",
              VARIANT_TONE[variant]
            ),
            children: /* @__PURE__ */ jsx(Icon, { className: "size-4" })
          }
        ),
        /* @__PURE__ */ jsxs("div", { className: "max-w-sm space-y-1", children: [
          /* @__PURE__ */ jsx("p", { className: "font-display text-13 font-medium text-ink-strong", children: title }),
          hint != null ? /* @__PURE__ */ jsx("p", { className: "text-13 leading-relaxed text-ink-muted", children: hint }) : null
        ] }),
        action != null || evidenceHref ? /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center justify-center gap-2 pt-1", children: [
          action,
          evidenceHref ? /* @__PURE__ */ jsxs(
            ExternalLink,
            {
              bare: true,
              href: evidenceHref,
              className: "mg-focus-ring inline-flex items-center gap-1 text-11 text-ink-muted hover:text-ink-strong",
              children: [
                evidenceLabel,
                /* @__PURE__ */ jsx(ExternalLink$1, { className: "size-3", "aria-hidden": true })
              ]
            }
          ) : null
        ] }) : null
      ]
    }
  );
}
function TableSkeleton({
  rows = 8,
  columns = 5,
  density = "comfortable",
  withHeader = true,
  className
}) {
  const rowPad = density === "compact" ? "py-2" : "py-3";
  return /* @__PURE__ */ jsxs(
    "div",
    {
      role: "status",
      "aria-live": "polite",
      "aria-busy": "true",
      className: classNames(
        "rounded border border-border bg-card overflow-hidden",
        className
      ),
      children: [
        /* @__PURE__ */ jsx("span", { className: "sr-only", children: "Loading table\u2026" }),
        withHeader ? /* @__PURE__ */ jsx(
          "div",
          {
            className: "grid gap-3 border-b border-border bg-surface-2 px-4 py-2",
            style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` },
            children: Array.from({ length: columns }).map((_, c) => /* @__PURE__ */ jsx(
              "span",
              {
                className: "h-3 rounded bg-border/70",
                style: { width: `${40 + c * 17 % 40}%` }
              },
              `h-${c}`
            ))
          }
        ) : null,
        /* @__PURE__ */ jsx("div", { children: Array.from({ length: rows }).map((_, r) => /* @__PURE__ */ jsx(
          "div",
          {
            className: classNames(
              "grid gap-3 border-b border-border/60 px-4 last:border-b-0",
              rowPad
            ),
            style: {
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`
            },
            children: Array.from({ length: columns }).map((_2, c) => /* @__PURE__ */ jsx(
              "span",
              {
                className: "h-3 rounded bg-border/50",
                style: {
                  width: `${45 + (r * 13 + c * 29) % 45}%`,
                  animation: "mg-skel-pulse 1.4s ease-in-out infinite",
                  animationDelay: `${(r + c) % 6 * 90}ms`
                }
              },
              `${r}-${c}`
            ))
          },
          r
        )) })
      ]
    }
  );
}
function PanelHeader({
  title,
  description,
  actions,
  variant = "display",
  className
}) {
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: cn(
        "flex flex-wrap items-start justify-between gap-3",
        className
      ),
      children: [
        /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
          variant === "micro" ? /* @__PURE__ */ jsx("h3", { className: "text-13 font-semibold text-ink-strong", children: title }) : /* @__PURE__ */ jsx("h2", { className: "font-display text-16 font-medium leading-tight text-ink-strong", children: title }),
          description ? /* @__PURE__ */ jsx("p", { className: "mt-1 text-13 leading-relaxed text-ink-muted", children: description }) : null
        ] }),
        actions ? /* @__PURE__ */ jsx("div", { className: "flex shrink-0 flex-wrap items-center gap-2", children: actions }) : null
      ]
    }
  );
}
function Divider({
  tone = "default",
  pip = false,
  className
}) {
  const bar = tone === "accent" ? "bg-accent/40" : "bg-border";
  return /* @__PURE__ */ jsx(
    "div",
    {
      className: cn("relative h-px w-full", bar, className),
      role: "separator",
      "aria-hidden": true,
      children: pip ? /* @__PURE__ */ jsx("span", { className: "absolute left-0 top-1/2 -translate-y-1/2 size-1.5 rounded bg-accent" }) : null
    }
  );
}
function DefinitionList({
  items,
  layout = "inline",
  className
}) {
  if (layout === "grid") {
    return /* @__PURE__ */ jsx(
      "dl",
      {
        className: cn(
          "grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2",
          className
        ),
        children: items.map((it, i) => /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
          /* @__PURE__ */ jsx("dt", { className: "text-10 text-ink-muted", children: it.term }),
          /* @__PURE__ */ jsx("dd", { className: "mt-1 truncate text-13 text-ink-strong", children: it.detail })
        ] }, i))
      }
    );
  }
  if (layout === "stacked") {
    return /* @__PURE__ */ jsx("dl", { className: cn("space-y-3", className), children: items.map((it, i) => /* @__PURE__ */ jsxs("div", { className: "min-w-0", children: [
      /* @__PURE__ */ jsx("dt", { className: "text-10 text-ink-muted", children: it.term }),
      /* @__PURE__ */ jsx("dd", { className: "mt-1 text-13 text-ink-strong", children: it.detail })
    ] }, i)) });
  }
  return /* @__PURE__ */ jsx("dl", { className: cn("divide-y divide-border/70", className), children: items.map((it, i) => /* @__PURE__ */ jsxs(
    "div",
    {
      className: "flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0",
      children: [
        /* @__PURE__ */ jsx("dt", { className: "text-11 shrink-0 text-ink-muted", children: it.term }),
        /* @__PURE__ */ jsx("dd", { className: "min-w-0 truncate text-right text-13 text-ink-strong", children: it.detail })
      ]
    },
    i
  )) });
}
function LoadingPill({
  children = "Loading",
  tone = "muted",
  className
}) {
  return /* @__PURE__ */ jsx(
    Chip,
    {
      tone,
      icon: /* @__PURE__ */ jsx(Loader2, { className: "size-3 animate-spin" }),
      className,
      children
    }
  );
}
var SIZE = {
  sm: "min-h-8 px-2.5 text-13",
  md: "min-h-10 px-4 text-13",
  lg: "min-h-11 px-4 text-13"
};
var TONE2 = {
  default: "border-border text-ink-muted hover:border-accent/60 hover:text-ink-strong",
  accent: "border-accent/60 bg-primary-soft text-ink-strong hover:border-accent",
  warn: "border-health-warn/60 text-health-warn-text hover:border-health-warn",
  down: "border-health-down/60 text-health-down hover:border-health-down"
};
var GhostButton = forwardRef(
  function GhostButton2({
    size = "sm",
    tone = "default",
    icon,
    iconRight,
    className,
    children,
    type,
    ...rest
  }, ref) {
    return /* @__PURE__ */ jsxs(
      "button",
      {
        ref,
        type: type ?? "button",
        className: cn(
          "inline-flex items-center justify-center gap-1.5 rounded border bg-card transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          SIZE[size],
          TONE2[tone],
          className
        ),
        ...rest,
        children: [
          icon,
          children != null ? /* @__PURE__ */ jsx("span", { className: "min-w-0 truncate", children }) : null,
          iconRight
        ]
      }
    );
  }
);
function PagerFooter({
  summary,
  onPrev,
  onNext,
  hasPrev,
  hasNext,
  loading,
  className
}) {
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3 text-13 text-ink-muted",
        className
      ),
      children: [
        /* @__PURE__ */ jsx("div", { className: "min-w-0 truncate", "aria-live": "polite", children: loading ? "Loading\u2026" : summary }),
        /* @__PURE__ */ jsxs("div", { className: "flex items-center gap-2", children: [
          /* @__PURE__ */ jsx(
            GhostButton,
            {
              onClick: onPrev,
              disabled: !hasPrev || loading,
              icon: /* @__PURE__ */ jsx(ChevronLeft, { className: "size-3.5" }),
              "aria-label": "Previous page",
              children: "Prev"
            }
          ),
          /* @__PURE__ */ jsx(
            GhostButton,
            {
              onClick: onNext,
              disabled: !hasNext || loading,
              iconRight: /* @__PURE__ */ jsx(ChevronRight, { className: "size-3.5" }),
              "aria-label": "Next page",
              children: "Next"
            }
          )
        ] })
      ]
    }
  );
}
function ScrollShadow({
  orientation = "horizontal",
  className,
  innerClassName,
  children
}) {
  const ref = useRef(null);
  const [state, setState] = useState({ start: false, end: false });
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const update = () => {
      if (orientation === "horizontal") {
        setState({
          start: el.scrollLeft > 2,
          end: el.scrollLeft + el.clientWidth < el.scrollWidth - 2
        });
      } else {
        setState({
          start: el.scrollTop > 2,
          end: el.scrollTop + el.clientHeight < el.scrollHeight - 2
        });
      }
    };
    update();
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [orientation]);
  const isH = orientation === "horizontal";
  return /* @__PURE__ */ jsxs("div", { className: classNames("relative", className), children: [
    /* @__PURE__ */ jsx(
      "div",
      {
        ref,
        className: classNames(
          isH ? "overflow-x-auto" : "overflow-y-auto",
          "mg-scroll overscroll-contain",
          innerClassName
        ),
        style: isH ? { overflowY: "hidden", scrollbarWidth: "none" } : { overflowX: "hidden" },
        children
      }
    ),
    state.start ? /* @__PURE__ */ jsx(
      "div",
      {
        "aria-hidden": true,
        className: classNames(
          "pointer-events-none absolute z-[var(--mg-z-sticky)]",
          isH ? "left-0 top-0 h-full w-6 bg-gradient-to-r from-card to-transparent" : "left-0 top-0 h-6 w-full bg-gradient-to-b from-card to-transparent"
        )
      }
    ) : null,
    state.end ? /* @__PURE__ */ jsx(
      "div",
      {
        "aria-hidden": true,
        className: classNames(
          "pointer-events-none absolute z-[var(--mg-z-sticky)]",
          isH ? "right-0 top-0 h-full w-6 bg-gradient-to-l from-card to-transparent" : "bottom-0 left-0 h-6 w-full bg-gradient-to-t from-card to-transparent"
        )
      }
    ) : null
  ] });
}
var HIDE_TABLE = {
  sm: "hidden sm:block",
  md: "hidden md:block",
  lg: "hidden lg:block"
};
var SHOW_CARDS = {
  sm: "sm:hidden",
  md: "md:hidden",
  lg: "lg:hidden"
};
function ResponsiveTable({
  cardsFallback,
  cardsBelow = "md",
  minWidth = 720,
  className,
  children
}) {
  const min = typeof minWidth === "number" ? `${minWidth}px` : minWidth;
  if (cardsFallback != null) {
    return /* @__PURE__ */ jsxs("div", { className, children: [
      /* @__PURE__ */ jsx("div", { className: SHOW_CARDS[cardsBelow], children: cardsFallback }),
      /* @__PURE__ */ jsx("div", { className: HIDE_TABLE[cardsBelow], children: /* @__PURE__ */ jsx(ScrollShadow, { children: /* @__PURE__ */ jsx("div", { style: { minWidth: min }, children }) }) })
    ] });
  }
  return /* @__PURE__ */ jsx(ScrollShadow, { className: classNames(className), children: /* @__PURE__ */ jsx("div", { style: { minWidth: min }, children }) });
}
function FilterSheet({
  label = "Filters",
  activeCount = 0,
  children,
  className
}) {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    if (!open) return;
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    const prev = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = prev;
    };
  }, [open]);
  return /* @__PURE__ */ jsxs("div", { className, children: [
    /* @__PURE__ */ jsxs(
      "button",
      {
        type: "button",
        onClick: () => setOpen(true),
        "aria-expanded": open,
        "aria-haspopup": "dialog",
        className: classNames(
          "inline-flex min-h-9 items-center gap-1.5 rounded border px-2.5 py-1",
          "text-11 transition-colors",
          activeCount > 0 ? "border-accent/40 bg-accent/10 text-accent" : "border-border bg-card text-ink-strong hover:border-accent/40"
        ),
        children: [
          /* @__PURE__ */ jsx(Filter, { className: "size-3.5", "aria-hidden": true }),
          label,
          activeCount > 0 ? /* @__PURE__ */ jsx("span", { className: "ml-0.5 inline-flex size-4 items-center justify-center rounded bg-accent text-10 text-accent-foreground", children: activeCount }) : null
        ]
      }
    ),
    open ? /* @__PURE__ */ jsxs(
      "div",
      {
        role: "dialog",
        "aria-modal": "true",
        "aria-label": label,
        className: "fixed inset-0 z-[var(--mg-z-modal)] flex items-end sm:items-center sm:justify-center",
        children: [
          /* @__PURE__ */ jsx(
            "div",
            {
              className: "absolute inset-0 bg-ink-strong/30",
              onClick: () => setOpen(false),
              "aria-hidden": true
            }
          ),
          /* @__PURE__ */ jsxs(
            "div",
            {
              className: classNames(
                "relative z-[var(--mg-z-sticky)] w-full max-h-[85vh] overflow-y-auto",
                "rounded border-t border-border bg-card p-4",
                "sm:max-w-md sm:rounded sm:border sm:mx-4",
                "mg-scroll"
              ),
              children: [
                /* @__PURE__ */ jsxs("div", { className: "mb-4 flex items-center justify-between border-b border-border pb-3", children: [
                  /* @__PURE__ */ jsxs("span", { className: "text-11 text-ink-strong", children: [
                    label,
                    activeCount > 0 ? /* @__PURE__ */ jsxs("span", { className: "ml-2 text-ink-muted", children: [
                      "\xB7 ",
                      activeCount,
                      " active"
                    ] }) : null
                  ] }),
                  /* @__PURE__ */ jsx(
                    "button",
                    {
                      type: "button",
                      onClick: () => setOpen(false),
                      "aria-label": "Close filters",
                      className: "inline-flex size-8 items-center justify-center rounded text-ink-muted hover:text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      children: /* @__PURE__ */ jsx(X, { className: "size-4", "aria-hidden": true })
                    }
                  )
                ] }),
                /* @__PURE__ */ jsx("div", { className: "flex flex-col gap-3", children })
              ]
            }
          )
        ]
      }
    ) : null
  ] });
}
var HEIGHT = {
  xs: "h-16",
  sm: "h-24",
  md: "h-32",
  lg: "h-48",
  xl: "h-64"
};
function PanelSkeleton({
  height = "md",
  label = "Loading panel\u2026",
  className
}) {
  return /* @__PURE__ */ jsx(
    "div",
    {
      role: "status",
      "aria-live": "polite",
      "aria-busy": "true",
      className: classNames(
        "w-full rounded border border-border bg-card overflow-hidden",
        "animate-pulse",
        HEIGHT[height],
        className
      ),
      children: /* @__PURE__ */ jsx("span", { className: "sr-only", children: label })
    }
  );
}
var provenance = {
  native: {
    label: "Native",
    description: "Native chain metadata",
    className: "border-ink-strong/40 text-ink-strong"
  },
  "candidate-discovered": {
    label: "Candidate",
    description: "Discovered lead; not yet verified",
    className: "border-dashed border-ink-subtle text-ink-muted"
  },
  "community-seeded": {
    label: "Community",
    description: "Community-sourced registry metadata",
    className: "border-curation-seeded/45 text-curation-seeded"
  },
  "machine-verified": {
    label: "Machine",
    description: "Automatically verified registry metadata",
    className: "border-curation-machine/45 text-curation-machine"
  },
  "maintainer-reviewed": {
    label: "Reviewed",
    description: "Reviewed by a registry maintainer",
    className: "border-curation-verified/45 bg-primary-soft text-curation-verified"
  },
  "adapter-backed": {
    label: "Adapter",
    description: "Backed by a first-party registry adapter",
    className: "border-curation-adapter/45 text-curation-adapter"
  }
};
function ProvenanceChip({
  level,
  className
}) {
  const item = provenance[level ?? ""] ?? {
    label: level || "Unknown",
    description: "Curation provenance not classified",
    className: "border-border text-ink-muted"
  };
  return /* @__PURE__ */ jsx(
    "span",
    {
      tabIndex: 0,
      "aria-label": `${item.label}: ${item.description}`,
      className: classNames(
        "mg-focus-ring inline-flex items-center rounded border bg-transparent px-1.5 py-0.5 text-10",
        item.className,
        className
      ),
      children: item.label
    }
  );
}
function QueryBarRoot({
  children,
  className,
  ariaLabel = "Filter bar"
}) {
  return /* @__PURE__ */ jsx(
    "div",
    {
      role: "search",
      "aria-label": ariaLabel,
      className: classNames(
        "mg-query-shell",
        "flex w-full flex-wrap items-center gap-1 min-w-0",
        "h-10 rounded border border-border",
        "px-1 transition-colors",
        "focus-within:border-[color-mix(in_oklab,var(--accent)_45%,var(--border))]",
        "focus-within:ring-2 focus-within:ring-ring/60",
        className
      ),
      children
    }
  );
}
function QueryBarSearch({
  value,
  onChange,
  placeholder = "Search\u2026",
  shortcut = true,
  debounceMs = 0,
  className,
  ...props
}) {
  const ref = useRef(null);
  const [local, setLocal] = useState(value);
  useEffect(() => {
    setLocal(value);
  }, [value]);
  useEffect(() => {
    if (local === value) return;
    if (debounceMs <= 0) {
      onChange(local);
      return;
    }
    const t = window.setTimeout(() => onChange(local), debounceMs);
    return () => window.clearTimeout(t);
  }, [local, debounceMs]);
  useEffect(() => {
    if (!shortcut || typeof window === "undefined") return;
    const onKey = (e) => {
      if (e.key !== "/") return;
      const target = e.target;
      const tag = target?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || target?.isContentEditable)
        return;
      e.preventDefault();
      ref.current?.focus();
      ref.current?.select();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shortcut]);
  return /* @__PURE__ */ jsxs("div", { className: "relative flex flex-1 items-center gap-2 min-w-0 pl-2", children: [
    /* @__PURE__ */ jsx(Search, { className: "size-3.5 shrink-0 text-ink-muted", "aria-hidden": true }),
    /* @__PURE__ */ jsx(
      "input",
      {
        ...props,
        ref,
        type: "text",
        value: local,
        onChange: (e) => setLocal(e.target.value),
        onKeyDown: (e) => {
          if (e.key === "Enter" && debounceMs > 0 && local !== value) {
            onChange(local);
          }
          if (e.key === "Escape" && local) {
            e.preventDefault();
            setLocal("");
            onChange("");
          }
          props.onKeyDown?.(e);
        },
        placeholder,
        "aria-label": placeholder,
        className: classNames(
          "peer flex-1 min-w-0 bg-transparent border-0 outline-none",
          "py-1.5 text-13 text-ink-strong placeholder:text-ink-subtle-text",
          "focus:outline-none focus:ring-0",
          className
        )
      }
    ),
    local ? /* @__PURE__ */ jsx(
      "button",
      {
        type: "button",
        onClick: () => {
          setLocal("");
          onChange("");
          ref.current?.focus();
        },
        "aria-label": "Clear search",
        className: "mg-focus-ring inline-flex size-6 items-center justify-center rounded text-ink-muted hover:text-ink-strong",
        children: /* @__PURE__ */ jsx(X, { className: "size-3.5", "aria-hidden": true })
      }
    ) : shortcut ? /* @__PURE__ */ jsx(
      "kbd",
      {
        "aria-hidden": true,
        className: "pointer-events-none hidden sm:inline-flex items-center rounded border border-border/70 bg-paper px-1.5 py-0.5 text-10 text-ink-muted",
        children: "/"
      }
    ) : null
  ] });
}
function QueryBarDivider() {
  return /* @__PURE__ */ jsx(
    "span",
    {
      "aria-hidden": true,
      className: "mx-0.5 hidden sm:block h-5 w-px shrink-0 bg-border"
    }
  );
}
function QueryBarUtility({
  children,
  className
}) {
  return /* @__PURE__ */ jsx(
    "div",
    {
      className: classNames(
        "flex items-center gap-0.5 shrink-0 pr-1",
        className
      ),
      children
    }
  );
}
function QueryBarFilterTrigger(props) {
  const {
    label,
    options,
    placeholder = "Any",
    icon,
    align = "start",
    className
  } = props;
  const id = useId();
  const [open, setOpen] = useState(false);
  const selected = useMemo(
    () => props.multi ? props.value : props.value ? [props.value] : [],
    [props.multi, props.value]
  );
  const active = selected.length > 0;
  const preview = useMemo(() => {
    if (!active) return placeholder;
    const labels = selected.map(
      (v) => options.find((o) => o.value === v)?.label ?? v
    );
    if (labels.length === 1) return labels[0];
    return `${labels[0]} +${labels.length - 1}`;
  }, [selected, options, active, placeholder]);
  const toggle = useCallback(
    (v) => {
      if (props.multi) {
        const next = selected.includes(v) ? selected.filter((s) => s !== v) : [...selected, v];
        props.onChange(next);
      } else {
        props.onChange(selected[0] === v ? "" : v);
        setOpen(false);
      }
    },
    [props, selected]
  );
  const clear = useCallback(() => {
    if (props.multi) props.onChange([]);
    else props.onChange("");
  }, [props]);
  return /* @__PURE__ */ jsxs(Popover, { open, onOpenChange: setOpen, children: [
    /* @__PURE__ */ jsx(PopoverTrigger, { asChild: true, children: /* @__PURE__ */ jsxs(
      "button",
      {
        id,
        type: "button",
        "aria-label": `${label} filter${active ? `, ${selected.length} selected` : ""}`,
        className: classNames(
          "mg-ghost-trigger group inline-flex h-8 shrink-0 items-center gap-1.5 rounded px-2",
          "text-13 transition-colors",
          "hover:bg-surface-2",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "text-ink-strong" : "text-ink-muted",
          className
        ),
        children: [
          icon ? /* @__PURE__ */ jsx("span", { className: "shrink-0 text-ink-muted", children: icon }) : null,
          /* @__PURE__ */ jsx("span", { className: "text-10 opacity-80", children: label }),
          /* @__PURE__ */ jsx(
            "span",
            {
              className: classNames(
                "truncate max-w-[120px] font-medium",
                active ? "text-ink-strong border-b border-accent" : "text-ink-subtle-text"
              ),
              children: preview
            }
          ),
          /* @__PURE__ */ jsx(
            ChevronDown,
            {
              className: classNames(
                "size-3 shrink-0 text-ink-muted transition-transform",
                open && "rotate-180"
              ),
              "aria-hidden": true
            }
          )
        ]
      }
    ) }),
    /* @__PURE__ */ jsx(
      PopoverContent,
      {
        align,
        sideOffset: 6,
        className: "w-64 p-0 border-border bg-popover",
        children: /* @__PURE__ */ jsxs(Command, { children: [
          /* @__PURE__ */ jsx(
            CommandInput,
            {
              placeholder: `Filter ${label.toLowerCase()}\u2026`,
              className: "h-9"
            }
          ),
          /* @__PURE__ */ jsxs(CommandList, { className: "max-h-72", children: [
            /* @__PURE__ */ jsx(CommandEmpty, { children: "No matches." }),
            /* @__PURE__ */ jsx(CommandGroup, { children: options.map((o) => {
              const on = selected.includes(o.value);
              return /* @__PURE__ */ jsxs(
                CommandItem,
                {
                  value: o.label,
                  ...o.keywords ? { keywords: o.keywords } : {},
                  onSelect: () => toggle(o.value),
                  className: "cursor-pointer aria-selected:bg-surface-2",
                  children: [
                    /* @__PURE__ */ jsx(
                      "span",
                      {
                        className: classNames(
                          "inline-flex size-4 shrink-0 items-center justify-center rounded border",
                          on ? "border-accent bg-accent text-accent-foreground" : "border-border bg-transparent"
                        ),
                        "aria-hidden": true,
                        children: on ? /* @__PURE__ */ jsx(Check, { className: "size-3" }) : null
                      }
                    ),
                    /* @__PURE__ */ jsx("span", { className: "truncate", children: o.label })
                  ]
                },
                o.value
              );
            }) })
          ] }),
          active ? /* @__PURE__ */ jsxs("div", { className: "flex items-center justify-between border-t border-border px-2 py-1.5", children: [
            /* @__PURE__ */ jsxs("span", { className: "text-10 text-ink-muted", children: [
              selected.length,
              " selected"
            ] }),
            /* @__PURE__ */ jsx(
              "button",
              {
                type: "button",
                onClick: () => {
                  clear();
                  if (!props.multi) setOpen(false);
                },
                className: "mg-focus-ring rounded px-2 py-0.5 text-10 text-ink-muted hover:text-ink-strong",
                children: "Clear"
              }
            )
          ] }) : null
        ] })
      }
    )
  ] });
}
function QueryBarMetaRow({
  count,
  total,
  noun = "results",
  activeCount = 0,
  onReset,
  trailing,
  className
}) {
  const showTotal = total != null && total !== count;
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: classNames(
        "flex w-full items-center gap-2 pt-1.5",
        "text-10 text-ink-muted",
        className
      ),
      children: [
        /* @__PURE__ */ jsxs("span", { "aria-live": "polite", children: [
          /* @__PURE__ */ jsx("span", { className: "text-ink-strong", children: count.toLocaleString() }),
          showTotal ? /* @__PURE__ */ jsxs("span", { className: "opacity-70", children: [
            " of ",
            total.toLocaleString()
          ] }) : null,
          " ",
          noun
        ] }),
        activeCount > 0 ? /* @__PURE__ */ jsxs(Fragment, { children: [
          /* @__PURE__ */ jsx("span", { "aria-hidden": true, className: "opacity-40", children: "\xB7" }),
          /* @__PURE__ */ jsxs("span", { children: [
            activeCount,
            " filter",
            activeCount === 1 ? "" : "s"
          ] }),
          onReset ? /* @__PURE__ */ jsx(
            "button",
            {
              type: "button",
              onClick: onReset,
              className: "mg-focus-ring rounded text-accent hover:text-ink-strong transition-colors",
              children: "Reset"
            }
          ) : null
        ] }) : null,
        trailing ? /* @__PURE__ */ jsx("span", { className: "ml-auto flex items-center gap-2", children: trailing }) : null
      ]
    }
  );
}
var _ctx = createContext(null);
function useQueryBarContext() {
  return useContext(_ctx);
}
var QueryBar = Object.assign(QueryBarRoot, {
  Search: QueryBarSearch,
  Divider: QueryBarDivider,
  Utility: QueryBarUtility,
  FilterTrigger: QueryBarFilterTrigger,
  MetaRow: QueryBarMetaRow
});
var HEIGHTS = {
  sm: "min-h-[120px]",
  md: "min-h-[200px]",
  lg: "min-h-[320px]"
};
function PanelError({
  title = "Couldn't load this panel",
  message = "Something went wrong fetching this data. Retry, or try again in a moment.",
  errorId,
  onRetry,
  height = "md",
  trailing,
  className
}) {
  const [copied, setCopied] = useState(false);
  return /* @__PURE__ */ jsxs(
    "div",
    {
      role: "alert",
      className: classNames(
        "mg-panel-error flex flex-col items-center justify-center gap-3 rounded",
        "border border-border/70 bg-card p-6 text-center",
        HEIGHTS[height],
        className
      ),
      children: [
        /* @__PURE__ */ jsx("div", { className: "grid size-9 place-items-center rounded bg-surface-2 text-health-warn", children: /* @__PURE__ */ jsx(AlertTriangle, { className: "size-4", "aria-hidden": true }) }),
        /* @__PURE__ */ jsxs("div", { className: "max-w-sm space-y-1", children: [
          /* @__PURE__ */ jsx("div", { className: "font-display text-13 font-semibold text-ink-strong", children: title }),
          /* @__PURE__ */ jsx("p", { className: "text-13 leading-relaxed text-ink-muted", children: message })
        ] }),
        /* @__PURE__ */ jsxs("div", { className: "flex flex-wrap items-center justify-center gap-2 pt-1", children: [
          onRetry ? /* @__PURE__ */ jsx(
            GhostButton,
            {
              size: "sm",
              onClick: onRetry,
              icon: /* @__PURE__ */ jsx(RefreshCw, { className: "size-3" }),
              children: "Retry"
            }
          ) : null,
          errorId ? /* @__PURE__ */ jsxs(
            "button",
            {
              type: "button",
              onClick: () => {
                void navigator.clipboard.writeText(errorId).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1400);
                });
              },
              className: "mg-focus-ring inline-flex items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 text-10 text-ink-muted hover:text-ink-strong",
              "aria-label": `Copy error id ${errorId}`,
              children: [
                copied ? /* @__PURE__ */ jsx(Check, { className: "size-3", "aria-hidden": true }) : /* @__PURE__ */ jsx(Copy, { className: "size-3", "aria-hidden": true }),
                /* @__PURE__ */ jsxs("span", { className: "normal-case", children: [
                  "id \xB7 ",
                  errorId.slice(0, 8)
                ] })
              ]
            }
          ) : null,
          trailing
        ] })
      ]
    }
  );
}
function QueryProgress({
  active,
  position = "absolute",
  className,
  ariaLabel = "Updating results"
}) {
  return /* @__PURE__ */ jsx(
    "div",
    {
      role: "progressbar",
      "aria-label": ariaLabel,
      "aria-hidden": !active,
      className: classNames(
        "mg-query-progress pointer-events-none overflow-hidden",
        position === "absolute" && "absolute inset-x-0 top-0 z-[var(--mg-z-sticky)]",
        position === "fixed" && "fixed inset-x-0 top-0 z-[var(--mg-z-modal)]",
        position === "sticky" && "sticky top-0 z-[var(--mg-z-sticky)] -mt-px",
        "h-[2px]",
        active ? "opacity-100" : "opacity-0 transition-opacity duration-300",
        className
      ),
      children: /* @__PURE__ */ jsx(
        "div",
        {
          className: classNames(
            "h-full w-1/3 rounded",
            active && "mg-query-progress-track"
          ),
          style: {
            background: "linear-gradient(90deg, transparent, color-mix(in oklab, var(--accent) 90%, transparent), transparent)"
          }
        }
      )
    }
  );
}
function FilterChipRow({
  items,
  onRemove,
  onClearAll,
  className
}) {
  if (items.length === 0) return null;
  return /* @__PURE__ */ jsxs(
    "div",
    {
      role: "list",
      "aria-label": "Active filters",
      className: classNames(
        "flex flex-wrap items-center gap-1.5 pt-2",
        className
      ),
      children: [
        items.map((item) => /* @__PURE__ */ jsxs(
          "button",
          {
            role: "listitem",
            type: "button",
            onClick: () => onRemove(item.id),
            "aria-label": `Remove ${item.label} filter (${item.value})`,
            className: classNames(
              "group inline-flex h-6 items-center gap-1.5 rounded border border-border bg-card px-2",
              "text-11 transition-colors",
              "hover:border-[color-mix(in_oklab,var(--accent)_45%,var(--border))]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            ),
            children: [
              item.icon ? /* @__PURE__ */ jsx("span", { className: "text-ink-muted", children: item.icon }) : null,
              /* @__PURE__ */ jsx("span", { className: "text-10 text-ink-muted", children: item.label }),
              /* @__PURE__ */ jsx("span", { className: "font-medium text-ink-strong", children: item.value }),
              /* @__PURE__ */ jsx(
                X,
                {
                  "aria-hidden": true,
                  className: "size-3 text-ink-muted transition-colors group-hover:text-health-down"
                }
              )
            ]
          },
          item.id
        )),
        onClearAll && items.length > 1 ? /* @__PURE__ */ jsx(
          "button",
          {
            type: "button",
            onClick: onClearAll,
            className: "mg-focus-ring ml-1 rounded px-1.5 py-0.5 text-10 text-ink-muted hover:text-ink-strong",
            children: "Clear all"
          }
        ) : null
      ]
    }
  );
}
function RoutePending({
  title,
  panels = 2,
  panelHeight = "md",
  header,
  className
}) {
  return /* @__PURE__ */ jsxs(
    "div",
    {
      "aria-busy": "true",
      "aria-live": "polite",
      className: classNames(
        "mg-route-pending mx-auto w-full max-w-shell px-4 py-6 md:px-6",
        className
      ),
      children: [
        header ?? /* @__PURE__ */ jsxs("div", { className: "mb-6 space-y-3", children: [
          /* @__PURE__ */ jsx(
            "div",
            {
              className: "h-3 w-32 animate-pulse rounded bg-surface-2",
              "aria-hidden": true
            }
          ),
          /* @__PURE__ */ jsxs("div", { className: "flex items-baseline gap-3", children: [
            /* @__PURE__ */ jsx(
              "div",
              {
                className: "h-7 w-64 animate-pulse rounded bg-surface-2",
                "aria-hidden": true
              }
            ),
            title ? /* @__PURE__ */ jsxs("span", { className: "sr-only", children: [
              "Loading ",
              title
            ] }) : /* @__PURE__ */ jsx("span", { className: "sr-only", children: "Loading page" })
          ] }),
          /* @__PURE__ */ jsx(
            "div",
            {
              className: "h-3 w-96 max-w-full animate-pulse rounded bg-surface-2/70",
              "aria-hidden": true
            }
          )
        ] }),
        /* @__PURE__ */ jsx("div", { className: "space-y-4", children: Array.from({ length: panels }).map((_, i) => /* @__PURE__ */ jsx(PanelSkeleton, { height: panelHeight }, i)) })
      ]
    }
  );
}
function isScrolledPast(scrollY, threshold) {
  return scrollY > threshold;
}
function useScrolled(threshold = 4) {
  const [scrolled, setScrolled] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined") return;
    const onScroll = () => {
      setScrolled(isScrolledPast(window.scrollY, threshold));
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, [threshold]);
  return scrolled;
}

// src/components/metagraphed/charts/series-palette.ts
var CHART_RAMP_SIZE = 10;
var OTHER_COLOR = "var(--chart-11)";
var OTHER_KEY = "Other";
var SeriesPaletteRegistry = class {
  slots = /* @__PURE__ */ new Map();
  /** Assigns the next free ramp index to every unseen key, in the order given. */
  assign(keys) {
    for (const key of keys) {
      if (key === OTHER_KEY || this.slots.has(key)) continue;
      if (this.slots.size >= CHART_RAMP_SIZE) continue;
      this.slots.set(key, this.slots.size + 1);
    }
  }
  indexOf(key) {
    return this.slots.get(key) ?? null;
  }
  palette() {
    const indexOf = (key) => this.indexOf(key);
    return {
      indexOf,
      isOther: (key) => key === OTHER_KEY || indexOf(key) === null,
      colorOf: (key) => {
        const i = indexOf(key);
        return i === null ? OTHER_COLOR : `var(--chart-${i})`;
      }
    };
  }
  /** The keys that own a swatch, in ramp order. */
  keys() {
    return [...this.slots.entries()].sort((a, b) => a[1] - b[1]).map(([k]) => k);
  }
};
function collapseOther(segments, registry, label = OTHER_KEY) {
  const kept = [];
  let other = 0;
  for (const s of segments) {
    if (registry.indexOf(s.key) === null) other += s.value;
    else
      kept.push({
        key: s.key,
        label: s.label ?? s.key,
        value: s.value
      });
  }
  if (other > 0) kept.push({ key: OTHER_KEY, label, value: other });
  return kept;
}
var defaultFormat2 = (v) => String(v);
var BAR_PX = 15;
function StackedColumns({
  id,
  columns,
  seriesOrder,
  registry,
  other = OTHER_KEY,
  formatValue = defaultFormat2,
  ariaLabel,
  columnSource = "stacked-columns",
  className
}) {
  const ownRegistry = useRef(null);
  if (!registry && !ownRegistry.current)
    ownRegistry.current = new SeriesPaletteRegistry();
  const reg = registry ?? ownRegistry.current;
  reg.assign(seriesOrder);
  const palette = reg.palette();
  const rows = useMemo(
    () => columns.map((c) => ({
      ...c,
      segments: collapseOther(c.segments, reg, other)
    })),
    [columns, reg, other]
  );
  const seriesKeys = useMemo(() => {
    const keys = reg.keys().filter((k) => rows.some((r) => r.segments.some((s) => s.key === k)));
    if (rows.some((r) => r.segments.some((s) => s.key === OTHER_KEY)))
      keys.push(OTHER_KEY);
    return keys;
  }, [reg, rows]);
  const { active } = useActiveEntity();
  const activeSeries = active && seriesKeys.includes(active.key) ? active.key : null;
  const scrollRef = useRef(null);
  const [cadence, setCadence] = useState(7);
  const [gap, setGap] = useState(12);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const update = () => {
      const width = el.clientWidth;
      setCadence(width >= 768 ? 7 : 14);
      const pitch = width / Math.max(1, rows.length);
      setGap(pitch >= BAR_PX + 12 ? 12 : pitch >= BAR_PX + 8 ? 8 : 6);
    };
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, [rows.length]);
  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [rows.length]);
  const max = Math.max(1, ...rows.map((r) => r.total));
  return /* @__PURE__ */ jsxs(
    "div",
    {
      id,
      className: classNames("mg-stack", className),
      "data-mg-stack": "",
      "data-series-active": activeSeries ? "true" : void 0,
      style: {
        "--mg-stack-count": rows.length,
        "--mg-stack-gap": `${gap}px`
      },
      children: [
        /* @__PURE__ */ jsx(ChartTooltip, { top: 110 }),
        /* @__PURE__ */ jsx("div", { ref: scrollRef, className: "mg-stack-scroll", children: /* @__PURE__ */ jsxs("div", { className: "mg-stack-chart", children: [
          /* @__PURE__ */ jsx("div", { className: "mg-stack-axis", "aria-hidden": "true", children: rows.map((c, i) => /* @__PURE__ */ jsx(
            "div",
            {
              "data-entity": c.key,
              "data-active": active?.key === c.key ? "true" : void 0,
              "data-label-hidden": i % cadence !== 0 ? "true" : void 0,
              children: /* @__PURE__ */ jsxs("span", { className: "mg-stack-axis-label", children: [
                /* @__PURE__ */ jsx("span", { className: "mg-stack-axis-total", children: formatValue(c.total) }),
                /* @__PURE__ */ jsx("span", { children: c.axisLabel ?? c.label })
              ] })
            },
            c.key
          )) }),
          /* @__PURE__ */ jsx(
            "div",
            {
              className: "mg-stack-bars",
              role: "group",
              "aria-label": ariaLabel,
              "data-marks": true,
              children: rows.map((c) => /* @__PURE__ */ jsx(
                Column,
                {
                  column: c,
                  max,
                  palette,
                  activeSeries,
                  formatValue,
                  source: columnSource
                },
                c.key
              ))
            }
          )
        ] }) }),
        /* @__PURE__ */ jsx("div", { className: "mg-sr-table", children: /* @__PURE__ */ jsxs("table", { children: [
          /* @__PURE__ */ jsx("caption", { children: ariaLabel }),
          /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
            /* @__PURE__ */ jsx("th", { scope: "col", children: "Period" }),
            /* @__PURE__ */ jsx("th", { scope: "col", children: "Total" }),
            seriesKeys.map((k) => /* @__PURE__ */ jsx("th", { scope: "col", children: k === OTHER_KEY ? other : rows.flatMap((r) => r.segments).find((s) => s.key === k)?.label ?? k }, k))
          ] }) }),
          /* @__PURE__ */ jsx("tbody", { children: rows.map((c) => /* @__PURE__ */ jsxs("tr", { children: [
            /* @__PURE__ */ jsx("th", { scope: "row", children: c.label }),
            /* @__PURE__ */ jsx("td", { children: formatValue(c.total) }),
            seriesKeys.map((k) => /* @__PURE__ */ jsx("td", { children: formatValue(
              c.segments.find((s) => s.key === k)?.value ?? 0
            ) }, k))
          ] }, c.key)) })
        ] }) })
      ]
    }
  );
}
function Column({
  column: c,
  max,
  palette,
  activeSeries,
  formatValue,
  source
}) {
  const { set } = useActiveEntity();
  const [focusedSeries, setFocusedSeries] = useState(-1);
  const data = useMemo(
    () => ({
      title: c.label,
      total: `${formatValue(c.total)} total`,
      rows: c.segments.map((s) => ({
        key: s.key,
        label: s.label,
        value: formatValue(s.value),
        swatch: palette.colorOf(s.key)
      }))
    }),
    [c, formatValue, palette]
  );
  const mark = useEntityMark(c.key, {
    source,
    label: markAriaLabel(c.label, formatValue(c.total)),
    data
  });
  const elRef = useRef(null);
  const ref = useCallback(
    (el) => {
      elRef.current = el;
      mark.ref(el);
    },
    [mark]
  );
  const onKeyDown = (event) => {
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const n = c.segments.length;
      if (n === 0) return;
      const next = event.key === "ArrowUp" ? (focusedSeries + 1) % n : (focusedSeries - 1 + n) % n;
      setFocusedSeries(next);
      const s = c.segments[next];
      set({ key: s.key, source, element: elRef.current, data });
      return;
    }
    mark.onKeyDown(event);
  };
  const onBlur = (event) => {
    setFocusedSeries(-1);
    mark.onBlur(event);
  };
  const height = `${c.total / max * 100}%`;
  const rowsTemplate = c.segments.map((s) => `${c.total > 0 ? s.value / c.total * 100 : 0}%`).join(" ");
  return /* @__PURE__ */ jsx(
    "button",
    {
      type: "button",
      ...mark,
      ref,
      onKeyDown,
      onBlur,
      className: "mg-stack-col",
      style: {
        "--mg-stack-h": height,
        "--mg-stack-rows": rowsTemplate
      },
      children: /* @__PURE__ */ jsx("span", { className: "mg-stack-stack", "aria-hidden": "true", children: c.segments.map((s) => /* @__PURE__ */ jsx(
        "i",
        {
          "data-entity": s.key,
          "data-active": activeSeries === s.key ? "true" : void 0,
          "data-dim": activeSeries && activeSeries !== s.key ? "true" : void 0,
          style: { "--swatch": palette.colorOf(s.key) },
          onPointerEnter: (event) => {
            if (event.pointerType === "touch") return;
            set({ key: s.key, source, element: elRef.current, data });
          }
        },
        s.key
      )) })
    }
  );
}
function stackedSpecimen() {
  const series = [
    "Apex",
    "Targon",
    "Chutes",
    "Affine",
    "Score",
    "Nineteen",
    "Bitmind",
    "Gradients",
    "Macrocosmos",
    "Omron",
    "Vidaio",
    "Dippy"
  ];
  const columns = Array.from({ length: 56 }, (_, i) => {
    const segments = series.map((name, j) => ({
      key: name,
      label: name,
      value: Math.round(40 + 30 * Math.sin((i + j * 3) / 5) + j * 4)
    }));
    const total = segments.reduce((a, s) => a + s.value, 0);
    const d = new Date(Date.UTC(2026, 5, 28) + i * 864e5);
    const label = d.toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      timeZone: "UTC"
    }).toUpperCase();
    return { key: `d${i}`, label, axisLabel: label, total, segments };
  });
  return { columns, seriesOrder: series.slice(0, 8) };
}

// src/components/metagraphed/charts/line-geometry.ts
var LINE_VIEWBOX = { width: 1200, height: 370 };
var PAD_Y = 8;
var PLOT_RIGHT = 0.94;
function placePoints(points, box = LINE_VIEWBOX) {
  if (points.length === 0) return [];
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = Math.max(1, t1 - t0);
  let min = Infinity;
  let max = -Infinity;
  for (const p of points) {
    if (p.v < min) min = p.v;
    if (p.v > max) max = p.v;
  }
  const range = max - min || 1;
  return points.map((p) => ({
    ...p,
    x: points.length === 1 ? box.width * PLOT_RIGHT / 2 : (p.t - t0) / span * box.width * PLOT_RIGHT,
    y: box.height - PAD_Y - (p.v - min) / range * (box.height - PAD_Y * 2)
  }));
}
function smoothPath(points) {
  if (points.length === 0) return "";
  const f = (n) => (Math.round(n * 100) / 100).toString();
  if (points.length === 1) return `M${f(points[0].x)} ${f(points[0].y)}`;
  let d = `M${f(points[0].x)} ${f(points[0].y)}`;
  const k = 0.2;
  for (let i = 0; i < points.length - 1; i++) {
    const p0 = points[Math.max(0, i - 1)];
    const p1 = points[i];
    const p2 = points[i + 1];
    const p3 = points[Math.min(points.length - 1, i + 2)];
    const c1x = p1.x + (p2.x - p0.x) * k;
    const c1y = p1.y + (p2.y - p0.y) * k;
    const c2x = p2.x - (p3.x - p1.x) * k;
    const c2y = p2.y - (p3.y - p1.y) * k;
    d += ` C${f(c1x)} ${f(c1y)} ${f(c2x)} ${f(c2y)} ${f(p2.x)} ${f(p2.y)}`;
  }
  return d;
}
function windowPoints(points, window2) {
  return points.filter((p) => p.t >= window2.from && p.t <= window2.to);
}
function windowDelta(points, window2) {
  const inside = windowPoints(points, window2);
  if (inside.length === 0)
    return { start: 0, end: 0, ratio: null, label: "\u2014", state: "empty" };
  const start = inside[0].v;
  const end = inside[inside.length - 1].v;
  if (start === 0)
    return {
      start,
      end,
      ratio: null,
      label: "\u2014",
      state: end > 0 ? "positive" : "flat"
    };
  const ratio = (end - start) / Math.abs(start);
  const pct = Math.round(ratio * 100);
  const label = pct === 0 ? "0%" : pct > 0 ? `+${pct}%` : `\u2212${Math.abs(pct)}%`;
  return {
    start,
    end,
    ratio,
    label,
    state: pct > 0 ? "positive" : pct < 0 ? "negative" : "flat"
  };
}
function monthTicks(points) {
  if (points.length < 2) return [];
  const t0 = points[0].t;
  const t1 = points[points.length - 1].t;
  const span = t1 - t0 || 1;
  const out = [];
  const d = new Date(t0);
  d.setUTCDate(1);
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCMonth(d.getUTCMonth() + 1);
  while (d.getTime() <= t1) {
    out.push({
      label: d.toLocaleString("en-US", { month: "short", timeZone: "UTC" }).toUpperCase(),
      pct: (d.getTime() - t0) / span * 100 * PLOT_RIGHT
    });
    d.setUTCMonth(d.getUTCMonth() + 1);
  }
  return out;
}
var defaultFormat3 = (v) => String(v);
var dateFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  timeZone: "UTC"
});
var formatLineDate = (t) => dateFormat.format(new Date(t)).toUpperCase();
var rangeFormat = new Intl.DateTimeFormat("en-US", {
  month: "short",
  day: "numeric",
  year: "numeric",
  timeZone: "UTC"
});
function LineWithWindow({
  id,
  points,
  window: window2,
  unit,
  formatValue = defaultFormat3,
  formatDate = formatLineDate,
  formatRange,
  ariaLabel,
  keyOf,
  source = "line",
  compact = false,
  className
}) {
  const placed = useMemo(() => placePoints(points), [points]);
  const inside = useMemo(() => windowPoints(placed, window2), [placed, window2]);
  const delta = useMemo(() => windowDelta(points, window2), [points, window2]);
  const months = useMemo(() => monthTicks(points), [points]);
  const keyFor = keyOf ?? ((p) => `${source}:${p.t}`);
  const { active } = useActiveEntity();
  const activePoint = active ? placed.find((p) => keyFor(p) === active.key) : void 0;
  const first = placed[0];
  const wStart = inside[0];
  const wEnd = inside[inside.length - 1];
  const pct = (n, of) => `${(n / of * 100).toFixed(2)}%`;
  const rangeLabel = wStart && wEnd ? formatRange ? formatRange(wStart.t, wEnd.t) : `${rangeFormat.format(new Date(wStart.t)).toUpperCase()} \u2192 ${rangeFormat.format(new Date(wEnd.t)).toUpperCase()}` : "";
  const summary = momentumAriaLabel(
    unit,
    wEnd ? formatValue(wEnd.v) : null,
    delta.label,
    rangeLabel
  );
  return /* @__PURE__ */ jsxs(
    "div",
    {
      id,
      className: classNames("mg-line", className),
      "data-mg-line": "",
      "data-compact": compact ? "true" : void 0,
      "data-state": delta.state,
      children: [
        compact ? null : /* @__PURE__ */ jsxs("div", { className: "mg-line-summary", children: [
          /* @__PURE__ */ jsxs("p", { className: "mg-line-total", children: [
            /* @__PURE__ */ jsx("strong", { children: wEnd ? formatValue(wEnd.v) : "\u2014" }),
            /* @__PURE__ */ jsx("span", { className: "mg-line-delta", "data-state": delta.state, children: delta.label })
          ] }),
          /* @__PURE__ */ jsxs("p", { className: "mg-line-range", children: [
            rangeLabel,
            " \xB7 ",
            unit
          ] })
        ] }),
        /* @__PURE__ */ jsxs(
          "div",
          {
            className: "mg-line-plot",
            role: "group",
            "aria-label": summary,
            "data-marks": true,
            children: [
              /* @__PURE__ */ jsx(ChartTooltip, { top: compact ? 16 : 110 }),
              /* @__PURE__ */ jsxs(
                "svg",
                {
                  viewBox: `0 0 ${LINE_VIEWBOX.width} ${LINE_VIEWBOX.height}`,
                  preserveAspectRatio: "none",
                  "aria-hidden": "true",
                  focusable: "false",
                  children: [
                    /* @__PURE__ */ jsx("path", { className: "mg-line-muted", d: smoothPath(placed) }),
                    /* @__PURE__ */ jsx("path", { className: "mg-line-active", d: smoothPath(inside) }),
                    activePoint ? /* @__PURE__ */ jsx(
                      "line",
                      {
                        className: "mg-line-cursor",
                        x1: activePoint.x,
                        x2: activePoint.x,
                        y1: 0,
                        y2: LINE_VIEWBOX.height
                      }
                    ) : null
                  ]
                }
              ),
              [first, wStart, wEnd].filter((p) => Boolean(p)).map((p, i) => /* @__PURE__ */ jsx(
                "i",
                {
                  className: "mg-line-marker",
                  "data-window": i > 0 ? "true" : void 0,
                  style: {
                    "--mg-line-x": pct(p.x, LINE_VIEWBOX.width),
                    "--mg-line-y": pct(p.y, LINE_VIEWBOX.height)
                  }
                },
                `${i}-${p.t}`
              )),
              activePoint ? /* @__PURE__ */ jsx(
                "i",
                {
                  className: "mg-line-marker mg-line-marker-cursor",
                  style: {
                    "--mg-line-x": pct(activePoint.x, LINE_VIEWBOX.width),
                    "--mg-line-y": pct(activePoint.y, LINE_VIEWBOX.height)
                  }
                }
              ) : null,
              wEnd && delta.state !== "empty" ? /* @__PURE__ */ jsxs(
                "span",
                {
                  className: "mg-line-end",
                  "data-state": delta.state,
                  "aria-hidden": "true",
                  style: {
                    "--mg-line-x": pct(wEnd.x, LINE_VIEWBOX.width),
                    "--mg-line-y": pct(wEnd.y, LINE_VIEWBOX.height)
                  },
                  children: [
                    delta.label,
                    /* @__PURE__ */ jsx("i", {})
                  ]
                }
              ) : null,
              /* @__PURE__ */ jsx("div", { className: "mg-line-hits", children: placed.map((p, i) => {
                const left = i === 0 ? 0 : (placed[i - 1].x + p.x) / 2;
                const right = i === placed.length - 1 ? LINE_VIEWBOX.width : (p.x + placed[i + 1].x) / 2;
                return /* @__PURE__ */ jsx(
                  Hit,
                  {
                    entityKey: keyFor(p),
                    label: formatDate(p.t),
                    value: formatValue(p.v),
                    source,
                    left: pct(left, LINE_VIEWBOX.width),
                    width: pct(right - left, LINE_VIEWBOX.width)
                  },
                  p.t
                );
              }) })
            ]
          }
        ),
        compact ? null : /* @__PURE__ */ jsx("div", { className: "mg-line-months", "aria-hidden": "true", children: months.map((m) => /* @__PURE__ */ jsx("span", { style: { left: `${m.pct}%` }, children: m.label }, m.pct)) }),
        /* @__PURE__ */ jsx("div", { className: "mg-sr-table", children: /* @__PURE__ */ jsxs("table", { children: [
          /* @__PURE__ */ jsx("caption", { children: ariaLabel }),
          /* @__PURE__ */ jsx("thead", { children: /* @__PURE__ */ jsxs("tr", { children: [
            /* @__PURE__ */ jsx("th", { scope: "col", children: "Date" }),
            /* @__PURE__ */ jsx("th", { scope: "col", children: unit })
          ] }) }),
          /* @__PURE__ */ jsx("tbody", { children: points.map((p) => /* @__PURE__ */ jsxs("tr", { children: [
            /* @__PURE__ */ jsx("th", { scope: "row", children: formatDate(p.t) }),
            /* @__PURE__ */ jsx("td", { children: formatValue(p.v) })
          ] }, p.t)) })
        ] }) })
      ]
    }
  );
}
function Hit({
  entityKey,
  label,
  value,
  source,
  left,
  width
}) {
  const elRef = useRef(null);
  const mark = useEntityMark(entityKey, {
    source,
    label: markAriaLabel(label, value),
    data: { title: label, total: value }
  });
  return /* @__PURE__ */ jsx(
    "button",
    {
      type: "button",
      ...mark,
      ref: (el) => {
        elRef.current = el;
        mark.ref(el);
      },
      className: "mg-line-hit",
      style: { left, width }
    }
  );
}
function lineSpecimen(days = 120) {
  const day = 864e5;
  const t0 = Date.UTC(2026, 3, 24);
  const points = [];
  let v = 40;
  for (let i = 0; i < days; i++) {
    v = Math.max(5, v + Math.sin(i / 9) * 6 + (i % 7 === 0 ? 9 : 1.2));
    points.push({ t: t0 + i * day, v: Math.round(v * 10) / 10 });
  }
  return {
    points,
    window: { from: t0 + (days - 56) * day, to: t0 + (days - 1) * day }
  };
}
function trendDeltaOf(values) {
  const points = values.filter((v) => typeof v === "number" && Number.isFinite(v)).map((v, i) => ({ t: i, v }));
  return windowDelta(points, {
    from: 0,
    to: Math.max(0, points.length - 1)
  });
}
function TrendDelta({ values, label, className }) {
  const delta = trendDeltaOf(values);
  return /* @__PURE__ */ jsx(
    "span",
    {
      className: classNames("mg-line-delta", className),
      "data-state": delta.state,
      "aria-label": `${label} ${delta.label}`,
      children: delta.label
    }
  );
}
function railFill(value, max, scale = "linear") {
  if (!(max > 0) || !(value > 0)) return 0;
  const ratio = Math.min(1, value / max);
  return Math.round((scale === "sqrt" ? Math.sqrt(ratio) : ratio) * 1e3) / 10;
}
function RankedRails({
  items,
  formatValue,
  formatSecondary,
  scale = "linear",
  max,
  columns,
  limit = 10,
  ariaLabel,
  source = "ranked-rails",
  onActivate,
  className
}) {
  const [expanded, setExpanded] = useState(false);
  const cap = max ?? Math.max(0, ...items.map((i) => Math.max(i.value, i.secondary ?? 0)));
  const shown = expanded ? items : items.slice(0, limit);
  const hasSecondary = items.some((i) => i.secondary !== void 0);
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: classNames("mg-rails", className),
      "data-mg-rails": "",
      "data-secondary": hasSecondary ? "true" : void 0,
      children: [
        columns ? /* @__PURE__ */ jsxs("div", { className: "mg-rails-head", "aria-hidden": "true", children: [
          /* @__PURE__ */ jsx("span", { children: columns.value }),
          /* @__PURE__ */ jsx("span", { children: columns.name }),
          /* @__PURE__ */ jsx("span", { children: columns.track }),
          hasSecondary ? /* @__PURE__ */ jsx("span", { children: columns.secondary ?? "" }) : null
        ] }) : null,
        /* @__PURE__ */ jsxs(
          "div",
          {
            className: "mg-rails-rows",
            role: "group",
            "aria-label": ariaLabel,
            "data-marks": true,
            children: [
              /* @__PURE__ */ jsx(ChartTooltip, { top: 8 }),
              shown.map((item) => /* @__PURE__ */ jsx(
                Rail,
                {
                  item,
                  cap,
                  scale,
                  formatValue,
                  formatSecondary: formatSecondary ?? formatValue,
                  hasSecondary,
                  source,
                  onActivate
                },
                item.key
              ))
            ]
          }
        ),
        items.length > limit && !expanded ? /* @__PURE__ */ jsxs(
          "button",
          {
            type: "button",
            className: "mg-rails-more",
            onClick: () => setExpanded(true),
            children: [
              "Show all ",
              items.length
            ]
          }
        ) : null
      ]
    }
  );
}
function Rail({
  item,
  cap,
  scale,
  formatValue,
  formatSecondary,
  hasSecondary,
  source,
  onActivate
}) {
  const mark = useEntityMark(item.key, {
    source,
    label: markAriaLabel(item.label, formatValue(item.value)),
    data: item.detail ? { title: item.label, total: formatValue(item.value), rows: item.detail } : { title: item.label, total: formatValue(item.value) },
    onActivate: item.href ? void 0 : onActivate ? () => onActivate(item) : void 0
  });
  const body = /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("span", { className: "mg-rails-value", children: formatValue(item.value) }),
    /* @__PURE__ */ jsxs("span", { className: "mg-rails-name", children: [
      item.avatar ? /* @__PURE__ */ jsx("span", { className: "mg-rails-avatar", children: item.avatar }) : null,
      /* @__PURE__ */ jsx("span", { children: item.label })
    ] }),
    /* @__PURE__ */ jsx("span", { className: "mg-rails-track", children: /* @__PURE__ */ jsx(
      "b",
      {
        style: {
          "--fill": `${railFill(item.value, cap, scale)}%`
        }
      }
    ) }),
    hasSecondary ? /* @__PURE__ */ jsx(
      "span",
      {
        className: "mg-rails-track",
        "data-secondary": true,
        title: item.secondary === void 0 ? void 0 : formatSecondary(item.secondary),
        children: /* @__PURE__ */ jsx(
          "b",
          {
            style: {
              "--fill": `${railFill(item.secondary ?? 0, cap, scale)}%`
            }
          }
        )
      }
    ) : null
  ] });
  const { role: _role, ...linkMark } = mark;
  return item.href ? /* @__PURE__ */ jsx("a", { ...linkMark, href: item.href, className: "mg-rails-row", children: body }) : /* @__PURE__ */ jsx("button", { type: "button", ...mark, className: "mg-rails-row", children: body });
}
function markerPosition(value, max) {
  if (value === null || !Number.isFinite(value) || !(max > 0)) return null;
  return Math.round(Math.min(1, Math.max(0, value / max)) * 1e3) / 10;
}
function MarkerRail({
  items,
  max = 100,
  formatValue,
  columns,
  ariaLabel,
  source = "marker-rail",
  onActivate,
  className
}) {
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: classNames("mg-marker-rail", className),
      "data-mg-marker-rail": "",
      children: [
        /* @__PURE__ */ jsxs("div", { className: "mg-rails-head", "aria-hidden": "true", children: [
          /* @__PURE__ */ jsx("span", { children: columns.ratio }),
          /* @__PURE__ */ jsx("span", { children: columns.name }),
          /* @__PURE__ */ jsx("span", { children: columns.scale })
        ] }),
        /* @__PURE__ */ jsx(
          "div",
          {
            className: "mg-rails-rows",
            role: "group",
            "aria-label": ariaLabel,
            "data-marks": true,
            children: items.map((item) => /* @__PURE__ */ jsx(
              MarkerRow,
              {
                item,
                max,
                formatValue,
                source,
                onActivate
              },
              item.key
            ))
          }
        )
      ]
    }
  );
}
function MarkerRow({
  item,
  max,
  formatValue,
  source,
  onActivate
}) {
  const pos = markerPosition(item.value, max);
  const shown = item.value === null || pos === null ? "\u2014" : formatValue(item.value);
  const mark = useEntityMark(item.key, {
    source,
    label: markAriaLabel(item.label, shown === "\u2014" ? null : shown),
    onActivate: item.href ? void 0 : onActivate ? () => onActivate(item) : void 0
  });
  const body = /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("span", { className: "mg-rails-value", children: shown }),
    /* @__PURE__ */ jsxs("span", { className: "mg-rails-name", children: [
      item.avatar ? /* @__PURE__ */ jsx("span", { className: "mg-rails-avatar", children: item.avatar }) : null,
      item.tag ? /* @__PURE__ */ jsx("span", { className: "mg-rails-tag", children: item.tag }) : null,
      /* @__PURE__ */ jsx("span", { children: item.label })
    ] }),
    /* @__PURE__ */ jsx(
      "span",
      {
        className: "mg-marker-rail-track",
        "data-empty": pos === null ? "true" : void 0,
        children: pos === null ? null : /* @__PURE__ */ jsx("i", { style: { "--pos": `${pos}%` } })
      }
    )
  ] });
  const { role: _role, ...linkMark } = mark;
  return item.href ? /* @__PURE__ */ jsx("a", { ...linkMark, href: item.href, className: "mg-rails-row", children: body }) : /* @__PURE__ */ jsx("button", { type: "button", ...mark, className: "mg-rails-row", children: body });
}
function RankGrid({
  items,
  cols = 4,
  ariaLabel,
  source = "rank-grid",
  start = 1,
  onActivate,
  className
}) {
  return /* @__PURE__ */ jsx(
    "ol",
    {
      className: classNames("mg-rank-grid", className),
      style: { "--cols": cols },
      role: "group",
      "aria-label": ariaLabel,
      "data-marks": true,
      "data-mg-rank-grid": "",
      children: items.map((item, i) => /* @__PURE__ */ jsx(
        RankRow,
        {
          item,
          rank: start + i,
          source,
          onActivate
        },
        item.key
      ))
    }
  );
}
function RankRow({
  item,
  rank,
  source,
  onActivate
}) {
  const mark = useEntityMark(item.key, {
    source,
    label: markAriaLabel(item.label, item.value),
    onActivate: item.href ? void 0 : onActivate ? () => onActivate(item) : void 0
  });
  const body = /* @__PURE__ */ jsxs(Fragment, { children: [
    /* @__PURE__ */ jsx("span", { className: "mg-rank-grid-rank", children: String(rank).padStart(2, "0") }),
    item.avatar ? /* @__PURE__ */ jsx("span", { className: "mg-rank-grid-avatar", children: item.avatar }) : /* @__PURE__ */ jsx(
      "i",
      {
        className: "mg-swatch",
        style: { "--swatch": item.swatch ?? "var(--faint)" }
      }
    ),
    /* @__PURE__ */ jsx("span", { className: "mg-rank-grid-name", children: item.label }),
    item.value ? /* @__PURE__ */ jsx("span", { className: "mg-rank-grid-value", children: item.value }) : null,
    item.share ? /* @__PURE__ */ jsx("span", { className: "mg-rank-grid-share", children: item.share }) : null
  ] });
  const { role: _role, ...linkMark } = mark;
  return /* @__PURE__ */ jsx("li", { "data-current": item.current ? "true" : void 0, children: item.href ? /* @__PURE__ */ jsx("a", { ...linkMark, href: item.href, className: "mg-rank-grid-row", children: body }) : /* @__PURE__ */ jsx("button", { type: "button", ...mark, className: "mg-rank-grid-row", children: body }) });
}
function deltaLabel(delta) {
  if (delta === void 0) return { text: "", state: "none" };
  if (delta === "new") return { text: "New", state: "new" };
  const pct = Math.round(delta * 100);
  if (pct === 0) return { text: "0%", state: "flat" };
  return pct > 0 ? { text: `+${pct}%`, state: "positive" } : { text: `\u2212${Math.abs(pct)}%`, state: "negative" };
}
function LeaderCards({
  items,
  featured = 3,
  ariaLabel,
  source = "leader-cards",
  className
}) {
  const lead = items.slice(0, featured);
  const rest = items.slice(featured);
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: classNames("mg-leaders", className),
      role: "group",
      "aria-label": ariaLabel,
      "data-marks": true,
      "data-mg-leaders": "",
      children: [
        lead.length > 0 ? /* @__PURE__ */ jsx("ol", { className: "mg-leaders-featured", start: 1, children: lead.map((item, i) => /* @__PURE__ */ jsx(
          LeaderCard,
          {
            item,
            rank: i + 1,
            variant: "featured",
            source
          },
          item.key
        )) }) : null,
        rest.length > 0 ? /* @__PURE__ */ jsx("ol", { className: "mg-leaders-compact", start: lead.length + 1, children: rest.map((item, i) => /* @__PURE__ */ jsx(
          LeaderCard,
          {
            item,
            rank: lead.length + i + 1,
            variant: "compact",
            source
          },
          item.key
        )) }) : null
      ]
    }
  );
}
function LeaderCard({
  item,
  rank,
  variant,
  source
}) {
  const mark = useEntityMark(item.key, {
    source,
    label: markAriaLabel(`#${rank} ${item.name}`, item.value)
  });
  const { role: _role, ...linkMark } = mark;
  const delta = deltaLabel(item.delta);
  const initials = item.initials ?? item.name.slice(0, 2).toUpperCase();
  return /* @__PURE__ */ jsx("li", { children: /* @__PURE__ */ jsxs(
    "a",
    {
      ...linkMark,
      href: item.href,
      className: "mg-leader",
      "data-variant": variant,
      children: [
        /* @__PURE__ */ jsx("span", { className: "mg-leader-rank", children: String(rank).padStart(2, "0") }),
        /* @__PURE__ */ jsx("span", { className: "mg-leader-avatar", "aria-hidden": "true", children: item.avatar ?? initials }),
        /* @__PURE__ */ jsxs("span", { className: "mg-leader-copy", children: [
          /* @__PURE__ */ jsx("strong", { children: item.name }),
          item.sub ? /* @__PURE__ */ jsx("span", { children: item.sub }) : null
        ] }),
        /* @__PURE__ */ jsxs("span", { className: "mg-leader-figures", children: [
          /* @__PURE__ */ jsx("span", { className: "mg-leader-value", children: item.value }),
          delta.state !== "none" ? /* @__PURE__ */ jsx("span", { className: "mg-leader-delta", "data-state": delta.state, children: delta.text }) : null
        ] }),
        variant === "featured" ? /* @__PURE__ */ jsx("span", { className: "mg-leader-watermark", "aria-hidden": "true", children: initials }) : null
      ]
    }
  ) });
}
function CompositionBreakdown({
  segments,
  registry,
  formatValue,
  limit,
  other = OTHER_KEY,
  legendCols = 4,
  ariaLabel,
  source = "composition",
  onActivate,
  className
}) {
  const own = useRef(null);
  if (!registry && !own.current) own.current = new SeriesPaletteRegistry();
  const reg = registry ?? own.current;
  const ordered = [...segments].sort((a, b) => b.value - a.value);
  const keep = limit === void 0 ? ordered : ordered.slice(0, limit);
  reg.assign(keep.map((s) => s.key));
  const palette = reg.palette();
  const shown = collapseOther(ordered, reg, other).filter((s) => s.value > 0);
  const total = shown.reduce((sum, s) => sum + s.value, 0);
  const { active, set, clear } = useActiveEntity();
  const barRef = useRef(null);
  const activeKey = active && shown.some((s) => s.key === active.key) ? active.key : null;
  const legend = shown.map((s) => ({
    key: s.key,
    label: s.key === OTHER_KEY ? other : s.label,
    value: formatValue(s.value),
    share: total > 0 ? `${Math.round(s.value / total * 1e3) / 10}%` : void 0,
    swatch: palette.colorOf(s.key),
    href: segments.find((o) => o.key === s.key)?.href
  }));
  return /* @__PURE__ */ jsxs(
    "div",
    {
      className: classNames("mg-composition", className),
      "data-mg-composition": "",
      children: [
        /* @__PURE__ */ jsx(
          "div",
          {
            ref: barRef,
            className: "mg-composition-bar",
            role: "img",
            "aria-label": `${ariaLabel}: ${legend.map((l) => `${l.label} ${l.share ?? l.value}`).join(", ")}`,
            "data-series-active": activeKey ? "true" : void 0,
            children: shown.map((s) => /* @__PURE__ */ jsx(
              "i",
              {
                "data-entity": s.key,
                "data-active": activeKey === s.key ? "true" : void 0,
                "data-dim": activeKey && activeKey !== s.key ? "true" : void 0,
                onPointerEnter: (event) => {
                  if (event.pointerType === "touch") return;
                  set({
                    key: s.key,
                    source,
                    element: barRef.current,
                    data: {
                      title: s.key === OTHER_KEY ? other : s.label,
                      total: formatValue(s.value)
                    }
                  });
                },
                onPointerLeave: (event) => {
                  if (event.pointerType === "touch") return;
                  clear();
                },
                style: {
                  "--share": total > 0 ? `${s.value / total * 100}%` : "0%",
                  "--swatch": palette.colorOf(s.key)
                }
              },
              s.key
            ))
          }
        ),
        /* @__PURE__ */ jsx(
          RankGrid,
          {
            items: legend,
            cols: legendCols,
            ariaLabel,
            source,
            onActivate: onActivate ? (item) => onActivate(item.key) : void 0
          }
        )
      ]
    }
  );
}

// src/components/metagraphed/charts/rank-specimens.ts
var RAIL_SPECIMEN = [
  ["Targon", 189e4, 412e3],
  ["Chutes", 121e4, 38e4],
  ["Affine", 64e4, 12e4],
  ["Score", 512e3, 98e3],
  ["Nineteen", 33e4, 61e3],
  ["Bitmind", 28e4, 44e3],
  ["Gradients", 19e4, 39e3],
  ["Apex", 14e4, 3e4],
  ["Macrocosmos", 12e4, 22e3],
  ["Omron", 95e3, 18e3],
  ["Vidaio", 61e3, 9e3],
  ["Dippy", 42e3, 6e3]
].map(([label, value, secondary]) => ({
  key: String(label),
  label: String(label),
  value: Number(value),
  secondary: Number(secondary),
  detail: [
    { key: "take", label: "Take", value: "9%" },
    { key: "apy", label: "APY", value: "0.46%" },
    { key: "nominators", label: "Nominators", value: "1,204" }
  ]
}));
var MARKER_SPECIMEN = [
  ["OpenAPI", "openapi", 99.8],
  ["Validator API", "subnet-api", 97.2],
  ["Docs", "docs", 100],
  ["Dashboard", "dashboard", 91.4],
  ["SSE feed", "sse", null]
].map(([label, tag, value]) => ({
  key: String(label),
  label: String(label),
  tag: String(tag),
  value
}));
var COMPOSITION_SPECIMEN = [
  ["Targon", 41],
  ["Chutes", 41],
  ["Affine", 18]
].map(([label, value]) => ({
  key: String(label),
  label: String(label),
  value: Number(value)
}));
var LEADER_SPECIMEN = RAIL_SPECIMEN.map((r, i) => ({
  key: r.key,
  name: r.label,
  sub: i % 2 ? "Macrocosmos" : "Rayon Labs",
  value: `${(r.value / 1e6).toFixed(2)}M \u03C4`,
  delta: i === 3 ? "new" : i * 7 % 11 / 10 - 0.3,
  href: `/subnets/${i + 1}`
}));

export { Accordion, AccordionContent, AccordionItem, AccordionTrigger, ActiveEntityProvider, AnalyticsPage, AnalyticsSection, AnimatedNumber, BackToTop, BrandIcon, CHART_RAMP_SIZE, COMPOSITION_SPECIMEN, CandidateChip, ChartTooltip, Chip, ClaudeIcon, ColumnCustomizer, Command, CommandDialog, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList, CommandSeparator, CommandShortcut, CompositionBreakdown, CopyButton, CopyIconToggle, CopyableCode, CurationChip, Definition, DefinitionList, DefinitionsProvider, Dialog, DialogClose, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogOverlay, DialogPortal, DialogTitle, DialogTrigger, DiscordIcon, Divider, DownloadCsvButton, EligibilityChip, EmptyState, EntityHero, ExternalLink, Fact, FactCell, FactSentence, FactStrip, FilterChipRow, FilterField, FilterInput, FilterSelect, FilterSheet, FilterToolbar, GhostButton, HealthDot, HealthPill, Indicator, Kbd, KeyChip, LEADER_SPECIMEN, LINE_VIEWBOX, LeaderCards, LineWithWindow, ListShell, LiveMeta, LiveTickerProvider, LoadMore, LoadingPill, MARKER_SPECIMEN, MAX_SECTIONS, MarkerRail, McpToolsList, OTHER_COLOR, OTHER_KEY, OpenAIIcon, PagerBar, PagerFooter, Panel, PanelError, PanelHeader, PanelSkeleton, Popover, PopoverAnchor, PopoverContent, PopoverTrigger, Provenance, ProvenanceChip, QueryBar, QueryProgress, RAIL_SPECIMEN, RangeControl, RankGrid, RankedRails, Raw, RawCode, ResponsiveTable, ReviewChip, RoutePending, SCOPES, SHARE_COPIED_EVENT, ScrollShadow, SectionHead, SectionNav, SeriesPaletteRegistry, ShareButton, Sheet, SheetClose, SheetContent, SheetDescription, SheetFooter, SheetHeader, SheetOverlay, SheetPortal, SheetTitle, SheetTrigger, Skeleton, StackedColumns, StatusBadge, TableColGroup, TableSkeleton, TableState, TimeAgo, Toaster, TrendDelta, ViewModeToggle, Wordmark, buildCsvDownloadUrl, classNames, cn, collapseOther, columnWidths, defaultVisible, deltaLabel, fmtYield, formatLineDate, isScrolledPast, lineSpecimen, markAriaLabel, markerPosition, momentumAriaLabel, monthTicks, nextTabIndex, pickActiveSection, placePoints, prefetchBrandIcon, provenanceSentence, railFill, rovingTabIndex, safeExternalUrl, sectionItems, smoothPath, stackedSpecimen, trendDeltaOf, useActiveEntity, useActiveSection, useColumnVisibility, useDefinition, useEntityMark, useIsActive, useLiveTicker, useQueryBarContext, useRovingGroup, useScrolled, windowDelta, windowPoints };
