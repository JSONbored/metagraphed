'use strict';

var clsx = require('clsx');
var tailwindMerge = require('tailwind-merge');
var React2 = require('react');
var cmdk = require('cmdk');
var lucideReact = require('lucide-react');
var SheetPrimitive = require('@radix-ui/react-dialog');
var jsxRuntime = require('react/jsx-runtime');
var PopoverPrimitive = require('@radix-ui/react-popover');
var classVarianceAuthority = require('class-variance-authority');
var sonner = require('sonner');

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

var clsx__default = /*#__PURE__*/_interopDefault(clsx);
var React2__namespace = /*#__PURE__*/_interopNamespace(React2);
var SheetPrimitive__namespace = /*#__PURE__*/_interopNamespace(SheetPrimitive);
var PopoverPrimitive__namespace = /*#__PURE__*/_interopNamespace(PopoverPrimitive);

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
function cn(...inputs) {
  return tailwindMerge.twMerge(clsx__default.default(...inputs));
}
var Dialog = SheetPrimitive__namespace.Root;
var DialogPortal = SheetPrimitive__namespace.Portal;
var DialogOverlay = React2__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  SheetPrimitive__namespace.Overlay,
  {
    ref,
    className: cn(
      "fixed inset-0 z-[var(--mg-z-modal)] bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    ),
    ...props
  }
));
DialogOverlay.displayName = SheetPrimitive__namespace.Overlay.displayName;
var DialogContent = React2__namespace.forwardRef(({ className, children, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsxs(DialogPortal, { children: [
  /* @__PURE__ */ jsxRuntime.jsx(DialogOverlay, {}),
  /* @__PURE__ */ jsxRuntime.jsxs(
    SheetPrimitive__namespace.Content,
    {
      ref,
      className: cn(
        "fixed left-[50%] top-[50%] z-[var(--mg-z-modal)] grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95 sm:rounded",
        className
      ),
      ...props,
      children: [
        children,
        /* @__PURE__ */ jsxRuntime.jsxs(SheetPrimitive__namespace.Close, { className: "absolute right-4 top-4 rounded opacity-70 ring-offset-background cursor-pointer transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-accent data-[state=open]:text-muted-foreground", children: [
          /* @__PURE__ */ jsxRuntime.jsx(lucideReact.X, { className: "h-4 w-4" }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "sr-only", children: "Close" })
        ] })
      ]
    }
  )
] }));
DialogContent.displayName = SheetPrimitive__namespace.Content.displayName;
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
var DialogTitle = React2__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  SheetPrimitive__namespace.Title,
  {
    ref,
    className: cn("text-16 font-semibold leading-none", className),
    ...props
  }
));
DialogTitle.displayName = SheetPrimitive__namespace.Title.displayName;
var DialogDescription = React2__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  SheetPrimitive__namespace.Description,
  {
    ref,
    className: cn("text-13 text-muted-foreground", className),
    ...props
  }
));
DialogDescription.displayName = SheetPrimitive__namespace.Description.displayName;
var Command = React2__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  cmdk.Command,
  {
    ref,
    className: cn(
      "flex h-full w-full flex-col overflow-hidden rounded bg-popover text-popover-foreground",
      className
    ),
    ...props
  }
));
Command.displayName = cmdk.Command.displayName;
var CommandDialog = ({ children, ...props }) => {
  return /* @__PURE__ */ jsxRuntime.jsx(Dialog, { ...props, children: /* @__PURE__ */ jsxRuntime.jsx(DialogContent, { className: "overflow-hidden p-0 max-w-[calc(100vw-2rem)] sm:max-w-lg", children: /* @__PURE__ */ jsxRuntime.jsx(Command, { className: "[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground [&_[cmdk-group]:not([hidden])_~[cmdk-group]]:pt-0 [&_[cmdk-group]]:px-2 [&_[cmdk-input-wrapper]_svg]:h-5 [&_[cmdk-input-wrapper]_svg]:w-5 [&_[cmdk-input]]:h-12 [&_[cmdk-item]]:px-2 [&_[cmdk-item]]:py-3 [&_[cmdk-item]_svg]:h-5 [&_[cmdk-item]_svg]:w-5", children }) }) });
};
var CommandInput = React2__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-center border-b px-3", "cmdk-input-wrapper": "", children: [
  /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Search, { className: "mr-2 h-4 w-4 shrink-0 opacity-50" }),
  /* @__PURE__ */ jsxRuntime.jsx(
    cmdk.Command.Input,
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
CommandInput.displayName = cmdk.Command.Input.displayName;
var CommandList = React2__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  cmdk.Command.List,
  {
    ref,
    className: cn("max-h-[300px] overflow-y-auto overflow-x-hidden", className),
    ...props
  }
));
CommandList.displayName = cmdk.Command.List.displayName;
var CommandEmpty = React2__namespace.forwardRef((props, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  cmdk.Command.Empty,
  {
    ref,
    className: "py-6 text-center text-13",
    ...props
  }
));
CommandEmpty.displayName = cmdk.Command.Empty.displayName;
var CommandGroup = React2__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  cmdk.Command.Group,
  {
    ref,
    className: cn(
      "overflow-hidden p-1 text-foreground [&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-13 [&_[cmdk-group-heading]]:font-medium [&_[cmdk-group-heading]]:text-muted-foreground",
      className
    ),
    ...props
  }
));
CommandGroup.displayName = cmdk.Command.Group.displayName;
var CommandSeparator = React2__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  cmdk.Command.Separator,
  {
    ref,
    className: cn("-mx-1 h-px bg-border", className),
    ...props
  }
));
CommandSeparator.displayName = cmdk.Command.Separator.displayName;
var CommandItem = React2__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  cmdk.Command.Item,
  {
    ref,
    className: cn(
      "relative flex cursor-default gap-2 select-none items-center rounded px-2 py-1.5 text-13 outline-none data-[disabled=true]:pointer-events-none data-[selected=true]:bg-accent data-[selected=true]:text-accent-foreground data-[disabled=true]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0",
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
      className: cn("ml-auto text-13 text-muted-foreground", className),
      ...props
    }
  );
};
CommandShortcut.displayName = "CommandShortcut";
var Popover = PopoverPrimitive__namespace.Root;
var PopoverTrigger = PopoverPrimitive__namespace.Trigger;
var PopoverContent = React2__namespace.forwardRef(({ className, align = "center", sideOffset = 4, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(PopoverPrimitive__namespace.Portal, { children: /* @__PURE__ */ jsxRuntime.jsx(
  PopoverPrimitive__namespace.Content,
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
PopoverContent.displayName = PopoverPrimitive__namespace.Content.displayName;
var Sheet = SheetPrimitive__namespace.Root;
var SheetTrigger = SheetPrimitive__namespace.Trigger;
var SheetPortal = SheetPrimitive__namespace.Portal;
var SheetOverlay = React2__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  SheetPrimitive__namespace.Overlay,
  {
    className: cn(
      "fixed inset-0 z-[var(--mg-z-modal)] bg-black/80 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0",
      className
    ),
    ...props,
    ref
  }
));
SheetOverlay.displayName = SheetPrimitive__namespace.Overlay.displayName;
var sheetVariants = classVarianceAuthority.cva(
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
var SheetContent = React2__namespace.forwardRef(({ side = "right", className, children, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsxs(SheetPortal, { children: [
  /* @__PURE__ */ jsxRuntime.jsx(SheetOverlay, {}),
  /* @__PURE__ */ jsxRuntime.jsxs(
    SheetPrimitive__namespace.Content,
    {
      ref,
      className: cn(sheetVariants({ side }), className),
      ...props,
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs(SheetPrimitive__namespace.Close, { className: "absolute right-4 top-4 rounded opacity-70 ring-offset-background cursor-pointer transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2 disabled:pointer-events-none data-[state=open]:bg-secondary", children: [
          /* @__PURE__ */ jsxRuntime.jsx(lucideReact.X, { className: "h-4 w-4" }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "sr-only", children: "Close" })
        ] }),
        children
      ]
    }
  )
] }));
SheetContent.displayName = SheetPrimitive__namespace.Content.displayName;
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
var SheetTitle = React2__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  SheetPrimitive__namespace.Title,
  {
    ref,
    className: cn("text-16 font-semibold text-foreground", className),
    ...props
  }
));
SheetTitle.displayName = SheetPrimitive__namespace.Title.displayName;
var SheetDescription = React2__namespace.forwardRef(({ className, ...props }, ref) => /* @__PURE__ */ jsxRuntime.jsx(
  SheetPrimitive__namespace.Description,
  {
    ref,
    className: cn("text-13 text-muted-foreground", className),
    ...props
  }
));
SheetDescription.displayName = SheetPrimitive__namespace.Description.displayName;
var Toaster = ({ ...props }) => {
  return /* @__PURE__ */ jsxRuntime.jsx(
    sonner.Toaster,
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
  return /* @__PURE__ */ jsxRuntime.jsx("div", { className: `animate-pulse rounded bg-surface-2 ${className}` });
}
var BOTTOM_HIDE_GAP = 96;
function BackToTop({ threshold = 600 }) {
  const [visible, setVisible] = React2.useState(false);
  React2.useEffect(() => {
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
        "fixed z-[var(--mg-z-overlay)] bottom-5 right-5 md:bottom-7 md:right-7",
        "inline-flex items-center gap-1.5 rounded border border-border",
        "px-3 py-2 text-11 text-ink-strong",
        "hover:border-accent/60 hover:text-accent",
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
  const [choice, setChoiceState] = React2.useState("system");
  const [resolved, setResolved] = React2.useState("light");
  const [mounted2, setMounted] = React2.useState(false);
  React2.useEffect(() => {
    const initial = readChoice();
    setChoiceState(initial);
    setResolved(apply(initial));
    setMounted(true);
  }, []);
  React2.useEffect(() => {
    if (!mounted2) return;
    setResolved(apply(choice));
    if (choice !== "system" || typeof window === "undefined") return;
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const onChange = () => setResolved(apply("system"));
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [choice, mounted2]);
  const setChoice = React2.useCallback((next) => {
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
var FIRST_PARTY_LOGO_HOSTS = /* @__PURE__ */ new Set(["metagraph.sh", "www.metagraph.sh"]);
var DISPLAY_LOGO_MAX_CSS_SIZE = 48;
var FIRST_PARTY_LOGO_PATH = /^\/logos\/(?:(cache)\/)?([a-z0-9][a-z0-9._-]*)\.(?:gif|ico|jpe?g|png|svg|webp)$/iu;
var FIRST_PARTY_DISPLAY_PATH = /^\/logos\/display\/(?:(?:cache)\/)?[a-z0-9][a-z0-9._-]*\.webp$/iu;
var DISPLAY_LOGO_ENTITY_KEY = /^[a-z0-9](?:[a-z0-9._-]*[a-z0-9])?$/iu;
function firstPartyDisplayLogoUrl(input, size) {
  if (size > DISPLAY_LOGO_MAX_CSS_SIZE) return null;
  const safe = safeImageUrl(input);
  if (!safe) return null;
  const parsed = new URL(safe);
  if (!FIRST_PARTY_LOGO_HOSTS.has(normaliseImageHostname(parsed.hostname)) || parsed.port) {
    return null;
  }
  const match = FIRST_PARTY_LOGO_PATH.exec(parsed.pathname);
  if (!match || match[2].includes("..") || match[2].endsWith("."))
    return null;
  const cache = match[1] ? "cache/" : "";
  return `/logos/display/${cache}${match[2]}.webp`;
}
function providerDisplayLogoUrl(providerSlug, iconUrl, size) {
  if (size > DISPLAY_LOGO_MAX_CSS_SIZE || !iconUrl) return null;
  const key = String(providerSlug ?? "").trim().toLowerCase();
  if (!DISPLAY_LOGO_ENTITY_KEY.test(key) || key.includes("..")) return null;
  return `/logos/display/${key}.webp`;
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
    const safe = u && FIRST_PARTY_DISPLAY_PATH.test(u) ? u : safeImageUrl(u);
    if (!safe) return;
    if (failedUrls.has(safe)) return;
    if (!out.includes(safe)) out.push(safe);
  };
  const primary = pickIconSource(iconUrl, theme);
  push(firstPartyDisplayLogoUrl(primary, size));
  push(providerDisplayLogoUrl(lookup?.providerSlug, primary, size));
  push(primary);
  if (lookup) {
    const override = resolveBrandOverride(lookup, theme);
    push(firstPartyDisplayLogoUrl(override, size));
    push(override);
  }
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
  const host = React2.useMemo(() => extractHost(url), [url]);
  const lookup = React2.useMemo(
    () => ({ providerSlug, subnetSlug, netuid }),
    [providerSlug, subnetSlug, netuid]
  );
  const chain = React2.useMemo(
    () => buildCandidateChain({ url, iconUrl, repoUrl, lookup, theme, size }),
    [url, iconUrl, repoUrl, lookup, theme, size]
  );
  const initialIndex = React2.useMemo(() => {
    if (!host) return 0;
    const winner = winnerByHost.get(host);
    if (!winner) return 0;
    const idx = chain.indexOf(winner);
    return idx >= 0 ? idx : 0;
  }, [host, chain]);
  const [index, setIndex] = React2.useState(initialIndex);
  const [loaded, setLoaded] = React2.useState(false);
  const [needsContrastTile, setNeedsContrastTile] = React2.useState(false);
  const imageRef = React2.useRef(null);
  React2.useEffect(() => {
    setIndex(initialIndex);
    setLoaded(false);
    setNeedsContrastTile(false);
  }, [initialIndex, chain]);
  const candidate = chain[index] ?? null;
  const exhausted = !candidate;
  React2.useEffect(() => {
    if (candidate && loadedUrls.has(candidate)) setLoaded(true);
    if (candidate && isDarkLogo.has(candidate)) {
      setNeedsContrastTile(theme === "dark" && isDarkLogo.get(candidate));
    }
  }, [candidate, theme]);
  const advance = React2.useCallback(() => {
    setIndex((i) => i + 1);
    setLoaded(false);
    setNeedsContrastTile(false);
  }, []);
  const onImgError = React2.useCallback(() => {
    if (candidate) failedUrls.add(candidate);
    advance();
  }, [candidate, advance]);
  React2.useEffect(() => {
    const image = imageRef.current;
    if (!candidate || !image?.complete || image.naturalWidth > 0) return;
    failedUrls.add(candidate);
    advance();
  }, [candidate, advance]);
  const onImgLoad = React2.useCallback(
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
    return /* @__PURE__ */ jsxRuntime.jsx(
      "span",
      {
        className: classNames(baseClasses, "bg-accent/10 text-ink-strong"),
        style,
        role: decorative ? void 0 : "img",
        "aria-hidden": ariaHidden,
        "aria-label": ariaLabel,
        children: /* @__PURE__ */ jsxRuntime.jsx(
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
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "span",
    {
      className: baseClasses,
      style,
      role: decorative ? void 0 : "img",
      "aria-hidden": ariaHidden,
      "aria-label": ariaLabel,
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
                style: { fontSize: initialsSize(size) },
                children: monogramFor(name, fallback)
              }
            )
          }
        ) : null,
        /* @__PURE__ */ jsxRuntime.jsx(
          "img",
          {
            ref: imageRef,
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
  const dot = /* @__PURE__ */ jsxRuntime.jsx(
    "span",
    {
      role: "img",
      "aria-label": `Health: ${label.toLowerCase()}`,
      className: classNames(
        "relative inline-block size-2 rounded-full mg-dot shrink-0",
        color,
        className
      )
    }
  );
  if (variant === "dot") return dot;
  return /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "inline-flex items-center gap-1.5", children: [
    dot,
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "text-13 font-medium text-ink", children: label })
  ] });
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
  const [copied, setCopied] = React2.useState(false);
  const timer = React2.useRef(null);
  const copy = React2.useCallback(
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
          // `max-w-full` alongside `min-w-0`, matching KeyChip: without it an
          // `inline-flex` shrink-to-fit box grows to its unwrapped content
          // width whatever the parent is, and a long value -- an MCP install
          // command, a feed URL -- escaped the viewport at 375px while
          // truncating happily at 1280 (#11618). The truncate/wrap choice
          // below only decides HOW the text behaves once the box is bound;
          // this is what binds it.
          "group inline-flex min-w-0 max-w-full items-center gap-1.5 rounded border border-border bg-card px-2 py-1 text-left text-11 text-ink hover:border-ink/30 transition-colors",
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
          label ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "shrink-0 text-ink-muted text-11", children: label }) : null,
          /* @__PURE__ */ jsxRuntime.jsx(
            "code",
            {
              className: classNames(
                "min-w-0 text-ink-strong",
                truncate ? "truncate" : "whitespace-normal break-all"
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
      return /* @__PURE__ */ jsxRuntime.jsx("span", { className, children });
    }
    return /* @__PURE__ */ jsxRuntime.jsx(
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
  const content = /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "min-w-0 truncate", children }),
    safeHref ? /* @__PURE__ */ jsxRuntime.jsx(lucideReact.ExternalLink, { className: "size-3 shrink-0 text-ink-muted" }) : null,
    authRequired ? /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "inline-flex items-center gap-0.5 rounded border border-border bg-surface px-1 text-10 text-ink-muted", children: [
      /* @__PURE__ */ jsxRuntime.jsx(lucideReact.Lock, { className: "size-2.5" }),
      " auth"
    ] }) : null,
    !publicSafe ? /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "inline-flex items-center gap-0.5 rounded border border-health-warn/30 bg-health-warn/5 px-1 text-10 text-health-warn", children: [
      /* @__PURE__ */ jsxRuntime.jsx(lucideReact.AlertTriangle, { className: "size-2.5" }),
      " private"
    ] }) : null
  ] });
  const classes = classNames(
    "inline-flex max-w-full items-center gap-1 underline decoration-ink/30 underline-offset-2 text-ink-strong",
    safeHref ? "hover:decoration-ink" : "cursor-default decoration-transparent",
    className
  );
  if (!safeHref) {
    return /* @__PURE__ */ jsxRuntime.jsx("span", { className: classes, children: content });
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
var ActiveEntityContext = React2.createContext(
  null
);
function ActiveEntityProvider({ children }) {
  const [state, dispatch] = React2.useReducer(reduceActiveEntity, {
    active: null,
    pinned: false
  });
  const set = React2.useCallback(
    (entity) => dispatch({ type: "set", entity }),
    []
  );
  const pin = React2.useCallback(
    (entity) => dispatch({ type: "pin", entity }),
    []
  );
  const clear = React2.useCallback(
    (options) => dispatch({ type: "clear", force: options?.force }),
    []
  );
  React2.useEffect(() => {
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
  const value = React2.useMemo(
    () => ({ active: state.active, pinned: state.pinned, set, pin, clear }),
    [state.active, state.pinned, set, pin, clear]
  );
  return /* @__PURE__ */ jsxRuntime.jsx(ActiveEntityContext.Provider, { value, children });
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
  return React2.useContext(ActiveEntityContext) ?? NOOP_CONTEXT;
}
function useIsActive(key) {
  return useActiveEntity().active?.key === key;
}
var MARKS_SELECTOR = "[data-marks]";
var MARK_SELECTOR = '[data-entity][role="button"], a[data-entity][href], button[data-entity]';
function siblingsOf(el) {
  const group = el.closest(MARKS_SELECTOR);
  if (!group) return [el];
  return Array.from(group.querySelectorAll(MARK_SELECTOR)).filter(
    (m) => m.closest(MARKS_SELECTOR) === group && m.getAttribute("aria-disabled") !== "true" && !m.hasAttribute("disabled")
  );
}
function useEntityMark(key, opts = {}) {
  const ctx = useActiveEntity();
  const { source = "mark", label, data, onActivate, disabled = false } = opts;
  const elRef = React2.useRef(null);
  const [isFirst, setIsFirst] = React2.useState(false);
  const lastPointerType = React2.useRef("mouse");
  const isActive = ctx.active?.key === key;
  const isPinnedHere = isActive && ctx.pinned;
  const ref = React2.useCallback((el) => {
    elRef.current = el;
  }, []);
  React2.useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    setIsFirst(siblingsOf(el)[0] === el);
  }, [key, disabled]);
  const entity = React2.useCallback(
    () => ({ key, source, element: elRef.current, data }),
    [key, source, data]
  );
  const onPointerDown = React2.useCallback((event) => {
    lastPointerType.current = event.pointerType || "mouse";
  }, []);
  const onPointerEnter = React2.useCallback(
    (event) => {
      if (disabled || event.pointerType === "touch") return;
      ctx.set(entity());
    },
    [ctx, entity, disabled]
  );
  const onPointerLeave = React2.useCallback(
    (event) => {
      if (event.pointerType === "touch") return;
      ctx.clear();
    },
    [ctx]
  );
  const onFocus = React2.useCallback(() => {
    if (disabled) return;
    if (lastPointerType.current === "touch") return;
    ctx.set(entity());
  }, [ctx, entity, disabled]);
  const onBlur = React2.useCallback(() => {
    ctx.clear();
  }, [ctx]);
  const onClick = React2.useCallback(
    (event) => {
      const control = event.target instanceof Element ? event.target.closest(
        'a[href], button, input, select, textarea, [role="button"], [role="link"]'
      ) : null;
      if (control && control !== event.currentTarget) return;
      if (disabled) {
        event.preventDefault();
        return;
      }
      const pointerType = event.detail === 0 ? "keyboard" : lastPointerType.current;
      if (tapIntent(pointerType, isPinnedHere) === "pin") {
        event.preventDefault();
        ctx.pin(entity());
        return;
      }
      onActivate?.();
    },
    [ctx, entity, disabled, isPinnedHere, onActivate]
  );
  const onKeyDown = React2.useCallback(
    (event) => {
      if (event.target !== event.currentTarget) return;
      const el = elRef.current;
      if (!el) return;
      if (event.key === "Escape") {
        ctx.clear({ force: true });
        event.stopPropagation();
        return;
      }
      if (event.key === "Enter" || event.key === " ") {
        if (disabled) {
          event.preventDefault();
          return;
        }
        if (el.matches("a[href]")) return;
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
  const [mobile, setMobile] = React2.useState(false);
  React2.useLayoutEffect(() => {
    const update = () => setMobile(tooltipPlacement(window.innerWidth) === "static");
    update();
    window.addEventListener("resize", update);
    return () => window.removeEventListener("resize", update);
  }, []);
  return mobile;
}
function ChartTooltip({
  top = 110,
  offsetLeft,
  fallback,
  className
}) {
  const { active } = useActiveEntity();
  const ref = React2.useRef(null);
  const mobile = useIsMobile();
  const [left, setLeft] = React2.useState(null);
  const [markTop, setMarkTop] = React2.useState(0);
  const [, mounted2] = React2.useState(false);
  React2.useLayoutEffect(() => mounted2(true), []);
  const host = React2.useRef(null);
  const container = host.current?.parentElement ?? null;
  const anchored = active !== null && active.element !== null && container !== null && container.contains(active.element);
  React2.useLayoutEffect(() => {
    if (!anchored || mobile || !ref.current || !active?.element || !container) {
      setLeft(null);
      return;
    }
    const markRect = active.element.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
    setMarkTop(markRect.bottom - containerRect.top + 4);
    setLeft(
      offsetLeft ?? placeTooltip(markRect, containerRect, ref.current.offsetWidth)
    );
  }, [anchored, mobile, active, container, offsetLeft]);
  const data = active ? active.data ?? fallback?.(active.key) ?? null : null;
  const show = anchored && data !== null;
  return /* @__PURE__ */ jsxRuntime.jsx("div", { ref: host, style: { display: "contents" }, "data-mg-tooltip-host": "", children: show && data ? /* @__PURE__ */ jsxRuntime.jsxs(
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
        top: top === "mark" ? markTop : top,
        left: left ?? 0,
        visibility: left === null ? "hidden" : void 0
      },
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-chart-tooltip-head", children: [
          /* @__PURE__ */ jsxRuntime.jsx("strong", { children: data.title }),
          data.total ? /* @__PURE__ */ jsxRuntime.jsx("span", { children: data.total }) : null
        ] }),
        data.rows && data.rows.length > 0 ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-chart-tooltip-divider" }) : null,
        data.rows?.map((row) => /* @__PURE__ */ jsxRuntime.jsxs(
          "div",
          {
            className: "mg-chart-tooltip-row",
            "data-current": row.key === active?.key ? "true" : void 0,
            "data-muted": active && data.rows?.some((r) => r.key === active.key) && row.key !== active.key ? "true" : void 0,
            children: [
              /* @__PURE__ */ jsxRuntime.jsxs("span", { children: [
                /* @__PURE__ */ jsxRuntime.jsx(
                  "i",
                  {
                    className: "mg-chart-tooltip-swatch",
                    "data-empty": row.swatch ? void 0 : "true",
                    style: row.swatch ? { "--swatch": row.swatch } : void 0
                  }
                ),
                /* @__PURE__ */ jsxRuntime.jsx("span", { children: row.label })
              ] }),
              /* @__PURE__ */ jsxRuntime.jsx("b", { children: row.value })
            ]
          },
          row.key
        )),
        data.note ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-chart-tooltip-note", children: data.note }) : null
      ]
    }
  ) : null });
}
var DefinitionsContext = React2.createContext({});
function DefinitionsProvider({
  definitions,
  children
}) {
  return /* @__PURE__ */ jsxRuntime.jsx(DefinitionsContext.Provider, { value: definitions, children });
}
function useDefinition(term) {
  return React2.useContext(DefinitionsContext)[term];
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
  const id = React2.useId();
  const [open, setOpen] = React2.useState(false);
  const rootRef = React2.useRef(null);
  const pointerType = React2.useRef("mouse");
  const close = React2.useCallback(() => setOpen(false), []);
  React2.useEffect(() => {
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
  if (!text) return children ? /* @__PURE__ */ jsxRuntime.jsx(jsxRuntime.Fragment, { children }) : null;
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "span",
    {
      ref: rootRef,
      className: ["mg-definition", className].filter(Boolean).join(" "),
      children: [
        /* @__PURE__ */ jsxRuntime.jsx(
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
        open ? /* @__PURE__ */ jsxRuntime.jsxs(
          "span",
          {
            id,
            role: "tooltip",
            className: "mg-definition-tip",
            "data-align": align,
            "data-mg-tooltip": "",
            children: [
              /* @__PURE__ */ jsxRuntime.jsx("strong", { children: term }),
              text
            ]
          }
        ) : null
      ]
    }
  );
}
function Raw({
  title = "Raw identifiers & sources",
  rows = [],
  children,
  defaultOpen,
  className,
  id
}) {
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "details",
    {
      id,
      className: ["mg-raw", className].filter(Boolean).join(" "),
      open: defaultOpen,
      "data-mg-raw": "",
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs("summary", { children: [
          title,
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-raw-chip", "aria-hidden": true, children: "RAW" })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-raw-body", children: [
          rows.length > 0 ? /* @__PURE__ */ jsxRuntime.jsx("dl", { children: rows.map((row) => /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-raw-row", children: [
            /* @__PURE__ */ jsxRuntime.jsx("dt", { children: row.label }),
            /* @__PURE__ */ jsxRuntime.jsx("dd", { children: row.href ? /* @__PURE__ */ jsxRuntime.jsx("a", { href: row.href, className: "text-accent hover:underline", children: /* @__PURE__ */ jsxRuntime.jsx("code", { title: row.value, children: row.value }) }) : /* @__PURE__ */ jsxRuntime.jsx("code", { title: row.value, children: row.value }) }),
            /* @__PURE__ */ jsxRuntime.jsx(
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
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "relative", children: [
    /* @__PURE__ */ jsxRuntime.jsx("pre", { className: "mg-raw-code", "aria-label": label, children: /* @__PURE__ */ jsxRuntime.jsx("code", { children }) }),
    /* @__PURE__ */ jsxRuntime.jsx(
      CopyButton,
      {
        value: children,
        label: label ?? "snippet",
        className: "absolute top-1 right-1"
      }
    )
  ] });
}
function AnalyticsSection({
  id,
  name,
  question,
  visual,
  visualRef,
  legend,
  footnote,
  controls,
  children,
  after,
  empty,
  className
}) {
  const headingId = `${id}-heading`;
  const blank = (node) => node === null || node === void 0 || node === false;
  const showEmpty = blank(visual) && blank(children) && blank(legend) && empty !== false;
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "section",
    {
      ref: visualRef,
      id,
      className: classNames("mg-section", className),
      "aria-labelledby": headingId,
      "data-mg-section": "",
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-section-head", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("h2", { id: headingId, className: "mg-section-h", children: [
            /* @__PURE__ */ jsxRuntime.jsx("strong", { children: typeof name === "string" ? name.replace(/\.?$/, ".") : name }),
            question ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
              " ",
              question
            ] }) : null
          ] }),
          controls ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-section-controls", children: controls }) : null
        ] }),
        visual ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-section-visual", children: visual }) : null,
        children,
        legend ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-section-legend", children: legend }) : null,
        showEmpty ? /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mg-section-empty", children: empty ?? "No data in this window." }) : null,
        footnote ? /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mg-section-note", children: footnote }) : null,
        after
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
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: classNames("mg-section-head", className), children: [
    /* @__PURE__ */ jsxRuntime.jsxs("h2", { id, className: "mg-section-h", children: [
      /* @__PURE__ */ jsxRuntime.jsx("strong", { children: typeof name === "string" ? name.replace(/\.?$/, ".") : name }),
      question ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
        " ",
        question
      ] }) : null
    ] }),
    controls ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-section-controls", children: controls }) : null
  ] });
}
function pickActiveSection(ids, visible, current) {
  return ids.find((id) => visible.has(id)) ?? current;
}
function sectionNavScrollState({
  scrollWidth,
  clientWidth,
  scrollLeft
}) {
  const hasOverflow = scrollWidth > clientWidth + 1;
  return {
    hasOverflow,
    atStart: !hasOverflow || scrollLeft <= 1,
    atEnd: !hasOverflow || scrollLeft + clientWidth >= scrollWidth - 1
  };
}
function useActiveSection(ids) {
  const [active, setActive] = React2.useState(ids[0] ?? null);
  React2.useEffect(() => {
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
  const scrollRef = React2.useRef(null);
  const [scrollState, setScrollState] = React2.useState({
    hasOverflow: false,
    atStart: true,
    atEnd: true
  });
  const syncScrollState = () => {
    const node = scrollRef.current;
    if (!node) return;
    const next = sectionNavScrollState(node);
    setScrollState(
      (current) => current.hasOverflow === next.hasOverflow && current.atStart === next.atStart && current.atEnd === next.atEnd ? current : next
    );
  };
  React2.useEffect(() => {
    const node = scrollRef.current;
    if (!node) return;
    syncScrollState();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(syncScrollState);
    observer.observe(node);
    return () => observer.disconnect();
  }, [items]);
  if (items.length === 0) return null;
  const LinkCmp = link ?? DefaultLink;
  return /* @__PURE__ */ jsxRuntime.jsx(
    "nav",
    {
      className: classNames("mg-section-nav", className),
      "aria-label": "Sections",
      "data-mg-section-nav": "",
      "data-overflow": scrollState.hasOverflow ? "true" : void 0,
      "data-scroll-start": scrollState.atStart ? "true" : void 0,
      "data-scroll-end": scrollState.atEnd ? "true" : void 0,
      children: /* @__PURE__ */ jsxRuntime.jsx(
        "div",
        {
          ref: scrollRef,
          className: "mg-section-nav-scroll",
          onScroll: syncScrollState,
          children: /* @__PURE__ */ jsxRuntime.jsx("ul", { children: items.map(
            (item) => item.href ? /* @__PURE__ */ jsxRuntime.jsx("li", { children: /* @__PURE__ */ jsxRuntime.jsx(
              LinkCmp,
              {
                href: item.href,
                "aria-current": item.current ? "page" : void 0,
                children: item.name
              }
            ) }, item.id) : /* @__PURE__ */ jsxRuntime.jsx("li", { children: /* @__PURE__ */ jsxRuntime.jsx(
              "a",
              {
                href: `#${item.id}`,
                "aria-current": active === item.id ? "location" : void 0,
                children: item.name
              }
            ) }, item.id)
          ) })
        }
      )
    }
  );
}
var DefaultLink = ({ href, children, ...rest }) => /* @__PURE__ */ jsxRuntime.jsx("a", { href, ...rest, children });
var MAX_SECTIONS = 7;
function sectionItems(children) {
  const items = [];
  React2.Children.forEach(children, (child) => {
    if (!React2.isValidElement(child)) return;
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
  sections,
  className
}) {
  const items = sections ? [...sections] : sectionItems(children);
  if (items.length > MAX_SECTIONS && process.env.NODE_ENV !== "production") {
    throw new Error(
      `AnalyticsPage: ${items.length} sections; a page answers at most ${MAX_SECTIONS} questions (#11607)`
    );
  }
  return /* @__PURE__ */ jsxRuntime.jsx(ActiveEntityProvider, { children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: classNames("mg-page", className), "data-mg-page": "", children: [
    hero,
    /* @__PURE__ */ jsxRuntime.jsx(SectionNav, { items }),
    children
  ] }) });
}
function FactStrip({
  cells,
  children,
  variant = "row",
  className
}) {
  const count = cells?.length ?? React2.Children.count(children);
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "dl",
    {
      className: classNames("mg-facts", className),
      "data-variant": variant,
      "data-count": count || void 0,
      children: [
        cells?.map((cell) => /* @__PURE__ */ jsxRuntime.jsx(FactCell, { ...cell }, cell.label)),
        children
      ]
    }
  );
}
function FactCell({
  label,
  value,
  kind,
  loading = false,
  tone,
  delta,
  hint,
  className
}) {
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: classNames("mg-fact", className), "data-tone": tone, children: [
    /* @__PURE__ */ jsxRuntime.jsxs("dt", { children: [
      label,
      /* @__PURE__ */ jsxRuntime.jsx(Definition, { term: label, sentence: hint })
    ] }),
    /* @__PURE__ */ jsxRuntime.jsxs("dd", { "aria-busy": loading || void 0, children: [
      loading ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-fact-loading", "aria-hidden": "true" }),
        /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "sr-only", children: [
          "Loading ",
          label
        ] })
      ] }) : /* @__PURE__ */ jsxRuntime.jsx(
        "span",
        {
          className: classNames(
            "mg-fact-value",
            kind === "text" && "mg-fact-value--text"
          ),
          children: value
        }
      ),
      !loading && delta ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-fact-delta", "data-tone": delta.tone, children: delta.text }) : null
    ] })
  ] });
}
function Fact({
  children,
  className
}) {
  return /* @__PURE__ */ jsxRuntime.jsx("span", { className: classNames("mg-fact-chip", className), children });
}
function FactSentence({ children, className }) {
  return /* @__PURE__ */ jsxRuntime.jsx("p", { className: classNames("mg-fact-sentence", className), children });
}
var LiveTickerContext = React2.createContext(null);
function LiveTickerProvider({ children }) {
  const [tick, setTick] = React2.useState(0);
  React2.useEffect(() => {
    const id = setInterval(() => setTick((n) => n + 1), 1e3);
    return () => clearInterval(id);
  }, []);
  return /* @__PURE__ */ jsxRuntime.jsx(LiveTickerContext.Provider, { value: tick, children });
}
function useLiveTicker() {
  return React2.useContext(LiveTickerContext);
}
function timeAgoTickDelayMs(ageMs) {
  return ageMs < 6e4 ? 1e3 : 6e4;
}
function TimeAgo({
  at,
  className,
  fallback = "\u2014"
}) {
  const [mounted2, setMounted] = React2.useState(false);
  const [, forceTick] = React2.useState(0);
  const sharedTicker = useLiveTicker();
  const hasSharedTicker = sharedTicker !== null;
  React2.useEffect(() => setMounted(true), []);
  React2.useEffect(() => {
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
  return /* @__PURE__ */ jsxRuntime.jsx("span", { className, suppressHydrationWarning: true, children: text });
}
var mounted = 0;
function LiveMeta({
  updatedAt,
  onRefresh,
  refreshing,
  source,
  className
}) {
  React2.useEffect(() => {
    mounted += 1;
    if (mounted > 1 && process.env.NODE_ENV !== "production") {
      throw new Error("LiveMeta: only one liveness line per page (#11607)");
    }
    return () => {
      mounted -= 1;
    };
  }, []);
  return /* @__PURE__ */ jsxRuntime.jsxs("p", { className: classNames("mg-live-meta", className), "data-mg-live-meta": "", children: [
    updatedAt ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      "Updated ",
      /* @__PURE__ */ jsxRuntime.jsx(TimeAgo, { at: updatedAt })
    ] }) : "Updated \u2014",
    source ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      " \xB7 ",
      source
    ] }) : null,
    onRefresh ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
      " \xB7 ",
      /* @__PURE__ */ jsxRuntime.jsx(
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
  const refs = React2.useRef([]);
  const itemRef = React2.useCallback(
    (index) => (el) => {
      refs.current[index] = el;
    },
    []
  );
  const onKeyDown = React2.useCallback(
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
  const id = React2.useId();
  const activeIndex = Math.max(
    0,
    options.findIndex((o) => o.value === value)
  );
  const select = React2.useCallback(
    (index) => {
      const next = options[index];
      if (next && next.value !== value) onChange(next.value);
    },
    [options, value, onChange]
  );
  const { itemRef, onKeyDown } = useRovingGroup(options.length, select);
  return /* @__PURE__ */ jsxRuntime.jsx(
    "div",
    {
      role: "radiogroup",
      "aria-label": label,
      id,
      className: classNames("mg-range", className),
      "data-mg-range": "",
      children: options.map((o, i) => /* @__PURE__ */ jsxRuntime.jsx(
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
  headingLevel = 1,
  className
}) {
  return /* @__PURE__ */ jsxRuntime.jsxs("header", { className: classNames("mg-hero", className), "data-mg-hero": "", children: [
    crumbs && crumbs.length > 0 ? /* @__PURE__ */ jsxRuntime.jsx("nav", { className: "mg-hero-crumbs", "aria-label": "Breadcrumb", children: crumbs.map((c, i) => /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-hero-crumb", children: c.href ? /* @__PURE__ */ jsxRuntime.jsx("a", { href: c.href, children: c.label }) : c.label }, `${c.label}-${i}`)) }) : null,
    /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-hero-title", children: [
      avatar ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-hero-avatar", children: avatar }) : null,
      headingLevel === 1 ? /* @__PURE__ */ jsxRuntime.jsx("h1", { children: name }) : headingLevel === 2 ? /* @__PURE__ */ jsxRuntime.jsx("h2", { children: name }) : /* @__PURE__ */ jsxRuntime.jsx("h3", { children: name }),
      action || secondary ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-hero-actions", children: [
        secondary,
        action
      ] }) : null
    ] }),
    sentence,
    cells ? /* @__PURE__ */ jsxRuntime.jsx(FactStrip, { cells }) : null,
    facts,
    live ? /* @__PURE__ */ jsxRuntime.jsx(LiveMeta, { ...live }) : null
  ] });
}

// src/components/metagraphed/charts/chart-aria.ts
function markAriaLabel(domain, total) {
  if (total === void 0 || total === null || total === "") return domain;
  return `${domain} \xB7 ${total} total`;
}
function momentumAriaLabel(unit, endValue, deltaLabel2, rangeLabel2) {
  const noun = unit.charAt(0).toUpperCase() + unit.slice(1);
  if (endValue === null) return `${noun}: no data in the window`;
  const range = rangeLabel2 ? ` over ${rangeLabel2}` : "";
  return `${noun}: ${endValue}, ${deltaLabel2}${range}`;
}
function Kbd({
  children,
  className
}) {
  return /* @__PURE__ */ jsxRuntime.jsx(
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
function ClaudeIcon({ className, ...props }) {
  return /* @__PURE__ */ jsxRuntime.jsx(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "var(--claude-brand)",
      "aria-hidden": "true",
      className,
      ...props,
      children: /* @__PURE__ */ jsxRuntime.jsx("path", { d: "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z" })
    }
  );
}
function OpenAIIcon({ className, ...props }) {
  return /* @__PURE__ */ jsxRuntime.jsx(
    "svg",
    {
      viewBox: "0 0 24 24",
      fill: "currentColor",
      "aria-hidden": "true",
      className,
      ...props,
      children: /* @__PURE__ */ jsxRuntime.jsx("path", { d: "M22.2819 9.8211a5.9847 5.9847 0 0 0-.5157-4.9108 6.0462 6.0462 0 0 0-6.5098-2.9A6.0651 6.0651 0 0 0 4.9807 4.1818a5.9847 5.9847 0 0 0-3.9977 2.9 6.0462 6.0462 0 0 0 .7427 7.0966 5.98 5.98 0 0 0 .511 4.9107 6.051 6.051 0 0 0 6.5146 2.9001A5.9847 5.9847 0 0 0 13.2599 24a6.0557 6.0557 0 0 0 5.7718-4.2058 5.9894 5.9894 0 0 0 3.9977-2.9001 6.0557 6.0557 0 0 0-.7475-7.0729zm-9.022 12.6081a4.4755 4.4755 0 0 1-2.8764-1.0408l.1419-.0804 4.7783-2.7582a.7948.7948 0 0 0 .3927-.6813v-6.7369l2.02 1.1686a.071.071 0 0 1 .038.052v5.5826a4.504 4.504 0 0 1-4.4945 4.4944zm-9.6607-4.1254a4.4708 4.4708 0 0 1-.5346-3.0137l.142.0852 4.783 2.7582a.7712.7712 0 0 0 .7806 0l5.8428-3.3685v2.3324a.0804.0804 0 0 1-.0332.0615L9.74 19.9502a4.4992 4.4992 0 0 1-6.1408-1.6464zM2.3408 7.8956a4.485 4.485 0 0 1 2.3655-1.9728V11.6a.7664.7664 0 0 0 .3879.6765l5.8144 3.3543-2.0201 1.1685a.0757.0757 0 0 1-.071 0l-4.8303-2.7865A4.504 4.504 0 0 1 2.3408 7.872zm16.5963 3.8558L13.1038 8.364 15.1192 7.2a.0757.0757 0 0 1 .071 0l4.8303 2.7913a4.4944 4.4944 0 0 1-.6765 8.1042v-5.6772a.79.79 0 0 0-.407-.667zm2.0107-3.0231l-.142-.0852-4.7735-2.7818a.7759.7759 0 0 0-.7854 0L9.409 9.2297V6.8974a.0662.0662 0 0 1 .0284-.0615l4.8303-2.7866a4.4992 4.4992 0 0 1 6.6802 4.66zM8.3065 12.863l-2.02-1.1638a.0804.0804 0 0 1-.038-.0567V6.0742a4.4992 4.4992 0 0 1 7.3757-3.4537l-.142.0805L8.704 5.459a.7948.7948 0 0 0-.3927.6813zm1.0976-2.3654l2.602-1.4998 2.6069 1.4998v2.9994l-2.5974 1.4997-2.6067-1.4997Z" })
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
        "inline-flex items-center gap-1.5 rounded border px-2 py-0.5",
        "text-10 leading-none whitespace-nowrap transition-colors",
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
        label ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "opacity-70", children: label }) : null,
        children != null ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "text-ink-strong normal-case", children }) : null
      ]
    }
  );
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
  return /* @__PURE__ */ jsxRuntime.jsxs("section", { ...rest, className: classNames("min-w-0", className), children: [
    hasHeader ? /* @__PURE__ */ jsxRuntime.jsxs("header", { className: "flex items-start justify-between gap-3 mg-panel-pad pb-2", children: [
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "min-w-0", children: [
        title != null ? /* @__PURE__ */ jsxRuntime.jsx("h3", { className: "text-13 font-semibold text-ink-strong", children: title }) : null,
        caption != null ? /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mt-1 text-13 text-ink-muted", children: caption }) : null
      ] }),
      action != null ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "shrink-0 flex items-center gap-2", children: action }) : null
    ] }) : null,
    /* @__PURE__ */ jsxRuntime.jsx(
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
              "inline-flex size-10 items-center justify-center rounded border border-border bg-surface-2",
              VARIANT_TONE[variant]
            ),
            children: /* @__PURE__ */ jsxRuntime.jsx(Icon, { className: "size-4" })
          }
        ),
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "max-w-sm space-y-1", children: [
          /* @__PURE__ */ jsxRuntime.jsx("p", { className: "font-display text-13 font-medium text-ink-strong", children: title }),
          hint != null ? /* @__PURE__ */ jsxRuntime.jsx("p", { className: "text-13 leading-relaxed text-ink-muted", children: hint }) : null
        ] }),
        action != null || evidenceHref ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex flex-wrap items-center justify-center gap-2 pt-1", children: [
          action,
          evidenceHref ? /* @__PURE__ */ jsxRuntime.jsxs(
            ExternalLink,
            {
              bare: true,
              href: evidenceHref,
              className: "mg-focus-ring inline-flex items-center gap-1 text-11 text-ink-muted hover:text-ink-strong",
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

// src/components/metagraphed/charts/series-palette.ts
var CHART_RAMP_SIZE = 10;
var OTHER_COLOR = "var(--chart-residual)";
var OTHER_KEY = "Other";
var RESIDUAL_KEY = "rest";
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
  let residualLabel = null;
  for (const s of segments) {
    if (s.key === RESIDUAL_KEY) {
      other += s.value;
      residualLabel = s.label ?? label;
      continue;
    }
    if (registry.indexOf(s.key) === null) other += s.value;
    else
      kept.push({
        key: s.key,
        label: s.label ?? s.key,
        value: s.value
      });
  }
  if (other > 0)
    kept.push({ key: OTHER_KEY, label: residualLabel ?? label, value: other });
  return kept;
}
function stackScrollState({
  clientWidth,
  scrollWidth,
  scrollLeft
}) {
  const overflow = scrollWidth > clientWidth + 1;
  return {
    overflow,
    atStart: !overflow || scrollLeft <= 1,
    atEnd: !overflow || scrollLeft + clientWidth >= scrollWidth - 1
  };
}
var defaultFormat = (v) => String(v);
var BAR_PX = 15;
function StackedColumns({
  id,
  columns,
  seriesOrder,
  registry,
  other = OTHER_KEY,
  formatValue = defaultFormat,
  ariaLabel,
  columnSource = "stacked-columns",
  className,
  loading = false,
  loadingColumns = 30
}) {
  const ownRegistry = React2.useRef(null);
  if (!registry && !ownRegistry.current)
    ownRegistry.current = new SeriesPaletteRegistry();
  const reg = registry ?? ownRegistry.current;
  reg.assign(seriesOrder);
  const palette = reg.palette();
  const displayColumns = React2.useMemo(
    () => loading ? Array.from({ length: Math.max(1, loadingColumns) }, (_, index) => ({
      key: `skeleton-${index}`,
      label: "",
      total: 0,
      segments: []
    })) : columns,
    [columns, loading, loadingColumns]
  );
  const rows = React2.useMemo(
    () => displayColumns.map((c) => ({
      ...c,
      segments: collapseOther(c.segments, reg, other)
    })),
    [displayColumns, reg, other]
  );
  const seriesKeys = React2.useMemo(() => {
    const keys = reg.keys().filter((k) => rows.some((r) => r.segments.some((s) => s.key === k)));
    if (rows.some((r) => r.segments.some((s) => s.key === OTHER_KEY)))
      keys.push(OTHER_KEY);
    return keys;
  }, [reg, rows]);
  const { active } = useActiveEntity();
  const activeSeries = active && seriesKeys.includes(active.key) ? active.key : null;
  const scrollRef = React2.useRef(null);
  const [cadence, setCadence] = React2.useState(7);
  const [gap, setGap] = React2.useState(12);
  const [scrollState, setScrollState] = React2.useState({
    overflow: false,
    atStart: true,
    atEnd: true
  });
  const updateScrollState = React2.useCallback((el) => {
    const next = stackScrollState(el);
    setScrollState(
      (previous) => previous.overflow === next.overflow && previous.atStart === next.atStart && previous.atEnd === next.atEnd ? previous : next
    );
  }, []);
  React2.useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => {
      const width = el.clientWidth;
      setCadence(width >= 768 ? 7 : 14);
      const pitch = width / Math.max(1, rows.length);
      setGap(pitch >= BAR_PX + 12 ? 12 : pitch >= BAR_PX + 8 ? 8 : 6);
      updateScrollState(el);
    };
    update();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(update);
    ro?.observe(el);
    el.addEventListener("scroll", update, { passive: true });
    return () => {
      ro?.disconnect();
      el.removeEventListener("scroll", update);
    };
  }, [rows.length, updateScrollState]);
  React2.useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollLeft = el.scrollWidth;
    updateScrollState(el);
  }, [rows.length, updateScrollState]);
  const max = Math.max(1, ...rows.map((r) => r.total));
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      id,
      className: classNames("mg-stack", className),
      "data-mg-stack": "",
      "data-loading": loading || void 0,
      "data-series-active": activeSeries ? "true" : void 0,
      "data-overflow": scrollState.overflow ? "true" : void 0,
      "data-scroll-start": scrollState.atStart ? "true" : void 0,
      "data-scroll-end": scrollState.atEnd ? "true" : void 0,
      style: {
        "--mg-stack-count": rows.length,
        "--mg-stack-gap": `${gap}px`
      },
      children: [
        /* @__PURE__ */ jsxRuntime.jsx(ChartTooltip, { top: 110 }),
        /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            ref: scrollRef,
            className: "mg-stack-scroll",
            tabIndex: scrollState.overflow ? 0 : void 0,
            "aria-label": scrollState.overflow ? `${ariaLabel}. Scroll horizontally to inspect more periods.` : void 0,
            children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-stack-chart", children: [
              /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-stack-axis", "aria-hidden": "true", children: rows.map((c, i) => /* @__PURE__ */ jsxRuntime.jsx(
                "div",
                {
                  "data-entity": c.key,
                  "data-active": active?.key === c.key ? "true" : void 0,
                  "data-label-hidden": i % cadence !== 0 ? "true" : void 0,
                  children: /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-stack-axis-label", children: loading ? /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-8" }) : /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
                    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-stack-axis-total", children: formatValue(c.total) }),
                    /* @__PURE__ */ jsxRuntime.jsx("span", { children: c.axisLabel ?? c.label })
                  ] }) })
                },
                c.key
              )) }),
              /* @__PURE__ */ jsxRuntime.jsx(
                "div",
                {
                  className: "mg-stack-bars",
                  role: "group",
                  "aria-label": ariaLabel,
                  "aria-busy": loading || void 0,
                  "data-marks": loading ? void 0 : "",
                  children: loading ? rows.map((c, index) => /* @__PURE__ */ jsxRuntime.jsx(ColumnSkeleton, { index }, c.key)) : rows.map((c) => /* @__PURE__ */ jsxRuntime.jsx(
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
            ] })
          }
        ),
        !loading ? /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-sr-table", children: /* @__PURE__ */ jsxRuntime.jsxs("table", { children: [
          /* @__PURE__ */ jsxRuntime.jsx("caption", { children: ariaLabel }),
          /* @__PURE__ */ jsxRuntime.jsx("thead", { children: /* @__PURE__ */ jsxRuntime.jsxs("tr", { children: [
            /* @__PURE__ */ jsxRuntime.jsx("th", { scope: "col", children: "Period" }),
            /* @__PURE__ */ jsxRuntime.jsx("th", { scope: "col", children: "Total" }),
            seriesKeys.map((k) => /* @__PURE__ */ jsxRuntime.jsx("th", { scope: "col", children: k === OTHER_KEY ? other : rows.flatMap((r) => r.segments).find((s) => s.key === k)?.label ?? k }, k))
          ] }) }),
          /* @__PURE__ */ jsxRuntime.jsx("tbody", { children: rows.map((c) => /* @__PURE__ */ jsxRuntime.jsxs("tr", { children: [
            /* @__PURE__ */ jsxRuntime.jsx("th", { scope: "row", children: c.label }),
            /* @__PURE__ */ jsxRuntime.jsx("td", { children: formatValue(c.total) }),
            seriesKeys.map((k) => /* @__PURE__ */ jsxRuntime.jsx("td", { children: formatValue(
              c.segments.find((s) => s.key === k)?.value ?? 0
            ) }, k))
          ] }, c.key)) })
        ] }) }) : null
      ]
    }
  );
}
function ColumnSkeleton({ index }) {
  const height = 32 + index * 19 % 53;
  return /* @__PURE__ */ jsxRuntime.jsx(
    "div",
    {
      className: "mg-stack-col mg-stack-col--skeleton",
      "aria-hidden": "true",
      style: { "--mg-stack-h": `${height}%` },
      children: /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-stack-skeleton-stack" })
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
  const [focusedSeries, setFocusedSeries] = React2.useState(-1);
  const data = React2.useMemo(
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
  const elRef = React2.useRef(null);
  const ref = React2.useCallback(
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
  return /* @__PURE__ */ jsxRuntime.jsx(
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
      children: /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-stack-stack", "aria-hidden": "true", children: c.segments.map((s) => /* @__PURE__ */ jsxRuntime.jsx(
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
var PAD_TOP = 20;
var PAD_BOTTOM = 8;
var PLOT_RIGHT = 0.94;
function placePoints(points, box = LINE_VIEWBOX, { zeroBaseline = false } = {}) {
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
  if (zeroBaseline && min >= 0) min = 0;
  const range = max - min || 1;
  return points.map((p) => ({
    ...p,
    x: points.length === 1 ? box.width * PLOT_RIGHT / 2 : (p.t - t0) / span * box.width * PLOT_RIGHT,
    y: box.height - PAD_BOTTOM - (p.v - min) / range * (box.height - PAD_TOP - PAD_BOTTOM)
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
var defaultFormat2 = (v) => String(v);
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
  formatValue = defaultFormat2,
  formatDate = formatLineDate,
  formatRange,
  ariaLabel,
  keyOf,
  source = "line",
  compact = false,
  marker,
  markerLabel,
  className,
  loading = false,
  zeroBaseline = false,
  animate = false
}) {
  const placed = React2.useMemo(
    () => placePoints(points, LINE_VIEWBOX, { zeroBaseline }),
    [points, zeroBaseline]
  );
  const inside = React2.useMemo(() => windowPoints(placed, window2), [placed, window2]);
  const delta = React2.useMemo(() => windowDelta(points, window2), [points, window2]);
  const months = React2.useMemo(() => monthTicks(points), [points]);
  const keyFor = keyOf ?? ((p) => `${source}:${p.t}`);
  const { active } = useActiveEntity();
  const activePoint = active ? placed.find((p) => keyFor(p) === active.key) : void 0;
  if (loading) {
    return /* @__PURE__ */ jsxRuntime.jsx(
      LineSkeleton,
      {
        id,
        ariaLabel,
        compact,
        className
      }
    );
  }
  const markerPoint = typeof marker === "number" ? placed.find((p) => p.t === marker) : void 0;
  const first = placed[0];
  const wStart = inside[0];
  const wEnd = inside[inside.length - 1];
  const pct = (n, of) => `${(n / of * 100).toFixed(2)}%`;
  const rangeLabel2 = wStart && wEnd ? formatRange ? formatRange(wStart.t, wEnd.t) : `${rangeFormat.format(new Date(wStart.t)).toUpperCase()} \u2192 ${rangeFormat.format(new Date(wEnd.t)).toUpperCase()}` : "";
  const summary = momentumAriaLabel(
    unit,
    wEnd ? formatValue(wEnd.v) : null,
    delta.label,
    rangeLabel2
  );
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      id,
      className: classNames("mg-line", className),
      "data-mg-line": "",
      "data-compact": compact ? "true" : void 0,
      "data-state": delta.state,
      "data-animate": animate ? "true" : void 0,
      children: [
        compact ? null : /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-line-summary", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("p", { className: "mg-line-total", children: [
            /* @__PURE__ */ jsxRuntime.jsx("strong", { children: wEnd ? formatValue(wEnd.v) : "\u2014" }),
            /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-line-delta", "data-state": delta.state, children: delta.label })
          ] }),
          /* @__PURE__ */ jsxRuntime.jsxs("p", { className: "mg-line-range", children: [
            rangeLabel2,
            " \xB7 ",
            unit
          ] })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs(
          "div",
          {
            className: "mg-line-plot",
            role: "group",
            "aria-label": summary,
            "data-marks": true,
            children: [
              /* @__PURE__ */ jsxRuntime.jsx(ChartTooltip, { top: compact ? 16 : 110 }),
              /* @__PURE__ */ jsxRuntime.jsxs(
                "svg",
                {
                  viewBox: `0 0 ${LINE_VIEWBOX.width} ${LINE_VIEWBOX.height}`,
                  preserveAspectRatio: "none",
                  "aria-hidden": "true",
                  focusable: "false",
                  children: [
                    /* @__PURE__ */ jsxRuntime.jsx(
                      "path",
                      {
                        className: "mg-line-muted",
                        d: smoothPath(placed),
                        pathLength: "1"
                      }
                    ),
                    /* @__PURE__ */ jsxRuntime.jsx(
                      "path",
                      {
                        className: "mg-line-active",
                        d: smoothPath(inside),
                        pathLength: "1"
                      }
                    ),
                    markerPoint ? /* @__PURE__ */ jsxRuntime.jsx(
                      "line",
                      {
                        className: "mg-line-subject",
                        x1: markerPoint.x,
                        x2: markerPoint.x,
                        y1: 0,
                        y2: LINE_VIEWBOX.height
                      }
                    ) : null,
                    activePoint ? /* @__PURE__ */ jsxRuntime.jsx(
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
              [first, wStart, wEnd].filter((p) => Boolean(p)).map((p, i) => /* @__PURE__ */ jsxRuntime.jsx(
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
              activePoint ? /* @__PURE__ */ jsxRuntime.jsx(
                "i",
                {
                  className: "mg-line-marker mg-line-marker-cursor",
                  style: {
                    "--mg-line-x": pct(activePoint.x, LINE_VIEWBOX.width),
                    "--mg-line-y": pct(activePoint.y, LINE_VIEWBOX.height)
                  }
                }
              ) : null,
              markerPoint && markerLabel ? /* @__PURE__ */ jsxRuntime.jsx(
                "i",
                {
                  className: "mg-line-marker mg-line-marker-subject",
                  "aria-label": markerLabel,
                  role: "img",
                  style: {
                    "--mg-line-x": pct(markerPoint.x, LINE_VIEWBOX.width),
                    "--mg-line-y": pct(markerPoint.y, LINE_VIEWBOX.height)
                  }
                }
              ) : null,
              wEnd && delta.state !== "empty" ? /* @__PURE__ */ jsxRuntime.jsxs(
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
                    /* @__PURE__ */ jsxRuntime.jsx("i", {})
                  ]
                }
              ) : null,
              /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-line-hits", children: placed.map((p, i) => {
                const left = i === 0 ? 0 : (placed[i - 1].x + p.x) / 2;
                const right = i === placed.length - 1 ? LINE_VIEWBOX.width : (p.x + placed[i + 1].x) / 2;
                return /* @__PURE__ */ jsxRuntime.jsx(
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
        compact ? null : /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-line-months", "aria-hidden": "true", children: months.map((m) => /* @__PURE__ */ jsxRuntime.jsx("span", { style: { left: `${m.pct}%` }, children: m.label }, m.pct)) }),
        /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-sr-table", children: /* @__PURE__ */ jsxRuntime.jsxs("table", { children: [
          /* @__PURE__ */ jsxRuntime.jsx("caption", { children: ariaLabel }),
          /* @__PURE__ */ jsxRuntime.jsx("thead", { children: /* @__PURE__ */ jsxRuntime.jsxs("tr", { children: [
            /* @__PURE__ */ jsxRuntime.jsx("th", { scope: "col", children: "Date" }),
            /* @__PURE__ */ jsxRuntime.jsx("th", { scope: "col", children: unit })
          ] }) }),
          /* @__PURE__ */ jsxRuntime.jsx("tbody", { children: points.map((p) => /* @__PURE__ */ jsxRuntime.jsxs("tr", { children: [
            /* @__PURE__ */ jsxRuntime.jsx("th", { scope: "row", children: formatDate(p.t) }),
            /* @__PURE__ */ jsxRuntime.jsx("td", { children: formatValue(p.v) })
          ] }, p.t)) })
        ] }) })
      ]
    }
  );
}
function LineSkeleton({
  id,
  ariaLabel,
  compact,
  className
}) {
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      id,
      className: classNames("mg-line", className),
      "data-mg-line": "",
      "data-compact": compact ? "true" : void 0,
      "data-loading": "true",
      children: [
        compact ? null : /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-line-summary", "aria-hidden": "true", children: [
          /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-8 w-24" }),
          /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-52 max-w-full" })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs(
          "div",
          {
            className: "mg-line-plot",
            role: "group",
            "aria-label": ariaLabel,
            "aria-busy": "true",
            children: [
              /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "sr-only", children: [
                "Loading ",
                ariaLabel
              ] }),
              /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-full w-full" })
            ]
          }
        ),
        compact ? null : /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-full", "aria-hidden": "true" })
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
  const elRef = React2.useRef(null);
  const mark = useEntityMark(entityKey, {
    source,
    label: markAriaLabel(label, value),
    data: { title: label, total: value }
  });
  return /* @__PURE__ */ jsxRuntime.jsx(
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
  secondaryScale = "shared",
  columns,
  limit = 10,
  ariaLabel,
  source = "ranked-rails",
  onActivate,
  className,
  loading = false,
  loadingRows = 6,
  loadingSecondary = false
}) {
  const [expanded, setExpanded] = React2.useState(false);
  const cap = max ?? Math.max(0, ...items.map((i) => Math.max(i.value, i.secondary ?? 0)));
  const shown = expanded ? items : items.slice(0, limit);
  const placeholders = Math.max(1, Math.min(loadingRows, limit));
  const hasSecondary = items.some((i) => i.secondary !== void 0) || loading && loadingSecondary;
  const secondaryCap = secondaryScale === "own" ? Math.max(0, ...items.map((i) => i.secondary ?? 0)) : cap;
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      className: classNames("mg-rails", className),
      "data-mg-rails": "",
      "data-secondary": hasSecondary ? "true" : void 0,
      children: [
        columns ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-rails-head", "aria-hidden": "true", children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: columns.value }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: columns.name }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: columns.track }),
          hasSecondary ? /* @__PURE__ */ jsxRuntime.jsx("span", { children: columns.secondary ?? "" }) : null
        ] }) : null,
        /* @__PURE__ */ jsxRuntime.jsxs(
          "div",
          {
            className: "mg-rails-rows",
            role: "group",
            "aria-label": ariaLabel,
            "aria-busy": loading || void 0,
            "data-marks": loading ? void 0 : "",
            children: [
              loading ? /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "sr-only", children: [
                "Loading ",
                ariaLabel
              ] }) : null,
              loading ? Array.from({ length: placeholders }, (_, index) => /* @__PURE__ */ jsxRuntime.jsx(
                RailSkeleton,
                {
                  hasSecondary
                },
                `skeleton-${index}`
              )) : /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
                /* @__PURE__ */ jsxRuntime.jsx(ChartTooltip, { top: "mark", offsetLeft: 268 }),
                shown.map((item) => /* @__PURE__ */ jsxRuntime.jsx(
                  Rail,
                  {
                    item,
                    cap,
                    secondaryCap,
                    scale,
                    formatValue,
                    formatSecondary: formatSecondary ?? formatValue,
                    hasSecondary,
                    source,
                    onActivate
                  },
                  item.key
                ))
              ] })
            ]
          }
        ),
        items.length > limit && !expanded && !loading ? /* @__PURE__ */ jsxRuntime.jsxs(
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
function RailSkeleton({ hasSecondary }) {
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-rails-row mg-rails-row--skeleton", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rails-value", children: /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "ml-auto h-3 w-10" }) }),
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rails-name", children: /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-3/5" }) }),
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rails-track", children: /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-full w-3/5" }) }),
    hasSecondary ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rails-track", "data-secondary": true, children: /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-full w-2/5" }) }) : null
  ] });
}
function Rail({
  item,
  cap,
  secondaryCap,
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
  const body = /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rails-value", children: formatValue(item.value) }),
    /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-rails-name", children: [
      item.avatar ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rails-avatar", children: item.avatar }) : null,
      /* @__PURE__ */ jsxRuntime.jsx("span", { children: item.label })
    ] }),
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rails-track", children: /* @__PURE__ */ jsxRuntime.jsx(
      "b",
      {
        style: {
          "--fill": `${railFill(item.value, cap, scale)}%`
        }
      }
    ) }),
    hasSecondary ? /* @__PURE__ */ jsxRuntime.jsx(
      "span",
      {
        className: "mg-rails-track",
        "data-secondary": true,
        title: item.secondary === void 0 ? void 0 : formatSecondary(item.secondary),
        children: /* @__PURE__ */ jsxRuntime.jsx(
          "b",
          {
            style: {
              "--fill": `${railFill(item.secondary ?? 0, secondaryCap, scale)}%`
            }
          }
        )
      }
    ) : null
  ] });
  const { role: _role, ...linkMark } = mark;
  return item.href ? /* @__PURE__ */ jsxRuntime.jsx("a", { ...linkMark, href: item.href, className: "mg-rails-row", children: body }) : /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", ...mark, className: "mg-rails-row", children: body });
}
var SCALE_INTERVALS = [0, 1, 2, 3, 4];
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
  className,
  loading = false,
  loadingRows = 5
}) {
  const placeholders = Math.max(1, loadingRows);
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      className: classNames("mg-marker-rail", className),
      "data-mg-marker-rail": "",
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-rails-head", "aria-hidden": "true", children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: columns.ratio }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: columns.name }),
          /* @__PURE__ */ jsxRuntime.jsx("span", { children: columns.scale })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs(
          "div",
          {
            className: "mg-rails-rows",
            role: "group",
            "aria-label": ariaLabel,
            "aria-busy": loading || void 0,
            "data-marks": loading ? void 0 : "",
            children: [
              loading ? /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "sr-only", children: [
                "Loading ",
                ariaLabel
              ] }) : null,
              loading ? Array.from({ length: placeholders }, (_, index) => /* @__PURE__ */ jsxRuntime.jsx(MarkerRowSkeleton, {}, `skeleton-${index}`)) : (items ?? []).map((item) => /* @__PURE__ */ jsxRuntime.jsx(
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
            ]
          }
        )
      ]
    }
  );
}
function MarkerRowSkeleton() {
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-rails-row mg-rails-row--skeleton", "aria-hidden": "true", children: [
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rails-value", children: /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "ml-auto h-3 w-10" }) }),
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rails-name", children: /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-3/5" }) }),
    /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-marker-rail-track", children: [
      /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-marker-rail-ticks", "aria-hidden": "true", children: SCALE_INTERVALS.map((interval) => /* @__PURE__ */ jsxRuntime.jsx("b", {}, interval)) }),
      /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-full w-full" })
    ] })
  ] });
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
  const body = /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rails-value", children: shown }),
    /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-rails-name", children: [
      item.avatar ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rails-avatar", children: item.avatar }) : null,
      item.tag ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rails-tag", children: item.tag }) : null,
      /* @__PURE__ */ jsxRuntime.jsx("span", { children: item.label })
    ] }),
    /* @__PURE__ */ jsxRuntime.jsxs(
      "span",
      {
        className: "mg-marker-rail-track",
        "data-empty": pos === null ? "true" : void 0,
        children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-marker-rail-ticks", "aria-hidden": "true", children: SCALE_INTERVALS.map((interval) => /* @__PURE__ */ jsxRuntime.jsx("b", {}, interval)) }),
          pos === null ? null : /* @__PURE__ */ jsxRuntime.jsx(
            "i",
            {
              className: "mg-marker-rail-marker",
              style: { "--pos": `${pos}%` }
            }
          )
        ]
      }
    )
  ] });
  const { role: _role, ...linkMark } = mark;
  return item.href ? /* @__PURE__ */ jsxRuntime.jsx("a", { ...linkMark, href: item.href, className: "mg-rails-row", children: body }) : /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", ...mark, className: "mg-rails-row", children: body });
}
function RankGrid({
  items,
  cols = 4,
  ariaLabel,
  source = "rank-grid",
  start = 1,
  onActivate,
  className,
  loading = false,
  loadingItems = cols
}) {
  const placeholders = Math.max(1, loadingItems);
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "ol",
    {
      className: classNames("mg-rank-grid", className),
      style: { "--cols": cols },
      role: "group",
      "aria-label": ariaLabel,
      "aria-busy": loading || void 0,
      "data-marks": loading ? void 0 : "",
      "data-mg-rank-grid": "",
      children: [
        loading ? /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "sr-only", children: [
          "Loading ",
          ariaLabel
        ] }) : null,
        loading ? Array.from({ length: placeholders }, (_, index) => /* @__PURE__ */ jsxRuntime.jsx(RankRowSkeleton, {}, `skeleton-${index}`)) : items.map((item, i) => /* @__PURE__ */ jsxRuntime.jsx(
          RankRow,
          {
            item,
            rank: start + i,
            source,
            onActivate
          },
          item.key
        ))
      ]
    }
  );
}
function RankRowSkeleton() {
  return /* @__PURE__ */ jsxRuntime.jsx("li", { "aria-hidden": "true", children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-rank-grid-row mg-rank-grid-row--skeleton", children: [
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rank-grid-rank", children: /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-3" }) }),
    /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-3" }),
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rank-grid-name", children: /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-3/5" }) }),
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rank-grid-value", children: /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-8" }) }),
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rank-grid-share", children: /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-7" }) })
  ] }) });
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
  const body = /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rank-grid-rank", children: String(rank).padStart(2, "0") }),
    item.avatar ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rank-grid-avatar", children: item.avatar }) : /* @__PURE__ */ jsxRuntime.jsx(
      "i",
      {
        className: "mg-swatch",
        style: { "--swatch": item.swatch ?? "var(--faint)" }
      }
    ),
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rank-grid-name", children: item.label }),
    item.value ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rank-grid-value", children: item.value }) : null,
    item.share ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-rank-grid-share", children: item.share }) : null
  ] });
  const { role: _role, ...linkMark } = mark;
  return /* @__PURE__ */ jsxRuntime.jsx("li", { "data-current": item.current ? "true" : void 0, children: item.href ? /* @__PURE__ */ jsxRuntime.jsx("a", { ...linkMark, href: item.href, className: "mg-rank-grid-row", children: body }) : /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", ...mark, className: "mg-rank-grid-row", children: body }) });
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
  className,
  loading = false,
  loadingItems = featured
}) {
  const placeholders = Math.max(featured, loadingItems);
  const leadCount = Math.min(featured, placeholders);
  const compactCount = Math.max(0, placeholders - leadCount);
  const lead = items.slice(0, featured);
  const rest = items.slice(featured);
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      className: classNames("mg-leaders", className),
      role: "group",
      "aria-label": ariaLabel,
      "aria-busy": loading || void 0,
      "data-marks": loading ? void 0 : "",
      "data-mg-leaders": "",
      children: [
        loading ? /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "sr-only", children: [
          "Loading ",
          ariaLabel
        ] }) : null,
        loading ? /* @__PURE__ */ jsxRuntime.jsx("ol", { className: "mg-leaders-featured", start: 1, children: Array.from({ length: leadCount }, (_, index) => /* @__PURE__ */ jsxRuntime.jsx(LeaderSkeleton, { variant: "featured" }, `featured-${index}`)) }) : lead.length > 0 ? /* @__PURE__ */ jsxRuntime.jsx("ol", { className: "mg-leaders-featured", start: 1, children: lead.map((item, i) => /* @__PURE__ */ jsxRuntime.jsx(
          LeaderCard,
          {
            item,
            rank: i + 1,
            variant: "featured",
            source
          },
          item.key
        )) }) : null,
        loading && compactCount > 0 ? /* @__PURE__ */ jsxRuntime.jsx("ol", { className: "mg-leaders-compact", start: leadCount + 1, children: Array.from({ length: compactCount }, (_, index) => /* @__PURE__ */ jsxRuntime.jsx(LeaderSkeleton, { variant: "compact" }, `compact-${index}`)) }) : rest.length > 0 ? /* @__PURE__ */ jsxRuntime.jsx("ol", { className: "mg-leaders-compact", start: lead.length + 1, children: rest.map((item, i) => /* @__PURE__ */ jsxRuntime.jsx(
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
function LeaderSkeleton({ variant }) {
  return /* @__PURE__ */ jsxRuntime.jsx("li", { "aria-hidden": "true", children: /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-leader", "data-variant": variant, children: [
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-leader-rank", children: /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-4" }) }),
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-leader-avatar", children: /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "size-5" }) }),
    /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-leader-copy", children: [
      /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-24 max-w-full" }),
      /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-14 max-w-full" })
    ] }),
    /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-leader-figures", children: /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-12" }) })
  ] }) });
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
  return /* @__PURE__ */ jsxRuntime.jsx("li", { children: /* @__PURE__ */ jsxRuntime.jsxs(
    "a",
    {
      ...linkMark,
      href: item.href,
      className: "mg-leader",
      "data-variant": variant,
      children: [
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-leader-rank", children: String(rank).padStart(2, "0") }),
        /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-leader-avatar", "aria-hidden": "true", children: item.avatar ?? initials }),
        /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-leader-copy", children: [
          /* @__PURE__ */ jsxRuntime.jsx("strong", { children: item.name }),
          item.sub ? /* @__PURE__ */ jsxRuntime.jsx("span", { children: item.sub }) : null
        ] }),
        /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-leader-figures", children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-leader-value", children: item.value }),
          delta.state !== "none" ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-leader-delta", "data-state": delta.state, children: delta.text }) : null
        ] })
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
  className,
  loading = false,
  loadingItems
}) {
  const own = React2.useRef(null);
  if (!registry && !own.current) own.current = new SeriesPaletteRegistry();
  const reg = registry ?? own.current;
  const { active, set, clear } = useActiveEntity();
  const barRef = React2.useRef(null);
  if (loading) {
    return /* @__PURE__ */ jsxRuntime.jsx(
      CompositionSkeleton,
      {
        ariaLabel,
        className,
        legendCols,
        loadingItems
      }
    );
  }
  const presentSegments = segments ?? [];
  const isResidual = (key) => key === OTHER_KEY || key === RESIDUAL_KEY;
  const ordered = [...presentSegments].sort((a, b) => {
    if (isResidual(a.key) !== isResidual(b.key))
      return isResidual(a.key) ? 1 : -1;
    return b.value - a.value;
  });
  const keep = limit === void 0 ? ordered : ordered.slice(0, limit);
  reg.assign(keep.map((s) => s.key));
  const palette = reg.palette();
  const shown = collapseOther(ordered, reg, other).filter((s) => s.value > 0);
  const total = shown.reduce((sum, s) => sum + s.value, 0);
  const activeKey = active && shown.some((s) => s.key === active.key) ? active.key : null;
  const legend = shown.map((s) => ({
    key: s.key,
    // collapseOther already decided this: a caller's residual keeps its own
    // label and the ramp's collapse takes the `other` prop. Re-deciding here
    // overwrote the caller's label with "Other".
    label: s.label,
    value: formatValue(s.value),
    share: total > 0 ? `${Math.round(s.value / total * 1e3) / 10}%` : void 0,
    swatch: palette.colorOf(s.key),
    href: presentSegments.find((o) => o.key === s.key)?.href
  }));
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      className: classNames("mg-composition", className),
      "data-mg-composition": "",
      children: [
        /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            ref: barRef,
            className: "mg-composition-bar",
            role: "img",
            "aria-label": `${ariaLabel}: ${legend.map((l) => `${l.label} ${l.share ?? l.value}`).join(", ")}`,
            "data-series-active": activeKey ? "true" : void 0,
            children: shown.map((s) => /* @__PURE__ */ jsxRuntime.jsx(
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
                      title: s.label,
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
                  // Keep the human-readable percentage for inspection and use
                  // the unitless share as the flex weight. The latter allocates
                  // the remaining bar width after inter-segment gaps, instead
                  // of adding every gap on top of 100% fixed-width segments.
                  "--weight": total > 0 ? String(s.value / total) : "0",
                  "--swatch": palette.colorOf(s.key)
                }
              },
              s.key
            ))
          }
        ),
        /* @__PURE__ */ jsxRuntime.jsx(
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
function CompositionSkeleton({
  ariaLabel,
  className,
  legendCols,
  loadingItems
}) {
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      className: classNames("mg-composition", className),
      "data-mg-composition": "",
      "data-loading": "true",
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs(
          "div",
          {
            className: "mg-composition-bar",
            role: "group",
            "aria-label": ariaLabel,
            "aria-busy": "true",
            children: [
              /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "sr-only", children: [
                "Loading ",
                ariaLabel
              ] }),
              /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-full flex-[1.25]" }),
              /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-full flex-1" }),
              /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-full flex-[0.75]" })
            ]
          }
        ),
        /* @__PURE__ */ jsxRuntime.jsx(
          RankGrid,
          {
            items: [],
            cols: legendCols,
            ariaLabel: `${ariaLabel} legend`,
            loading: true,
            loadingItems: loadingItems ?? legendCols
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
  value: `${(r.value / 1e6).toFixed(2)}M\u03C4`,
  delta: i === 3 ? "new" : i * 7 % 11 / 10 - 0.3,
  href: `/subnets/${i + 1}`
}));
function DataTableMenu({
  columns,
  visibleKeys,
  onVisibleKeys,
  csv,
  filename,
  shareUrl,
  label,
  pageSize,
  pageSizes,
  onPageSize
}) {
  const [copied, setCopied] = React2.useState(false);
  const toggle = (key) => {
    const next = visibleKeys.includes(key) ? visibleKeys.filter((k) => k !== key) : columns.filter((c) => c.key === key || visibleKeys.includes(c.key)).map((c) => c.key);
    if (next.length > 0) onVisibleKeys(next);
  };
  const download = () => {
    if (typeof document === "undefined") return;
    const blob = new Blob([csv()], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${filename.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.csv`;
    document.body.append(anchor);
    anchor.click();
    anchor.remove();
    URL.revokeObjectURL(url);
  };
  const copyLink = () => {
    const url = shareUrl ?? (typeof window === "undefined" ? "" : window.location.href);
    if (!url) return;
    void navigator.clipboard?.writeText(url).then(() => {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    });
  };
  return /* @__PURE__ */ jsxRuntime.jsxs(Popover, { children: [
    /* @__PURE__ */ jsxRuntime.jsx(PopoverTrigger, { asChild: true, children: /* @__PURE__ */ jsxRuntime.jsx(
      "button",
      {
        type: "button",
        className: "mg-dt-menu-trigger",
        "aria-label": `${label} options`,
        children: /* @__PURE__ */ jsxRuntime.jsx("span", { "aria-hidden": "true", children: "\u22EF" })
      }
    ) }),
    /* @__PURE__ */ jsxRuntime.jsxs(PopoverContent, { align: "end", className: "mg-dt-menu", children: [
      /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mg-dt-menu-heading", children: "Columns" }),
      /* @__PURE__ */ jsxRuntime.jsx("ul", { className: "mg-dt-menu-columns", children: columns.map((column) => /* @__PURE__ */ jsxRuntime.jsx("li", { children: /* @__PURE__ */ jsxRuntime.jsxs("label", { children: [
        /* @__PURE__ */ jsxRuntime.jsx(
          "input",
          {
            type: "checkbox",
            checked: visibleKeys.includes(column.key),
            onChange: () => toggle(column.key)
          }
        ),
        /* @__PURE__ */ jsxRuntime.jsx("span", { children: column.label })
      ] }) }, column.key)) }),
      onPageSize && pageSizes && pageSizes.length > 0 ? /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
        /* @__PURE__ */ jsxRuntime.jsx("p", { className: "mg-dt-menu-heading", children: "Rows per page" }),
        /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            className: "mg-dt-menu-sizes",
            role: "group",
            "aria-label": `${label} rows per page`,
            children: pageSizes.map((size) => /* @__PURE__ */ jsxRuntime.jsx(
              "button",
              {
                type: "button",
                "aria-pressed": size === pageSize,
                onClick: () => onPageSize(size),
                children: size
              },
              size
            ))
          }
        )
      ] }) : null,
      /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-dt-menu-actions", children: [
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", onClick: download, children: "Download CSV" }),
        /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", onClick: copyLink, children: copied ? "Link copied" : "Copy link" })
      ] })
    ] })
  ] });
}

// src/components/metagraphed/data-table/data-table-logic.ts
function nextSort(current, key) {
  if (!current || current.key !== key) return { key, dir: "asc" };
  if (current.dir === "asc") return { key, dir: "desc" };
  return null;
}
function isMissing(value) {
  return value === null || value === void 0 || value === "";
}
function compareValues(a, b) {
  if (isMissing(a) || isMissing(b))
    return isMissing(a) && isMissing(b) ? 0 : isMissing(a) ? 1 : -1;
  if (typeof a === "number" && typeof b === "number") return a - b;
  return String(a).localeCompare(String(b), "en-US", { numeric: true });
}
function sortRows(rows, sort, valueOf) {
  if (!sort) return [...rows];
  const decorated = rows.map((row, index) => ({
    row,
    index,
    value: valueOf(row, sort.key)
  }));
  decorated.sort((x, y) => {
    if (isMissing(x.value) || isMissing(y.value)) {
      if (!isMissing(x.value)) return -1;
      if (!isMissing(y.value)) return 1;
      return x.index - y.index;
    }
    const diff = compareValues(x.value, y.value);
    if (diff !== 0) return sort.dir === "asc" ? diff : -diff;
    return x.index - y.index;
  });
  return decorated.map((d) => d.row);
}
function pageCount(total, pageSize) {
  if (pageSize <= 0) return 1;
  return Math.max(1, Math.ceil(total / pageSize));
}
function pageSlice(rows, page, pageSize) {
  if (pageSize <= 0) return [...rows];
  const start = Math.max(0, (page - 1) * pageSize);
  return rows.slice(start, start + pageSize);
}
function rangeLabel(page, pageSize, total) {
  if (total <= 0) return "0";
  const start = Math.min(total, (page - 1) * pageSize + 1);
  const end = Math.min(total, page * pageSize);
  const n = (v) => v.toLocaleString("en-US");
  return `${n(start)}\u2013${n(end)} of ${n(total)}`;
}
function visibleRangeLabel(page, pageSize, rowCount) {
  if (rowCount <= 0 || pageSize <= 0) return "0";
  const start = Math.max(1, (page - 1) * pageSize + 1);
  const end = start + rowCount - 1;
  const n = (value) => value.toLocaleString("en-US");
  return start === end ? n(start) : `${n(start)}\u2013${n(end)}`;
}
function pageWindow(page, pages) {
  if (pages <= 7) return Array.from({ length: pages }, (_, i) => i + 1);
  const window2 = /* @__PURE__ */ new Set([1, pages, page]);
  for (const p of [page - 1, page + 1]) if (p > 1 && p < pages) window2.add(p);
  if (page <= 3) for (const p of [2, 3, 4]) window2.add(p);
  if (page >= pages - 2)
    for (const p of [pages - 3, pages - 2, pages - 1]) window2.add(p);
  const sorted = [...window2].filter((p) => p >= 1 && p <= pages).sort((a, b) => a - b);
  const out = [];
  let previous = 0;
  for (const p of sorted) {
    if (previous && p - previous > 1) out.push(null);
    out.push(p);
    previous = p;
  }
  return out;
}
function truncateIdentifier(value, head = 6, tail = 6) {
  if (value.length <= head + tail + 1) return value;
  return `${value.slice(0, head)}\u2026${value.slice(-tail)}`;
}
function csvField(value) {
  if (value === null || value === void 0) return "";
  const text = String(value);
  return /[",\n\r]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
function toCsv(rows, columns, valueOf) {
  const lines = [columns.map((c) => csvField(c.label)).join(",")];
  for (const row of rows)
    lines.push(columns.map((c) => csvField(valueOf(row, c.key))).join(","));
  return `${lines.join("\r\n")}\r
`;
}
function pickMobileMode(columnCount) {
  return columnCount <= 6 ? "cards" : "scroll";
}
function defaultVisibleKeys(columns) {
  return columns.filter((c) => !c.demote).map((c) => c.key);
}
function resolveVisibleKeys(columns, stored) {
  if (!stored) return defaultVisibleKeys(columns);
  const known = new Set(columns.map((c) => c.key));
  const kept = stored.filter((key) => known.has(key));
  return kept.length > 0 ? kept : defaultVisibleKeys(columns);
}
function shouldBoundViewport(renderedRows, threshold = 20) {
  return renderedRows > threshold;
}
var numberFormat = new Intl.NumberFormat("en-US", {
  maximumFractionDigits: 2
});
var DefaultLink2 = ({ href, children, ...rest }) => /* @__PURE__ */ jsxRuntime.jsx("a", { href, ...rest, children });
function defaultFormat3(kind, value) {
  if (value === null || value === void 0 || value === "") return "\u2014";
  if (kind === "number" || kind === "tint") {
    return typeof value === "number" ? numberFormat.format(value) : String(value);
  }
  if (kind === "delta" && typeof value === "number") {
    const pct = Math.round(value * 100);
    return pct > 0 ? `+${pct}%` : pct < 0 ? `\u2212${Math.abs(pct)}%` : "0%";
  }
  return String(value);
}
function statusTone(value) {
  const word = value.toLowerCase();
  if ([
    "ok",
    "up",
    "healthy",
    "active",
    "verified",
    "resolved",
    "passed"
  ].includes(word))
    return "good";
  if (["warn", "warning", "degraded", "stale", "partial", "pending"].includes(
    word
  ))
    return "warn";
  if (["down", "failed", "error", "offline", "rejected", "inactive"].includes(
    word
  ))
    return "bad";
  return "muted";
}
function DataTable({
  rows,
  columns,
  rowKey,
  caption,
  captionHidden,
  total,
  hasMore = false,
  captionCount: captionCountProp,
  sort: sortProp,
  onSort,
  page: pageProp,
  onPage,
  pageSize = 50,
  pageSizes,
  onPageSize,
  paginate,
  rowHref,
  link,
  onRowActivate,
  expand,
  search,
  filters,
  loading,
  empty,
  error,
  dense,
  mobile,
  compactMobileLabels,
  source = "table",
  storageKey,
  shareUrl,
  className,
  id
}) {
  const captionId = React2.useId();
  const [ownSort, setOwnSort] = React2.useState(null);
  const [ownPage, setOwnPage] = React2.useState(1);
  const [visibleKeys, setVisibleKeys] = React2.useState(
    () => defaultVisibleKeys(columns)
  );
  const [expanded, setExpanded] = React2.useState(null);
  const viewportRef = React2.useRef(null);
  const columnSignature = columns.map((c) => `${c.key}:${c.demote ? 1 : 0}`).join(",");
  const columnSpec = React2.useMemo(
    () => columnSignature.split(",").filter(Boolean).map((part) => {
      const [key, demoted] = part.split(":");
      return { key, demote: demoted === "1" };
    }),
    [columnSignature]
  );
  React2.useEffect(() => {
    if (!storageKey || typeof window === "undefined") return;
    try {
      const raw = window.localStorage.getItem(`mg-columns:${storageKey}`);
      setVisibleKeys(
        resolveVisibleKeys(
          columnSpec,
          raw ? JSON.parse(raw) : null
        )
      );
    } catch {
      setVisibleKeys(defaultVisibleKeys(columnSpec));
    }
  }, [storageKey, columnSpec]);
  React2.useEffect(() => {
    if (storageKey) return;
    setVisibleKeys((current) => {
      const known = new Set(columnSpec.map((c) => c.key));
      const kept = current.filter((key) => known.has(key));
      return kept.length === current.length ? current : kept;
    });
  }, [storageKey, columnSpec]);
  const sort = onSort ? sortProp ?? null : ownSort;
  const page = onPage ? pageProp ?? 1 : ownPage;
  const valueOf = React2.useCallback(
    (row, key) => {
      const column = columns.find((c) => c.key === key);
      return column?.value ? column.value(row) : void 0;
    },
    [columns]
  );
  const shown = React2.useMemo(
    () => columns.filter((c) => visibleKeys.includes(c.key)),
    [columns, visibleKeys]
  );
  const sorted = React2.useMemo(
    () => onSort ? [...rows] : sortRows(rows, sort, valueOf),
    [rows, sort, valueOf, onSort]
  );
  const hasExactTotal = typeof total === "number" || !onPage;
  const exactTotal = total ?? sorted.length;
  const pages = hasExactTotal ? pageCount(exactTotal, pageSize) : hasMore ? page + 1 : Math.max(1, page);
  const paging = paginate ?? (!onPage ? sorted.length > pageSize : hasExactTotal || hasMore || page > 1);
  const visibleRows = React2.useMemo(
    () => onPage || !paging ? sorted : pageSlice(sorted, page, pageSize),
    [sorted, page, pageSize, onPage, paging]
  );
  const bounded = shouldBoundViewport(visibleRows.length);
  const mobileMode = mobile ?? pickMobileMode(shown.length);
  const useCompactMobileLabels = compactMobileLabels && mobileMode === "cards";
  const nominatedLeadKey = shown.find(
    (column) => column.lead ?? column.mobileLead
  )?.key;
  const mobileLeadKey = mobileMode === "cards" ? nominatedLeadKey ?? shown[0]?.key : void 0;
  const rowLinkKey = nominatedLeadKey ?? shown[0]?.key;
  const captionCount = captionCountProp === void 0 ? total ?? rows.length : captionCountProp;
  const handleSort = (key) => {
    const next = nextSort(sort, key);
    if (onSort) onSort(next);
    else setOwnSort(next);
    if (onPage) onPage(1);
    else setOwnPage(1);
  };
  const goToPage = (next) => {
    if (onPage) onPage(next);
    else setOwnPage(next);
    viewportRef.current?.scrollTo({ top: 0 });
  };
  const csv = () => toCsv(sorted, shown, valueOf);
  const hasRows = visibleRows.length > 0;
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "div",
    {
      id,
      className: classNames("mg-dt", className),
      "data-mg-data-table": "",
      "data-expandable": expand ? "true" : void 0,
      "data-mobile": mobileMode,
      "data-mobile-label-template": useCompactMobileLabels ? captionId : void 0,
      "data-dense": dense ? "true" : void 0,
      children: [
        useCompactMobileLabels ? /* @__PURE__ */ jsxRuntime.jsx("style", { media: "(max-width: 1023px)", children: shown.map(
          (column, index) => `[data-mobile-label-template=${JSON.stringify(captionId)}] tbody td:nth-child(${index + 1})::before{content:${JSON.stringify(column.label)}}`
        ).join("") }) : null,
        /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-dt-caption", children: [
          /* @__PURE__ */ jsxRuntime.jsxs("p", { id: captionId, className: captionHidden ? "sr-only" : "mg-dt-title", children: [
            caption,
            captionCount != null && captionCount > 0 ? /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-dt-count", children: [
              " ",
              "(",
              captionCount.toLocaleString("en-US"),
              ")"
            ] }) : null
          ] }),
          /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-dt-tools", children: [
            search ? /* @__PURE__ */ jsxRuntime.jsx(
              "input",
              {
                type: "search",
                className: "mg-dt-search",
                value: search.value,
                onChange: (event) => search.onChange(event.target.value),
                placeholder: search.placeholder ?? "Search",
                "aria-label": `Search ${caption}`
              }
            ) : null,
            filters,
            /* @__PURE__ */ jsxRuntime.jsx(
              DataTableMenu,
              {
                columns,
                pageSize,
                pageSizes,
                onPageSize,
                visibleKeys,
                onVisibleKeys: (keys) => {
                  setVisibleKeys(keys);
                  if (storageKey && typeof window !== "undefined") {
                    try {
                      window.localStorage.setItem(
                        `mg-columns:${storageKey}`,
                        JSON.stringify(keys)
                      );
                    } catch {
                    }
                  }
                },
                csv,
                filename: caption,
                shareUrl,
                label: caption
              }
            )
          ] })
        ] }),
        /* @__PURE__ */ jsxRuntime.jsx(
          "div",
          {
            ref: viewportRef,
            className: classNames(
              "mg-dt-viewport",
              bounded ? "mg-dt-viewport-bounded" : null
            ),
            children: /* @__PURE__ */ jsxRuntime.jsxs("table", { "aria-labelledby": captionId, "aria-busy": loading || void 0, children: [
              /* @__PURE__ */ jsxRuntime.jsx("thead", { children: /* @__PURE__ */ jsxRuntime.jsx("tr", { children: shown.map((column) => {
                const active = sort?.key === column.key;
                return /* @__PURE__ */ jsxRuntime.jsxs(
                  "th",
                  {
                    scope: "col",
                    "data-align": column.align ?? (column.kind === "number" || column.kind === "delta" || column.kind === "tint" ? "right" : void 0),
                    "aria-sort": active ? sort.dir === "asc" ? "ascending" : "descending" : void 0,
                    style: column.width ? {
                      width: typeof column.width === "number" ? `${column.width}px` : column.width
                    } : void 0,
                    children: [
                      column.sortable ? /* @__PURE__ */ jsxRuntime.jsxs(
                        "button",
                        {
                          type: "button",
                          className: "mg-dt-sort",
                          onClick: () => handleSort(column.key),
                          "data-active": active ? "true" : void 0,
                          children: [
                            column.label,
                            /* @__PURE__ */ jsxRuntime.jsx(SortIcon, { dir: active ? sort.dir : null })
                          ]
                        }
                      ) : column.label,
                      column.definition ? /* @__PURE__ */ jsxRuntime.jsx(Definition, { term: column.definition }) : null
                    ]
                  },
                  column.key
                );
              }) }) }),
              /* @__PURE__ */ jsxRuntime.jsx("tbody", { children: loading ? Array.from({ length: 8 }, (_, i) => /* @__PURE__ */ jsxRuntime.jsx("tr", { className: "mg-dt-row mg-dt-skeleton", children: shown.map((column) => {
                const align = column.align ?? (column.kind === "number" || column.kind === "delta" || column.kind === "tint" ? "right" : void 0);
                return /* @__PURE__ */ jsxRuntime.jsx(
                  "td",
                  {
                    "data-label": mobileMode === "cards" && !useCompactMobileLabels ? column.label : void 0,
                    "data-lead": column.key === rowLinkKey ? "true" : void 0,
                    "data-mobile-lead": column.key === mobileLeadKey ? "true" : void 0,
                    "data-align": align,
                    "data-demote": column.demote ? "true" : void 0,
                    "data-wrap": column.wrap ? "true" : void 0,
                    "data-kind": column.kind === "tint" ? "tint" : void 0,
                    children: /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "h-3 w-full" })
                  },
                  column.key
                );
              }) }, `skeleton-${i}`)) : hasRows ? visibleRows.map((row) => /* @__PURE__ */ jsxRuntime.jsx(
                Row,
                {
                  row,
                  entityKey: rowKey(row),
                  expansionId: `${captionId}-${rowKey(row)}`,
                  cardLabels: mobileMode === "cards" && !useCompactMobileLabels,
                  mobileLeadKey,
                  rowLinkKey,
                  columns: shown,
                  href: rowHref?.(row),
                  link,
                  onActivate: onRowActivate ? () => onRowActivate(row) : void 0,
                  source,
                  expand,
                  expanded: expanded === rowKey(row),
                  onExpand: () => setExpanded(
                    (current) => current === rowKey(row) ? null : rowKey(row)
                  )
                },
                rowKey(row)
              )) : /* @__PURE__ */ jsxRuntime.jsx("tr", { className: "mg-dt-state", children: /* @__PURE__ */ jsxRuntime.jsx("td", { colSpan: shown.length, children: error ?? empty ?? "Nothing to show." }) }) })
            ] })
          }
        ),
        paging && pages > 1 ? /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "mg-dt-footer", children: [
          /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-dt-range", children: hasExactTotal ? rangeLabel(page, pageSize, exactTotal) : visibleRangeLabel(page, pageSize, rows.length) }),
          /* @__PURE__ */ jsxRuntime.jsxs("nav", { className: "mg-dt-pager", "aria-label": `${caption} pages`, children: [
            /* @__PURE__ */ jsxRuntime.jsx(
              "button",
              {
                type: "button",
                onClick: () => goToPage(page - 1),
                disabled: page <= 1,
                children: "Previous"
              }
            ),
            pageWindow(page, pages).map(
              (p, i) => p === null ? /* @__PURE__ */ jsxRuntime.jsx("span", { "aria-hidden": "true", children: "\u2026" }, `gap-${i}`) : /* @__PURE__ */ jsxRuntime.jsx(
                "button",
                {
                  type: "button",
                  onClick: () => goToPage(p),
                  "data-current": p === page ? "true" : void 0,
                  "aria-current": p === page ? "page" : void 0,
                  "aria-label": `Page ${p}`,
                  children: p
                },
                p
              )
            ),
            /* @__PURE__ */ jsxRuntime.jsx(
              "button",
              {
                type: "button",
                onClick: () => goToPage(page + 1),
                disabled: page >= pages,
                children: "Next"
              }
            )
          ] })
        ] }) : null
      ]
    }
  );
}
function Row({
  row,
  entityKey,
  expansionId,
  columns,
  cardLabels,
  mobileLeadKey,
  rowLinkKey,
  href,
  link,
  onActivate,
  source,
  expand,
  expanded,
  onExpand
}) {
  const expansion = expand ? expand(row) : null;
  const expandable = expansion !== null && expansion !== void 0 && expansion !== false;
  const mark = useEntityMark(entityKey, {
    source,
    label: entityKey,
    onActivate: expandable ? onExpand : onActivate
  });
  const {
    role: _role,
    tabIndex: _tabIndex,
    "aria-label": _label,
    ...rowMark
  } = mark;
  return /* @__PURE__ */ jsxRuntime.jsxs(jsxRuntime.Fragment, { children: [
    /* @__PURE__ */ jsxRuntime.jsx(
      "tr",
      {
        ...rowMark,
        className: "mg-dt-row",
        "data-expandable": expandable ? "true" : void 0,
        "data-expanded": expanded ? "true" : void 0,
        children: columns.map((column, index) => {
          const mobileLead = column.key === mobileLeadKey;
          const lead = column.key === rowLinkKey;
          return /* @__PURE__ */ jsxRuntime.jsx(
            Cell,
            {
              row,
              column,
              label: cardLabels ? column.label : void 0,
              lead,
              mobileLead,
              href: column.key === rowLinkKey ? href : void 0,
              link,
              disclosure: index === 0 && expandable ? { expanded, controls: expansionId, onToggle: onExpand } : void 0,
              onActivate: column.key === rowLinkKey && !href && !expandable ? onActivate : void 0
            },
            column.key
          );
        })
      }
    ),
    expandable && expanded ? /* @__PURE__ */ jsxRuntime.jsx("tr", { className: "mg-dt-expansion", id: expansionId, children: /* @__PURE__ */ jsxRuntime.jsx("td", { colSpan: columns.length, children: expansion }) }) : null
  ] });
}
function SortIcon({ dir }) {
  return /* @__PURE__ */ jsxRuntime.jsxs(
    "svg",
    {
      className: "mg-dt-sort-icon",
      viewBox: "0 0 24 24",
      fill: "none",
      stroke: "currentColor",
      strokeWidth: "2",
      strokeLinecap: "round",
      strokeLinejoin: "round",
      "aria-hidden": "true",
      children: [
        dir !== "asc" ? /* @__PURE__ */ jsxRuntime.jsx("path", { d: "m7 15 5 5 5-5" }) : null,
        dir !== "desc" ? /* @__PURE__ */ jsxRuntime.jsx("path", { d: "m7 9 5-5 5 5" }) : null
      ]
    }
  );
}
function Cell({
  row,
  column,
  label,
  lead,
  mobileLead,
  href,
  link,
  onActivate,
  disclosure
}) {
  const raw = column.value ? column.value(row) : void 0;
  const text = column.format ? column.format(raw, row) : defaultFormat3(column.kind, raw);
  const align = column.align ?? (column.kind === "number" || column.kind === "delta" || column.kind === "tint" ? "right" : void 0);
  const tint = column.kind === "tint" ? column.tint?.(row) ?? null : null;
  let body;
  let bodyIsLink = false;
  if (column.render) body = column.render(row);
  else if (column.kind === "identifier" && typeof raw === "string" && raw)
    body = /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-dt-id", title: raw, children: [
      /* @__PURE__ */ jsxRuntime.jsx("span", { children: truncateIdentifier(raw) }),
      /* @__PURE__ */ jsxRuntime.jsx(CopyButton, { value: raw, label: label ?? column.label, compact: true })
    ] });
  else if (column.kind === "status" && typeof raw === "string" && raw)
    body = /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-dt-status", "data-tone": statusTone(raw), children: [
      /* @__PURE__ */ jsxRuntime.jsx("i", { "aria-hidden": "true" }),
      raw
    ] });
  else if (column.kind === "time" && typeof raw === "string" && raw)
    body = /* @__PURE__ */ jsxRuntime.jsx(TimeAgo, { at: raw });
  else if (column.kind === "delta" && typeof raw === "number")
    body = /* @__PURE__ */ jsxRuntime.jsx(
      "span",
      {
        className: "mg-dt-delta",
        "data-state": raw > 0 ? "up" : raw < 0 ? "down" : "flat",
        children: text
      }
    );
  else if (column.kind === "link") {
    const to = column.href?.(row);
    const LinkCmp = link ?? DefaultLink2;
    bodyIsLink = Boolean(to);
    body = to ? /* @__PURE__ */ jsxRuntime.jsx(
      LinkCmp,
      {
        href: to,
        className: classNames("mg-dt-link", href && "mg-dt-rowlink"),
        children: text
      }
    ) : text;
  } else body = text;
  const RowLink = link ?? DefaultLink2;
  const toggle = disclosure === void 0 ? null : /* @__PURE__ */ jsxRuntime.jsx(
    "button",
    {
      type: "button",
      className: "mg-dt-disclosure",
      "aria-expanded": disclosure.expanded,
      "aria-controls": disclosure.expanded ? disclosure.controls : void 0,
      "aria-label": disclosure.expanded ? "Collapse row" : "Expand row",
      onClick: (event) => {
        event.stopPropagation();
        disclosure.onToggle();
      }
    }
  );
  const linked = href !== void 0 && !bodyIsLink ? /* @__PURE__ */ jsxRuntime.jsx(RowLink, { href, className: "mg-dt-rowlink", children: body }) : null;
  const content = disclosure !== void 0 ? /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-dt-rowlead", children: [
    toggle,
    linked ?? (bodyIsLink ? body : /* @__PURE__ */ jsxRuntime.jsx(
      "button",
      {
        type: "button",
        className: "mg-dt-rowbutton",
        "aria-expanded": disclosure.expanded,
        "aria-controls": disclosure.expanded ? disclosure.controls : void 0,
        onClick: (event) => {
          event.stopPropagation();
          disclosure.onToggle();
        },
        children: body
      }
    ))
  ] }) : linked !== null ? linked : bodyIsLink ? body : onActivate ? /* @__PURE__ */ jsxRuntime.jsx("button", { type: "button", className: "mg-dt-rowbutton", onClick: onActivate, children: body }) : body;
  return /* @__PURE__ */ jsxRuntime.jsx(
    "td",
    {
      "data-label": label,
      "data-lead": lead ? "true" : void 0,
      "data-mobile-lead": mobileLead ? "true" : void 0,
      "data-align": align,
      "data-demote": column.demote ? "true" : void 0,
      "data-wrap": column.wrap ? "true" : void 0,
      "data-kind": column.kind === "tint" ? "tint" : void 0,
      style: tint === null ? void 0 : { "--tint": `${Math.round(tint * 100)}%` },
      children: content
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
        className: "border-t border-border bg-surface p-3 space-y-1.5",
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
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-center justify-between gap-3 border-t border-health-down/30 bg-health-down/5 px-4 py-2 text-13", children: [
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
    return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-center justify-between gap-3 border-t border-health-warn/30 bg-health-warn/5 px-4 py-2 text-13 text-health-warn", children: [
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
  return /* @__PURE__ */ jsxRuntime.jsxs("div", { className: "flex items-center justify-between gap-3 border-t border-border bg-surface px-4 py-2 text-11 text-ink-muted", children: [
    /* @__PURE__ */ jsxRuntime.jsxs("span", { children: [
      shown,
      total != null ? ` of ${total}` : ""
    ] }),
    hasMore ? /* @__PURE__ */ jsxRuntime.jsx(
      "button",
      {
        type: "button",
        onClick: onLoadMore,
        className: "inline-flex items-center rounded border border-border bg-card px-3 py-1.5 text-13 font-medium hover:border-ink/30 min-h-9",
        children: "Load more"
      }
    ) : /* @__PURE__ */ jsxRuntime.jsx("span", { className: "opacity-60", children: "end of list" })
  ] });
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
        "flex min-w-0 flex-col",
        grow ? "flex-1 min-w-[180px]" : null,
        className
      ),
      children: [
        /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "sr-only", children: [
          label,
          hint ? /* @__PURE__ */ jsxRuntime.jsx("span", { children: hint }) : null
        ] }),
        children
      ]
    }
  );
}
var CONTROL_CLASSES = [
  "h-8 min-w-0 w-full rounded border border-transparent bg-transparent px-2.5",
  "text-13 text-ink-strong placeholder:text-ink-subtle-text",
  "mg-focus-ring transition-colors",
  "hover:border-border hover:bg-card focus-visible:border-border",
  "focus-visible:bg-card"
].join(" ");
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
function bestIndices(row) {
  if (!row.better) return [];
  const numeric = row.values.map(
    (v) => typeof v === "number" && Number.isFinite(v) ? v : null
  );
  const present = numeric.filter((v) => v !== null);
  if (present.length < 2) return [];
  const best = row.better === "high" ? Math.max(...present) : Math.min(...present);
  const winners = numeric.flatMap((v, i) => v === best ? [i] : []);
  return winners.length === present.length ? [] : winners;
}
var defaultFormat4 = (value) => typeof value === "number" ? value.toLocaleString("en-US") : value;
function CompareLedger({
  entities,
  groups,
  highlightBest = true,
  loading = false,
  ariaLabel,
  className
}) {
  return /* @__PURE__ */ jsxRuntime.jsx(
    "div",
    {
      className: classNames("mg-compare", className),
      "data-mg-compare": "",
      style: { "--mg-compare-cols": entities.length },
      children: /* @__PURE__ */ jsxRuntime.jsx("div", { className: "mg-compare-scroll", children: /* @__PURE__ */ jsxRuntime.jsxs("table", { "aria-busy": loading || void 0, "aria-label": ariaLabel, children: [
        /* @__PURE__ */ jsxRuntime.jsx("thead", { children: /* @__PURE__ */ jsxRuntime.jsxs("tr", { children: [
          /* @__PURE__ */ jsxRuntime.jsx("th", { scope: "col", children: /* @__PURE__ */ jsxRuntime.jsx("span", { className: "sr-only", children: "Metric" }) }),
          entities.map((entity) => /* @__PURE__ */ jsxRuntime.jsx("th", { scope: "col", children: /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-compare-entity", children: [
            entity.avatar ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-compare-avatar", children: entity.avatar }) : null,
            /* @__PURE__ */ jsxRuntime.jsxs("span", { className: "mg-compare-names", children: [
              entity.href ? /* @__PURE__ */ jsxRuntime.jsx("a", { href: entity.href, children: entity.name }) : /* @__PURE__ */ jsxRuntime.jsx("strong", { children: entity.name }),
              entity.sub ? /* @__PURE__ */ jsxRuntime.jsx("span", { children: entity.sub }) : null
            ] }),
            entity.onChange ? /* @__PURE__ */ jsxRuntime.jsx(
              "button",
              {
                type: "button",
                className: "mg-compare-change",
                onClick: entity.onChange,
                children: "Change"
              }
            ) : null
          ] }) }, entity.key))
        ] }) }),
        groups.map((group) => /* @__PURE__ */ jsxRuntime.jsxs("tbody", { children: [
          /* @__PURE__ */ jsxRuntime.jsx("tr", { className: "mg-compare-group", children: /* @__PURE__ */ jsxRuntime.jsx("th", { scope: "colgroup", colSpan: entities.length + 1, children: group.label }) }),
          group.rows.map((row) => {
            const winners = loading || !highlightBest ? [] : bestIndices(row);
            const format = row.format ?? defaultFormat4;
            return /* @__PURE__ */ jsxRuntime.jsxs("tr", { children: [
              /* @__PURE__ */ jsxRuntime.jsx("th", { scope: "row", children: row.label }),
              entities.map((entity, i) => {
                const value = row.values[i] ?? null;
                return /* @__PURE__ */ jsxRuntime.jsxs(
                  "td",
                  {
                    "data-best": winners.includes(i) ? "true" : void 0,
                    children: [
                      /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-compare-value", children: loading ? /* @__PURE__ */ jsxRuntime.jsx(Skeleton, { className: "ml-auto h-3 w-4/5 max-w-24" }) : value === null ? "\u2014" : format(value) }),
                      !loading && row.spark?.[i] ? /* @__PURE__ */ jsxRuntime.jsx("span", { className: "mg-compare-spark", children: row.spark[i] }) : null
                    ]
                  },
                  entity.key
                );
              })
            ] }, row.key);
          })
        ] }, group.label))
      ] }) })
    }
  );
}

exports.ActiveEntityProvider = ActiveEntityProvider;
exports.AnalyticsPage = AnalyticsPage;
exports.AnalyticsSection = AnalyticsSection;
exports.BackToTop = BackToTop;
exports.BrandIcon = BrandIcon;
exports.CHART_RAMP_SIZE = CHART_RAMP_SIZE;
exports.COMPOSITION_SPECIMEN = COMPOSITION_SPECIMEN;
exports.ChartTooltip = ChartTooltip;
exports.Chip = Chip;
exports.ClaudeIcon = ClaudeIcon;
exports.Command = Command;
exports.CommandDialog = CommandDialog;
exports.CommandEmpty = CommandEmpty;
exports.CommandGroup = CommandGroup;
exports.CommandInput = CommandInput;
exports.CommandItem = CommandItem;
exports.CommandList = CommandList;
exports.CommandSeparator = CommandSeparator;
exports.CommandShortcut = CommandShortcut;
exports.CompareLedger = CompareLedger;
exports.CompositionBreakdown = CompositionBreakdown;
exports.CopyButton = CopyButton;
exports.CopyIconToggle = CopyIconToggle;
exports.CopyableCode = CopyableCode;
exports.DataTable = DataTable;
exports.Definition = Definition;
exports.DefinitionsProvider = DefinitionsProvider;
exports.Dialog = Dialog;
exports.DialogContent = DialogContent;
exports.DialogDescription = DialogDescription;
exports.DialogFooter = DialogFooter;
exports.DialogHeader = DialogHeader;
exports.DialogTitle = DialogTitle;
exports.DiscordIcon = DiscordIcon;
exports.EmptyState = EmptyState;
exports.EntityHero = EntityHero;
exports.ExternalLink = ExternalLink;
exports.Fact = Fact;
exports.FactCell = FactCell;
exports.FactSentence = FactSentence;
exports.FactStrip = FactStrip;
exports.FilterField = FilterField;
exports.FilterInput = FilterInput;
exports.FilterSelect = FilterSelect;
exports.HealthDot = HealthDot;
exports.Kbd = Kbd;
exports.LEADER_SPECIMEN = LEADER_SPECIMEN;
exports.LINE_VIEWBOX = LINE_VIEWBOX;
exports.LeaderCards = LeaderCards;
exports.LineWithWindow = LineWithWindow;
exports.LiveMeta = LiveMeta;
exports.LiveTickerProvider = LiveTickerProvider;
exports.LoadMore = LoadMore;
exports.MARKER_SPECIMEN = MARKER_SPECIMEN;
exports.MAX_SECTIONS = MAX_SECTIONS;
exports.MarkerRail = MarkerRail;
exports.OTHER_COLOR = OTHER_COLOR;
exports.OTHER_KEY = OTHER_KEY;
exports.OpenAIIcon = OpenAIIcon;
exports.Panel = Panel;
exports.Popover = Popover;
exports.PopoverContent = PopoverContent;
exports.PopoverTrigger = PopoverTrigger;
exports.RAIL_SPECIMEN = RAIL_SPECIMEN;
exports.RESIDUAL_KEY = RESIDUAL_KEY;
exports.RangeControl = RangeControl;
exports.RankGrid = RankGrid;
exports.RankedRails = RankedRails;
exports.Raw = Raw;
exports.RawCode = RawCode;
exports.SCOPES = SCOPES;
exports.SectionHead = SectionHead;
exports.SectionNav = SectionNav;
exports.SeriesPaletteRegistry = SeriesPaletteRegistry;
exports.Sheet = Sheet;
exports.SheetContent = SheetContent;
exports.SheetDescription = SheetDescription;
exports.SheetFooter = SheetFooter;
exports.SheetHeader = SheetHeader;
exports.SheetTitle = SheetTitle;
exports.SheetTrigger = SheetTrigger;
exports.Skeleton = Skeleton;
exports.StackedColumns = StackedColumns;
exports.TimeAgo = TimeAgo;
exports.Toaster = Toaster;
exports.Wordmark = Wordmark;
exports.bestIndices = bestIndices;
exports.classNames = classNames;
exports.cn = cn;
exports.collapseOther = collapseOther;
exports.compareValues = compareValues;
exports.csvField = csvField;
exports.defaultVisibleKeys = defaultVisibleKeys;
exports.deltaLabel = deltaLabel;
exports.formatLineDate = formatLineDate;
exports.isMissing = isMissing;
exports.lineSpecimen = lineSpecimen;
exports.markAriaLabel = markAriaLabel;
exports.markerPosition = markerPosition;
exports.momentumAriaLabel = momentumAriaLabel;
exports.monthTicks = monthTicks;
exports.nextSort = nextSort;
exports.nextTabIndex = nextTabIndex;
exports.pageCount = pageCount;
exports.pageSlice = pageSlice;
exports.pageWindow = pageWindow;
exports.pickActiveSection = pickActiveSection;
exports.pickMobileMode = pickMobileMode;
exports.placePoints = placePoints;
exports.prefetchBrandIcon = prefetchBrandIcon;
exports.railFill = railFill;
exports.rangeLabel = rangeLabel;
exports.resolveVisibleKeys = resolveVisibleKeys;
exports.rovingTabIndex = rovingTabIndex;
exports.safeExternalUrl = safeExternalUrl;
exports.sectionItems = sectionItems;
exports.shouldBoundViewport = shouldBoundViewport;
exports.smoothPath = smoothPath;
exports.sortRows = sortRows;
exports.stackedSpecimen = stackedSpecimen;
exports.statusTone = statusTone;
exports.toCsv = toCsv;
exports.truncateIdentifier = truncateIdentifier;
exports.useActiveEntity = useActiveEntity;
exports.useActiveSection = useActiveSection;
exports.useDefinition = useDefinition;
exports.useEntityMark = useEntityMark;
exports.useIsActive = useIsActive;
exports.useRovingGroup = useRovingGroup;
exports.windowDelta = windowDelta;
exports.windowPoints = windowPoints;
