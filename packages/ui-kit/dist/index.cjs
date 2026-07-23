'use strict';

var React3 = require('react');
var AccordionPrimitive = require('@radix-ui/react-accordion');
var lucideReact = require('lucide-react');
var clsx = require('clsx');
var tailwindMerge = require('tailwind-merge');
var jsxRuntime = require('react/jsx-runtime');
var cmdk = require('cmdk');
var DialogPrimitive = require('@radix-ui/react-dialog');
var HoverCardPrimitive = require('@radix-ui/react-hover-card');
var PopoverPrimitive = require('@radix-ui/react-popover');
var classVarianceAuthority = require('class-variance-authority');
var sonner = require('sonner');
var TooltipPrimitive = require('@radix-ui/react-tooltip');

function _interopDefault (e) { return e && e.__esModule ? e : { default: e }; }

function _interopNamespace(e) {
  if (e && e.__esModule) return e;
  var n = Object.create(null);
  if (e) {
    Object.keys(e).forEach(function (k) {
      if (k !== 'default') {
        var d = Object.getOwnPropertyDescriptor(e, k);
        Object.defineProperty(n, k, d.get ? d : {
          enumerable: true,
          get: function () { return e[k]; }
        });
      }
    });
  }
  n.default = e;
  return Object.freeze(n);
}

var React3__namespace = /*#__PURE__*/_interopNamespace(React3);
var AccordionPrimitive__namespace = /*#__PURE__*/_interopNamespace(AccordionPrimitive);
var clsx__default = /*#__PURE__*/_interopDefault(clsx);
var DialogPrimitive__namespace = /*#__PURE__*/_interopNamespace(DialogPrimitive);
var HoverCardPrimitive__namespace = /*#__PURE__*/_interopNamespace(HoverCardPrimitive);
var PopoverPrimitive__namespace = /*#__PURE__*/_interopNamespace(PopoverPrimitive);
var TooltipPrimitive__namespace = /*#__PURE__*/_interopNamespace(TooltipPrimitive);

