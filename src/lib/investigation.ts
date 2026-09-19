// Pure investigation policy; no repository execution or model access.
export const issueKinds = ["module_resolution", "package_exports", "type_declaration", "logic_bug", "validation", "ui_state", "config", "api_change", "build_config", "documentation", "test_related", "unknown"] as const;
export type IssueAnalysis = {
  kinds: (typeof issueKinds)[number][];
  summary: string;
  expectedBehavior: string;
  observedBehavior: string;
  importantSymbols: string[];
  importantPaths: string[];
  errorMessages: string[];
  likelyEvidenceSurfaces: string[];
  maintainerClarifications: string[];
  reproductionDetails: string[];
  proposedApproaches: string[];
  constraints: string[];
};
export type MissingEvidence = { fact: string; whyNeeded: string };
export const stringList = { type: "array", maxItems: 20, items: { type: "string", maxLength: 2000 } };
export const analysisSchema = {
  type: "object", additionalProperties: false,
  required: ["kinds", "summary", "expectedBehavior", "observedBehavior", "importantSymbols", "importantPaths", "errorMessages", "likelyEvidenceSurfaces", "maintainerClarifications", "reproductionDetails", "proposedApproaches", "constraints"],
  properties: {
    kinds: { type: "array", minItems: 1, maxItems: 5, items: { type: "string", enum: issueKinds } },
    summary: { type: "string", minLength: 1 }, expectedBehavior: { type: "string", minLength: 1 }, observedBehavior: { type: "string" },
    importantSymbols: stringList, importantPaths: stringList, errorMessages: stringList, likelyEvidenceSurfaces: stringList,
    maintainerClarifications: stringList, reproductionDetails: stringList, proposedApproaches: stringList, constraints: stringList,
  },
};
export type Schema = { type?: string; enum?: readonly unknown[]; required?: readonly string[]; properties?: Record<string, Schema>; additionalProperties?: boolean; items?: Schema; minItems?: number; maxItems?: number; minLength?: number; maxLength?: number; minimum?: number; maximum?: number };

export function cleanAndExtractJson(raw: string): string {
  if (!raw || typeof raw !== "string") return "";
  let trimmed = raw.trim();
  // Strip markdown code fences if wrapped
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenceMatch?.[1]) {
    trimmed = fenceMatch[1].trim();
  }
  // If not starting with { or [, locate the first JSON opening bracket
  const firstBrace = trimmed.indexOf("{");
  const firstBracket = trimmed.indexOf("[");
  let startIdx = -1;
  let endChar = "";
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    startIdx = firstBrace;
    endChar = "}";
  } else if (firstBracket !== -1) {
    startIdx = firstBracket;
    endChar = "]";
  }
  if (startIdx !== -1) {
    const lastIdx = trimmed.lastIndexOf(endChar);
    if (lastIdx > startIdx) {
      trimmed = trimmed.slice(startIdx, lastIdx + 1);
    }
  }
  // If it parses directly, return as-is
  try {
    JSON.parse(trimmed);
    return trimmed;
  } catch {
    // Strip comments and trailing commas to repair common LLM syntax slips
    const stripped = trimmed
      .replace(/\/\*[\s\S]*?\*\/|([^:]|^)\/\/.*$/gm, "$1")
      .replace(/,\s*([}\]])/g, "$1")
      .trim();
    return stripped;
  }
}

