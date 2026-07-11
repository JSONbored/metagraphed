import { jsx } from 'react/jsx-runtime';

// src/PlaceholderCard.tsx
function PlaceholderCard({ label }) {
  return /* @__PURE__ */ jsx("div", { className: "ui-kit-placeholder-card", children: label });
}

export { PlaceholderCard };
