type Row = Record<string, unknown>;

export function openSites(root: unknown, name: string): string[] {
  const found: string[] = [];
  const walk = (node: unknown, at: string): void => {
    if (Array.isArray(node)) {
      for (const entry of node) walk(entry, at);
      return;
    }
    if (!node || typeof node !== "object") return;
    const row = node as Row;
    if (row.type === "object" || row.properties !== undefined) {
      const properties = row.properties as Row | undefined;
      const hasProperties = properties && Object.keys(properties).length > 0;
      const additional = row.additionalProperties;
      const typedRecord =
        additional &&
        typeof additional === "object" &&
        Object.keys(additional as Row).length > 0;
      // An object union declares its properties in the alternatives. Each
      // alternative must itself be typed; the recursive walk below still
      // audits nested object sites and any untyped branch.
      const typedUnion = ["oneOf", "anyOf"].some((key) => {
        const variants = row[key];
        return (
          Array.isArray(variants) &&
          variants.length > 0 &&
          variants.every((variant: unknown) => {
            if (
              !variant ||
              typeof variant !== "object" ||
              Array.isArray(variant)
            )
              return false;
            const branch = variant as Row;
            if (branch.type !== "object") return false;
            const props = branch.properties;
            const record = branch.additionalProperties;
            return Boolean(
              (props &&
                typeof props === "object" &&
                Object.keys(props).length > 0) ||
              (record &&
                typeof record === "object" &&
                Object.keys(record).length > 0),
            );
          })
        );
      });
      if (!hasProperties && !typedRecord && !typedUnion) found.push(at);
    }
    for (const [key, value] of Object.entries(row)) {
      // Annotations, not shape.
      if (["examples", "enum", "description", "default", "title"].includes(key))
        continue;
      if (key === "properties") {
        for (const [name, child] of Object.entries(value as Row))
          walk(child, `${at}.${name}`);
        continue;
      }
      if (key === "items") {
        walk(value, `${at}[]`);
        continue;
      }
      if (key === "additionalProperties") {
        walk(value, `${at}{}`);
        continue;
      }
      // A union branch is the SAME site: which branch an open object landed in
      // is an implementation detail of how the schema was written.
      if (["anyOf", "oneOf", "allOf"].includes(key)) {
        for (const branch of value as unknown[]) walk(branch, at);
        continue;
      }
      if (value && typeof value === "object") walk(value, at);
    }
  };
  walk(root, name);
  return [...new Set(found)];
}
