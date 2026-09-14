// Generates SCHEMA.md from prisma/schema.prisma.
//
// Generated rather than hand-written so it cannot drift: a reference that
// disagrees with the schema is worse than no reference. Re-run after any schema
// change with `bun run docs:schema`.
import { readFileSync, writeFileSync } from "node:fs";

const SCHEMA_PATH = "prisma/schema.prisma";
const OUT_PATH = "SCHEMA.md";

interface Field {
  name: string;
  type: string;
  optional: boolean;
  list: boolean;
  attrs: string;
  doc: string;
}

interface Model {
  name: string;
  table: string;
  doc: string;
  fields: Field[];
  blockAttrs: string[];
}

interface EnumDef {
  name: string;
  dbName: string;
  doc: string;
  values: { name: string; mapped: string | null }[];
}

const source = readFileSync(SCHEMA_PATH, "utf8");

/** Collect the `///` doc comment block immediately above a line. */
function docAbove(lines: string[], index: number): string {
  const collected: string[] = [];
  for (let i = index - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? "";
    if (line.startsWith("///")) collected.unshift(line.replace(/^\/\/\/\s?/, ""));
    else if (line === "") continue;
    else break;
  }
  return collected.join(" ").trim();
}

function parse(): { models: Model[]; enums: EnumDef[] } {
  const lines = source.split("\n");
  const models: Model[] = [];
  const enums: EnumDef[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";

    const modelMatch = /^model\s+(\w+)\s*\{/.exec(line);
    if (modelMatch?.[1]) {
      const model: Model = {
        name: modelMatch[1],
        table: modelMatch[1],
        doc: docAbove(lines, i),
        fields: [],
        blockAttrs: [],
      };
      for (let j = i + 1; j < lines.length && !/^\}/.test(lines[j] ?? ""); j++) {
        const body = (lines[j] ?? "").trim();
        if (body.startsWith("@@map")) {
          model.table = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? model.name;
          continue;
        }
        if (body.startsWith("@@")) {
          model.blockAttrs.push(body);
          continue;
        }
        const field = /^(\w+)\s+(\w+)(\[\])?(\?)?\s*(.*)$/.exec(body);
        if (field?.[1] && field[2]) {
          model.fields.push({
            name: field[1],
            type: field[2],
            list: field[3] === "[]",
            optional: field[4] === "?",
            attrs: (field[5] ?? "").trim(),
            doc: docAbove(lines, j),
          });
        }
      }
      models.push(model);
      continue;
    }

    const enumMatch = /^enum\s+(\w+)\s*\{/.exec(line);
    if (enumMatch?.[1]) {
      const def: EnumDef = {
        name: enumMatch[1],
        dbName: enumMatch[1],
        doc: docAbove(lines, i),
        values: [],
      };
      for (let j = i + 1; j < lines.length && !/^\}/.test(lines[j] ?? ""); j++) {
        const body = (lines[j] ?? "").trim();
        if (body.startsWith("@@map")) {
          def.dbName = /@@map\("([^"]+)"\)/.exec(body)?.[1] ?? def.name;
          continue;
        }
        if (body === "" || body.startsWith("//") || body.startsWith("@@")) continue;
        const value = /^(\w+)(?:\s+@map\("([^"]+)"\))?/.exec(body);
        if (value?.[1]) def.values.push({ name: value[1], mapped: value[2] ?? null });
      }
      enums.push(def);
      continue;
    }
  }
  return { models, enums };
}

const { models, enums } = parse();

const isRelation = (field: Field, names: Set<string>) => names.has(field.type);
const modelNames = new Set(models.map((m) => m.name));

/** Short, readable type for the reference table. */
function renderType(field: Field): string {
  const base = /@db\.(\w+\([^)]*\)|\w+)/.exec(field.attrs)?.[1] ?? field.type;
  return `${base}${field.list ? "[]" : ""}${field.optional ? "?" : ""}`;
}