// src/components/ui/accordion.tsx
function cn(...inputs) {
  return tailwindMerge.twMerge(clsx__default.default(...inputs));
}
var Accordion = AccordionPrimitive__namespace.Root;
var AccordionItem = React3__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  AccordionPrimitive__namespace.Item,
  {
    ref,
    className: cn("border-b", className),
    ...props
  }
));
AccordionItem.displayName = "AccordionItem";
var AccordionTrigger = React3__namespace.forwardRef(({ className, children, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(AccordionPrimitive__namespace.Header, { className: "flex", children: /* @__PURE__ */ jsxRuntime.jsxs(
  AccordionPrimitive__namespace.Trigger,
  {
    ref,
    className: cn(
      "flex flex-1 items-center justify-between py-4 text-sm font-medium cursor-pointer transition-all hover:underline text-left [&[data-state=open]>svg]:rotate-180",
      className
    ),
    ...props,
    children: [
      children,
      /* @__PURE__ */ jsxRuntime.jsx(lucideReact.ChevronDown, { className: "h-4 w-4 shrink-0 text-muted-foreground transition-transform duration-200" })
    ]
  }
) }));
AccordionTrigger.displayName = AccordionPrimitive__namespace.Trigger.displayName;
var AccordionContent = React3__namespace.forwardRef(({ className, children, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  AccordionPrimitive__namespace.Content,
  {
    ref,
    className: "overflow-hidden text-sm data-[state=closed]:animate-accordion-up data-[state=open]:animate-accordion-down",
    ...props,
    children: /* @__PURE__ */ jsxRuntime.jsx("div", { className: cn("pb-4 pt-0", className), children })
  }
));
AccordionContent.displayName = AccordionPrimitive__namespace.Content.displayName;
var Dialog = DialogPrimitive__namespace.Root;
var DialogTrigger = DialogPrimitive__namespace.Trigger;
var DialogPortal = DialogPrimitive__namespace.Portal;
var DialogClose = DialogPrimitive__namespace.Close;
var DialogOverlay = React3__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  DialogPrimitive__namespace.Overlay,
  {
    ref,
    className: cn(
      "fixed inset-0 z-50 bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    ),
    ...props
  }
));
DialogOverlay.displayName = DialogPrimitive__namespace.Overlay.displayName;
var DialogContent = React3__namespace.forwardRef(({ className, children, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsxs(DialogPortal, { children: [
  /* @__PURE__ */ jsxRuntime.jsx(DialogOverlay, {}),
  /* @__PURE__ */ jsxRuntime.jsxs(
    DialogPrimitive__namespace.Content,
    {
      ref,
      className: cn(
        "fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded-lg",
        className
      ),
      ...props,
      children: [
        children,
        /* @__PURE__ */ jsxRuntime.jsxs(DialogPrimitive__namespace.Close, { className: "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background cursor-pointer transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground", children: [
          /* @__PURE__ */ jsxRuntime.jsx(lucideReact.X, { className: "h-4 w-4" }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "sr-only", children: "Close" })
        ] })
      ]
    }
  )
] }));
DialogContent.displayName = DialogPrimitive__namespace.Content.displayName;
var DialogHeader = ({
  className,
  ...props
}) => /* @__PURE__ */ jsxRuntime.jsx(
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
}) => /* @__PURE__ */ jsxRuntime.jsx(
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
var DialogTitle = React3__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  DialogPrimitive__namespace.Title,
  {
    ref,
    className: cn(
      "text-lg font-semibold leading-none tracking-tight",
      className
    ),
    ...props
  }
));
DialogTitle.displayName = DialogPrimitive__namespace.Title.displayName;
var DialogDescription = React3__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  DialogPrimitive__namespace.Description,
  {
    ref,
    className: cn("text-sm text-muted-foreground", className),
    ...props
  }
));
DialogDescription.displayName = DialogPrimitive__namespace.Description.displayName;
var Command = React3__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  cmdk.Command,
  {
    ref,
    className: cn(
      "flex h-full w-full flex-col overflow-hidden rounded-md bg-popover text-popover-foreground",
      className
    ),
    ...props
  }
));
Command.displayName = cmdk.Command.displayName;
var CommandDialog = ({ children, ...props }) => {
  return /* @__PURE__ */ jsxRuntime.jsx(Dialog, { ...props, children: /* @__PURE__ */ jsxRuntime.jsx(DialogContent, { className: "overflow-hidden p-0 max-w-[calc(100vw-2rem)] sm:max-w-lg", children: /* @__PURE__ */ jsxRuntime.jsx(Command, { className: "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5", children }) }) });
};
var CommandInput = React3__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-center border-b px-3", "cmdk-input-wrapper": "", children: [
  /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Search, { className: "mr-2 h-4 w-4 shrink-0 opacity-50" }),
  /* @__PURE__ */ jsxRuntime.jsx(
    cmdk.Command.Input,
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
CommandInput.displayName = cmdk.Command.Input.displayName;
var CommandList = React3__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  cmdk.Command.List,
  {
    ref,
    className: cn("max-h-[300px] overflow-y-auto overflow-x-hidden", className),
    ...props
  }
));
CommandList.displayName = cmdk.Command.List.displayName;
var CommandEmpty = React3__namespace.forwardRef((props, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  cmdk.Command.Empty,
  {
    ref,
    className: "py-6 text-center text-sm",
    ...props
  }
));
CommandEmpty.displayName = cmdk.Command.Empty.displayName;
var CommandGroup = React3__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  cmdk.Command.Group,
  {
    ref,
    className: cn(
      "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
      className
    ),
    ...props
  }
));
CommandGroup.displayName = cmdk.Command.Group.displayName;
var CommandSeparator = React3__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  cmdk.Command.Separator,
  {
    ref,
    className: cn("-mx-1 h-px bg-border", className),
    ...props
  }
));
CommandSeparator.displayName = cmdk.Command.Separator.displayName;
var CommandItem = React3__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  cmdk.Command.Item,
  {
    ref,
    className: cn(
      "relative flex cursor-default gap-2 select-none items-center rounded-sm px-2 py-1.5 text-sm outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
      className
    ),
    ...props
  }
));
CommandItem.displayName = cmdk.Command.Item.displayName;
var CommandShortcut = ({
  className,
  ...props
}) => {
  return /* @__PURE__ */ jsxRuntime.jsx(
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
var HoverCard = HoverCardPrimitive__namespace.Root;
var HoverCardTrigger = HoverCardPrimitive__namespace.Trigger;
var HoverCardContent = React3__namespace.forwardRef(({ className, align = "center", sideOffset = 4, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  HoverCardPrimitive__namespace.Content,
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
HoverCardContent.displayName = HoverCardPrimitive__namespace.Content.displayName;
var Popover = PopoverPrimitive__namespace.Root;
var PopoverTrigger = PopoverPrimitive__namespace.Trigger;
var PopoverAnchor = PopoverPrimitive__namespace.Anchor;
var PopoverContent = React3__namespace.forwardRef(({ className, align = "center", sideOffset = 4, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(PopoverPrimitive__namespace.Portal, { children: /* @__PURE__ */ jsxRuntime.jsx(
  PopoverPrimitive__namespace.Content,
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
PopoverContent.displayName = PopoverPrimitive__namespace.Content.displayName;
var Sheet = DialogPrimitive__namespace.Root;
var SheetTrigger = DialogPrimitive__namespace.Trigger;
var SheetClose = DialogPrimitive__namespace.Close;
var SheetPortal = DialogPrimitive__namespace.Portal;
var SheetOverlay = React3__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  DialogPrimitive__namespace.Overlay,
  {
    className: cn(
      "fixed inset-0 z-50 bg-black/80  data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    ),
    ...props,
    ref
  }
));
SheetOverlay.displayName = DialogPrimitive__namespace.Overlay.displayName;
var sheetVariants = classVarianceAuthority.cva(
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
var SheetContent = React3__namespace.forwardRef(({ side = "right", className, children, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsxs(SheetPortal, { children: [
  /* @__PURE__ */ jsxRuntime.jsx(SheetOverlay, {}),
  /* @__PURE__ */ jsxRuntime.jsxs(
    DialogPrimitive__namespace.Content,
    {
      ref,
      className: cn(sheetVariants({ side }), className),
      ...props,
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs(DialogPrimitive__namespace.Close, { className: "absolute right-4 top-4 rounded-sm opacity-70 ring-offset-background cursor-pointer transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary", children: [
          /* @__PURE__ */ jsxRuntime.jsx(lucideReact.X, { className: "h-4 w-4" }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "sr-only", children: "Close" })
        ] }),
        children
      ]
    }
  )
] }));
SheetContent.displayName = DialogPrimitive__namespace.Content.displayName;
var SheetHeader = ({
  className,
  ...props
}) => /* @__PURE__ */ jsxRuntime.jsx(
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
}) => /* @__PURE__ */ jsxRuntime.jsx(
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
var SheetTitle = React3__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  DialogPrimitive__namespace.Title,
  {
    ref,
    className: cn("text-lg font-semibold text-foreground", className),
    ...props
  }
));
SheetTitle.displayName = DialogPrimitive__namespace.Title.displayName;
var SheetDescription = React3__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  DialogPrimitive__namespace.Description,
  {
    ref,
    className: cn("text-sm text-muted-foreground", className),
    ...props
  }
));
SheetDescription.displayName = DialogPrimitive__namespace.Description.displayName;

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
function SegmentedToggle({
  options,
  value,
  onChange,
  ariaLabel,
  className
}) {
  return /* @__PURE__ */ jsxRuntime.jsx(
    "div",
    {
      role: "tablist",
      "aria-label": ariaLabel,
      className: classNames(
        "inline-flex items-center rounded-md border border-border bg-card p-0.5",
        className
      ),
      children: options.map(
        ({ value: v, label, Icon, ariaLabel: optionAriaLabel, title }) => {
          const active = v === value;
          return /* @__PURE__ */ jsxRuntime.jsxs(
            "button",
            {
              type: "button",
              role: "tab",
              "aria-selected": active,
              "aria-label": optionAriaLabel ?? label,
              title: title ?? label,
              onClick: () => onChange(v),
              className: classNames(
                "inline-flex items-center gap-1.5 rounded px-2 py-1 text-[11px] font-medium transition-colors min-h-8",
                active ? "bg-surface text-ink-strong" : "text-ink-muted hover:text-ink-strong"
              ),
              children: [
                Icon ? /* @__PURE__ */ jsxRuntime.jsx(Icon, { className: "size-3.5" }) : null,
                /* @__PURE__ */ jsxRuntime.jsx("span", { className: "hidden sm:inline", children: label })
              ]
            },
            v
          );
        }
      )
    }
  );
}
var Toaster = ({ ...props }) => {
  return /* @__PURE__ */ jsxRuntime.jsx(
    sonner.Toaster,
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
var TooltipProvider = TooltipPrimitive__namespace.Provider;
var Tooltip = TooltipPrimitive__namespace.Root;
var TooltipTrigger = TooltipPrimitive__namespace.Trigger;
var TooltipContent = React3__namespace.forwardRef(({ className, sideOffset = 4, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(TooltipPrimitive__namespace.Portal, { children: /* @__PURE__ */ jsxRuntime.jsx(
  TooltipPrimitive__namespace.Content,
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
TooltipContent.displayName = TooltipPrimitive__namespace.Content.displayName;
function Skeleton({ className = "h-4 w-full" }) {
  return /* @__PURE__ */ jsxRuntime.jsx("div", { className: `animate-pulse rounded bg-surface-2 ${className}` });
}
function AccentBand({
  children,
  pattern = false,
  className,
  innerClassName
}) {
  return /* @__PURE__ */ jsxRuntime.jsxs(
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
        pattern ? /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            className: "mg-dot-grid absolute inset-0 opacity-40 pointer-events-none",
            "aria-hidden": true
          }
        ) : null,
        /* @__PURE__ */ jsxRuntime.jsx(
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
  const [display, setDisplay] = React3.useState(safe);
  const [flash, setFlash] = React3.useState("");
  const fromRef = React3.useRef(safe);
  const rafRef = React3.useRef(null);
  React3.useEffect(() => {
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
  return /* @__PURE__ */ jsxRuntime.jsx(
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
  const [visible, setVisible] = React3.useState(false);
  React3.useEffect(() => {
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
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
        "px-3 py-2 mg-type-label uppercase text-ink-strong",
        "shadow-[0_8px_24px_-12px_rgba(0,0,0,0.35)] hover:border-accent/60 hover:text-accent",
        "transition-[opacity,transform,border-color,color] duration-200",
        visible ? "opacity-100 translate-y-0 pointer-events-auto" : "opacity-0 translate-y-2 pointer-events-none"
      ),
      children: [
        /* @__PURE__ */ jsxRuntime.jsx(lucideReact.ArrowUp, { className: "size-3.5" }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "hidden sm:inline", children: "Top" })
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
  const [choice, setChoiceState] = React3.useState(() => readChoice());
  const [resolved, setResolved] = React3.useState("light");
  React3.useEffect(() => {
    setResolved(apply(choice));
    if (choice !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(apply("system"));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice]);
  const setChoice = React3.useCallback((next) => {
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
var viteEnv = undefined;
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
    const host = u.hostname.toLowerCase();
    if (host !== "github.com" && !host.endsWith(".github.com")) return null;
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
  const host = extractHost(url);
  if (host) push(buildProxyIconUrl(host, size * 2, theme));
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
  const host = React3.useMemo(() => extractHost(url), [url]);
  const lookup = React3.useMemo(
    () => ({ providerSlug, subnetSlug, netuid }),
    [providerSlug, subnetSlug, netuid]
  );
  const chain = React3.useMemo(
    () => buildCandidateChain({ url, iconUrl, repoUrl, lookup, theme, size }),
    [url, iconUrl, repoUrl, lookup, theme, size]
  );
  const initialIndex = React3.useMemo(() => {
    if (!host) return 0;
    const winner = winnerByHost.get(host);
    if (!winner) return 0;
    const idx = chain.indexOf(winner);
    return idx >= 0 ? idx : 0;
  }, [host, chain]);
  const [index, setIndex] = React3.useState(initialIndex);
  const [loaded, setLoaded] = React3.useState(false);
  const [needsContrastTile, setNeedsContrastTile] = React3.useState(false);
  React3.useEffect(() => {
    setIndex(initialIndex);
    setLoaded(false);
    setNeedsContrastTile(false);
  }, [initialIndex, chain]);
  const candidate = chain[index] ?? null;
  const exhausted = !candidate;
  React3.useEffect(() => {
    if (candidate && loadedUrls.has(candidate)) setLoaded(true);
    if (candidate && isDarkLogo.has(candidate)) {
      setNeedsContrastTile(theme === "dark" && isDarkLogo.get(candidate));
    }
  }, [candidate, theme]);
  const advance = React3.useCallback(() => {
    setIndex((i) => i + 1);
    setLoaded(false);
    setNeedsContrastTile(false);
  }, []);
  const onImgError = React3.useCallback(() => {
    if (candidate) failedUrls.add(candidate);
    advance();
  }, [candidate, advance]);
  const onImgLoad = React3.useCallback(
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
    "rounded-md border border-border",
    needsContrastTile ? "bg-white/95" : "bg-surface",
    className
  );
  const style = { width: size, height: size };
  const labelText = name ?? (fallback != null ? String(fallback) : "");
  const ariaLabel = decorative ? void 0 : labelText ? `${labelText} icon` : "icon";
  const ariaHidden = decorative ? true : void 0;
  if (exhausted) {
    return /* @__PURE__ */ jsxRuntime.jsx(
      "span",
      {
        className: classNames(baseClasses, "bg-accent/10 text-ink-strong"),
        style,
        role: decorative ? void 0 : "img",
        "aria-hidden": ariaHidden,
        "aria-label": ariaLabel,
        title: decorative ? void 0 : labelText || void 0,
        children: /* @__PURE__ */ jsxRuntime.jsx(
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "span",
    {
      className: baseClasses,
      style,
      role: decorative ? void 0 : "img",
      "aria-hidden": ariaHidden,
      "aria-label": ariaLabel,
      title: decorative ? void 0 : labelText || void 0,
      children: [
        !loaded ? /* @__PURE__ */ jsxRuntime.jsx(
          "span",
          {
            "aria-hidden": "true",
            className: "absolute inset-0 flex items-center justify-center bg-accent/10 text-ink-muted/70",
            children: /* @__PURE__ */ jsxRuntime.jsx(
              "span",
              {
                className: "font-display font-semibold tabular-nums leading-none",
                style: { fontSize: Math.max(10, Math.round(size * 0.42)) },
                children: monogramFor(name, fallback)
              }
            )
          }
        ) : null,
        /* @__PURE__ */ jsxRuntime.jsx(
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
  const dot = /* @__PURE__ */ jsxRuntime.jsx(
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
  return /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
    dot,
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "text-[11px] font-medium text-ink", children: label })
  ] });
}
function HealthPill({
  state,
  label
}) {
  if (label) {
    return /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
      /* @__PURE__ */ jsxRuntime.jsx(HealthDot, { state }),
      /* @__PURE__ */ jsxRuntime.jsx("span", { className: "text-[11px] font-medium text-ink", children: label })
    ] });
  }
  return /* @__PURE__ */ jsxRuntime.jsx(HealthDot, { state, variant: "label" });
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
  return /* @__PURE__ */ jsxRuntime.jsx(
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
  return /* @__PURE__ */ jsxRuntime.jsx(
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
  return /* @__PURE__ */ jsxRuntime.jsx("span", { className: "inline-flex items-center rounded border border-dashed border-ink-subtle bg-transparent px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wider text-ink-muted", children: "Unverified" });
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
  const [copied, setCopied] = React3.useState(false);
  const timer = React3.useRef(null);
  const copy = React3.useCallback(
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
          sonner.toast.success(copySuccessTitle(label), {
            description: truncateCopyPreview(value),
            duration: 1800
          });
        }
        if (timer.current) window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setCopied(false), resetAfter);
        return true;
      } catch (err) {
        sonner.toast.error("Copy failed", {
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "span",
    {
      className: classNames(
        "relative inline-flex shrink-0 items-center justify-center",
        sizeClass
      ),
      "aria-hidden": true,
      children: [
        /* @__PURE__ */ jsxRuntime.jsx(
          lucideReact.Check,
          {
            className: classNames(
              "absolute text-health-ok transition-all duration-150",
              sizeClass,
              copied ? "scale-100 opacity-100" : "scale-50 opacity-0"
            )
          }
        ),
        /* @__PURE__ */ jsxRuntime.jsx(
          lucideReact.Copy,
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
  return /* @__PURE__ */ jsxRuntime.jsx("span", { role: "status", "aria-live": "polite", className: "sr-only", children });
}
function CopyButton({
  value,
  label,
  className,
  compact
}) {
  const { copied, copy } = useCopy({ label });
  return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
    /* @__PURE__ */ jsxRuntime.jsx(
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
        children: /* @__PURE__ */ jsxRuntime.jsx(CopyIconToggle, { copied })
      }
    ),
    /* @__PURE__ */ jsxRuntime.jsx(CopyStatusRegion, { children: copied ? `${label ?? "Value"} copied to clipboard` : "" })
  ] });
}
function CopyableCode({
  value,
  label,
  className,
  truncate = true
}) {
  const { copied, copy } = useCopy({ label: label ?? "value" });
  return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
    /* @__PURE__ */ jsxRuntime.jsxs(
      "button",
      {
        type: "button",
        onClick: () => copy(value),
        title: value,
        "aria-label": copied ? "Copied" : `Copy ${label ?? "value"}`,
        className: classNames(
          "group inline-flex min-w-0 items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-left font-mono text-[11px] text-ink hover:border-ink/30 transition-colors",
          // Matches KeyChip's ring treatment -- this one is a bordered chip like
          // KeyChip (not an icon-only hit area), so the offset ring reads cleanly
          // against the card behind it (#6371).
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent/60 focus-visible:ring-offset-1 focus-visible:ring-offset-card",
          className
        ),
        children: [
          label ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "shrink-0 text-ink-muted mg-type-micro", children: label }) : null,
          /* @__PURE__ */ jsxRuntime.jsx(
            "code",
            {
              className: classNames(
                "min-w-0 text-ink-strong",
                truncate ? "truncate" : "truncate sm:whitespace-normal sm:break-all"
              ),
              children: value
            }
          ),
          /* @__PURE__ */ jsxRuntime.jsxs(
            "span",
            {
              className: "relative inline-flex size-3 shrink-0 items-center justify-center",
              "aria-hidden": true,
              children: [
                /* @__PURE__ */ jsxRuntime.jsx(
                  lucideReact.Check,
                  {
                    className: classNames(
                      "absolute size-3 text-health-ok transition-all duration-150",
                      copied ? "scale-100 opacity-100" : "scale-50 opacity-0"
                    )
                  }
                ),
                /* @__PURE__ */ jsxRuntime.jsx(
                  lucideReact.Copy,
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
    /* @__PURE__ */ jsxRuntime.jsx(CopyStatusRegion, { children: copied ? `${label ?? "Value"} copied to clipboard` : "" })
  ] });
}
function DensityToggle({
  value,
  onChange,
  className
}) {
  const options = [
    {
      value: "comfortable",
      label: "Comfortable",
      Icon: lucideReact.Rows3,
      ariaLabel: "Comfortable row density",
      title: "Comfortable rows"
    },
    {
      value: "compact",
      label: "Compact",
      Icon: lucideReact.Rows2,
      ariaLabel: "Compact row density",
      title: "Compact rows"
    }
  ];
  return /* @__PURE__ */ jsxRuntime.jsx(
    SegmentedToggle,
    {
      options,
      value,
      onChange,
      ariaLabel: "Row density",
      className
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
  className,
  bare
}) {
  const exportUrl = buildCsvDownloadUrl(url);
  const onClick = () => {
    window.location.href = exportUrl;
  };
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "button",
    {
      type: "button",
      onClick,
      "aria-label": label,
      title: label,
      className: classNames(
        bare ? "inline-flex items-center gap-1.5 rounded px-2 py-1 min-h-8 text-[11px] font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" : (
          // rounded-full matches the pill idiom shared by SectionBadge/FilterChip/
          // other compact header controls it commonly sits next to — a plain
          // `rounded` rectangle reads as a mismatched shape beside a pill.
          "inline-flex items-center gap-1.5 rounded-full border border-border bg-card p-1.5 text-[11px] font-medium text-ink hover:border-ink/30 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring sm:px-2.5 sm:py-1"
        ),
        className
      ),
      children: [
        /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Download, { className: "size-3 text-ink-muted", "aria-hidden": true }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "hidden sm:inline", children: label })
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
  return /* @__PURE__ */ jsxRuntime.jsx(TooltipProvider, { delayDuration: 120, children: /* @__PURE__ */ jsxRuntime.jsxs(Tooltip, { children: [
    /* @__PURE__ */ jsxRuntime.jsx(TooltipTrigger, { asChild: true, children: /* @__PURE__ */ jsxRuntime.jsx(
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
    /* @__PURE__ */ jsxRuntime.jsxs(
      TooltipContent,
      {
        side: "top",
        className: "max-w-[240px] text-[11px] leading-relaxed",
        children: [
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-type-micro opacity-70 mb-1", children: ELIGIBILITY_LABEL[eligibility] }),
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
  const content = /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "truncate", children }),
    safeHref ? /* @__PURE__ */ jsxRuntime.jsx(lucideReact.ExternalLink, { className: "size-3 shrink-0 text-ink-muted" }) : null,
    authRequired ? /* @__PURE__ */ jsxRuntime.jsxs(
      "span",
      {
        title: "Authentication required",
        className: "inline-flex items-center gap-0.5 rounded border border-border bg-surface px-1 mg-type-micro text-ink-muted",
        children: [
          /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Lock, { className: "size-2.5" }),
          " auth"
        ]
      }
    ) : null,
    !publicSafe ? /* @__PURE__ */ jsxRuntime.jsxs(
      "span",
      {
        title: "Not public-safe \u2014 handle with care",
        className: "inline-flex items-center gap-0.5 rounded border border-health-warn/30 bg-health-warn/5 px-1 mg-type-micro text-health-warn",
        children: [
          /* @__PURE__ */ jsxRuntime.jsx(lucideReact.AlertTriangle, { className: "size-2.5" }),
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
    return /* @__PURE__ */ jsxRuntime.jsx("span", { className: classes, title: "Blocked unsafe external URL", children: content });
  }
  return /* @__PURE__ */ jsxRuntime.jsx(
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
function InfoTooltip({
  label,
  className
}) {
  return /* @__PURE__ */ jsxRuntime.jsx(TooltipProvider, { delayDuration: 150, children: /* @__PURE__ */ jsxRuntime.jsxs(Tooltip, { children: [
    /* @__PURE__ */ jsxRuntime.jsx(TooltipTrigger, { asChild: true, children: /* @__PURE__ */ jsxRuntime.jsx(
      "button",
      {
        type: "button",
        "aria-label": label,
        className: "inline-flex items-center text-ink-muted hover:text-ink-strong focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded " + (className ?? ""),
        children: /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Info, { className: "size-3.5" })
      }
    ) }),
    /* @__PURE__ */ jsxRuntime.jsx(
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
  const [mounted, setMounted] = React3.useState(false);
  React3.useEffect(() => setMounted(true), []);
  const missing = at == null;
  const stale = !missing && isStaleFreshness(at, thresholdMs);
  const cls = missing ? "bg-health-unknown" : stale ? "bg-health-warn" : "bg-health-ok";
  const rel = mounted ? formatRelative(at) : "";
  const title = missing ? "No freshness data" : !mounted ? void 0 : stale ? `Stale \u2014 last updated ${rel}` : `Fresh \u2014 updated ${rel}`;
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "span",
    {
      className: classNames("inline-flex items-center gap-1.5", className),
      title,
      suppressHydrationWarning: true,
      children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: classNames("size-1.5 rounded-full", cls) }),
        !dotOnly ? /* @__PURE__ */ jsxRuntime.jsx(
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
function tierFreshnessLabel(tier, at) {
  if (at == null) return "No freshness data";
  const prefix = tier === "realtime" ? "Live chain read" : "Daily rollup snapshot";
  return `${prefix} \u2014 updated ${formatRelative(at)}`;
}
function DailyRollupFreshness({
  at,
  className
}) {
  return /* @__PURE__ */ jsxRuntime.jsxs("span", { className: classNames("inline-flex items-center gap-1", className), children: [
    /* @__PURE__ */ jsxRuntime.jsx(FreshnessIndicator, { at, dotOnly: true }),
    /* @__PURE__ */ jsxRuntime.jsx(InfoTooltip, { label: tierFreshnessLabel("daily", at) })
  ] });
}
function RealtimeFreshness({
  at,
  className
}) {
  return /* @__PURE__ */ jsxRuntime.jsxs("span", { className: classNames("inline-flex items-center gap-1", className), children: [
    /* @__PURE__ */ jsxRuntime.jsx(FreshnessIndicator, { at, dotOnly: true }),
    /* @__PURE__ */ jsxRuntime.jsx(InfoTooltip, { label: tierFreshnessLabel("realtime", at) })
  ] });
}
function HoverPreview({
  children,
  content,
  className,
  focusable
}) {
  const [open, setOpen] = React3.useState(false);
  return /* @__PURE__ */ jsxRuntime.jsxs(
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
        open ? /* @__PURE__ */ jsxRuntime.jsx(
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
  return /* @__PURE__ */ jsxRuntime.jsx(
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
  return (
    // Self-wrapped so KeyChip works outside AppShell's global provider.
    /* @__PURE__ */ jsxRuntime.jsxs(TooltipProvider, { children: [
      /* @__PURE__ */ jsxRuntime.jsxs(Tooltip, { delayDuration: 120, children: [
        /* @__PURE__ */ jsxRuntime.jsx(TooltipTrigger, { asChild: true, children: /* @__PURE__ */ jsxRuntime.jsxs(
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
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "truncate tabular-nums", children: short }),
              /* @__PURE__ */ jsxRuntime.jsx(
                CopyIconToggle,
                {
                  copied,
                  className: "text-ink-muted group-hover:text-ink"
                }
              )
            ]
          }
        ) }),
        /* @__PURE__ */ jsxRuntime.jsxs(
          TooltipContent,
          {
            side: "top",
            className: "max-w-[90vw] break-all font-mono text-[11px]",
            children: [
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mr-1 mg-type-micro opacity-70", children: label }),
              value
            ]
          }
        )
      ] }),
      /* @__PURE__ */ jsxRuntime.jsx(CopyStatusRegion, { children: copied ? `${label} copied to clipboard` : "" })
    ] })
  );
}
function ListShell({
  filters,
  cards,
  table,
  footer,
  empty,
  isEmpty,
  isStale,
  stickyHeader: _stickyHeader = true
}) {
  const rootRef = React3.useRef(null);
  const filterRef = React3.useRef(null);
  const [filterH, setFilterH] = React3.useState(0);
  React3.useLayoutEffect(() => {
    const el = filterRef.current;
    if (!el) return;
    setFilterH(Math.round(el.getBoundingClientRect().height));
  }, []);
  React3.useEffect(() => {
    const el = filterRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const h = Math.round(
        entries[0]?.contentRect.height ?? el.getBoundingClientRect().height
      );
      setFilterH((prev) => prev === h ? prev : h);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const tableCard = "rounded border border-border bg-card overflow-hidden";
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      ref: rootRef,
      style: { ["--mg-list-filter-offset"]: `${filterH}px` },
      children: [
        /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            ref: filterRef,
            className: classNames(
              // Sticky filter bar. Offset reads --mg-sticky-offset (published by
              // AppShell to match real header + ticker height) with a fallback.
              "sticky z-20 -mx-4 md:mx-0 mb-3",
              "bg-paper/95 backdrop-blur supports-[backdrop-filter]:bg-paper/80",
              "border-b border-border md:border md:rounded md:bg-card",
              "px-3 py-2 md:p-2.5"
            ),
            style: { top: "var(--mg-sticky-offset, 3.5rem)" },
            children: /* @__PURE__ */ jsxRuntime.jsx("div", { className: "flex flex-wrap items-center gap-2", children: filters })
          }
        ),
        isEmpty ? empty : /* @__PURE__ */ jsxRuntime.jsxs("div", { className: isStale ? "opacity-70 transition-opacity" : void 0, children: [
          cards ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "md:hidden space-y-2", children: cards }) : null,
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: cards ? "hidden md:block" : void 0, children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: tableCard, children: [
            /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-table-scroll overflow-x-auto", children: table }),
            footer
          ] }) }),
          cards && footer ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "md:hidden mt-3", children: footer }) : null
        ] })
      ]
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
    return /* @__PURE__ */ jsxRuntime.jsxs(
      "div",
      {
        className: "border-t border-border bg-surface/30 p-3 space-y-1.5",
        "aria-live": "polite",
        "aria-busy": "true",
        children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "sr-only", children: "Loading more results\u2026" }),
          /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-7 w-full" }),
          /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-7 w-full" }),
          /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-7 w-3/4" })
        ]
      }
    );
  }
  if (error) {
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-center justify-between gap-3 border-t border-health-down/30 bg-health-down/5 px-4 py-2 text-[11px]", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "inline-flex items-center gap-1.5 text-health-down", children: [
        /* @__PURE__ */ jsxRuntime.jsx(lucideReact.AlertCircle, { className: "size-3" }),
        "Couldn\u2019t load more \u2014 ",
        error.message || "network error",
        "."
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs(
        "button",
        {
          type: "button",
          onClick: onLoadMore,
          className: "inline-flex items-center gap-1 rounded border border-border bg-card px-2.5 py-1 font-medium hover:border-ink/30 min-h-9",
          children: [
            /* @__PURE__ */ jsxRuntime.jsx(lucideReact.RefreshCw, { className: "size-3" }),
            " Retry"
          ]
        }
      )
    ] });
  }
  if (cursorInvalid) {
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-center justify-between gap-3 border-t border-health-warn/30 bg-health-warn/5 px-4 py-2 text-[11px] text-health-warn", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
        /* @__PURE__ */ jsxRuntime.jsx(lucideReact.AlertCircle, { className: "size-3" }),
        "Pagination stopped \u2014 the server returned an invalid next cursor."
      ] }),
      /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "font-mono text-ink-muted", children: [
        shown,
        total != null ? ` / ${total}` : ""
      ] })
    ] });
  }
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-center justify-between gap-3 border-t border-border bg-surface/30 px-4 py-2 text-[11px] font-mono text-ink-muted", children: [
    /* @__PURE__ */ jsxRuntime.jsxs("span", { children: [
      shown,
      total != null ? ` of ${total}` : ""
    ] }),
    hasMore ? /* @__PURE__ */ jsxRuntime.jsx(
      "button",
      {
        type: "button",
        onClick: onLoadMore,
        className: "inline-flex items-center rounded border border-border bg-card px-3 py-1.5 text-[11px] font-medium hover:border-ink/30 min-h-9",
        children: "Load more"
      }
    ) : /* @__PURE__ */ jsxRuntime.jsx("span", { className: "opacity-60", children: "end of list" })
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "section",
    {
      className: classNames(
        "mg-hero-slab relative mb-12 md:mb-16 pt-12 md:pt-20 pb-10 md:pb-14",
        className
      ),
      children: [
        caption ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "absolute right-0 top-4 hidden md:block", children: /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-hero-caption", children: caption }) }) : null,
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "grid gap-10 md:grid-cols-[minmax(0,1fr)_auto] md:items-end", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "min-w-0 max-w-3xl", children: [
            eyebrow ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-fade-in mg-type-micro text-ink-muted inline-flex items-center gap-2", children: [
              live ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-live-dot" }) : null,
              eyebrow
            ] }) : null,
            /* @__PURE__ */ jsxRuntime.jsx("h1", { className: "mg-fade-in mg-fade-in-delay-1 mt-4 font-display text-[2.5rem] sm:text-5xl md:text-[3.75rem] font-semibold leading-[1.02] tracking-[-0.025em] text-ink-strong", children: title }),
            description ? /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mg-fade-in mg-fade-in-delay-2 mt-5 max-w-xl text-base md:text-lg text-ink-muted leading-relaxed", children: description }) : null,
            actions ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-fade-in mg-fade-in-delay-3 mt-6 flex flex-wrap items-center gap-2", children: actions }) : null
          ] }),
          aside ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-fade-in mg-fade-in-delay-2 hidden md:block shrink-0", children: aside }) : null
        ] }),
        kpis && kpis.length > 0 ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-fade-in mg-fade-in-delay-3 mg-kpi-strip mt-12 md:mt-16", children: kpis.map((k) => /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-type-micro text-ink-muted", children: k.label }),
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mt-1.5 flex items-baseline gap-2", children: [
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "font-display text-2xl md:text-[1.75rem] font-semibold tabular-nums text-ink-strong leading-none tracking-[-0.01em]", children: k.value }),
            k.hint ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "font-mono text-[11px] text-ink-muted", children: k.hint }) : null
          ] }),
          k.chart ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mt-2.5 -ml-0.5", children: k.chart }) : null
        ] }, k.label)) }) : null
      ]
    }
  );
}
function EntityHero({
  eyebrow,
  live,
  icon,
  title,
  subtitle,
  description,
  chips,
  links,
  actions,
  banner,
  aside,
  stats,
  caption,
  size = "compact",
  className
}) {
  const visibleStats = (stats ?? []).filter(
    (s) => s.value !== void 0 && s.value !== null && s.value !== ""
  );
  const display = size === "display";
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "header",
    {
      className: classNames(
        "mg-hero-slab relative",
        display ? "mb-12 md:mb-16 pt-12 md:pt-20 pb-10 md:pb-14" : "pt-8 md:pt-12 pb-8 md:pb-10 mb-6",
        className
      ),
      children: [
        caption ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "absolute right-0 top-4 hidden md:block", children: /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-hero-caption", children: caption }) }) : null,
        banner ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mb-5", children: banner }) : null,
        /* @__PURE__ */ jsxRuntime.jsxs(
          "div",
          {
            className: classNames(
              "grid md:grid-cols-[minmax(0,1fr)_auto]",
              display ? "gap-10 md:items-end" : "gap-6 md:items-start"
            ),
            children: [
              /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-start gap-4 min-w-0 max-w-3xl", children: [
                icon ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "shrink-0 mt-1", children: icon }) : null,
                /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "min-w-0", children: [
                  eyebrow ? /* @__PURE__ */ jsxRuntime.jsxs(
                    "div",
                    {
                      className: classNames(
                        "mg-fade-in font-mono text-[10px] uppercase text-ink-muted inline-flex items-center gap-2",
                        display ? "tracking-[0.22em]" : "tracking-[0.2em] mb-2"
                      ),
                      children: [
                        live ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-live-dot" }) : null,
                        eyebrow
                      ]
                    }
                  ) : null,
                  /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex flex-wrap items-baseline gap-x-4 gap-y-1", children: [
                    /* @__PURE__ */ jsxRuntime.jsx(
                      "h1",
                      {
                        className: classNames(
                          "mg-fade-in mg-fade-in-delay-1 font-display font-semibold text-ink-strong",
                          display ? "mt-4 text-[2.5rem] sm:text-5xl md:text-[3.75rem] leading-[1.02] tracking-[-0.025em]" : "text-3xl md:text-4xl tracking-[-0.01em]"
                        ),
                        children: title
                      }
                    ),
                    !display && subtitle ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "font-mono text-xs md:text-sm text-ink-muted", children: subtitle }) : null
                  ] }),
                  description ? /* @__PURE__ */ jsxRuntime.jsx(
                    "p",
                    {
                      className: classNames(
                        "mg-fade-in mg-fade-in-delay-2 text-ink-muted leading-relaxed",
                        display ? "mt-5 max-w-xl text-base md:text-lg" : "mt-3 max-w-3xl text-sm md:text-base"
                      ),
                      children: description
                    }
                  ) : null,
                  links ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mt-6", children: links }) : null,
                  actions ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-fade-in mg-fade-in-delay-3 mt-6 flex flex-wrap items-center gap-2", children: actions }) : null
                ] })
              ] }),
              chips ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "flex flex-wrap items-center gap-1.5 md:justify-end shrink-0 max-w-md", children: chips }) : null,
              aside ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-fade-in mg-fade-in-delay-2 hidden md:block shrink-0", children: aside }) : null
            ]
          }
        ),
        visibleStats.length > 0 ? /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            className: classNames(
              "mg-fade-in mg-fade-in-delay-3 mg-kpi-strip",
              display ? "mt-12 md:mt-16" : "mt-8 md:mt-10"
            ),
            children: visibleStats.map((s) => /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
              /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-type-micro text-ink-muted", children: s.label }),
              /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mt-1.5 flex items-baseline gap-2", children: [
                /* @__PURE__ */ jsxRuntime.jsx(
                  "span",
                  {
                    className: classNames(
                      "font-display font-semibold tabular-nums text-ink-strong leading-none",
                      display ? "text-2xl md:text-[1.75rem] tracking-[-0.01em]" : "text-xl md:text-2xl"
                    ),
                    children: s.value
                  }
                ),
                s.hint ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "font-mono text-[11px] text-ink-muted", children: s.hint }) : null
              ] }),
              s.chart ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mt-2.5 -ml-0.5", children: s.chart }) : null
            ] }, s.label))
          }
        ) : null
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
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
        hasHeader ? /* @__PURE__ */ jsxRuntime.jsxs(
          "header",
          {
            className: classNames(
              "grid gap-4 md:grid-cols-[minmax(0,1fr)_auto] md:items-end",
              divider === "hairline" && tone !== "muted" && "mg-section-rule pt-8",
              "pb-6"
            ),
            children: [
              /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "min-w-0", children: [
                eyebrow ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-type-micro text-ink-muted inline-flex items-center gap-2", children: eyebrow }) : null,
                title ? /* @__PURE__ */ jsxRuntime.jsxs("h2", { className: "group/anchor mt-2 flex items-baseline gap-2 font-display text-2xl md:text-[1.875rem] font-semibold tracking-[-0.02em] text-ink-strong", children: [
                  /* @__PURE__ */ jsxRuntime.jsx("span", { children: title }),
                  id ? /* @__PURE__ */ jsxRuntime.jsx(
                    "a",
                    {
                      href: `#${id}`,
                      "aria-label": "Permalink",
                      className: "mg-anchor-btn -mb-0.5 inline-flex size-5 items-center justify-center rounded text-ink-muted hover:text-accent",
                      children: /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Link, { className: "size-3.5" })
                    }
                  ) : null
                ] }) : null,
                description ? /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mt-2 max-w-2xl text-sm text-ink-muted leading-relaxed", children: description }) : null
              ] }),
              actions ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "flex flex-wrap items-center gap-2 md:justify-end", children: actions }) : null
            ]
          }
        ) : null,
        toolbar ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mb-6 -mt-2 flex flex-wrap items-center gap-2 border-b border-border pb-4", children: toolbar }) : null,
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: hasHeader || toolbar ? "" : "", children })
      ]
    }
  );
}
function ScrollReveal({
  children,
  className = "",
  delay = 0
}) {
  const ref = React3.useRef(null);
  React3.useEffect(() => {
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
  return /* @__PURE__ */ jsxRuntime.jsx("div", { ref, className: `mg-reveal ${className}`, children });
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
  const [copied, setCopied] = React3.useState(false);
  const onCopy = async () => {
    if (typeof window === "undefined") return;
    const url = new URL(window.location.href);
    url.hash = id;
    history.replaceState(null, "", url.toString());
    try {
      await navigator.clipboard.writeText(url.toString());
      setCopied(true);
      sonner.toast.success("Link copied", { description: `#${id}` });
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      sonner.toast.message("Link updated", { description: `#${id}` });
    }
  };
  return /* @__PURE__ */ jsxRuntime.jsxs(
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
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mb-3 flex items-center gap-3", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "min-w-0 flex-1", children: [
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-center gap-1.5", children: [
              /* @__PURE__ */ jsxRuntime.jsx("h2", { className: "font-display text-sm font-semibold uppercase tracking-wider text-ink-strong", children: title }),
              info ? /* @__PURE__ */ jsxRuntime.jsx(InfoTooltip, { label: info }) : null,
              /* @__PURE__ */ jsxRuntime.jsx(
                "button",
                {
                  type: "button",
                  onClick: onCopy,
                  "aria-label": `Copy link to ${typeof title === "string" ? title : id} section`,
                  className: "mg-anchor-btn inline-flex items-center justify-center text-ink-muted hover:text-accent focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded min-h-11 min-w-11 p-0.5",
                  children: copied ? /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Check, { className: "size-3.5 text-accent" }) : /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Link2, { className: "size-3.5" })
                }
              )
            ] }),
            subtitle ? /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mt-0.5 text-[11px] text-ink-muted", children: subtitle }) : null
          ] }),
          right ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "shrink-0", children: right }) : null
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      className: classNames(
        "mb-4 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between",
        className
      ),
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "max-w-2xl", children: [
          /* @__PURE__ */ jsxRuntime.jsx(
            "h2",
            {
              id,
              className: "font-display text-sm font-semibold uppercase tracking-wider text-ink-strong",
              children: title
            }
          ),
          intro ? /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mt-1.5 text-sm leading-relaxed text-ink-muted", children: intro }) : null
        ] }),
        right ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "flex shrink-0 items-center gap-2", children: right }) : null
      ]
    }
  );
}
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
  const [announcement, setAnnouncement] = React3.useState("");
  React3.useEffect(() => {
    if (!copied) setAnnouncement("");
  }, [copied]);
  const onClick = async () => {
    const href = url ?? (typeof window !== "undefined" ? window.location.href : "");
    if (!href) return;
    const ok = await copy(href);
    if (ok) {
      sonner.toast.success("Link copied", {
        description: "Filters, sort, and pagination are preserved in the URL."
      });
      setAnnouncement(`Link copied to clipboard: ${href}`);
    } else {
      setAnnouncement("Couldn't copy link to clipboard.");
    }
  };
  return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
    /* @__PURE__ */ jsxRuntime.jsxs(
      "button",
      {
        type: "button",
        onClick,
        "aria-label": "Copy link with current filters, sort, and page",
        title: "Copy link with current filters, sort, and page",
        className: classNames(
          connected ? "inline-flex size-8 items-center justify-center text-ink-muted hover:bg-surface hover:text-ink-strong transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" : bare ? iconOnly ? "inline-flex items-center justify-center rounded p-1 min-h-8 text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" : "inline-flex items-center gap-1.5 rounded px-2 py-1 min-h-8 text-[11px] font-medium text-ink-muted hover:text-ink-strong hover:bg-surface transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" : iconOnly ? "inline-flex size-8 items-center justify-center rounded-md border border-border bg-card text-ink-muted hover:border-ink/30 hover:text-ink-strong transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring" : "inline-flex items-center gap-1.5 rounded border border-border bg-card px-2.5 py-1 text-[11px] font-medium text-ink hover:border-ink/30 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          className
        ),
        children: [
          copied ? /* @__PURE__ */ jsxRuntime.jsx(
            lucideReact.Check,
            {
              className: connected || iconOnly && !bare ? "size-4 text-health-ok" : "size-3 text-health-ok"
            }
          ) : /* @__PURE__ */ jsxRuntime.jsx(
            lucideReact.Share2,
            {
              className: connected || iconOnly && !bare ? "size-4" : "size-3 text-ink-muted"
            }
          ),
          hideText ? null : copied ? "Link copied" : label
        ]
      }
    ),
    /* @__PURE__ */ jsxRuntime.jsx(CopyStatusRegion, { children: announcement })
  ] });
}
function ActionBar({
  children,
  className
}) {
  return /* @__PURE__ */ jsxRuntime.jsx(
    "div",
    {
      className: classNames(
        "inline-flex items-center gap-0.5 rounded-md border border-border bg-card p-0.5",
        className
      ),
      children
    }
  );
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
  return /* @__PURE__ */ jsxRuntime.jsxs(ActionBar, { children: [
    /* @__PURE__ */ jsxRuntime.jsxs(
      "button",
      {
        type: "button",
        onClick: onPrev,
        disabled: !hasPrev,
        className: itemCls,
        children: [
          /* @__PURE__ */ jsxRuntime.jsx(lucideReact.ChevronLeft, { className: "size-3" }),
          " ",
          prevLabel
        ]
      }
    ),
    /* @__PURE__ */ jsxRuntime.jsxs(
      "button",
      {
        type: "button",
        onClick: onNext,
        disabled: !hasNext,
        className: itemCls,
        children: [
          nextLabel,
          " ",
          /* @__PURE__ */ jsxRuntime.jsx(lucideReact.ChevronRight, { className: "size-3" })
        ]
      }
    )
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
  const [mounted, setMounted] = React3.useState(false);
  React3.useEffect(() => setMounted(true), []);
  const text = !at ? fallback : mounted ? formatRelative(at) : "";
  return /* @__PURE__ */ jsxRuntime.jsx(
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
  const Icon = { empty: lucideReact.Inbox, stale: lucideReact.Clock, error: lucideReact.AlertCircle }[variant];
  const iconCls = {
    empty: "text-accent",
    stale: "text-health-warn",
    error: "text-health-down"
  }[variant];
  const apiErr = hasApiErrorShape(error) ? error : null;
  const status = apiErr?.status;
  const url = apiErr?.url;
  const message = variant === "error" ? error?.message ?? "Unknown error" : void 0;
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      role: variant === "error" ? "alert" : void 0,
      className: classNames(
        "rounded-xl border bg-card px-8 py-16 text-center",
        tone,
        className
      ),
      children: [
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mx-auto inline-flex size-10 items-center justify-center rounded-full border border-border bg-paper", children: /* @__PURE__ */ jsxRuntime.jsx(Icon, { className: classNames("size-4", iconCls) }) }),
        /* @__PURE__ */ jsxRuntime.jsx("h3", { className: "mt-4 font-display text-base font-semibold text-ink-strong tracking-tight", children: title }),
        description ? /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mx-auto mt-1.5 max-w-md text-sm text-ink-muted leading-relaxed", children: description }) : null,
        variant === "stale" && generatedAt ? /* @__PURE__ */ jsxRuntime.jsxs("p", { className: "mt-3 font-mono text-[11px] text-ink-muted", children: [
          "Last verified ",
          /* @__PURE__ */ jsxRuntime.jsx(TimeAgo, { at: generatedAt })
        ] }) : null,
        message ? /* @__PURE__ */ jsxRuntime.jsxs("p", { className: "mx-auto mt-3 max-w-md font-mono text-[11px] text-ink-muted", children: [
          status ? /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "text-health-down", children: [
            "HTTP ",
            status,
            " \xB7 "
          ] }) : null,
          message
        ] }) : null,
        cta || onRetry || url ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mt-5 flex flex-wrap items-center justify-center gap-2", children: [
          onRetry ? /* @__PURE__ */ jsxRuntime.jsxs(
            "button",
            {
              type: "button",
              onClick: onRetry,
              className: "inline-flex items-center gap-1.5 rounded-full border border-border bg-paper px-3.5 py-1.5 text-[12px] font-medium text-ink hover:border-accent/50 hover:text-accent transition-colors",
              children: [
                /* @__PURE__ */ jsxRuntime.jsx(lucideReact.RefreshCw, { className: "size-3" }),
                " Retry"
              ]
            }
          ) : null,
          cta ? /* @__PURE__ */ jsxRuntime.jsxs(
            "a",
            {
              href: cta.href,
              ...cta.external ? { target: "_blank", rel: "noopener noreferrer" } : {},
              className: "inline-flex items-center gap-1.5 rounded-full bg-ink-strong px-3.5 py-1.5 text-[12px] font-medium text-paper hover:opacity-90 transition-opacity",
              children: [
                cta.label,
                cta.external ? /* @__PURE__ */ jsxRuntime.jsx(lucideReact.ExternalLink, { className: "size-3" }) : null
              ]
            }
          ) : null,
          url ? /* @__PURE__ */ jsxRuntime.jsxs(
            "a",
            {
              href: url,
              target: "_blank",
              rel: "noopener noreferrer",
              className: "inline-flex items-center gap-1.5 text-[11px] font-mono text-ink-muted hover:text-ink-strong",
              children: [
                "View API URL ",
                /* @__PURE__ */ jsxRuntime.jsx(lucideReact.ExternalLink, { className: "size-3" })
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
    label: "Table",
    Icon: lucideReact.List,
    ariaLabel: "Switch to table view"
  },
  {
    value: "grid",
    label: "Grid",
    Icon: lucideReact.LayoutGrid,
    ariaLabel: "Switch to grid view"
  },
  {
    value: "matrix",
    label: "Matrix",
    Icon: lucideReact.Grid3x3,
    ariaLabel: "Switch to matrix view"
  }
];
function ViewModeToggle({
  value,
  onChange,
  options = ["table", "grid", "matrix"],
  className
}) {
  const available = OPTIONS.filter((o) => options.includes(o.value));
  return /* @__PURE__ */ jsxRuntime.jsx(
    SegmentedToggle,
    {
      options: available,
      value,
      onChange,
      ariaLabel: "View mode",
      className
    }
  );
}
function Wordmark({ className }) {
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "svg",
    {
      className,
      xmlns: "http://www.w3.org/2000/svg",
      viewBox: "-5.00 -5.00 1190.44 164.29",
      fill: "none",
      role: "img",
      "aria-label": "Metagraphed",
      children: [
        /* @__PURE__ */ jsxRuntime.jsx(
          "path",
          {
            transform: "translate(0,0.000) scale(0.26813)",
            d: "M 315.5,1.1999999999999886 C 313.40000000000003,1.6999999999999886 281.7,32.799999999999955 206.5,107.89999999999998 C 146.5,167.89999999999998 99.30000000000001,214.39999999999998 97.7,215.0 C 95.9,215.6 79.4,216.0 52.300000000000004,216.0 C 11.4,216.0 9.600000000000001,216.1 6.5,218.0 C -0.4,222.29999999999998 0.0,215.79999999999998 0.0,328.7 C 0.0,428.5 0.0,430.6 2.0,433.8 C 6.0,440.3 12.9,442.5 19.5,439.4 C 21.3,438.6 70.9,389.4 130.6,329.3 C 223.9,235.5 239.20000000000002,220.39999999999998 243.8,218.39999999999998 C 249.0,216.0 249.5,216.0 281.8,216.0 C 312.40000000000003,216.0 314.70000000000005,216.1 317.70000000000005,218.0 C 319.40000000000003,219.0 321.5,220.89999999999998 322.20000000000005,222.2 C 323.20000000000005,224.0 323.6,245.1 324.0,328.0 L 324.5,431.5 L 326.8,434.8 C 331.0,440.6 338.1,442.6 343.8,439.6 C 345.3,438.8 395.8,388.8 456.0,328.5 C 516.2,268.2 566.7,218.2 568.2,217.39999999999998 C 570.4,216.29999999999998 577.3000000000001,216.0 605.2,216.0 C 637.4000000000001,216.0 639.7,216.1 642.7,218.0 C 644.4000000000001,219.0 646.5,220.89999999999998 647.2,222.2 C 648.2,224.0 648.6,245.7 649.0,331.7 C 649.5,438.1 649.5,438.9 651.6,441.7 C 654.8000000000001,446.1 659.7,448.2 665.0,447.5 C 669.4000000000001,447.0 670.6,445.9 707.3000000000001,409.2 C 728.1,388.5 745.8000000000001,370.3 746.6,368.8 C 747.8000000000001,366.5 748.0,354.9 748.0,295.79999999999995 C 748.0,228.0 747.9000000000001,225.39999999999998 746.0,222.29999999999998 C 742.5,216.5 742.6,216.5 703.3000000000001,216.0 C 668.7,215.5 667.0,215.39999999999998 664.3000000000001,213.39999999999998 C 662.8000000000001,212.29999999999998 660.7,209.79999999999998 659.8000000000001,207.89999999999998 C 658.1,204.7 658.0,197.89999999999998 658.0,107.79999999999995 C 658.0,-0.7000000000000455 658.4000000000001,5.7999999999999545 650.8000000000001,1.8999999999999773 C 646.6,-0.20000000000004547 643.4000000000001,-0.5 639.3000000000001,1.099999999999966 C 637.7,1.6999999999999886 590.2,48.599999999999966 529.9,109.09999999999997 L 423.3,216.1 L 382.70000000000005,215.79999999999998 C 343.5,215.5 342.1,215.39999999999998 339.3,213.39999999999998 C 337.8,212.29999999999998 335.70000000000005,209.79999999999998 334.8,207.89999999999998 C 333.1,204.7 333.0,197.89999999999998 333.0,107.69999999999999 C 333.0,4.099999999999966 333.20000000000005,8.199999999999989 328.1,3.599999999999966 C 325.6,1.2999999999999545 319.5,0.0999999999999659 315.5,1.1999999999999886",
            fill: "#30FFC0"
          }
        ),
        /* @__PURE__ */ jsxRuntime.jsxs(
          "g",
          {
            transform: "translate(216.673,120.000) scale(0.171429,-0.171429)",
            fill: "currentColor",
            children: [
              /* @__PURE__ */ jsxRuntime.jsx(
                "path",
                {
                  transform: "translate(0,0)",
                  d: "M296 -14Q222 -14 165.5 17.5Q109 49 77.5 106.5Q46 164 46 242V254Q46 332 77.0 389.5Q108 447 164.0 478.5Q220 510 294 510Q367 510 421.0 477.5Q475 445 505.0 387.5Q535 330 535 254V211H174Q176 160 212.0 128.0Q248 96 300 96Q353 96 378.0 119.0Q403 142 416 170L519 116Q505 90 478.5 59.5Q452 29 408.0 7.5Q364 -14 296 -14ZM175 305H407Q403 348 372.5 374.0Q342 400 293 400Q242 400 212.0 374.0Q182 348 175 305Z"
                }
              ),
              /* @__PURE__ */ jsxRuntime.jsx(
                "path",
                {
                  transform: "translate(577,0)",
                  d: "M260 0Q211 0 180.5 30.5Q150 61 150 112V392H26V496H150V650H276V496H412V392H276V134Q276 104 304 104H400V0Z"
                }
              ),
              /* @__PURE__ */ jsxRuntime.jsx(
                "path",
                {
                  transform: "translate(1033,0)",
                  d: "M224 -14Q171 -14 129.0 4.5Q87 23 62.5 58.5Q38 94 38 145Q38 196 62.5 230.5Q87 265 130.5 282.5Q174 300 230 300H366V328Q366 363 344.0 385.5Q322 408 274 408Q227 408 204.0 386.5Q181 365 174 331L58 370Q70 408 96.5 439.5Q123 471 167.5 490.5Q212 510 276 510Q374 510 431.0 461.0Q488 412 488 319V134Q488 104 516 104H556V0H472Q435 0 411.0 18.0Q387 36 387 66V67H368Q364 55 350.0 35.5Q336 16 306.0 1.0Q276 -14 224 -14ZM246 88Q299 88 332.5 117.5Q366 147 366 196V206H239Q204 206 184.0 191.0Q164 176 164 149Q164 122 185.0 105.0Q206 88 246 88Z"
                }
              ),
              /* @__PURE__ */ jsxRuntime.jsx(
                "path",
                {
                  transform: "translate(1611,0)",
                  d: "M46 246V262Q46 340 77.0 395.5Q108 451 159.5 480.5Q211 510 272 510Q340 510 375.0 486.0Q410 462 426 436H444V496H568V-88Q568 -139 538.0 -169.5Q508 -200 458 -200H126V-90H414Q442 -90 442 -60V69H424Q414 53 396.0 36.5Q378 20 348.0 9.0Q318 -2 272 -2Q211 -2 159.5 27.5Q108 57 77.0 112.5Q46 168 46 246ZM308 108Q366 108 405.0 145.0Q444 182 444 249V259Q444 327 405.5 363.5Q367 400 308 400Q250 400 211.0 363.5Q172 327 172 259V249Q172 182 211.0 145.0Q250 108 308 108Z"
                }
              ),
              /* @__PURE__ */ jsxRuntime.jsx(
                "path",
                {
                  transform: "translate(2249,0)",
                  d: "M70 0V496H194V440H212Q223 470 248.5 484.0Q274 498 308 498H368V386H306Q258 386 227.0 360.5Q196 335 196 282V0Z"
                }
              ),
              /* @__PURE__ */ jsxRuntime.jsx(
                "path",
                {
                  transform: "translate(2645,0)",
                  d: "M224 -14Q171 -14 129.0 4.5Q87 23 62.5 58.5Q38 94 38 145Q38 196 62.5 230.5Q87 265 130.5 282.5Q174 300 230 300H366V328Q366 363 344.0 385.5Q322 408 274 408Q227 408 204.0 386.5Q181 365 174 331L58 370Q70 408 96.5 439.5Q123 471 167.5 490.5Q212 510 276 510Q374 510 431.0 461.0Q488 412 488 319V134Q488 104 516 104H556V0H472Q435 0 411.0 18.0Q387 36 387 66V67H368Q364 55 350.0 35.5Q336 16 306.0 1.0Q276 -14 224 -14ZM246 88Q299 88 332.5 117.5Q366 147 366 196V206H239Q204 206 184.0 191.0Q164 176 164 149Q164 122 185.0 105.0Q206 88 246 88Z"
                }
              ),
              /* @__PURE__ */ jsxRuntime.jsx(
                "path",
                {
                  transform: "translate(3223,0)",
                  d: "M70 -200V496H194V436H212Q229 465 265.0 487.5Q301 510 368 510Q428 510 479.0 480.5Q530 451 561.0 394.0Q592 337 592 256V240Q592 159 561.0 102.0Q530 45 479.0 15.5Q428 -14 368 -14Q323 -14 292.5 -3.5Q262 7 243.5 23.5Q225 40 214 57H196V-200ZM330 96Q389 96 427.5 133.5Q466 171 466 243V253Q466 325 427.0 362.5Q388 400 330 400Q272 400 233.0 362.5Q194 325 194 253V243Q194 171 233.0 133.5Q272 96 330 96Z"
                }
              ),
              /* @__PURE__ */ jsxRuntime.jsx(
                "path",
                {
                  transform: "translate(3861,0)",
                  d: "M70 0V700H196V435H214Q222 451 239.0 467.0Q256 483 284.5 493.5Q313 504 357 504Q415 504 458.5 477.5Q502 451 526.0 404.5Q550 358 550 296V0H424V286Q424 342 396.5 370.0Q369 398 318 398Q260 398 228.0 359.5Q196 321 196 252V0Z"
                }
              ),
              /* @__PURE__ */ jsxRuntime.jsx(
                "path",
                {
                  transform: "translate(4477,0)",
                  d: "M296 -14Q222 -14 165.5 17.5Q109 49 77.5 106.5Q46 164 46 242V254Q46 332 77.0 389.5Q108 447 164.0 478.5Q220 510 294 510Q367 510 421.0 477.5Q475 445 505.0 387.5Q535 330 535 254V211H174Q176 160 212.0 128.0Q248 96 300 96Q353 96 378.0 119.0Q403 142 416 170L519 116Q505 90 478.5 59.5Q452 29 408.0 7.5Q364 -14 296 -14ZM175 305H407Q403 348 372.5 374.0Q342 400 293 400Q242 400 212.0 374.0Q182 348 175 305Z"
                }
              ),
              /* @__PURE__ */ jsxRuntime.jsx(
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
  return /* @__PURE__ */ jsxRuntime.jsx(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "currentColor",
      "aria-hidden": "true",
      className,
      ...props,
      children: /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M20.317 4.3698a19.7913 19.7913 0 0 0-4.8851-1.5152.0741.0741 0 0 0-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 0 0-.0785-.037 19.7363 19.7363 0 0 0-4.8852 1.515.0699.0699 0 0 0-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 0 0 .0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 0 0 .0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 0 0-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 0 1-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 0 1 .0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 0 1 .0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 0 1-.0066.1276 12.2986 12.2986 0 0 1-1.873.8914.0766.0766 0 0 0-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 0 0 .0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 0 0 .0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 0 0-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z" })
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
  const [open, setOpen] = React3.useState(false);
  const hasMore = tools.length > PREVIEW_COUNT;
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mt-2", children: [
    /* @__PURE__ */ jsxRuntime.jsx("div", { className: "flex flex-wrap gap-1.5", children: visibleTools(tools, open).map((t) => /* @__PURE__ */ jsxRuntime.jsx(
      "span",
      {
        title: t.title,
        className: "inline-flex items-center rounded border border-border bg-card px-1.5 py-0.5 font-mono text-[10px] text-ink-muted",
        children: t.name
      },
      t.name
    )) }),
    hasMore ? /* @__PURE__ */ jsxRuntime.jsx(
      "button",
      {
        type: "button",
        onClick: () => setOpen((v) => !v),
        "aria-expanded": open,
        className: classNames(
          "mt-2 inline-flex items-center gap-1 font-mono text-[10px] text-ink-muted",
          "hover:text-accent transition-colors"
        ),
        children: open ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
          /* @__PURE__ */ jsxRuntime.jsx(lucideReact.ChevronUp, { className: "size-3" }),
          " Show fewer"
        ] }) : /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
          /* @__PURE__ */ jsxRuntime.jsx(lucideReact.ChevronDown, { className: "size-3" }),
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
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "min-w-0", children: [
    /* @__PURE__ */ jsxRuntime.jsx("div", { className: YIELD_PERCENTILE_LABEL_CLASS, children: label }),
    /* @__PURE__ */ jsxRuntime.jsx("div", { className: YIELD_PERCENTILE_VALUE_CLASS, children: value })
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
  return /* @__PURE__ */ jsxRuntime.jsx(
    "section",
    {
      className: YIELD_PERCENTILE_STRIP_CONTAINER_CLASS,
      "aria-label": "Yield percentile distribution",
      children: /* @__PURE__ */ jsxRuntime.jsx("div", { className: YIELD_PERCENTILE_STRIP_GRID_CLASS, children: tiles.map((tile) => /* @__PURE__ */ jsxRuntime.jsx(
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
function PrimaryLinksRail({
  website,
  docs,
  repo,
  dashboard,
  extras,
  bare
}) {
  const items = [
    { label: "Website", href: website, icon: lucideReact.Globe },
    { label: "Docs", href: docs, icon: lucideReact.BookOpen },
    { label: "Repository", href: repo, icon: lucideReact.Github },
    { label: "Dashboard", href: dashboard, icon: lucideReact.LayoutDashboard },
    ...(extras ?? []).map((e) => ({
      label: e.label,
      href: e.href,
      icon: e.icon ?? lucideReact.Globe
    }))
  ].filter((i) => safeExternalUrl(i.href));
  if (items.length === 0) return null;
  const segments = items.map((it) => {
    const Icon = it.icon;
    const href = safeExternalUrl(it.href);
    return /* @__PURE__ */ jsxRuntime.jsx(
      "a",
      {
        href,
        target: "_blank",
        rel: "noopener noreferrer",
        title: it.label,
        "aria-label": it.label,
        className: "inline-flex size-8 items-center justify-center text-ink-muted hover:bg-surface hover:text-ink-strong transition-colors",
        children: /* @__PURE__ */ jsxRuntime.jsx(Icon, { className: "size-4" })
      },
      it.label + href
    );
  });
  if (bare) return /* @__PURE__ */ jsxRuntime.jsx(jsxRuntime.Fragment, { children: segments });
  return /* @__PURE__ */ jsxRuntime.jsx("div", { className: "inline-flex items-center rounded-md border border-border bg-card divide-x divide-border overflow-hidden", children: segments });
}
function MethodologyCallout({
  generatedAt,
  windowLabel,
  stakeRisk
}) {
  const [open, setOpen] = React3.useState(false);
  const freshLine = formatFreshness(generatedAt, windowLabel);
  const freshAbs = formatFreshnessAbsolute(generatedAt);
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "aside",
    {
      "aria-label": "Data freshness and methodology",
      className: "mb-6 rounded-lg border border-border bg-card/60",
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs(
          "button",
          {
            type: "button",
            onClick: () => setOpen((o) => !o),
            "aria-expanded": open,
            className: "flex w-full items-start gap-2 px-3 py-2 text-left focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
            children: [
              /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Info, { className: "mt-0.5 size-3.5 shrink-0 text-accent" }),
              /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "min-w-0 flex-1", children: [
                /* @__PURE__ */ jsxRuntime.jsx("span", { className: "block mg-type-micro text-ink-muted", children: "Data freshness & methodology" }),
                freshLine ? /* @__PURE__ */ jsxRuntime.jsx(
                  "span",
                  {
                    className: "mt-0.5 block font-mono text-[10px] text-ink-muted/80",
                    title: freshAbs ?? void 0,
                    children: freshLine
                  }
                ) : null
              ] }),
              /* @__PURE__ */ jsxRuntime.jsx(
                lucideReact.ChevronDown,
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
        open ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "grid gap-3 border-t border-border px-3 py-3 text-[11.5px] leading-relaxed text-ink-muted md:grid-cols-2", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-type-micro text-ink-strong", children: "Sparklines" }),
            /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mt-1", children: "Uptime & latency sparklines plot the active health window (7d default, switchable to 30d). Each point is the mean across every tracked endpoint in that bucket \u2014 gaps mean no probe landed in the window, not zero." })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-type-micro text-ink-strong", children: "Donuts & mosaics" }),
            /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mt-1", children: "Pool ratio comes from on-chain AMM reserves; endpoint topology counts tracked public surfaces by kind. The mosaic in Operational status colors one cell per endpoint by its last probe result." })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-type-micro text-ink-strong", children: "Staleness" }),
            /* @__PURE__ */ jsxRuntime.jsxs("p", { className: "mt-1", children: [
              "Tiles show a ",
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "text-health-warn-text", children: "stale" }),
              " ",
              "chip when the snapshot is older than the refresh budget. Visuals still render with the last known values; retry buttons re-fetch just the affected panel. Each tile carries its own",
              " ",
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "text-ink-strong", children: "updated \xB7 window" }),
              " stamp so you can tell stale from missing at a glance."
            ] })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-type-micro text-ink-strong", children: "Verified vs. candidate" }),
            /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mt-1", children: "Only curated surfaces feed donuts and the topology breakdown. Unverified leads live in the Candidates tab and never count toward health, completeness, or pool ratios." })
          ] }),
          stakeRisk ? /* @__PURE__ */ jsxRuntime.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-type-micro text-ink-strong", children: "Root vs. alpha risk" }),
            /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mt-1", children: "Root stake (netuid 0) is TAO-denominated with no principal risk \u2014 what you stake is what you can unstake. Alpha stake is price-exposed: it's held in the subnet's own token, so a positive nominal APY can still net-lose TAO if the alpha price falls faster than the yield accrues." })
          ] }) : null
        ] }) : null
      ]
    }
  );
}

// src/components/metagraphed/charts/chart-aria.ts
function chartSegmentsAriaLabel(segments) {
  return segments.map((s) => `${s.label} ${s.value}`).join(", ");
}
function synthesizeBarMiniAriaLabel(data) {
  if (data.length === 0) return "Bar chart with no data";
  return chartSegmentsAriaLabel(data);
}
function synthesizeDonutAriaLabel(segments) {
  if (segments.length === 0) return "Donut chart with no data";
  const total = segments.reduce((sum2, s) => sum2 + Math.max(0, s.value), 0);
  if (total <= 0) return "Donut chart with no data";
  return chartSegmentsAriaLabel(segments);
}
var SPARKLINE_EMPTY_ARIA_LABEL = "Sparkline chart with no data";
var CANDLESTICK_MINI_EMPTY_ARIA_LABEL = "Candlestick chart with no data";
function BarMini({
  data,
  max,
  className,
  showValue = true,
  formatValue,
  ariaLabel
}) {
  const cap = max ?? Math.max(1, ...data.map((d) => d.value));
  const label = ariaLabel ?? synthesizeBarMiniAriaLabel(data);
  return /* @__PURE__ */ jsxRuntime.jsx(
    "ul",
    {
      role: "img",
      "aria-label": label,
      className: classNames("space-y-1.5", className),
      children: data.map((d) => {
        const pct = cap > 0 ? Math.max(2, Math.round(d.value / cap * 100)) : 0;
        return /* @__PURE__ */ jsxRuntime.jsxs(
          "li",
          {
            className: "grid grid-cols-[5.5rem_1fr_auto] items-center gap-2",
            children: [
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-type-micro text-ink-muted truncate", children: d.label }),
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "relative h-1.5 rounded-full bg-surface overflow-hidden", children: /* @__PURE__ */ jsxRuntime.jsx(
                "span",
                {
                  className: "absolute inset-y-0 left-0 rounded-full",
                  style: {
                    width: `${pct}%`,
                    background: d.color ?? "var(--accent)"
                  }
                }
              ) }),
              showValue ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "font-mono text-[10px] tabular-nums text-ink-strong", children: formatValue ? formatValue(d.value) : d.value }) : null
            ]
          },
          d.label
        );
      })
    }
  );
}
var BODY_WIDTH_RATIO = 0.6;
function CandlestickMini({
  data,
  width = 480,
  height = 160,
  upColor = "var(--health-ok)",
  downColor = "var(--health-down)",
  className,
  ariaLabel,
  formatValue,
  interactive = true
}) {
  const wrapRef = React3.useRef(null);
  const [hover, setHover] = React3.useState(null);
  const candles = data.slice(-500).filter(
    (c) => Number.isFinite(c.open) && Number.isFinite(c.high) && Number.isFinite(c.low) && Number.isFinite(c.close)
  );
  if (candles.length === 0) {
    return /* @__PURE__ */ jsxRuntime.jsx(
      "svg",
      {
        width: "100%",
        height,
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: "none",
        className: `block max-w-full ${className ?? ""}`,
        style: { maxWidth: width },
        role: "img",
        "aria-label": ariaLabel ?? CANDLESTICK_MINI_EMPTY_ARIA_LABEL,
        children: /* @__PURE__ */ jsxRuntime.jsx(
          "line",
          {
            x1: 0,
            y1: height / 2,
            x2: width,
            y2: height / 2,
            stroke: "var(--border)",
            strokeDasharray: "2 3"
          }
        )
      }
    );
  }
  let min = candles[0].low;
  let max = candles[0].high;
  for (const c of candles) {
    if (c.low < min) min = c.low;
    if (c.high > max) max = c.high;
  }
  const span = max - min || 1;
  const padY = height * 0.06;
  const plotHeight = height - padY * 2;
  const y = (v) => padY + plotHeight - (v - min) / span * plotHeight;
  const slotWidth = width / candles.length;
  const bodyWidth = Math.max(1, slotWidth * BODY_WIDTH_RATIO);
  const bars = candles.map((c, i) => {
    const cx = slotWidth * (i + 0.5);
    const up = c.close >= c.open;
    const color = up ? upColor : downColor;
    const bodyTop = y(Math.max(c.open, c.close));
    const bodyBottom = y(Math.min(c.open, c.close));
    const bodyHeight = Math.max(1, bodyBottom - bodyTop);
    return {
      cx,
      up,
      color,
      wickTop: y(c.high),
      wickBottom: y(c.low),
      bodyTop,
      bodyHeight
    };
  });
  const canTooltip = interactive && candles.length > 0;
  function onMove(e) {
    if (!canTooltip) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const idx = Math.min(
      candles.length - 1,
      Math.floor(x / rect.width * candles.length)
    );
    setHover(idx);
  }
  function onKeyDown(e) {
    if (!canTooltip) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setHover((prev) => Math.min(candles.length - 1, (prev ?? -1) + 1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setHover((prev) => Math.max(0, (prev ?? candles.length) - 1));
    }
  }
  function onFocus() {
    if (!canTooltip) return;
    setHover((prev) => prev ?? 0);
  }
  const hoverCandle = hover != null ? candles[hover] : null;
  const hoverBar = hover != null ? bars[hover] : null;
  const fmt = formatValue ?? ((v) => v.toString());
  const tooltipText = hoverCandle ? `${hoverCandle.label} \xB7 O ${fmt(hoverCandle.open)} H ${fmt(hoverCandle.high)} L ${fmt(hoverCandle.low)} C ${fmt(hoverCandle.close)}` : "";
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      ref: wrapRef,
      className: `relative block w-full ${className ?? ""}`,
      style: { width: "100%", maxWidth: width, height },
      onPointerMove: onMove,
      onPointerLeave: () => setHover(null),
      onKeyDown,
      onFocus,
      onBlur: () => setHover(null),
      tabIndex: canTooltip ? 0 : void 0,
      "aria-label": canTooltip ? `${ariaLabel ?? "Candlestick chart"}, use arrow keys to step through candles` : void 0,
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs(
          "svg",
          {
            width: "100%",
            height,
            viewBox: `0 0 ${width} ${height}`,
            preserveAspectRatio: "none",
            role: "img",
            "aria-label": ariaLabel,
            className: "block w-full",
            children: [
              bars.map((b, i) => /* @__PURE__ */ jsxRuntime.jsxs("g", { children: [
                /* @__PURE__ */ jsxRuntime.jsx(
                  "line",
                  {
                    x1: b.cx,
                    x2: b.cx,
                    y1: b.wickTop,
                    y2: b.wickBottom,
                    stroke: b.color,
                    strokeWidth: 1
                  }
                ),
                /* @__PURE__ */ jsxRuntime.jsx(
                  "rect",
                  {
                    x: b.cx - bodyWidth / 2,
                    y: b.bodyTop,
                    width: bodyWidth,
                    height: b.bodyHeight,
                    fill: b.color,
                    opacity: b.up ? 0.85 : 0.7
                  }
                )
              ] }, i)),
              hoverBar ? /* @__PURE__ */ jsxRuntime.jsx(
                "line",
                {
                  x1: hoverBar.cx,
                  x2: hoverBar.cx,
                  y1: 0,
                  y2: height,
                  stroke: "var(--ink-muted)",
                  strokeOpacity: 0.35,
                  strokeWidth: 1
                }
              ) : null
            ]
          }
        ),
        hoverBar && tooltipText ? /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            className: "pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded border border-border bg-paper px-1.5 py-0.5 font-mono text-[10px] leading-tight text-ink-strong shadow-sm whitespace-nowrap",
            style: {
              left: Math.max(60, Math.min(width - 60, hoverBar.cx)),
              top: Math.max(0, hoverBar.wickTop - 4)
            },
            role: "tooltip",
            children: tooltipText
          }
        ) : null,
        /* @__PURE__ */ jsxRuntime.jsx("span", { "aria-live": "polite", className: "sr-only", children: tooltipText })
      ]
    }
  );
}
function Donut({
  segments,
  size = 96,
  strokeWidth = 12,
  centerLabel,
  centerSub,
  className,
  ariaLabel
}) {
  const id = React3.useId();
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  const radius = (size - strokeWidth) / 2;
  const circumference = 2 * Math.PI * radius;
  let offset = 0;
  const label = ariaLabel ?? synthesizeDonutAriaLabel(segments);
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      role: "img",
      "aria-label": label,
      className,
      style: { width: size, height: size, position: "relative", flexShrink: 0 },
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs(
          "svg",
          {
            width: size,
            height: size,
            viewBox: `0 0 ${size} ${size}`,
            "aria-hidden": true,
            children: [
              /* @__PURE__ */ jsxRuntime.jsx(
                "circle",
                {
                  cx: size / 2,
                  cy: size / 2,
                  r: radius,
                  fill: "none",
                  stroke: "var(--border)",
                  strokeWidth,
                  opacity: 0.4
                }
              ),
              total > 0 ? segments.map((s, i) => {
                const len = Math.max(0, s.value) / total * circumference;
                const dasharray = `${len} ${circumference - len}`;
                const dashoffset = -offset;
                offset += len;
                return /* @__PURE__ */ jsxRuntime.jsx(
                  "circle",
                  {
                    cx: size / 2,
                    cy: size / 2,
                    r: radius,
                    fill: "none",
                    stroke: s.color,
                    strokeWidth,
                    strokeDasharray: dasharray,
                    strokeDashoffset: dashoffset,
                    strokeLinecap: "butt",
                    transform: `rotate(-90 ${size / 2} ${size / 2})`
                  },
                  `${id}-${i}`
                );
              }) : null
            ]
          }
        ),
        centerLabel || centerSub ? /* @__PURE__ */ jsxRuntime.jsxs(
          "div",
          {
            style: {
              position: "absolute",
              inset: 0,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "center",
              pointerEvents: "none"
            },
            children: [
              centerLabel ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "font-display text-base font-semibold tabular-nums text-ink-strong leading-none", children: centerLabel }) : null,
              centerSub ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-type-micro text-ink-muted mt-0.5", children: centerSub }) : null
            ]
          }
        ) : null
      ]
    }
  );
}
function DonutLegend({ segments }) {
  return /* @__PURE__ */ jsxRuntime.jsx("ul", { className: "space-y-1", children: segments.map((s) => /* @__PURE__ */ jsxRuntime.jsxs(
    "li",
    {
      className: "flex items-center gap-2 mg-type-micro text-ink-muted",
      children: [
        /* @__PURE__ */ jsxRuntime.jsx(
          "span",
          {
            "aria-hidden": true,
            className: "inline-block size-2 rounded-sm",
            style: { background: s.color }
          }
        ),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "text-ink", children: s.label }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "ml-auto tabular-nums text-ink-strong", children: s.value })
      ]
    },
    s.label
  )) });
}
function SparkLegend({
  children,
  metric,
  source,
  windowLabel,
  updatedAt,
  staleness,
  side = "top"
}) {
  const fresh = formatFreshness(updatedAt, windowLabel);
  const freshAbs = formatFreshnessAbsolute(updatedAt);
  return (
    // Self-wrapped so SparkLegend works outside AppShell's global provider.
    /* @__PURE__ */ jsxRuntime.jsx(TooltipProvider, { children: /* @__PURE__ */ jsxRuntime.jsxs(Tooltip, { delayDuration: 200, children: [
      /* @__PURE__ */ jsxRuntime.jsx(TooltipTrigger, { asChild: true, children: /* @__PURE__ */ jsxRuntime.jsx(
        "span",
        {
          tabIndex: 0,
          className: "inline-flex max-w-full items-center focus:outline-none focus-visible:ring-1 focus-visible:ring-ring rounded",
          children
        }
      ) }),
      /* @__PURE__ */ jsxRuntime.jsxs(
        TooltipContent,
        {
          side,
          sideOffset: 6,
          collisionPadding: 8,
          avoidCollisions: true,
          className: "max-w-xs text-[11px] leading-relaxed",
          children: [
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-type-micro mb-1", children: [
              metric,
              windowLabel ? ` \xB7 ${windowLabel}` : ""
            ] }),
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mb-1", children: [
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-type-micro opacity-70", children: "source \xB7 " }),
              source
            ] }),
            staleness ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mb-1", children: [
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-type-micro opacity-70", children: "staleness \xB7 " }),
              staleness
            ] }) : null,
            fresh || freshAbs ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mt-1 font-mono text-[10px] opacity-80", children: [
              fresh ?? "",
              freshAbs ? `${fresh ? " \xB7 " : ""}last checked ${freshAbs}` : ""
            ] }) : null
          ]
        }
      )
    ] }) })
  );
}
function Sparkline({
  values,
  points,
  width = 120,
  height = 28,
  color = "var(--accent)",
  fill = true,
  className,
  ariaLabel,
  formatValue,
  interactive = true
}) {
  const wrapRef = React3.useRef(null);
  const [hover, setHover] = React3.useState(null);
  const pts = values.slice(-500).filter((v) => typeof v === "number" && Number.isFinite(v));
  if (pts.length === 0) {
    return /* @__PURE__ */ jsxRuntime.jsx(
      "svg",
      {
        width: "100%",
        height,
        viewBox: `0 0 ${width} ${height}`,
        preserveAspectRatio: "none",
        className: `block max-w-full ${className ?? ""}`,
        style: { maxWidth: width },
        role: "img",
        "aria-label": ariaLabel ?? SPARKLINE_EMPTY_ARIA_LABEL,
        children: /* @__PURE__ */ jsxRuntime.jsx(
          "line",
          {
            x1: 0,
            y1: height / 2,
            x2: width,
            y2: height / 2,
            stroke: "var(--border)",
            strokeDasharray: "2 3"
          }
        )
      }
    );
  }
  let min = pts[0];
  let max = pts[0];
  for (const value of pts) {
    if (value < min) min = value;
    if (value > max) max = value;
  }
  const span = max - min || 1;
  const step = pts.length > 1 ? width / (pts.length - 1) : 0;
  const coords = pts.map((v, i) => {
    const x = pts.length === 1 ? width / 2 : i * step;
    const y = height - 2 - (v - min) / span * (height - 4);
    return [x, y];
  });
  const line = coords.map(([x, y], i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`).join(" ");
  const area = `${line} L${coords[coords.length - 1][0].toFixed(1)},${height} L0,${height} Z`;
  const canTooltip = interactive && pts.length > 1;
  function onMove(e) {
    if (!canTooltip) return;
    const rect = wrapRef.current?.getBoundingClientRect();
    if (!rect) return;
    const x = Math.max(0, Math.min(rect.width, e.clientX - rect.left));
    const idx = Math.round(x / rect.width * (pts.length - 1));
    setHover(idx);
  }
  function onKeyDown(e) {
    if (!canTooltip) return;
    if (e.key === "ArrowRight") {
      e.preventDefault();
      setHover((prev) => Math.min(pts.length - 1, (prev ?? -1) + 1));
    } else if (e.key === "ArrowLeft") {
      e.preventDefault();
      setHover((prev) => Math.max(0, (prev ?? pts.length) - 1));
    }
  }
  function onFocus() {
    if (!canTooltip) return;
    setHover((prev) => prev ?? 0);
  }
  const hoverPoint = hover != null ? coords[hover] : null;
  const hoverValue = hover != null ? pts[hover] : null;
  const hoverLabel = hover != null ? points?.[hover]?.t : void 0;
  const tooltipText = hoverValue != null ? `${hoverLabel ? `${hoverLabel} \xB7 ` : ""}${formatValue ? formatValue(hoverValue) : hoverValue}` : "";
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      ref: wrapRef,
      className: `relative block w-full ${className ?? ""}`,
      style: { width: "100%", maxWidth: width, height },
      onPointerMove: onMove,
      onPointerLeave: () => setHover(null),
      onKeyDown,
      onFocus,
      onBlur: () => setHover(null),
      tabIndex: canTooltip ? 0 : void 0,
      "aria-label": canTooltip ? `${ariaLabel ?? "Sparkline chart"}, use arrow keys to step through values` : void 0,
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs(
          "svg",
          {
            width: "100%",
            height,
            viewBox: `0 0 ${width} ${height}`,
            preserveAspectRatio: "none",
            role: "img",
            "aria-label": ariaLabel,
            className: "block w-full",
            children: [
              fill ? /* @__PURE__ */ jsxRuntime.jsx("path", { d: area, fill: color, opacity: 0.12 }) : null,
              /* @__PURE__ */ jsxRuntime.jsx(
                "path",
                {
                  d: line,
                  fill: "none",
                  stroke: color,
                  strokeWidth: 1.5,
                  strokeLinecap: "round",
                  strokeLinejoin: "round"
                }
              ),
              hoverPoint ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
                /* @__PURE__ */ jsxRuntime.jsx(
                  "line",
                  {
                    x1: hoverPoint[0],
                    x2: hoverPoint[0],
                    y1: 0,
                    y2: height,
                    stroke: "var(--ink-muted)",
                    strokeOpacity: 0.35,
                    strokeWidth: 1
                  }
                ),
                /* @__PURE__ */ jsxRuntime.jsx(
                  "circle",
                  {
                    cx: hoverPoint[0],
                    cy: hoverPoint[1],
                    r: 2.5,
                    fill: color
                  }
                )
              ] }) : null
            ]
          }
        ),
        hoverPoint && tooltipText ? /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            className: "pointer-events-none absolute z-10 -translate-x-1/2 -translate-y-full rounded border border-border bg-paper px-1.5 py-0.5 font-mono text-[10px] leading-tight text-ink-strong shadow-sm whitespace-nowrap",
            style: {
              left: Math.max(24, Math.min(width - 24, hoverPoint[0])),
              top: hoverPoint[1] - 4
            },
            role: "tooltip",
            children: tooltipText
          }
        ) : null,
        /* @__PURE__ */ jsxRuntime.jsx("span", { "aria-live": "polite", className: "sr-only", children: tooltipText })
      ]
    }
  );
}
function StatTile({
  icon: Icon,
  eyebrow,
  value,
  hint,
  chart,
  tone = "default",
  className,
  truncate = true,
  tooltip
}) {
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      className: classNames(
        "rounded-lg border bg-card p-4 flex items-center gap-4",
        tone === "accent" && "border-accent/40",
        tone === "ok" && "border-health-ok/40",
        tone === "warn" && "border-health-warn/40",
        tone === "down" && "border-health-down/40",
        tone === "default" && "border-border",
        className
      ),
      children: [
        Icon ? /* @__PURE__ */ jsxRuntime.jsx(
          Icon,
          {
            "aria-hidden": true,
            className: classNames(
              "size-4 shrink-0",
              tone === "accent" ? "text-accent" : tone === "ok" ? "text-health-ok" : tone === "warn" ? "text-health-warn" : tone === "down" ? "text-health-down" : "text-ink-muted"
            )
          }
        ) : null,
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "min-w-0 flex-1", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-center gap-1 mg-type-micro text-ink-muted", children: [
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: truncate ? "truncate" : "leading-tight", children: eyebrow }),
            tooltip ? /* @__PURE__ */ jsxRuntime.jsx(InfoTooltip, { label: tooltip, className: "shrink-0" }) : null
          ] }),
          /* @__PURE__ */ jsxRuntime.jsxs(
            "div",
            {
              className: classNames(
                "mt-1 flex min-w-0 gap-1.5",
                truncate ? "items-baseline" : "flex-wrap items-baseline"
              ),
              children: [
                /* @__PURE__ */ jsxRuntime.jsx("span", { className: "shrink-0 font-display text-base font-semibold tabular-nums leading-none text-ink-strong sm:text-xl md:text-2xl", children: value }),
                hint ? /* @__PURE__ */ jsxRuntime.jsx(
                  "span",
                  {
                    className: classNames(
                      "min-w-0 font-mono text-[10px] text-ink-muted",
                      truncate ? "truncate" : ""
                    ),
                    children: hint
                  }
                ) : null
              ]
            }
          )
        ] }),
        chart ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "shrink-0 opacity-80", children: chart }) : null
      ]
    }
  );
}
function StatWithSpark({
  label,
  value,
  hint,
  full,
  unit,
  tone = "default",
  viz,
  delta,
  className,
  updatedAt,
  windowLabel
}) {
  const freshLine = formatFreshness(updatedAt, windowLabel);
  const freshAbs = formatFreshnessAbsolute(updatedAt);
  return (
    // Self-wrapped so StatWithSpark works outside AppShell's global provider.
    /* @__PURE__ */ jsxRuntime.jsx(TooltipProvider, { children: /* @__PURE__ */ jsxRuntime.jsxs(Tooltip, { delayDuration: 200, children: [
      /* @__PURE__ */ jsxRuntime.jsx(TooltipTrigger, { asChild: true, children: /* @__PURE__ */ jsxRuntime.jsxs(
        "div",
        {
          tabIndex: 0,
          className: classNames(
            "group flex flex-col gap-1 px-3 py-2.5 min-w-0 focus:outline-none focus-visible:bg-surface/40 transition-colors",
            className
          ),
          children: [
            /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-type-micro text-ink-muted truncate", children: label }),
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-baseline gap-1.5 min-w-0", children: [
              /* @__PURE__ */ jsxRuntime.jsx(
                "span",
                {
                  className: classNames(
                    "font-display text-lg font-semibold tabular-nums leading-none truncate",
                    tone === "ok" && "text-health-ok",
                    tone === "warn" && "text-health-warn",
                    tone === "down" && "text-health-down",
                    tone === "default" && "text-ink-strong"
                  ),
                  children: value
                }
              ),
              unit ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "shrink-0 mg-type-micro text-ink-muted", children: unit }) : null,
              delta
            ] }),
            viz ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mt-0.5 min-h-[18px]", children: viz }) : null,
            hint ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "font-mono text-[9.5px] text-ink-muted/80 truncate", children: hint }) : null,
            freshLine ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "font-mono text-[9px] tracking-wide text-ink-muted/70 truncate", children: freshLine }) : null
          ]
        }
      ) }),
      /* @__PURE__ */ jsxRuntime.jsxs(
        TooltipContent,
        {
          side: "bottom",
          className: "max-w-xs text-[11px] leading-relaxed",
          children: [
            /* @__PURE__ */ jsxRuntime.jsx("div", { children: full ?? hint ?? label }),
            freshAbs || windowLabel ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mt-1 font-mono text-[10px] text-primary-foreground/70", children: [
              freshAbs ? `Last checked ${freshAbs}` : null,
              freshAbs && windowLabel ? " \xB7 " : "",
              windowLabel ? `${windowLabel} window` : null
            ] }) : null
          ]
        }
      )
    ] }) })
  );
}
function MiniStack({
  segments,
  height = 8
}) {
  const total = segments.reduce((a, s) => a + Math.max(0, s.value), 0);
  if (total <= 0) {
    return /* @__PURE__ */ jsxRuntime.jsx(
      "div",
      {
        className: "w-full rounded-full bg-border/40",
        style: { height },
        "aria-hidden": true
      }
    );
  }
  return /* @__PURE__ */ jsxRuntime.jsx(
    "div",
    {
      className: "flex w-full overflow-hidden rounded-full bg-border/40",
      style: { height },
      role: "img",
      "aria-label": segments.map((s) => `${s.label} ${s.value}`).join(", "),
      children: segments.map(
        (s) => s.value > 0 ? /* @__PURE__ */ jsxRuntime.jsx(
          "span",
          {
            style: {
              width: `${s.value / total * 100}%`,
              background: s.color
            },
            title: `${s.label} \xB7 ${s.value}`
          },
          s.label
        ) : null
      )
    }
  );
}
function MiniRadial({
  value,
  size = 28,
  stroke = 4,
  color = "var(--ink-strong)"
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(1, value));
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "svg",
    {
      width: size,
      height: size,
      viewBox: `0 0 ${size} ${size}`,
      className: "block",
      "aria-hidden": true,
      children: [
        /* @__PURE__ */ jsxRuntime.jsx(
          "circle",
          {
            cx: size / 2,
            cy: size / 2,
            r,
            fill: "none",
            stroke: "var(--border)",
            strokeWidth: stroke,
            opacity: 0.5
          }
        ),
        /* @__PURE__ */ jsxRuntime.jsx(
          "circle",
          {
            cx: size / 2,
            cy: size / 2,
            r,
            fill: "none",
            stroke: color,
            strokeWidth: stroke,
            strokeDasharray: `${c * pct} ${c}`,
            strokeLinecap: "round",
            transform: `rotate(-90 ${size / 2} ${size / 2})`
          }
        )
      ]
    }
  );
}
function DotRow({
  dots
}) {
  return (
    // One provider for the row rather than one per dot -- self-wrapped so DotRow
    // works outside AppShell's global provider.
    /* @__PURE__ */ jsxRuntime.jsx(TooltipProvider, { children: /* @__PURE__ */ jsxRuntime.jsx(
      "div",
      {
        className: "flex items-center gap-1",
        role: "img",
        "aria-label": "Source coverage",
        children: dots.map((d) => /* @__PURE__ */ jsxRuntime.jsxs(Tooltip, { delayDuration: 150, children: [
          /* @__PURE__ */ jsxRuntime.jsx(TooltipTrigger, { asChild: true, children: /* @__PURE__ */ jsxRuntime.jsx(
            "span",
            {
              className: classNames(
                "size-1.5 rounded-full",
                d.on ? "bg-accent" : "bg-border"
              )
            }
          ) }),
          /* @__PURE__ */ jsxRuntime.jsxs(TooltipContent, { side: "top", className: "font-mono text-[10px]", children: [
            d.label,
            " ",
            d.on ? "\u2713" : "\u2014"
          ] })
        ] }, d.label))
      }
    ) })
  );
}
function NoDataSpark({
  updatedAt,
  windowLabel,
  reason = "not enough data yet",
  height = 18
}) {
  const freshAbs = formatFreshnessAbsolute(updatedAt);
  const freshLine = formatFreshness(updatedAt, windowLabel);
  return (
    // Self-wrapped so NoDataSpark works outside AppShell's global provider.
    /* @__PURE__ */ jsxRuntime.jsx(TooltipProvider, { children: /* @__PURE__ */ jsxRuntime.jsxs(Tooltip, { delayDuration: 150, children: [
      /* @__PURE__ */ jsxRuntime.jsx(TooltipTrigger, { asChild: true, children: /* @__PURE__ */ jsxRuntime.jsxs(
        "div",
        {
          tabIndex: 0,
          role: "img",
          "aria-label": `${reason}${freshAbs ? `, last checked ${freshAbs}` : ""}`,
          className: "flex w-full items-center gap-1.5 rounded-sm border border-dashed border-border/70 bg-paper/40 px-1.5 focus:outline-none focus-visible:ring-1 focus-visible:ring-ring",
          style: { height },
          children: [
            /* @__PURE__ */ jsxRuntime.jsx(
              "span",
              {
                "aria-hidden": true,
                className: "inline-block size-1 rounded-full bg-ink-muted/60"
              }
            ),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "truncate mg-type-micro text-ink-muted/80", children: freshLine ?? reason })
          ]
        }
      ) }),
      /* @__PURE__ */ jsxRuntime.jsxs(
        TooltipContent,
        {
          side: "top",
          className: "max-w-xs text-[11px] leading-relaxed",
          children: [
            reason,
            ".",
            " ",
            freshAbs ? `Last checked ${freshAbs}${windowLabel ? ` \xB7 ${windowLabel} window` : ""}.` : "No probe samples recorded yet."
          ]
        }
      )
    ] }) })
  );
}
var sum = (ns) => ns.reduce((a, b) => a + b, 0);
var MIN_TILE_W_FOR_LABEL = 16;
var MIN_TILE_H_FOR_LABEL = 12;
var MIN_TILE_W_FOR_VALUE = 16;
var MIN_TILE_H_FOR_VALUE = 22;
function worstRatio(areas, side) {
  if (areas.length === 0 || side <= 0) return Infinity;
  const s = sum(areas);
  if (s <= 0) return Infinity;
  const max = Math.max(...areas);
  const min = Math.min(...areas);
  const s2 = s * s;
  const side2 = side * side;
  return Math.max(side2 * max / s2, s2 / (side2 * min));
}
function squarify(data) {
  const positive = data.filter((d) => d.value > 0);
  const total = sum(positive.map((d) => d.value));
  if (total <= 0) return [];
  const items = positive.map((d) => ({
    datum: d,
    area: d.value / total * 1e4,
    share: d.value / total
  })).sort((a, b) => b.area - a.area);
  const tiles = [];
  let rect = { x: 0, y: 0, w: 100, h: 100 };
  let row = [];
  const layoutRow = (rowItems, r) => {
    const rowArea = sum(rowItems.map((i) => i.area));
    if (rowArea <= 0) return r;
    if (r.w >= r.h) {
      const dw = rowArea / r.h;
      let y = r.y;
      for (const it of rowItems) {
        const h = it.area / dw;
        tiles.push({ ...it.datum, share: it.share, x: r.x, y, w: dw, h });
        y += h;
      }
      return { x: r.x + dw, y: r.y, w: r.w - dw, h: r.h };
    }
    const dh = rowArea / r.w;
    let x = r.x;
    for (const it of rowItems) {
      const w = it.area / dh;
      tiles.push({ ...it.datum, share: it.share, x, y: r.y, w, h: dh });
      x += w;
    }
    return { x: r.x, y: r.y + dh, w: r.w, h: r.h - dh };
  };
  for (const item of items) {
    const side = Math.min(rect.w, rect.h);
    const current = row.map((i) => i.area);
    const withItem = [...current, item.area];
    if (row.length === 0 || worstRatio(withItem, side) <= worstRatio(current, side)) {
      row.push(item);
    } else {
      rect = layoutRow(row, rect);
      row = [item];
    }
  }
  if (row.length > 0) layoutRow(row, rect);
  return tiles;
}
function TreemapMini({
  data,
  className,
  formatValue = String,
  ariaLabel
}) {
  const tiles = squarify(data);
  if (tiles.length === 0) return null;
  const label = ariaLabel ?? `Treemap of ${tiles.length} items sized by share: ` + tiles.map((t) => `${t.label} ${(t.share * 100).toFixed(1)}%`).join(", ");
  return /* @__PURE__ */ jsxRuntime.jsx(
    "div",
    {
      role: "img",
      "aria-label": label,
      className: classNames(
        "relative aspect-[16/9] w-full overflow-hidden rounded-md",
        className
      ),
      children: tiles.map((t) => /* @__PURE__ */ jsxRuntime.jsx(
        "div",
        {
          title: `${t.label} \xB7 ${formatValue(t.value)} \xB7 ${(t.share * 100).toFixed(1)}%`,
          className: "absolute overflow-hidden p-1",
          style: {
            left: `${t.x}%`,
            top: `${t.y}%`,
            width: `${t.w}%`,
            height: `${t.h}%`
          },
          children: /* @__PURE__ */ jsxRuntime.jsx(
            "div",
            {
              className: "flex h-full w-full flex-col justify-between rounded-sm border border-background/40 p-1.5",
              style: { background: t.color ?? "var(--accent)" },
              children: t.w > MIN_TILE_W_FOR_LABEL && t.h > MIN_TILE_H_FOR_LABEL ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
                /* @__PURE__ */ jsxRuntime.jsx("span", { className: "truncate font-mono text-[10px] font-medium leading-none text-accent-foreground", children: t.label }),
                t.w > MIN_TILE_W_FOR_VALUE && t.h > MIN_TILE_H_FOR_VALUE ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "truncate font-mono text-[9px] leading-none text-accent-foreground/80", children: formatValue(t.value) }) : null
              ] }) : null
            }
          )
        },
        t.label
      ))
    }
  );
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
    Cmp,
    {
      title,
      onClick,
      className: classNames(
        "inline-flex items-center gap-1.5 rounded-full border px-2 py-0.5",
        "font-mono text-[10px] leading-none whitespace-nowrap transition-colors",
        onClick ? "mg-focus-ring hover:border-ink/30 cursor-pointer" : null,
        TONE_CLASSES[tone],
        className
      ),
      children: [
        dot ? /* @__PURE__ */ jsxRuntime.jsx(
          "span",
          {
            "aria-hidden": true,
            className: "mg-health-dot",
            style: { color: "currentColor" }
          }
        ) : icon ? /* @__PURE__ */ jsxRuntime.jsx(
          "span",
          {
            "aria-hidden": true,
            className: "inline-flex size-3 items-center justify-center",
            children: icon
          }
        ) : null,
        label ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "uppercase tracking-widest opacity-70", children: label }) : null,
        children != null ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "text-ink-strong normal-case tracking-normal", children }) : null
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
  return /* @__PURE__ */ jsxRuntime.jsx(
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "span",
    {
      title,
      className: classNames(
        "inline-flex min-w-0",
        isRow ? "items-baseline gap-1.5" : "flex-col gap-0.5",
        className
      ),
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs(
          "span",
          {
            className: classNames(
              "inline-flex items-center gap-1 mg-type-micro text-ink-muted",
              isRow ? "self-center" : null
            ),
            children: [
              Icon ? /* @__PURE__ */ jsxRuntime.jsx(Icon, { className: "size-3", "aria-hidden": true }) : null,
              label
            ]
          }
        ),
        /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "font-mono text-[11px] tabular-nums text-ink-strong truncate", children: [
          value,
          hint ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "ml-1 text-ink-muted normal-case", children: hint }) : null
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "label",
    {
      htmlFor,
      className: classNames(
        "flex flex-col gap-1 min-w-0",
        grow ? "flex-1 min-w-[180px]" : null,
        className
      ),
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-type-micro text-ink-muted inline-flex items-center gap-1.5", children: [
          label,
          hint ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "opacity-70", children: hint }) : null
        ] }),
        children
      ]
    }
  );
}
var CONTROL_CLASSES = "h-9 min-w-0 w-full rounded border border-border bg-card px-2.5 text-[12px] text-ink-strong placeholder:text-ink-subtle-text mg-focus-ring hover:border-ink/25 transition-colors";
function FilterInput({
  className,
  leadingIcon = true,
  ...props
}) {
  if (!leadingIcon) {
    return /* @__PURE__ */ jsxRuntime.jsx("input", { ...props, className: classNames(CONTROL_CLASSES, className) });
  }
  return /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "relative inline-flex w-full items-center", children: [
    /* @__PURE__ */ jsxRuntime.jsx(
      lucideReact.Search,
      {
        className: "pointer-events-none absolute left-2.5 size-3.5 text-ink-muted",
        "aria-hidden": true
      }
    ),
    /* @__PURE__ */ jsxRuntime.jsx(
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
  return /* @__PURE__ */ jsxRuntime.jsx(
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      className: classNames(
        "flex w-full flex-wrap items-end gap-2 md:gap-3",
        className
      ),
      children: [
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "flex flex-1 flex-wrap items-end gap-2 md:gap-3 min-w-0", children }),
        trailing ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "flex flex-wrap items-center gap-1.5 shrink-0", children: trailing }) : null
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
  const [open, setOpen] = React3.useState(false);
  const visibleCount = columns.filter((c) => isVisible(c.id)).length;
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: classNames("relative", className), children: [
    /* @__PURE__ */ jsxRuntime.jsxs(
      "button",
      {
        type: "button",
        onClick: () => setOpen((v) => !v),
        "aria-haspopup": "menu",
        "aria-expanded": open,
        title: "Customize visible columns",
        className: "mg-focus-ring inline-flex items-center gap-1.5 h-9 rounded border border-border bg-card px-2.5 mg-type-micro text-ink-muted hover:text-ink-strong hover:border-ink/25 transition-colors",
        children: [
          /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Columns3, { className: "size-3", "aria-hidden": true }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "hidden sm:inline", children: "Columns" }),
          /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "text-ink-strong tabular-nums normal-case tracking-normal", children: [
            visibleCount,
            "/",
            columns.length
          ] })
        ]
      }
    ),
    open ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsx(
        "button",
        {
          type: "button",
          "aria-label": "Close column menu",
          className: "fixed inset-0 z-30 cursor-default",
          onClick: () => setOpen(false)
        }
      ),
      /* @__PURE__ */ jsxRuntime.jsxs(
        "div",
        {
          role: "menu",
          className: "absolute right-0 z-40 mt-1.5 w-64 rounded border border-border bg-card p-1 mg-card-glow",
          children: [
            /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-center justify-between px-2 py-1.5", children: [
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-type-micro text-ink-muted", children: "Columns" }),
              /* @__PURE__ */ jsxRuntime.jsxs(
                "button",
                {
                  type: "button",
                  onClick: onReset,
                  className: "mg-focus-ring inline-flex items-center gap-1 font-mono text-[10px] text-ink-muted hover:text-ink-strong",
                  title: "Reset to defaults",
                  children: [
                    /* @__PURE__ */ jsxRuntime.jsx(lucideReact.RotateCcw, { className: "size-3", "aria-hidden": true }),
                    " Reset"
                  ]
                }
              )
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx("div", { className: "max-h-72 overflow-y-auto py-0.5", children: columns.map((c) => {
              const checked = isVisible(c.id);
              return /* @__PURE__ */ jsxRuntime.jsxs(
                "label",
                {
                  className: classNames(
                    "flex items-center gap-2 rounded px-2 py-1.5 text-[12px] text-ink hover:bg-surface-2 cursor-pointer",
                    c.required ? "opacity-60 cursor-not-allowed" : null
                  ),
                  children: [
                    /* @__PURE__ */ jsxRuntime.jsx(
                      "input",
                      {
                        type: "checkbox",
                        checked,
                        disabled: c.required,
                        onChange: () => onToggle(c.id),
                        className: "accent-accent size-3.5"
                      }
                    ),
                    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "flex-1 truncate", children: c.label }),
                    c.required ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-type-micro text-ink-subtle-text", children: "Locked" }) : null
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
  const initial = React3.useMemo(() => defaultVisible(columns), [columns]);
  const [visible, setVisible] = React3.useState(initial);
  React3.useEffect(() => {
    const persisted = readPersisted(pageKey);
    if (!persisted) return;
    const set = new Set(persisted);
    for (const c of columns) if (c.required) set.add(c.id);
    const known = new Set(columns.map((c) => c.id));
    setVisible(Array.from(set).filter((id) => known.has(id)));
  }, [pageKey, columns]);
  React3.useEffect(() => {
    writePersisted(pageKey, visible);
  }, [pageKey, visible]);
  const isVisible = React3.useCallback(
    (id) => visible.includes(id),
    [visible]
  );
  const toggle = React3.useCallback(
    (id) => {
      const col = columns.find((c) => c.id === id);
      if (col?.required) return;
      setVisible(
        (prev) => prev.includes(id) ? prev.filter((v) => v !== id) : [...prev, id]
      );
    },
    [columns]
  );
  const reset = React3.useCallback(() => {
    setVisible(defaultVisible(columns));
  }, [columns]);
  return { visible, isVisible, toggle, reset, setVisible };
}
var TONE_CLASSES2 = {
  default: "text-ink-muted",
  muted: "text-ink-subtle-text",
  accent: "text-accent-text",
  warn: "text-health-warn-text",
  down: "text-health-down"
};
function SectionLabel({
  children,
  size = "micro",
  tone = "default",
  icon,
  hint,
  as,
  className,
  title
}) {
  const Cmp = as ?? "span";
  return /* @__PURE__ */ jsxRuntime.jsxs(
    Cmp,
    {
      title,
      className: classNames(
        size === "micro" ? "mg-type-micro" : "mg-type-label",
        "inline-flex items-center gap-1.5",
        TONE_CLASSES2[tone],
        className
      ),
      children: [
        icon ? /* @__PURE__ */ jsxRuntime.jsx(
          "span",
          {
            "aria-hidden": true,
            className: "inline-flex size-3 items-center justify-center",
            children: icon
          }
        ) : null,
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "truncate", children }),
        hint != null ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "text-ink-subtle-text normal-case tracking-normal", children: hint }) : null
      ]
    }
  );
}
var TONE_CLASSES3 = {
  default: "border-border bg-card",
  accent: "border-accent/40 bg-primary-soft",
  warn: "border-health-warn/40 bg-health-warn/5",
  down: "border-health-down/40 bg-health-down/5",
  muted: "border-border bg-surface-2"
};
function Panel({
  title,
  action,
  caption,
  dense,
  flush,
  interactive,
  tone = "default",
  as,
  className,
  bodyClassName,
  children
}) {
  const Cmp = as ?? "section";
  const hasHeader = title != null || action != null || caption != null;
  const padClass = flush ? "mg-panel-pad-flush" : dense ? "mg-panel-pad-dense" : "mg-panel-pad";
  return /* @__PURE__ */ jsxRuntime.jsxs(
    Cmp,
    {
      className: classNames(
        "rounded border",
        TONE_CLASSES3[tone],
        interactive ? "mg-hover-lift" : null,
        className
      ),
      children: [
        hasHeader ? /* @__PURE__ */ jsxRuntime.jsxs(
          "header",
          {
            className: classNames(
              "flex items-start justify-between gap-3 border-b border-border/70",
              dense ? "mg-panel-pad-dense" : "mg-panel-pad"
            ),
            style: {
              paddingTop: "var(--mg-space-sm)",
              paddingBottom: "var(--mg-space-sm)"
            },
            children: [
              /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "min-w-0", children: [
                title != null ? /* @__PURE__ */ jsxRuntime.jsx(SectionLabel, { children: title }) : null,
                caption != null ? /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mt-1 text-[13px] text-ink-muted", children: caption }) : null
              ] }),
              action != null ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "shrink-0 flex items-center gap-2", children: action }) : null
            ]
          }
        ) : null,
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: classNames(padClass, bodyClassName), children })
      ]
    }
  );
}
var VARIANT_ICON = {
  empty: lucideReact.Inbox,
  filtered: lucideReact.Filter,
  error: lucideReact.AlertTriangle,
  stale: lucideReact.RotateCcw
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
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
        /* @__PURE__ */ jsxRuntime.jsx(
          "span",
          {
            "aria-hidden": true,
            className: classNames(
              "inline-flex size-10 items-center justify-center rounded-full border border-border bg-surface-2",
              VARIANT_TONE[variant]
            ),
            children: /* @__PURE__ */ jsxRuntime.jsx(Icon, { className: "size-4" })
          }
        ),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "max-w-sm space-y-1", children: [
          /* @__PURE__ */ jsxRuntime.jsx("p", { className: "font-display text-[15px] font-medium text-ink-strong", children: title }),
          hint != null ? /* @__PURE__ */ jsxRuntime.jsx("p", { className: "text-[13px] leading-relaxed text-ink-muted", children: hint }) : null
        ] }),
        action != null || evidenceHref ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex flex-wrap items-center justify-center gap-2 pt-1", children: [
          action,
          evidenceHref ? /* @__PURE__ */ jsxRuntime.jsxs(
            "a",
            {
              href: evidenceHref,
              target: "_blank",
              rel: "noreferrer",
              className: "mg-focus-ring inline-flex items-center gap-1 mg-type-label uppercase text-ink-muted hover:text-ink-strong",
              children: [
                evidenceLabel,
                /* @__PURE__ */ jsxRuntime.jsx(lucideReact.ExternalLink, { className: "size-3", "aria-hidden": true })
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
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
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "sr-only", children: "Loading table\u2026" }),
        withHeader ? /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            className: "grid gap-3 border-b border-border bg-surface-2 px-4 py-2",
            style: { gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))` },
            children: Array.from({ length: columns }).map((_, c) => /* @__PURE__ */ jsxRuntime.jsx(
              "span",
              {
                className: "h-3 rounded bg-border/70",
                style: { width: `${40 + c * 17 % 40}%` }
              },
              `h-${c}`
            ))
          }
        ) : null,
        /* @__PURE__ */ jsxRuntime.jsx("div", { children: Array.from({ length: rows }).map((_, r) => /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            className: classNames(
              "grid gap-3 border-b border-border/60 px-4 last:border-b-0",
              rowPad
            ),
            style: {
              gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`
            },
            children: Array.from({ length: columns }).map((_2, c) => /* @__PURE__ */ jsxRuntime.jsx(
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
var colMap = {
  1: "grid-cols-1",
  2: "grid-cols-2",
  3: "grid-cols-3",
  4: "grid-cols-4",
  6: "grid-cols-6"
};
var smMap = { 2: "sm:grid-cols-2", 3: "sm:grid-cols-3" };
var mdMap = {
  2: "md:grid-cols-2",
  3: "md:grid-cols-3",
  4: "md:grid-cols-4"
};
var lgMap = {
  2: "lg:grid-cols-2",
  3: "lg:grid-cols-3",
  4: "lg:grid-cols-4",
  6: "lg:grid-cols-6"
};
var gapMap = { sm: "gap-2", md: "gap-3", lg: "gap-4" };
function MetricGrid({
  children,
  cols = { base: 1, sm: 2, lg: 3 },
  gap = "md",
  className
}) {
  return /* @__PURE__ */ jsxRuntime.jsx(
    "div",
    {
      className: cn(
        "grid",
        colMap[cols.base ?? 1],
        cols.sm ? smMap[cols.sm] : void 0,
        cols.md ? mdMap[cols.md] : void 0,
        cols.lg ? lgMap[cols.lg] : void 0,
        gapMap[gap],
        className
      ),
      children
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      className: cn(
        "flex flex-wrap items-start justify-between gap-3",
        className
      ),
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "min-w-0", children: [
          variant === "micro" ? /* @__PURE__ */ jsxRuntime.jsx(SectionLabel, { children: title }) : /* @__PURE__ */ jsxRuntime.jsx("h2", { className: "font-display text-base font-medium leading-tight text-ink-strong", children: title }),
          description ? /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mt-1 text-xs leading-relaxed text-ink-muted", children: description }) : null
        ] }),
        actions ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "flex shrink-0 flex-wrap items-center gap-2", children: actions }) : null
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
  return /* @__PURE__ */ jsxRuntime.jsx(
    "div",
    {
      className: cn("relative h-px w-full", bar, className),
      role: "separator",
      "aria-hidden": true,
      children: pip ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "absolute left-0 top-1/2 -translate-y-1/2 size-1.5 rounded-[1px] bg-accent" }) : null
    }
  );
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
function isTablistNavKey(key) {
  return key === "ArrowRight" || key === "ArrowLeft" || key === "ArrowDown" || key === "ArrowUp" || key === "Home" || key === "End";
}
function rovingTabIndex(index, activeIndex) {
  return index === activeIndex ? 0 : -1;
}
function useRovingTablist(count, onSelect) {
  const refs = React3.useRef([]);
  const tabRef = React3.useCallback(
    (index) => (el) => {
      refs.current[index] = el;
    },
    []
  );
  const onKeyDown = React3.useCallback(
    (index) => (e) => {
      const next = nextTabIndex(index, e.key, count);
      if (next == null) return;
      e.preventDefault();
      refs.current[next]?.focus();
      onSelect(next);
    },
    [count, onSelect]
  );
  return { tabRef, onKeyDown };
}
function TabStrip({
  items,
  value,
  onChange,
  ariaLabel,
  size = "md",
  className
}) {
  const activeIndex = Math.max(
    0,
    items.findIndex((i) => i.id === value)
  );
  const { tabRef, onKeyDown } = useRovingTablist(items.length, (i) => {
    const it = items[i];
    if (it && !it.disabled) onChange(it.id);
  });
  const pad = size === "sm" ? "px-2 py-1.5" : "px-3 py-2";
  const text = size === "sm" ? "text-[12px]" : "text-[13px]";
  return /* @__PURE__ */ jsxRuntime.jsx(
    "div",
    {
      role: "tablist",
      "aria-label": ariaLabel,
      className: classNames(
        "flex items-center gap-1 border-b border-border",
        className
      ),
      children: items.map((it, i) => {
        const selected = it.id === value;
        return /* @__PURE__ */ jsxRuntime.jsxs(
          "button",
          {
            ref: tabRef(i),
            role: "tab",
            type: "button",
            "aria-selected": selected,
            tabIndex: rovingTabIndex(i, activeIndex),
            disabled: it.disabled,
            onKeyDown: onKeyDown(i),
            onClick: () => !it.disabled && onChange(it.id),
            className: classNames(
              "-mb-px inline-flex items-center gap-2 border-b-2 font-medium transition-colors",
              pad,
              text,
              selected ? "border-accent text-ink-strong" : "border-transparent text-ink-muted hover:text-ink-strong",
              it.disabled ? "opacity-50 cursor-not-allowed" : null
            ),
            children: [
              /* @__PURE__ */ jsxRuntime.jsx("span", { children: it.label }),
              it.meta != null ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "text-ink-muted", children: it.meta }) : null
            ]
          },
          it.id
        );
      })
    }
  );
}
function isScrolledPast(scrollY, threshold) {
  return scrollY > threshold;
}
function useScrolled(threshold = 4) {
  const [scrolled, setScrolled] = React3.useState(false);
  React3.useEffect(() => {
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
function StickyToolbar({
  children,
  offset,
  hairline = true,
  className
}) {
  const scrolled = useScrolled(4);
  const top = offset != null ? { top: offset } : { top: "var(--mg-sticky-offset, 0px)" };
  return /* @__PURE__ */ jsxRuntime.jsx(
    "div",
    {
      style: top,
      className: cn(
        "sticky z-20 -mx-4 border-b bg-paper/95 px-4 py-2 backdrop-blur transition-[border-color,box-shadow] sm:mx-0 sm:px-0",
        hairline && scrolled ? "border-border" : "border-transparent",
        className
      ),
      children: /* @__PURE__ */ jsxRuntime.jsx("div", { className: "flex flex-wrap items-center gap-2", children })
    }
  );
}
function DefinitionList({
  items,
  layout = "inline",
  className
}) {
  if (layout === "grid") {
    return /* @__PURE__ */ jsxRuntime.jsx(
      "dl",
      {
        className: cn(
          "grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-2",
          className
        ),
        children: items.map((it, i) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "min-w-0", children: [
          /* @__PURE__ */ jsxRuntime.jsx("dt", { title: it.title, className: "mg-type-micro text-ink-muted", children: it.term }),
          /* @__PURE__ */ jsxRuntime.jsx("dd", { className: "mt-1 truncate text-sm text-ink-strong", children: it.detail })
        ] }, i))
      }
    );
  }
  if (layout === "stacked") {
    return /* @__PURE__ */ jsxRuntime.jsx("dl", { className: cn("space-y-3", className), children: items.map((it, i) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "min-w-0", children: [
      /* @__PURE__ */ jsxRuntime.jsx("dt", { title: it.title, className: "mg-type-micro text-ink-muted", children: it.term }),
      /* @__PURE__ */ jsxRuntime.jsx("dd", { className: "mt-1 text-sm text-ink-strong", children: it.detail })
    ] }, i)) });
  }
  return /* @__PURE__ */ jsxRuntime.jsx("dl", { className: cn("divide-y divide-border/70", className), children: items.map((it, i) => /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      className: "flex items-baseline justify-between gap-4 py-2 first:pt-0 last:pb-0",
      children: [
        /* @__PURE__ */ jsxRuntime.jsx(
          "dt",
          {
            title: it.title,
            className: "mg-type-label shrink-0 text-ink-muted",
            children: it.term
          }
        ),
        /* @__PURE__ */ jsxRuntime.jsx("dd", { className: "min-w-0 truncate text-right text-sm text-ink-strong", children: it.detail })
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
  return /* @__PURE__ */ jsxRuntime.jsx(
    Chip,
    {
      tone,
      icon: /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Loader2, { className: "size-3 animate-spin" }),
      className,
      children
    }
  );
}
var SIZE = {
  sm: "min-h-8 px-2.5 text-xs",
  md: "min-h-10 px-4 text-sm",
  lg: "min-h-11 px-5 text-sm"
};
var TONE2 = {
  default: "border-border text-ink-muted hover:border-accent/60 hover:text-ink-strong",
  accent: "border-accent/60 bg-primary-soft text-ink-strong hover:border-accent",
  warn: "border-health-warn/60 text-health-warn-text hover:border-health-warn",
  down: "border-health-down/60 text-health-down hover:border-health-down"
};
var GhostButton = React3.forwardRef(
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
    return /* @__PURE__ */ jsxRuntime.jsxs(
      "button",
      {
        ref,
        type: type ?? "button",
        className: cn(
          "inline-flex items-center justify-center gap-1.5 rounded-md border bg-card transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
          SIZE[size],
          TONE2[tone],
          className
        ),
        ...rest,
        children: [
          icon,
          children != null ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "min-w-0 truncate", children }) : null,
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      className: cn(
        "flex flex-wrap items-center justify-between gap-3 border-t border-border/70 pt-3 text-[12px] text-ink-muted",
        className
      ),
      children: [
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "min-w-0 truncate", "aria-live": "polite", children: loading ? "Loading\u2026" : summary }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-center gap-2", children: [
          /* @__PURE__ */ jsxRuntime.jsx(
            GhostButton,
            {
              onClick: onPrev,
              disabled: !hasPrev || loading,
              icon: /* @__PURE__ */ jsxRuntime.jsx(lucideReact.ChevronLeft, { className: "size-3.5" }),
              "aria-label": "Previous page",
              children: "Prev"
            }
          ),
          /* @__PURE__ */ jsxRuntime.jsx(
            GhostButton,
            {
              onClick: onNext,
              disabled: !hasNext || loading,
              iconRight: /* @__PURE__ */ jsxRuntime.jsx(lucideReact.ChevronRight, { className: "size-3.5" }),
              "aria-label": "Next page",
              children: "Next"
            }
          )
        ] })
      ]
    }
  );
}
function MetaStrip({
  items,
  separator = "dot",
  className
}) {
  const sep = separator === "pipe" ? "|" : "\xB7";
  return /* @__PURE__ */ jsxRuntime.jsx(
    "div",
    {
      className: cn(
        "flex flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-ink-muted",
        className
      ),
      children: items.map((it, i) => /* @__PURE__ */ jsxRuntime.jsxs(
        "span",
        {
          title: it.title,
          className: "inline-flex items-center gap-1.5",
          children: [
            i > 0 ? /* @__PURE__ */ jsxRuntime.jsx("span", { "aria-hidden": true, className: "text-ink-subtle-text", children: sep }) : null,
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-type-micro", children: it.label }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "text-ink-strong", children: it.value })
          ]
        },
        i
      ))
    }
  );
}
function ScrollShadow({
  orientation = "horizontal",
  className,
  innerClassName,
  children
}) {
  const ref = React3.useRef(null);
  const [state, setState] = React3.useState({ start: false, end: false });
  React3.useEffect(() => {
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
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: classNames("relative", className), children: [
    /* @__PURE__ */ jsxRuntime.jsx(
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
    state.start ? /* @__PURE__ */ jsxRuntime.jsx(
      "div",
      {
        "aria-hidden": true,
        className: classNames(
          "pointer-events-none absolute z-10",
          isH ? "left-0 top-0 h-full w-6 bg-gradient-to-r from-card to-transparent" : "left-0 top-0 h-6 w-full bg-gradient-to-b from-card to-transparent"
        )
      }
    ) : null,
    state.end ? /* @__PURE__ */ jsxRuntime.jsx(
      "div",
      {
        "aria-hidden": true,
        className: classNames(
          "pointer-events-none absolute z-10",
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
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className, children: [
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: SHOW_CARDS[cardsBelow], children: cardsFallback }),
      /* @__PURE__ */ jsxRuntime.jsx("div", { className: HIDE_TABLE[cardsBelow], children: /* @__PURE__ */ jsxRuntime.jsx(ScrollShadow, { children: /* @__PURE__ */ jsxRuntime.jsx("div", { style: { minWidth: min }, children }) }) })
    ] });
  }
  return /* @__PURE__ */ jsxRuntime.jsx(ScrollShadow, { className: classNames(className), children: /* @__PURE__ */ jsxRuntime.jsx("div", { style: { minWidth: min }, children }) });
}
function FilterSheet({
  label = "Filters",
  activeCount = 0,
  children,
  className
}) {
  const [open, setOpen] = React3.useState(false);
  React3.useEffect(() => {
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
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className, children: [
    /* @__PURE__ */ jsxRuntime.jsxs(
      "button",
      {
        type: "button",
        onClick: () => setOpen(true),
        "aria-expanded": open,
        "aria-haspopup": "dialog",
        className: classNames(
          "inline-flex min-h-9 items-center gap-1.5 rounded border px-2.5 py-1",
          "mg-type-label uppercase transition-colors",
          activeCount > 0 ? "border-accent/40 bg-accent/10 text-accent" : "border-border bg-card text-ink-strong hover:border-accent/40"
        ),
        children: [
          /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Filter, { className: "size-3.5", "aria-hidden": true }),
          label,
          activeCount > 0 ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "ml-0.5 inline-flex size-4 items-center justify-center rounded-full bg-accent text-[9px] text-accent-foreground", children: activeCount }) : null
        ]
      }
    ),
    open ? /* @__PURE__ */ jsxRuntime.jsxs(
      "div",
      {
        role: "dialog",
        "aria-modal": "true",
        "aria-label": label,
        className: "fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center",
        children: [
          /* @__PURE__ */ jsxRuntime.jsx(
            "div",
            {
              className: "absolute inset-0 bg-ink-strong/30 backdrop-blur-sm",
              onClick: () => setOpen(false),
              "aria-hidden": true
            }
          ),
          /* @__PURE__ */ jsxRuntime.jsxs(
            "div",
            {
              className: classNames(
                "relative z-10 w-full max-h-[85vh] overflow-y-auto",
                "rounded-t-xl border-t border-border bg-card p-4",
                "sm:max-w-md sm:rounded-xl sm:border sm:mx-4",
                "mg-scroll"
              ),
              children: [
                /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mb-4 flex items-center justify-between border-b border-border pb-3", children: [
                  /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-type-label uppercase text-ink-strong", children: [
                    label,
                    activeCount > 0 ? /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "ml-2 text-ink-muted", children: [
                      "\xB7 ",
                      activeCount,
                      " active"
                    ] }) : null
                  ] }),
                  /* @__PURE__ */ jsxRuntime.jsx(
                    "button",
                    {
                      type: "button",
                      onClick: () => setOpen(false),
                      "aria-label": "Close filters",
                      className: "inline-flex size-8 items-center justify-center rounded text-ink-muted hover:text-ink-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                      children: /* @__PURE__ */ jsxRuntime.jsx(lucideReact.X, { className: "size-4", "aria-hidden": true })
                    }
                  )
                ] }),
                /* @__PURE__ */ jsxRuntime.jsx("div", { className: "flex flex-col gap-3", children })
              ]
            }
          )
        ]
      }
    ) : null
  ] });
}
var INLINE_FROM = {
  sm: "sm:flex",
  md: "md:flex",
  lg: "lg:flex"
};
var HIDE_UNTIL = {
  sm: "hidden sm:flex",
  md: "hidden md:flex",
  lg: "hidden lg:flex"
};
var SHOW_UNTIL = {
  sm: "sm:hidden",
  md: "md:hidden",
  lg: "lg:hidden"
};
function PageActions({
  primary,
  secondary,
  inlineFrom = "md",
  className
}) {
  const [open, setOpen] = React3.useState(false);
  const ref = React3.useRef(null);
  React3.useEffect(() => {
    if (!open) return;
    const onClick = (e) => {
      if (ref.current && !ref.current.contains(e.target))
        setOpen(false);
    };
    const onKey = (e) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: classNames("flex items-center gap-2", className), children: [
    primary,
    secondary ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      /* @__PURE__ */ jsxRuntime.jsx(
        "div",
        {
          className: classNames(
            HIDE_UNTIL[inlineFrom],
            INLINE_FROM[inlineFrom],
            "items-center gap-2"
          ),
          children: secondary
        }
      ),
      /* @__PURE__ */ jsxRuntime.jsxs(
        "div",
        {
          className: classNames("relative", SHOW_UNTIL[inlineFrom]),
          ref,
          children: [
            /* @__PURE__ */ jsxRuntime.jsx(
              "button",
              {
                type: "button",
                onClick: () => setOpen((v) => !v),
                "aria-label": "More actions",
                "aria-expanded": open,
                "aria-haspopup": "menu",
                className: "inline-flex size-9 items-center justify-center rounded border border-border bg-card text-ink-strong hover:border-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                children: /* @__PURE__ */ jsxRuntime.jsx(lucideReact.MoreHorizontal, { className: "size-4", "aria-hidden": true })
              }
            ),
            open ? /* @__PURE__ */ jsxRuntime.jsx(
              "div",
              {
                role: "menu",
                className: "absolute right-0 top-full z-30 mt-2 min-w-[180px] rounded border border-border bg-card p-2 shadow-lg",
                children: /* @__PURE__ */ jsxRuntime.jsx("div", { className: "flex flex-col items-stretch gap-1 [&>*]:w-full [&>*]:justify-start", children: secondary })
              }
            ) : null
          ]
        }
      )
    ] }) : null
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
  return /* @__PURE__ */ jsxRuntime.jsx(
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
      children: /* @__PURE__ */ jsxRuntime.jsx("span", { className: "sr-only", children: label })
    }
  );
}
function MobileCollapse({
  label,
  hint,
  trailing,
  defaultOpen = false,
  children,
  className
}) {
  const [open, setOpen] = React3.useState(defaultOpen);
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className, children: [
    /* @__PURE__ */ jsxRuntime.jsxs(
      "button",
      {
        type: "button",
        onClick: () => setOpen((v) => !v),
        "aria-expanded": open,
        className: classNames(
          "md:hidden w-full flex items-center justify-between gap-3",
          "rounded border border-border bg-card px-3 py-2 mg-focus-ring",
          "text-left transition-colors hover:border-accent/40"
        ),
        children: [
          /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "flex min-w-0 flex-1 flex-col", children: [
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-type-micro text-ink-strong", children: label }),
            hint ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mt-0.5 truncate font-mono text-[11px] text-ink-muted", children: hint }) : null
          ] }),
          /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "flex shrink-0 items-center gap-2", children: [
            trailing,
            /* @__PURE__ */ jsxRuntime.jsx(
              lucideReact.ChevronDown,
              {
                "aria-hidden": true,
                className: classNames(
                  "size-4 text-ink-muted transition-transform",
                  open ? "rotate-180" : "rotate-0"
                )
              }
            )
          ] })
        ]
      }
    ),
    /* @__PURE__ */ jsxRuntime.jsx(
      "div",
      {
        className: classNames(
          open ? "mt-3 block" : "hidden",
          "md:mt-0 md:block"
        ),
        children
      }
    )
  ] });
}
var tierLabels = {
  buildable: "Buildable",
  emerging: "Emerging",
  "identity-only": "Identity only",
  dormant: "Dormant"
};
function ReadinessGauge({
  score,
  tier,
  details,
  compact = false,
  className
}) {
  if (score == null && !tier) {
    return /* @__PURE__ */ jsxRuntime.jsx("span", { className: "font-mono text-[11px] text-ink-muted", children: "\u2014" });
  }
  const value = Math.max(0, Math.min(100, score ?? 0));
  const label = tierLabels[tier ?? ""] ?? tier ?? "Not classified";
  const fill = value >= 75 ? "bg-health-ok" : value >= 45 ? "bg-health-warn" : value > 0 ? "bg-health-down" : "bg-health-unknown";
  const detail = details?.length ? ` Services: ${details.join(", ")}.` : "";
  const description = `Integration readiness ${value} out of 100. ${label}.${detail}`;
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "span",
    {
      tabIndex: 0,
      "aria-label": description,
      title: description,
      className: classNames(
        "mg-focus-ring inline-grid items-center gap-2",
        compact ? "min-w-[78px] grid-cols-[minmax(0,1fr)_1.75rem]" : "min-w-[96px] grid-cols-[minmax(0,1fr)_2rem]",
        className
      ),
      children: [
        /* @__PURE__ */ jsxRuntime.jsx(
          "span",
          {
            className: "relative h-1.5 overflow-hidden rounded-full bg-surface-2",
            "aria-hidden": true,
            children: /* @__PURE__ */ jsxRuntime.jsx(
              "span",
              {
                className: classNames("absolute inset-y-0 left-0 rounded-full", fill),
                style: { width: `${value}%` }
              }
            )
          }
        ),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "text-right font-mono text-[11px] tabular-nums text-ink-strong", children: value })
      ]
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
  return /* @__PURE__ */ jsxRuntime.jsx(
    "span",
    {
      tabIndex: 0,
      title: item.description,
      "aria-label": `${item.label}: ${item.description}`,
      className: classNames(
        "mg-focus-ring inline-flex items-center rounded border bg-transparent px-1.5 py-0.5 mg-type-micro",
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
  return /* @__PURE__ */ jsxRuntime.jsx(
    "div",
    {
      role: "search",
      "aria-label": ariaLabel,
      className: classNames(
        "mg-query-shell",
        "flex w-full items-center gap-1 min-w-0",
        "h-10 rounded-lg border border-border bg-card/60",
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
  const ref = React3.useRef(null);
  const [local, setLocal] = React3.useState(value);
  React3.useEffect(() => {
    setLocal(value);
  }, [value]);
  React3.useEffect(() => {
    if (local === value) return;
    if (debounceMs <= 0) {
      onChange(local);
      return;
    }
    const t = window.setTimeout(() => onChange(local), debounceMs);
    return () => window.clearTimeout(t);
  }, [local, debounceMs]);
  React3.useEffect(() => {
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
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "relative flex flex-1 items-center gap-2 min-w-0 pl-2", children: [
    /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Search, { className: "size-3.5 shrink-0 text-ink-muted", "aria-hidden": true }),
    /* @__PURE__ */ jsxRuntime.jsx(
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
          "py-1.5 text-[13px] text-ink-strong placeholder:text-ink-subtle-text",
          "focus:outline-none focus:ring-0",
          className
        )
      }
    ),
    local ? /* @__PURE__ */ jsxRuntime.jsx(
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
        children: /* @__PURE__ */ jsxRuntime.jsx(lucideReact.X, { className: "size-3.5", "aria-hidden": true })
      }
    ) : shortcut ? /* @__PURE__ */ jsxRuntime.jsx(
      "kbd",
      {
        "aria-hidden": true,
        className: "pointer-events-none hidden sm:inline-flex items-center rounded border border-border/70 bg-paper px-1.5 py-0.5 font-mono text-[10px] text-ink-muted",
        children: "/"
      }
    ) : null
  ] });
}
function QueryBarDivider() {
  return /* @__PURE__ */ jsxRuntime.jsx(
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
  return /* @__PURE__ */ jsxRuntime.jsx(
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
  const id = React3.useId();
  const [open, setOpen] = React3.useState(false);
  const selected = props.multi ? props.value : props.value ? [props.value] : [];
  const active = selected.length > 0;
  const preview = React3.useMemo(() => {
    if (!active) return placeholder;
    const labels = selected.map(
      (v) => options.find((o) => o.value === v)?.label ?? v
    );
    if (labels.length === 1) return labels[0];
    return `${labels[0]} +${labels.length - 1}`;
  }, [selected, options, active, placeholder]);
  const toggle = React3.useCallback(
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
  const clear = React3.useCallback(() => {
    if (props.multi) props.onChange([]);
    else props.onChange("");
  }, [props]);
  return /* @__PURE__ */ jsxRuntime.jsxs(Popover, { open, onOpenChange: setOpen, children: [
    /* @__PURE__ */ jsxRuntime.jsx(PopoverTrigger, { asChild: true, children: /* @__PURE__ */ jsxRuntime.jsxs(
      "button",
      {
        id,
        type: "button",
        "aria-label": `${label} filter${active ? `, ${selected.length} selected` : ""}`,
        className: classNames(
          "mg-ghost-trigger group inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md px-2",
          "text-[12px] transition-colors",
          "hover:bg-surface-2",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          active ? "text-ink-strong" : "text-ink-muted",
          className
        ),
        children: [
          icon ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "shrink-0 text-ink-muted", children: icon }) : null,
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-type-micro opacity-80", children: label }),
          /* @__PURE__ */ jsxRuntime.jsx(
            "span",
            {
              className: classNames(
                "truncate max-w-[120px] font-medium",
                active ? "text-ink-strong border-b border-accent" : "text-ink-subtle-text"
              ),
              children: preview
            }
          ),
          /* @__PURE__ */ jsxRuntime.jsx(
            lucideReact.ChevronDown,
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
    /* @__PURE__ */ jsxRuntime.jsx(
      PopoverContent,
      {
        align,
        sideOffset: 6,
        className: "w-64 p-0 border-border bg-popover",
        children: /* @__PURE__ */ jsxRuntime.jsxs(Command, { children: [
          /* @__PURE__ */ jsxRuntime.jsx(
            CommandInput,
            {
              placeholder: `Filter ${label.toLowerCase()}\u2026`,
              className: "h-9"
            }
          ),
          /* @__PURE__ */ jsxRuntime.jsxs(CommandList, { className: "max-h-72", children: [
            /* @__PURE__ */ jsxRuntime.jsx(CommandEmpty, { children: "No matches." }),
            /* @__PURE__ */ jsxRuntime.jsx(CommandGroup, { children: options.map((o) => {
              const on = selected.includes(o.value);
              return /* @__PURE__ */ jsxRuntime.jsxs(
                CommandItem,
                {
                  value: o.label,
                  ...o.keywords ? { keywords: o.keywords } : {},
                  onSelect: () => toggle(o.value),
                  className: "cursor-pointer aria-selected:bg-surface-2",
                  children: [
                    /* @__PURE__ */ jsxRuntime.jsx(
                      "span",
                      {
                        className: classNames(
                          "inline-flex size-4 shrink-0 items-center justify-center rounded border",
                          on ? "border-accent bg-accent text-accent-foreground" : "border-border bg-transparent"
                        ),
                        "aria-hidden": true,
                        children: on ? /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Check, { className: "size-3" }) : null
                      }
                    ),
                    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "truncate", children: o.label })
                  ]
                },
                o.value
              );
            }) })
          ] }),
          active ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-center justify-between border-t border-border px-2 py-1.5", children: [
            /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-type-micro text-ink-muted", children: [
              selected.length,
              " selected"
            ] }),
            /* @__PURE__ */ jsxRuntime.jsx(
              "button",
              {
                type: "button",
                onClick: () => {
                  clear();
                  if (!props.multi) setOpen(false);
                },
                className: "mg-focus-ring rounded px-2 py-0.5 mg-type-micro text-ink-muted hover:text-ink-strong",
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      className: classNames(
        "flex w-full items-center gap-2 pt-1.5",
        "mg-type-micro text-ink-muted",
        className
      ),
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs("span", { "aria-live": "polite", children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "text-ink-strong", children: count.toLocaleString() }),
          showTotal ? /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "opacity-70", children: [
            " of ",
            total.toLocaleString()
          ] }) : null,
          " ",
          noun
        ] }),
        activeCount > 0 ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { "aria-hidden": true, className: "opacity-40", children: "\xB7" }),
          /* @__PURE__ */ jsxRuntime.jsxs("span", { children: [
            activeCount,
            " filter",
            activeCount === 1 ? "" : "s"
          ] }),
          onReset ? /* @__PURE__ */ jsxRuntime.jsx(
            "button",
            {
              type: "button",
              onClick: onReset,
              className: "mg-focus-ring rounded text-accent hover:text-ink-strong transition-colors",
              children: "Reset"
            }
          ) : null
        ] }) : null,
        trailing ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "ml-auto flex items-center gap-2", children: trailing }) : null
      ]
    }
  );
}
var _ctx = React3.createContext(null);
function useQueryBarContext() {
  return React3.useContext(_ctx);
}
var QueryBar = Object.assign(QueryBarRoot, {
  Search: QueryBarSearch,
  Divider: QueryBarDivider,
  Utility: QueryBarUtility,
  FilterTrigger: QueryBarFilterTrigger,
  MetaRow: QueryBarMetaRow
});
function ChartSkeleton({
  height = 40,
  variant = "spark",
  className,
  label = "Loading chart"
}) {
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      role: "img",
      "aria-label": label,
      className: classNames(
        "mg-chart-skeleton relative w-full overflow-hidden rounded-md",
        "border border-border/60 bg-surface-2/40",
        className
      ),
      style: { height },
      children: [
        /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            className: "pointer-events-none absolute inset-x-2 bottom-1 h-px bg-border",
            "aria-hidden": true
          }
        ),
        variant === "bars" ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "absolute inset-2 flex items-end gap-[3px]", "aria-hidden": true, children: Array.from({ length: 16 }).map((_, i) => /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            className: "flex-1 rounded-sm bg-ink-strong/10 animate-pulse",
            style: { height: `${20 + i * 17 % 70}%` }
          },
          i
        )) }) : null,
        variant === "area" ? /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            className: "absolute inset-0 animate-pulse",
            "aria-hidden": true,
            style: {
              background: "linear-gradient(to top, color-mix(in oklab, var(--accent) 12%, transparent), transparent 70%)"
            }
          }
        ) : null,
        /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            className: "pointer-events-none absolute inset-y-0 -left-full w-1/2 mg-shimmer-sweep",
            "aria-hidden": true
          }
        )
      ]
    }
  );
}
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
  const [copied, setCopied] = React3.useState(false);
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      role: "alert",
      className: classNames(
        "mg-panel-error flex flex-col items-center justify-center gap-3 rounded-xl",
        "border border-border/70 bg-card p-6 text-center",
        HEIGHTS[height],
        className
      ),
      children: [
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "grid size-9 place-items-center rounded-full bg-surface-2 text-health-warn", children: /* @__PURE__ */ jsxRuntime.jsx(lucideReact.AlertTriangle, { className: "size-4", "aria-hidden": true }) }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "max-w-sm space-y-1", children: [
          /* @__PURE__ */ jsxRuntime.jsx("div", { className: "font-display text-[13px] font-semibold text-ink-strong", children: title }),
          /* @__PURE__ */ jsxRuntime.jsx("p", { className: "text-[12px] leading-relaxed text-ink-muted", children: message })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex flex-wrap items-center justify-center gap-2 pt-1", children: [
          onRetry ? /* @__PURE__ */ jsxRuntime.jsx(
            GhostButton,
            {
              size: "sm",
              onClick: onRetry,
              icon: /* @__PURE__ */ jsxRuntime.jsx(lucideReact.RefreshCw, { className: "size-3" }),
              children: "Retry"
            }
          ) : null,
          errorId ? /* @__PURE__ */ jsxRuntime.jsxs(
            "button",
            {
              type: "button",
              onClick: () => {
                void navigator.clipboard.writeText(errorId).then(() => {
                  setCopied(true);
                  window.setTimeout(() => setCopied(false), 1400);
                });
              },
              className: "mg-focus-ring inline-flex items-center gap-1.5 rounded border border-border bg-paper px-2 py-1 mg-type-micro text-ink-muted hover:text-ink-strong",
              "aria-label": `Copy error id ${errorId}`,
              children: [
                copied ? /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Check, { className: "size-3", "aria-hidden": true }) : /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Copy, { className: "size-3", "aria-hidden": true }),
                /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "tracking-normal normal-case", children: [
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
  return /* @__PURE__ */ jsxRuntime.jsx(
    "div",
    {
      role: "progressbar",
      "aria-label": ariaLabel,
      "aria-hidden": !active,
      className: classNames(
        "mg-query-progress pointer-events-none overflow-hidden",
        position === "absolute" && "absolute inset-x-0 top-0 z-10",
        position === "fixed" && "fixed inset-x-0 top-0 z-50",
        position === "sticky" && "sticky top-0 z-10 -mt-px",
        "h-[2px]",
        active ? "opacity-100" : "opacity-0 transition-opacity duration-300",
        className
      ),
      children: /* @__PURE__ */ jsxRuntime.jsx(
        "div",
        {
          className: classNames(
            "h-full w-1/3 rounded-full",
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      role: "list",
      "aria-label": "Active filters",
      className: classNames(
        "flex flex-wrap items-center gap-1.5 pt-2",
        className
      ),
      children: [
        items.map((item) => /* @__PURE__ */ jsxRuntime.jsxs(
          "button",
          {
            role: "listitem",
            type: "button",
            onClick: () => onRemove(item.id),
            "aria-label": `Remove ${item.label} filter (${item.value})`,
            className: classNames(
              "group inline-flex h-6 items-center gap-1.5 rounded-full border border-border bg-card px-2",
              "text-[11px] transition-colors",
              "hover:border-[color-mix(in_oklab,var(--accent)_45%,var(--border))]",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
            ),
            children: [
              item.icon ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "text-ink-muted", children: item.icon }) : null,
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-type-micro text-ink-muted", children: item.label }),
              /* @__PURE__ */ jsxRuntime.jsx("span", { className: "font-medium text-ink-strong", children: item.value }),
              /* @__PURE__ */ jsxRuntime.jsx(
                lucideReact.X,
                {
                  "aria-hidden": true,
                  className: "size-3 text-ink-muted transition-colors group-hover:text-health-down"
                }
              )
            ]
          },
          item.id
        )),
        onClearAll && items.length > 1 ? /* @__PURE__ */ jsxRuntime.jsx(
          "button",
          {
            type: "button",
            onClick: onClearAll,
            className: "mg-focus-ring ml-1 rounded px-1.5 py-0.5 mg-type-micro text-ink-muted hover:text-ink-strong",
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      "aria-busy": "true",
      "aria-live": "polite",
      className: classNames(
        "mg-route-pending mx-auto w-full max-w-shell px-4 py-6 md:px-6",
        className
      ),
      children: [
        header ?? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mb-6 space-y-3", children: [
          /* @__PURE__ */ jsxRuntime.jsx(
            "div",
            {
              className: "h-3 w-32 animate-pulse rounded bg-surface-2",
              "aria-hidden": true
            }
          ),
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-baseline gap-3", children: [
            /* @__PURE__ */ jsxRuntime.jsx(
              "div",
              {
                className: "h-7 w-64 animate-pulse rounded bg-surface-2",
                "aria-hidden": true
              }
            ),
            title ? /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "sr-only", children: [
              "Loading ",
              title
            ] }) : /* @__PURE__ */ jsxRuntime.jsx("span", { className: "sr-only", children: "Loading page" })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsx(
            "div",
            {
              className: "h-3 w-96 max-w-full animate-pulse rounded bg-surface-2/70",
              "aria-hidden": true
            }
          )
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "space-y-4", children: Array.from({ length: panels }).map((_, i) => /* @__PURE__ */ jsxRuntime.jsx(PanelSkeleton, { height: panelHeight }, i)) })
      ]
    }
  );
}

exports.AccentBand = AccentBand;
exports.Accordion = Accordion;
exports.AccordionContent = AccordionContent;
exports.AccordionItem = AccordionItem;
exports.AccordionTrigger = AccordionTrigger;
exports.ActionBar = ActionBar;
exports.AnimatedNumber = AnimatedNumber;
exports.BackToTop = BackToTop;
exports.BarMini = BarMini;
exports.BrandIcon = BrandIcon;
exports.CandidateChip = CandidateChip;
exports.CandlestickMini = CandlestickMini;
exports.ChartSkeleton = ChartSkeleton;
exports.Chip = Chip;
exports.ColumnCustomizer = ColumnCustomizer;
exports.Command = Command;
exports.CommandDialog = CommandDialog;
exports.CommandEmpty = CommandEmpty;
exports.CommandGroup = CommandGroup;
exports.CommandInput = CommandInput;
exports.CommandItem = CommandItem;
exports.CommandList = CommandList;
exports.CommandSeparator = CommandSeparator;
exports.CommandShortcut = CommandShortcut;
exports.CopyButton = CopyButton;
exports.CopyIconToggle = CopyIconToggle;
exports.CopyableCode = CopyableCode;
exports.CurationChip = CurationChip;
exports.DailyRollupFreshness = DailyRollupFreshness;
exports.DefinitionList = DefinitionList;
exports.DensityToggle = DensityToggle;
exports.Dialog = Dialog;
exports.DialogClose = DialogClose;
exports.DialogContent = DialogContent;
exports.DialogDescription = DialogDescription;
exports.DialogFooter = DialogFooter;
exports.DialogHeader = DialogHeader;
exports.DialogOverlay = DialogOverlay;
exports.DialogPortal = DialogPortal;
exports.DialogTitle = DialogTitle;
exports.DialogTrigger = DialogTrigger;
exports.DiscordIcon = DiscordIcon;
exports.Divider = Divider;
exports.Donut = Donut;
exports.DonutLegend = DonutLegend;
exports.DotRow = DotRow;
exports.DownloadCsvButton = DownloadCsvButton;
exports.EligibilityChip = EligibilityChip;
exports.EmptyState = EmptyState;
exports.EntityHero = EntityHero;
exports.ExternalLink = ExternalLink;
exports.FilterChipRow = FilterChipRow;
exports.FilterField = FilterField;
exports.FilterInput = FilterInput;
exports.FilterSelect = FilterSelect;
exports.FilterSheet = FilterSheet;
exports.FilterToolbar = FilterToolbar;
exports.FreshnessIndicator = FreshnessIndicator;
exports.GhostButton = GhostButton;
exports.HealthDot = HealthDot;
exports.HealthPill = HealthPill;
exports.HoverCard = HoverCard;
exports.HoverCardContent = HoverCardContent;
exports.HoverCardTrigger = HoverCardTrigger;
exports.HoverPreview = HoverPreview;
exports.Indicator = Indicator;
exports.InfoTooltip = InfoTooltip;
exports.Kbd = Kbd;
exports.KeyChip = KeyChip;
exports.ListShell = ListShell;
exports.LoadMore = LoadMore;
exports.LoadingPill = LoadingPill;
exports.McpToolsList = McpToolsList;
exports.MetaStrip = MetaStrip;
exports.MethodologyCallout = MethodologyCallout;
exports.MetricGrid = MetricGrid;
exports.MiniRadial = MiniRadial;
exports.MiniStack = MiniStack;
exports.MobileCollapse = MobileCollapse;
exports.NoDataSpark = NoDataSpark;
exports.PageActions = PageActions;
exports.PageHero = PageHero;
exports.PageSection = PageSection;
exports.PagerBar = PagerBar;
exports.PagerFooter = PagerFooter;
exports.Panel = Panel;
exports.PanelError = PanelError;
exports.PanelHeader = PanelHeader;
exports.PanelSkeleton = PanelSkeleton;
exports.Popover = Popover;
exports.PopoverAnchor = PopoverAnchor;
exports.PopoverContent = PopoverContent;
exports.PopoverTrigger = PopoverTrigger;
exports.PrimaryLinksRail = PrimaryLinksRail;
exports.ProvenanceChip = ProvenanceChip;
exports.QueryBar = QueryBar;
exports.QueryProgress = QueryProgress;
exports.ReadinessGauge = ReadinessGauge;
exports.RealtimeFreshness = RealtimeFreshness;
exports.ResponsiveTable = ResponsiveTable;
exports.ReviewChip = ReviewChip;
exports.RoutePending = RoutePending;
exports.SCOPES = SCOPES;
exports.ScrollReveal = ScrollReveal;
exports.ScrollShadow = ScrollShadow;
exports.SectionAnchor = SectionAnchor;
exports.SectionHeading = SectionHeading;
exports.SectionLabel = SectionLabel;
exports.SegmentedToggle = SegmentedToggle;
exports.ShareButton = ShareButton;
exports.Sheet = Sheet;
exports.SheetClose = SheetClose;
exports.SheetContent = SheetContent;
exports.SheetDescription = SheetDescription;
exports.SheetFooter = SheetFooter;
exports.SheetHeader = SheetHeader;
exports.SheetOverlay = SheetOverlay;
exports.SheetPortal = SheetPortal;
exports.SheetTitle = SheetTitle;
exports.SheetTrigger = SheetTrigger;
exports.Skeleton = Skeleton;
exports.SparkLegend = SparkLegend;
exports.Sparkline = Sparkline;
exports.StatTile = StatTile;
exports.StatWithSpark = StatWithSpark;
exports.StatusBadge = StatusBadge;
exports.StickyToolbar = StickyToolbar;
exports.TabStrip = TabStrip;
exports.TableSkeleton = TableSkeleton;
exports.TableState = TableState;
exports.TimeAgo = TimeAgo;
exports.Toaster = Toaster;
exports.Tooltip = Tooltip;
exports.TooltipContent = TooltipContent;
exports.TooltipProvider = TooltipProvider;
exports.TooltipTrigger = TooltipTrigger;
exports.TreemapMini = TreemapMini;
exports.ViewModeToggle = ViewModeToggle;
exports.Wordmark = Wordmark;
exports.YieldPercentileStrip = YieldPercentileStrip;
exports.buildCsvDownloadUrl = buildCsvDownloadUrl;
exports.defaultVisible = defaultVisible;
exports.fmtYield = fmtYield;
exports.isScrolledPast = isScrolledPast;
exports.isTablistNavKey = isTablistNavKey;
exports.nextTabIndex = nextTabIndex;
exports.prefetchBrandIcon = prefetchBrandIcon;
exports.rovingTabIndex = rovingTabIndex;
exports.safeExternalUrl = safeExternalUrl;
exports.tierFreshnessLabel = tierFreshnessLabel;
exports.useColumnVisibility = useColumnVisibility;
exports.useQueryBarContext = useQueryBarContext;
exports.useRovingTablist = useRovingTablist;
exports.useScrolled = useScrolled;
