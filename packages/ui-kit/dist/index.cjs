'use strict';

var jsxRuntime = require('react/jsx-runtime');

// src/PlaceholderCard.tsx
function PlaceholderCard({ label }) {
  return /* @__PURE__ */ jsxRuntime.jsx("div", { className: "ui-kit-placeholder-card", children: label });
}

exports.PlaceholderCard = PlaceholderCard;