function keyOf(field: Field): string {
  const keys: string[] = [];
  if (field.attrs.includes("@id")) keys.push("PK");
  if (field.attrs.includes("@unique")) keys.push("UK");
  if (/@relation\(.*fields:/.test(field.attrs)) keys.push("FK");
  return keys.join(" ");
}

const lines: string[] = [];
lines.push("# Schema reference");
lines.push("");
lines.push(
  "**Generated from `prisma/schema.prisma` — do not edit by hand.** " +
    "Re-run `bun run docs:schema` after any schema change.",
);
lines.push("");
lines.push(
  "For the diagrams and the reasoning behind this shape, see " +
    "[`ARCHITECTURE.md`](ARCHITECTURE.md). The schema file itself carries the " +
    "commentary explaining *why* each decision was made.",
);
lines.push("");
lines.push(`${models.length} models, ${enums.length} enums.`);
lines.push("");

// --- Inventory --------------------------------------------------------------
lines.push("## Model inventory");
lines.push("");
lines.push("`fpId` marks a model mirrored from FP; the rest are ours alone.");
lines.push("");
lines.push("| Model | Table | Mirrors FP | Purpose |");
lines.push("|---|---|---|---|");
for (const model of models) {
  const mirrored = model.fields.some((f) => f.name === "fpId") ? "yes" : "—";
  const purpose = (model.doc.split(/(?<=\.)\s/)[0] ?? "").replace(/\|/g, "\\|");
  lines.push(`| \`${model.name}\` | \`${model.table}\` | ${mirrored} | ${purpose} |`);
}
lines.push("");

// --- Per-model detail -------------------------------------------------------
lines.push("## Models");
lines.push("");
for (const model of models) {
  lines.push(`### ${model.name}`);
  lines.push("");
  lines.push(`Table \`${model.table}\`.`);
  lines.push("");
  if (model.doc) {
    lines.push(model.doc);
    lines.push("");
  }

  const scalars = model.fields.filter((f) => !isRelation(f, modelNames));
  const relations = model.fields.filter((f) => isRelation(f, modelNames));

  lines.push("| Column | Type | Key | Notes |");
  lines.push("|---|---|---|---|");
  for (const field of scalars) {
    const note = field.doc.replace(/\|/g, "\\|");
    lines.push(`| \`${field.name}\` | ${renderType(field)} | ${keyOf(field)} | ${note} |`);
  }
  lines.push("");

  if (relations.length > 0) {
    lines.push("Relations: " + relations.map((r) => `\`${r.name}\` → ${r.type}`).join(", ") + ".");
    lines.push("");
  }
  const indexes = model.blockAttrs.filter((a) => a.startsWith("@@index") || a.startsWith("@@unique"));
  if (indexes.length > 0) {
    lines.push("Indexes:");
    lines.push("");
    for (const index of indexes) lines.push(`- \`${index}\``);
    lines.push("");
  }
}

// --- Enums ------------------------------------------------------------------
lines.push("## Enums");
lines.push("");
lines.push(
  "A `@map` value means the Postgres label is FP's exact wire string, so a row " +
    "reads like an API payload. An enum with no mapped values is ours alone — " +
    "FP has no such concept.",
);
lines.push("");
for (const def of enums) {
  const mapped = def.values.some((v) => v.mapped !== null);
  lines.push(`### ${def.name}`);
  lines.push("");
  if (def.doc) {
    lines.push(def.doc);
    lines.push("");
  }
  lines.push(`Postgres type \`${def.dbName}\`. ${mapped ? "Mirrors FP's wire values." : "Ours."}`);
  lines.push("");
  if (mapped) {
    lines.push("| TypeScript | Database / FP wire |");
    lines.push("|---|---|");
    for (const value of def.values) {
      lines.push(`| \`${value.name}\` | \`${value.mapped ?? value.name}\` |`);
    }
  } else {
    lines.push(def.values.map((v) => `\`${v.name}\``).join(", "));
  }
  lines.push("");
}

writeFileSync(OUT_PATH, `${lines.join("\n")}\n`);
console.log(
  `[docs] wrote ${OUT_PATH}: ${models.length} models, ${enums.length} enums, ${lines.length} lines`,
);