export function repairAgainstSchema(value: unknown, schema: Schema): unknown {
  if (!schema || typeof schema !== "object") return value;

  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const obj = { ...(value as Record<string, unknown>) };
    if (schema.properties) {
      for (const [key, propSchema] of Object.entries(schema.properties)) {
        if (Object.hasOwn(obj, key)) {
          obj[key] = repairAgainstSchema(obj[key], propSchema);
        } else if (schema.required && schema.required.includes(key)) {
          // Provide safe default for required properties
          if (propSchema.type === "array") obj[key] = [];
          else if (propSchema.type === "string") obj[key] = propSchema.enum ? propSchema.enum[0] : "";
          else if (propSchema.type === "boolean") obj[key] = false;
          else if (propSchema.type === "number") obj[key] = propSchema.minimum ?? 0;
          else if (propSchema.type === "object") obj[key] = repairAgainstSchema({}, propSchema);
        }
      }
      // Prune unallowed extra properties so strict additionalProperties: false conforms
      if (schema.additionalProperties === false) {
        for (const key of Object.keys(obj)) {
          if (!Object.hasOwn(schema.properties, key)) {
            delete obj[key];
          }
        }
      }
    }
    return obj;
  }

  if (schema.type === "array") {
    if (value === null || value === undefined) return [];
    let arr = Array.isArray(value) ? [...value] : [value];
    if (schema.items) {
      arr = arr.map((item) => repairAgainstSchema(item, schema.items!));
    }
    if (typeof schema.maxItems === "number" && arr.length > schema.maxItems) {
      arr = arr.slice(0, schema.maxItems);
    }
    return arr;
  }

  if (schema.type === "string") {
    if (typeof value !== "string") {
      if (value === null || value === undefined) value = "";
      else value = String(value);
    }
    let str = value as string;
    if (schema.enum && !schema.enum.includes(str)) {
      const match = schema.enum.find((e) => typeof e === "string" && e.toLowerCase() === str.toLowerCase());
      if (match !== undefined) str = match as string;
      else if (schema.enum.length > 0) str = schema.enum[0] as string;
    }
    if (typeof schema.maxLength === "number" && str.length > schema.maxLength) {
      str = str.slice(0, schema.maxLength);
    }
    return str;
  }

  if (schema.type === "number") {
    if (typeof value === "string") {
      const parsed = parseFloat(value.replace("%", ""));
      if (Number.isFinite(parsed)) value = parsed;
    }
    let num = typeof value === "number" && Number.isFinite(value) ? value : (schema.minimum ?? 0);
    if (schema.maximum === 1 && (schema.minimum ?? 0) === 0 && num > 1 && num <= 100) {
      num = num / 100;
    }
    if (typeof schema.minimum === "number" && num < schema.minimum) num = schema.minimum;
    if (typeof schema.maximum === "number" && num > schema.maximum) num = schema.maximum;
    return num;
  }

  if (schema.type === "boolean") {
    if (typeof value === "string") {
      if (value.toLowerCase() === "true") return true;
      if (value.toLowerCase() === "false") return false;
    }
    return Boolean(value);
  }

  return value;
}

export function validateSchemaDetails(value: unknown, schema: Schema, path = ""): string | null {
  if (schema.enum && !schema.enum.includes(value)) {
    return `${path || "root"}: value must be one of ${JSON.stringify(schema.enum)}`;
  }
  if (schema.type === "string") {
    if (typeof value !== "string") return `${path || "root"}: expected string`;
    if (value.length < (schema.minLength ?? 0) && value.trim().length === 0) return `${path || "root"}: string must not be empty`;
    if (typeof schema.maxLength === "number" && value.length > schema.maxLength) return `${path || "root"}: string exceeds max length ${schema.maxLength}`;
    return null;
  }
  if (schema.type === "number") {
    if (typeof value !== "number" || !Number.isFinite(value)) return `${path || "root"}: expected finite number`;
    if (value < (schema.minimum ?? -Infinity) || value > (schema.maximum ?? Infinity)) return `${path || "root"}: number out of range`;
    return null;
  }
  if (schema.type === "boolean") {
    return typeof value === "boolean" ? null : `${path || "root"}: expected boolean`;
  }
  if (schema.type === "array") {
    if (!Array.isArray(value)) return `${path || "root"}: expected array`;
    if (value.length < (schema.minItems ?? 0)) return `${path || "root"}: array has fewer than ${schema.minItems} items`;
    if (typeof schema.maxItems === "number" && value.length > schema.maxItems) return `${path || "root"}: array exceeds max items ${schema.maxItems}`;
    if (schema.items) {
      for (let i = 0; i < value.length; i++) {
        const err = validateSchemaDetails(value[i], schema.items, `${path}[${i}]`);
        if (err) return err;
      }
    }
    return null;
  }
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return `${path || "root"}: expected object`;
    const object = value as Record<string, unknown>;
    for (const key of schema.required ?? []) {
      if (!Object.hasOwn(object, key)) return `${path ? `${path}.${key}` : key}: required property is missing`;
    }
    for (const [key, item] of Object.entries(object)) {
      if (schema.properties?.[key]) {
        const err = validateSchemaDetails(item, schema.properties[key], path ? `${path}.${key}` : key);
        if (err) return err;
      } else if (schema.additionalProperties === false) {
        return `${path ? `${path}.${key}` : key}: extra property not allowed`;
      }
    }
    return null;
  }
  return null;
}

export function conforms(value: unknown, schema: Schema): boolean {
  if (schema.enum && !schema.enum.includes(value)) return false;
  if (schema.type === "string") return typeof value === "string" && (value.length >= (schema.minLength ?? 0) || value.trim().length > 0) && (typeof schema.maxLength !== "number" || value.length <= schema.maxLength);
  if (schema.type === "number") return typeof value === "number" && Number.isFinite(value) && value >= (schema.minimum ?? -Infinity) && value <= (schema.maximum ?? Infinity);
  if (schema.type === "boolean") return typeof value === "boolean";
  if (schema.type === "array") return Array.isArray(value) && value.length >= (schema.minItems ?? 0) && (typeof schema.maxItems !== "number" || value.length <= schema.maxItems) && value.every((item) => !schema.items || conforms(item, schema.items));
  if (schema.type === "object") {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const object = value as Record<string, unknown>;
    return (schema.required ?? []).every((key) => Object.hasOwn(object, key)) && Object.entries(object).every(([key, item]) => schema.properties?.[key] ? conforms(item, schema.properties[key]) : schema.additionalProperties !== false);
  }
  return true;
}
export function normalizeQuery(value: string): string | null {
  const query = value.trim().replace(/^["'`]|["'`]$/g, "").replace(/\((?:\.\.\.)?\)$/, "").replace(/\s+/g, " ");
  if (!query || query.length > 80 || query.split(" ").length > 8) return null;
  if (/^(index|package|source|src|file|code|test|build|config|readme)$/i.test(query)) return null;
  if (/[|\n\r]/.test(query)) return null;
  if (/^(search|inspect|read|find|locate|check|understand|the|whether|more|please)\b/i.test(query) || /\b(to understand|would|should|because|already|and then|need to)\b/i.test(query)) return null;
  return query;
}

export function proposedDiff(path: string, before: string | null, after: string | null) {
  const lines = (text: string | null) => !text ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n");
  const created = before === null;
  const deleted = after === null;
  if (created || deleted) {
    const changed = lines(created ? after : before);
    const header = created
      ? [`diff --git a/${path} b/${path}`, "new file mode 100644", "--- /dev/null", `+++ b/${path}`, `@@ -0,0 +1,${changed.length} @@`]
      : [`diff --git a/${path} b/${path}`, "deleted file mode 100644", `--- a/${path}`, "+++ /dev/null", `@@ -1,${changed.length} +0,0 @@`];
    const marker = created ? "+" : "-";
    return { diff: [...header, ...changed.map((line) => marker + line)].join("\n") + "\n", additions: created ? changed.length : 0, deletions: deleted ? changed.length : 0 };
  }
  const old = lines(before); const next = lines(after);
  let prefix = 0;
  while (prefix < old.length && prefix < next.length && old[prefix] === next[prefix]) prefix++;
  // Include the final line when only EOF newline changes.
  if (prefix === old.length && prefix === next.length && before!.endsWith("\n") !== after!.endsWith("\n")) prefix = Math.max(0, prefix - 1);
  let suffix = 0;
  while (before!.endsWith("\n") === after!.endsWith("\n") && suffix < old.length - prefix && suffix < next.length - prefix && old[old.length - 1 - suffix] === next[next.length - 1 - suffix]) suffix++;
  const start = Math.max(0, prefix - 3); const oldEnd = Math.min(old.length, old.length - suffix + 3); const newEnd = Math.min(next.length, next.length - suffix + 3);
  const output = [`diff --git a/${path} b/${path}`, `--- a/${path}`, `+++ b/${path}`, `@@ -${oldEnd - start ? start + 1 : start},${oldEnd - start} +${newEnd - start ? start + 1 : start},${newEnd - start} @@`];
  const push = (sign: string, text: string, finalWithoutNewline: boolean) => { output.push(sign + text); if (finalWithoutNewline) output.push("\\ No newline at end of file"); };
  for (let i = start; i < prefix; i++) push(" ", old[i], i === old.length - 1 && !before!.endsWith("\n"));
  for (let i = prefix; i < old.length - suffix; i++) push("-", old[i], i === old.length - 1 && !before!.endsWith("\n"));
  for (let i = prefix; i < next.length - suffix; i++) push("+", next[i], i === next.length - 1 && !after!.endsWith("\n"));
  for (let i = old.length - suffix; i < oldEnd; i++) push(" ", old[i], i === old.length - 1 && !before!.endsWith("\n"));
  return { diff: output.join("\n") + "\n", additions: next.length - prefix - suffix, deletions: old.length - prefix - suffix };
}
const surfaces: Record<string, RegExp> = {
  module_resolution: /package\.json$|tsconfig|\.d\.[cm]?ts$|(?:index|entry|lite)\.[cm]?[jt]s$|resolve|readme/i,
  package_exports: /package\.json$|\.d\.[cm]?ts$|rollup|tsup|exports|readme/i,
  type_declaration: /\.d\.[cm]?ts$|types|tsconfig|package\.json$/i,
  ui_state: /hook|provider|context|state|storage|component/i,
  validation: /schema|parser|validat|request|model/i,
  config: /config|package\.json$|\.ya?ml$/i,
  build_config: /config|package\.json$|rollup|webpack|vite|tsup/i,
  documentation: /readme|docs?\/|\.mdx?$/i,
  test_related: /test|spec|fixture/i,
  api_change: /api|routes?|index|\.d\.[cm]?ts$/i,
  logic_bug: /src\/|lib\/|test|spec/i,
};
export function repositoryStructure(paths: string[]) {
  const packages = paths.filter((path) => /(^|\/)package\.json$/.test(path));
  return { kind: packages.length > 1 ? "monorepo" : "single package", packages, source: paths.filter((p) => /(^|\/)(src|lib)\//.test(p)), tests: paths.filter((p) => /test|spec|fixture/i.test(p)), declarations: paths.filter((p) => /\.d\.[cm]?ts$/.test(p)), configuration: paths.filter((p) => /config|package\.json$|\.ya?ml$/.test(p)), generated: paths.filter((p) => /(^|\/)(dist|build|generated)\//.test(p)) };
}
export function relatedPaths(path: string, content: string, paths: string[]): string[] {
  const related = new Set<string>();
  for (const match of content.matchAll(/(?:from\s*|require\s*\(|import\s*\(|export\s*[^\n]*from\s*)["']([^"']+)["']/g)) {
    const reference = match[1];
    if (!reference.startsWith(".")) continue;
    const parts = [...path.split("/").slice(0, -1), ...reference.split("/")]; const normalized: string[] = [];
    for (const part of parts) { if (part === "..") normalized.pop(); else if (part !== ".") normalized.push(part); }
    const target = normalized.join("/").replace(/\.[cm]?js$/, "");
    paths.filter((p) => p === target || p.replace(/\.[cm]?[jt]sx?$/, "") === target || p.replace(/\/index\.[cm]?[jt]sx?$/, "") === target).forEach((p) => related.add(p));
  }
  const stem = path.split("/").pop()!.replace(/(?:\.d)?\.[^.]+$/, "");
  paths.filter((p) => p !== path && !/(^|\/)(bench|benchmark|bin|scripts)\//.test(p) && p.split("/").pop()!.replace(/(?:\.test|\.spec|\.d)?\.[^.]+$/, "") === stem).forEach((p) => related.add(p));
  // Package exports, declaration paths, and build entry points are observable references too.
  for (const match of content.matchAll(/["'](?:\.\/)?([^"'\s]+\.[cm]?[jt]sx?)["']/g)) {
    const prefix = path.split("/").slice(0, -1).join("/"); const candidate = [prefix, match[1]].filter(Boolean).join("/");
    if (paths.includes(candidate)) related.add(candidate);
  }
  return [...related];
}
export function candidateScore(path: string, analysis: IssueAnalysis, related: Set<string>, content = "") {
  let score = /(^|\/)(dist|build|generated)\//.test(path) ? -20 : 1;
  if (/(^|\/)(src|lib)\//.test(path)) score += 16;
  if (/\.d\.[cm]?ts$/.test(path)) score += 8;
  if (/(^|\/)package\.json$/.test(path)) score += 8;
  if (/(^|\/)(test|tests|__tests__)\//.test(path)) score += 5;
  if (/(^|\/)(bench|benchmark|bin|scripts)\//.test(path)) score -= 12;
  for (const mentioned of analysis.importantPaths) { if (path === mentioned || path.endsWith("/" + mentioned)) score += 25; else if (path.split("/").pop() === mentioned.split("/").pop()) score += 10; }
  for (const symbol of analysis.importantSymbols) { if (path.toLowerCase().includes(symbol.toLowerCase())) score += 10; if (content.includes(symbol)) score += 5; }
  for (const kind of analysis.kinds) if (surfaces[kind]?.test(path)) score += 8;
  if (related.has(path)) score += 20;
  if (/test|spec/i.test(path) && related.has(path)) score += 6;
  if (analysis.importantPaths.some((p) => p.includes("/") && path.startsWith(p.split("/").slice(0, -1).join("/") + "/"))) score += 4;
  return score;
}

// Normalize only harmless repository-relative spelling differences. Never guess by basename.
export function canonicalPath(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "");
}

export function classifyFileRole(path: string): import("./pilot-types").FileRole {
  if (/\.d\.[cm]?ts$/i.test(path)) return "types";
  const norm = path.toLowerCase().replace(/\\/g, "/");
  if (/(^|\/)(dist|build|coverage|\.next|out|generated|vendor)(\/|$)/.test(norm) || /\.min\.[cm]?[jt]s$/.test(norm)) {
    return "generated";
  }
  if (/(^|\/)(tests?|__tests__|specs?|fixtures?)(\/|$)/.test(norm) || /\.(test|spec)\.[cm]?[jt]sx?$/.test(norm)) {
    return "test";
  }
  if (/(^|\/)(docs?|documentation)(\/|$)/.test(norm) || /\.(md|mdx|txt|rst)$/.test(norm) || /(^|\/)license/i.test(norm)) {
    return "docs";
  }
  if (
    /(^|\/)(package\.json|tsconfig.*\.json|\.eslintrc.*|\.prettierrc.*|rollup\.config.*|webpack\.config.*|vite\.config.*|jest\.config.*|\.babelrc.*|turbo\.json)$/.test(norm) ||
    /\.(ya?ml|toml|ini|env(\..+)?)$/.test(norm)
  ) {
    return "config";
  }
  return "source";
}

export function isImplementationIssue(analysis?: Partial<IssueAnalysis>): boolean {
  if (!analysis) return true;
  const kinds = analysis.kinds ?? [];
  if (kinds.length > 0 && kinds.every((k) => k === "documentation")) return false;
  if (
    kinds.length === 0 &&
    (analysis.importantPaths ?? []).length > 0 &&
    (analysis.importantPaths ?? []).every((p) => /\.(md|mdx|txt|rst)$/i.test(p))
  ) {
    return false;
  }
  return kinds.some((k) => k !== "documentation") || (analysis.importantSymbols ?? []).length > 0;
}

export function extractStructuredRequirements(
  analysis: IssueAnalysis,
  issueTitle = "",
  issueBody = ""
): import("./pilot-types").StructuredRequirement[] {
  const list: import("./pilot-types").StructuredRequirement[] = [];
  let reqIndex = 1;
  const nextId = () => `R${reqIndex++}`;

  const bodyBullets: string[] = [];
  if (issueBody) {
    const lines = issueBody.split("\n");
    let inReqSection = false;
    for (const line of lines) {
      const trimmed = line.trim();
      if (/^#{1,6}[^\w\n]*(requirements|acceptance criteria|tasks|specification)/i.test(trimmed)) {
        inReqSection = true;
        continue;
      }
      if (inReqSection && /^#{1,6}(\s+|$)/.test(trimmed)) {
        inReqSection = false;
        continue;
      }
      if (inReqSection) {
        const bulletMatch = trimmed.match(/^[-*]\s+(?:\[[ xX]\]\s+)?(.+)$/);
        if (bulletMatch && bulletMatch[1].length >= 5) {
          bodyBullets.push(bulletMatch[1].trim());
        }
      }
    }
  }

  const isImpl = isImplementationIssue(analysis);

  if (bodyBullets.length > 0) {
    const seen = new Set<string>();
    for (const bullet of bodyBullets) {
      const norm = bullet.toLowerCase().replace(/[`'".,]/g, "").trim();
      if (seen.has(norm)) continue;
      seen.add(norm);
      if (list.some((r) => r.text.toLowerCase().replace(/[`'".,]/g, "").trim() === norm)) continue;
      const isTest = /\b(tests?|specs?|assert(?:ion)?s?|coverage)\b/i.test(bullet);
      const isPreserve = /\b(preserve[ds]?|preserving|backward|compatibility|avoid mutating|without changing|existing)\b/i.test(bullet);
      const isDocs = /\b(docs?|jsdocs?|examples?|readme|documentation)\b/i.test(bullet);
      const type: import("./pilot-types").RequirementType = isTest
        ? "mustTest"
        : isPreserve
        ? "mustPreserve"
        : isDocs || !isImpl
        ? "optionalDocs"
        : "mustImplement";
      list.push({
        id: nextId(),
        type,
        text: bullet,
        status: "unmapped",
      });
      if (list.length >= 12) break;
    }
  } else {
    if (analysis.expectedBehavior) {
      list.push({
        id: nextId(),
        type: isImpl ? "mustImplement" : "optionalDocs",
        text: analysis.expectedBehavior,
        status: "unmapped",
      });
    }
  }

  // The issue-analysis stage identifies maintainer comments separately from
  // speculation. Preserve only imperative clarifications as requirements.
  for (const clarification of analysis.maintainerClarifications || []) {
    const text = clarification.trim();
    if (!text || list.some((requirement) => requirement.text.toLowerCase() === text.toLowerCase())) continue;
    if (!/\b(must|should|need(?:s)? to|required?|please|do not)\b/i.test(text)) continue;
    const type: import("./pilot-types").RequirementType = /\b(tests?|specs?|assert(?:ion)?s?|coverage)\b/i.test(text)
      ? "mustTest"
      : /\b(preserve[ds]?|preserving|backward|compatibility|avoid mutating|without changing|existing)\b/i.test(text)
      ? "mustPreserve"
      : /\b(docs?|jsdocs?|examples?|readme|documentation)\b/i.test(text) || !isImpl
      ? "optionalDocs"
      : "mustImplement";
    list.push({ id: nextId(), type, text, status: "unmapped" });
  }

  for (const constraint of (analysis.constraints || []).slice(0, 3)) {
    if (!list.some((r) => r.text === constraint)) {
      list.push({
        id: nextId(),
        type: "mustPreserve",
        text: constraint,
        status: "unmapped",
      });
    }
  }

  if (isImpl) {
    if (!list.some((r) => r.type === "mustImplement")) {
      list.unshift({
        id: "R0",
        type: "mustImplement",
        text: analysis.summary || issueTitle || "Implement requested changes",
        status: "unmapped",
      });
    }
  } else {
    if (!list.some((r) => r.type === "optionalDocs" || r.type === "mustImplement")) {
      list.unshift({
        id: "R0",
        type: "optionalDocs",
        text: analysis.summary || issueTitle || "Update documentation as requested",
        status: "unmapped",
      });
    }
  }

  return list.map((req, i) => ({ ...req, id: `R${i + 1}` }));
}

export function symbolExistsInSource(symbol: string, diff: string, content: string): boolean {
  const clean = symbol.replace(/\(.*$/, "").trim();
  if (!clean || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(clean)) return true;
  const addedLines = diff
    .split("\n")
    .filter((l) => l.startsWith("+") && !l.startsWith("+++"))
    .join("\n");
  const regex = new RegExp(`\\b${clean}\\b`);
  return regex.test(addedLines) || regex.test(content);
}

export function checkTestImportsAgainstSource(
  testContent: string,
  sourceContent: string,
  allInspectedContent?: string,
  testPath?: string,
  modifiedSourcePaths?: string[]
): { valid: boolean; missingSymbol?: string } {
  const importMatches = testContent.matchAll(/import\s*\{([^}]+)\}\s*from\s*['"](\.[^'"]+)['"]/g);
  for (const match of importMatches) {
    const importTarget = match[2];
    if (testPath && modifiedSourcePaths && modifiedSourcePaths.length > 0) {
      const testDir = testPath.split("/").slice(0, -1).join("/");
      const targetNormalized = canonicalPath(testDir ? `${testDir}/${importTarget}` : importTarget).replace(/\.[a-zA-Z]+$/, "");
      const targetsModifiedSource = modifiedSourcePaths.some((sp) => {
        const spNormalized = canonicalPath(sp).replace(/\.[a-zA-Z]+$/, "");
        return spNormalized === targetNormalized || spNormalized.endsWith(`/${targetNormalized}`);
      });
      if (!targetsModifiedSource) continue;
    }
    const rawSymbols = match[1].split(",");
    for (const raw of rawSymbols) {
      const sym = raw.trim().split(/\s+as\s+/)[0].trim();
      if (!sym || !/^[a-zA-Z_$][a-zA-Z0-9_$]*$/.test(sym)) continue;
      const regex = new RegExp(`\\b${sym}\\b`);
      if (!regex.test(sourceContent) && (!allInspectedContent || !regex.test(allInspectedContent))) {
        return { valid: false, missingSymbol: sym };
      }
    }
  }
  return { valid: true };
}
