import ts from "typescript";

import { CONFIG } from "../config";

export interface CodeCompressionResult {
  display: string;
  compressed: boolean;
  displayTokens: number;
  strategy: "typescript-ast";
}

interface SummaryEntry {
  lines: string[];
  score: number;
  order: number;
}

const TS_LIKE_EXTENSIONS = new Set(["ts", "tsx", "js", "jsx", "mjs", "cjs"]);

const TS_LIKE_PATTERN =
  /\b(import|export|from|interface|type|enum|class|function|const|let|var|async|await)\b|=>/;

const IMPORTANT_NAME_RE =
  /(auth|config|controller|guard|handler|middleware|permission|policy|route|schema|security|service|store|token|validate|workflow)/i;

function stripCodeFence(text: string): string {
  const trimmed = text.trim();
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  const match = trimmed.match(/^```(?:ts|tsx|js|jsx|typescript|javascript)?\s*\n([\s\S]*?)\n```$/i);
  return match?.[1] ?? text;
}

function extensionOf(path?: string): string | undefined {
  return path?.split(".").pop()?.toLowerCase();
}

export function isTypeScriptLikeCode(text: string, path?: string): boolean {
  const ext = extensionOf(path);
  if (ext && TS_LIKE_EXTENSIONS.has(ext)) {
    return true;
  }
  // biome-ignore lint/performance/useTopLevelRegex: warning suppression
  if (/^\s*(def |class\s+\w+\s*:|from\s+\w+\s+import|package\s+\w+|func\s+\w+)/m.test(text)) {
    return false;
  }
  return TS_LIKE_PATTERN.test(text.slice(0, 2_000));
}

function scriptKindForPath(path?: string): ts.ScriptKind {
  switch (extensionOf(path)) {
    case "js":
    case "mjs":
    case "cjs":
      return ts.ScriptKind.JS;
    case "jsx":
      return ts.ScriptKind.JSX;
    case "tsx":
      return ts.ScriptKind.TSX;
    default:
      return ts.ScriptKind.TS;
  }
}

function lineRange(sourceFile: ts.SourceFile, node: ts.Node): string {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line + 1;
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd()).line + 1;
  return `L${start}${end === start ? "" : `-L${end}`}`;
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function leadingJsDoc(sourceFile: ts.SourceFile, node: ts.Node): string[] {
  const fullText = sourceFile.getFullText();
  const ranges = ts.getLeadingCommentRanges(fullText, node.pos) ?? [];
  return ranges
    .map((range) => fullText.slice(range.pos, range.end).trim())
    .filter((comment) => comment.startsWith("/**"))
    .map((comment) => oneLine(comment))
    .slice(-1);
}

function modifiersOf(node: ts.Node): readonly ts.Modifier[] {
  return ts.canHaveModifiers(node) ? (ts.getModifiers(node) ?? []) : [];
}

function hasModifier(node: ts.Node, kind: ts.SyntaxKind): boolean {
  return modifiersOf(node).some((modifier) => modifier.kind === kind);
}

function modifiersText(node: ts.Node, sourceFile: ts.SourceFile): string {
  return modifiersOf(node)
    .map((modifier) => modifier.getText(sourceFile))
    .filter((text) => text !== "export" && text !== "default")
    .join(" ");
}

function exportPrefix(node: ts.Node): string {
  return [
    hasModifier(node, ts.SyntaxKind.ExportKeyword) ? "export" : "",
    hasModifier(node, ts.SyntaxKind.DefaultKeyword) ? "default" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function nodeName(node: ts.Node, sourceFile: ts.SourceFile): string {
  const named = node as ts.Node & { name?: ts.Node };
  if (named.name && ts.isIdentifier(named.name)) {
    return named.name.text;
  }
  if (ts.isVariableStatement(node)) {
    return node.declarationList.declarations.map((decl) => decl.name.getText(sourceFile)).join(",");
  }
  return "";
}

function importanceScore(node: ts.Node, sourceFile: ts.SourceFile): number {
  let score = 10;
  if (ts.isClassDeclaration(node)) {
    score += 36;
  }
  if (ts.isFunctionDeclaration(node)) {
    score += 34;
  }
  if (ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)) {
    score += 30;
  }
  if (ts.isEnumDeclaration(node)) {
    score += 24;
  }
  if (ts.isVariableStatement(node)) {
    score += 18;
  }
  if (hasModifier(node, ts.SyntaxKind.ExportKeyword)) {
    score += 70;
  }
  if (hasModifier(node, ts.SyntaxKind.DefaultKeyword)) {
    score += 12;
  }
  if (IMPORTANT_NAME_RE.test(nodeName(node, sourceFile))) {
    score += 18;
  }
  return score;
}

function memberImportanceScore(member: ts.ClassElement, sourceFile: ts.SourceFile): number {
  let score = 10;
  if (ts.isConstructorDeclaration(member)) {
    score += 28;
  }
  if (
    ts.isMethodDeclaration(member) ||
    ts.isGetAccessorDeclaration(member) ||
    ts.isSetAccessorDeclaration(member)
  ) {
    score += 24;
  }
  if (ts.isPropertyDeclaration(member)) {
    score += 12;
  }
  if (
    hasModifier(member, ts.SyntaxKind.PublicKeyword) ||
    !hasModifier(member, ts.SyntaxKind.PrivateKeyword)
  ) {
    score += 15;
  }
  if (hasModifier(member, ts.SyntaxKind.StaticKeyword)) {
    score += 8;
  }
  if (hasModifier(member, ts.SyntaxKind.PrivateKeyword)) {
    score -= 35;
  }
  if (hasModifier(member, ts.SyntaxKind.ProtectedKeyword)) {
    score -= 8;
  }
  if (IMPORTANT_NAME_RE.test(nodeName(member, sourceFile))) {
    score += 16;
  }
  return score;
}

function formatFunctionLike(
  node:
    | ts.FunctionDeclaration
    | ts.MethodDeclaration
    | ts.ConstructorDeclaration
    | ts.GetAccessorDeclaration
    | ts.SetAccessorDeclaration
    | ts.FunctionExpression
    | ts.ArrowFunction,
  sourceFile: ts.SourceFile,
  fallbackName?: string,
): string {
  const prefix = exportPrefix(node);
  const modifiers = modifiersText(node, sourceFile);
  const name = ts.isConstructorDeclaration(node)
    ? "constructor"
    : "name" in node && node.name
      ? node.name.getText(sourceFile)
      : (fallbackName ?? "<anonymous>");
  const typeParams =
    "typeParameters" in node && node.typeParameters
      ? `<${node.typeParameters.map((param) => param.getText(sourceFile)).join(", ")}>`
      : "";
  const params = node.parameters.map((param) => param.getText(sourceFile)).join(", ");
  const returnType = "type" in node && node.type ? `: ${node.type.getText(sourceFile)}` : "";
  const keyword =
    ts.isMethodDeclaration(node) ||
    ts.isConstructorDeclaration(node) ||
    ts.isGetAccessorDeclaration(node) ||
    ts.isSetAccessorDeclaration(node) ||
    ts.isArrowFunction(node)
      ? ""
      : "function ";
  return oneLine(`${prefix} ${modifiers} ${keyword}${name}${typeParams}(${params})${returnType};`);
}

function summarizeMembers(
  members: ts.NodeArray<ts.TypeElement | ts.ClassElement>,
  sourceFile: ts.SourceFile,
  maxMembers = CONFIG.codeCompressor.maxInterfaceMembers,
): string {
  const fieldTexts = members
    .slice(0, maxMembers)
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    .map((member) => oneLine(member.getText(sourceFile).replace(/[,{;]$/, "")));
  const suffix = members.length > maxMembers ? `; ... ${members.length - maxMembers} more` : "";
  return `{ ${fieldTexts.join("; ")}${suffix} }`;
}

function summarizeTypeNode(node: ts.TypeNode, sourceFile: ts.SourceFile): string {
  if (ts.isTypeLiteralNode(node)) {
    return summarizeMembers(node.members, sourceFile);
  }
  if (ts.isUnionTypeNode(node)) {
    const sample = node.types
      .slice(0, CONFIG.codeCompressor.maxUnionTypes)
      .map((type) => oneLine(type.getText(sourceFile)))
      .join(" | ");
    return node.types.length > CONFIG.codeCompressor.maxUnionTypes
      ? `${sample} | ... ${node.types.length - CONFIG.codeCompressor.maxUnionTypes} more`
      : sample;
  }
  return oneLine(node.getText(sourceFile));
}

function formatInterface(node: ts.InterfaceDeclaration, sourceFile: ts.SourceFile): string {
  const prefix = exportPrefix(node);
  const typeParams = node.typeParameters
    ? `<${node.typeParameters.map((param) => param.getText(sourceFile)).join(", ")}>`
    : "";
  const heritage =
    node.heritageClauses?.map((clause) => clause.getText(sourceFile)).join(" ") ?? "";
  return oneLine(
    `${prefix} interface ${node.name.getText(sourceFile)}${typeParams} ${heritage} ${summarizeMembers(node.members, sourceFile)}`,
  );
}

function formatTypeAlias(node: ts.TypeAliasDeclaration, sourceFile: ts.SourceFile): string {
  const prefix = exportPrefix(node);
  const typeParams = node.typeParameters
    ? `<${node.typeParameters.map((param) => param.getText(sourceFile)).join(", ")}>`
    : "";
  return oneLine(
    `${prefix} type ${node.name.getText(sourceFile)}${typeParams} = ${summarizeTypeNode(node.type, sourceFile)};`,
  );
}

function formatEnum(node: ts.EnumDeclaration, sourceFile: ts.SourceFile): string {
  const prefix = exportPrefix(node);
  const members = node.members
    .slice(0, CONFIG.codeCompressor.maxImportantLiterals)
    .map((member) => member.name.getText(sourceFile));
  const suffix =
    node.members.length > CONFIG.codeCompressor.maxImportantLiterals
      ? `, ... ${node.members.length - CONFIG.codeCompressor.maxImportantLiterals} more`
      : "";
  return oneLine(
    `${prefix} enum ${node.name.getText(sourceFile)} { ${members.join(", ")}${suffix} }`,
  );
}

function formatVariableStatement(node: ts.VariableStatement, sourceFile: ts.SourceFile): string {
  const prefix = exportPrefix(node);
  const declarationKind =
    node.declarationList.flags & ts.NodeFlags.Const
      ? "const"
      : node.declarationList.flags & ts.NodeFlags.Let
        ? "let"
        : "var";
  const declarations = node.declarationList.declarations.map((decl) => {
    const name = decl.name.getText(sourceFile);
    const type = decl.type ? `: ${decl.type.getText(sourceFile)}` : "";
    if (!decl.initializer) {
      return `${name}${type}`;
    }
    if (ts.isArrowFunction(decl.initializer) || ts.isFunctionExpression(decl.initializer)) {
      const asyncPrefix = decl.initializer.modifiers?.some(
        (modifier) => modifier.kind === ts.SyntaxKind.AsyncKeyword,
      )
        ? "async "
        : "";
      const params = decl.initializer.parameters
        .map((param) => param.getText(sourceFile))
        .join(", ");
      const returnType = decl.initializer.type
        ? `: ${decl.initializer.type.getText(sourceFile)}`
        : "";
      return `${name}${type} = ${asyncPrefix}(${params})${returnType} => ...`;
    }
    if (ts.isObjectLiteralExpression(decl.initializer)) {
      return `${name}${type} = { ${decl.initializer.properties.length} keys }`;
    }
    if (ts.isArrayLiteralExpression(decl.initializer)) {
      return `${name}${type} = [${decl.initializer.elements.length} items]`;
    }
    return `${name}${type} = <${ts.SyntaxKind[decl.initializer.kind]}>`;
  });
  return oneLine(`${prefix} ${declarationKind} ${declarations.join(", ")};`);
}

function formatClass(node: ts.ClassDeclaration, sourceFile: ts.SourceFile): string[] {
  const prefix = exportPrefix(node);
  const modifiers = modifiersText(node, sourceFile);
  const name = node.name?.getText(sourceFile) ?? "<anonymous>";
  const typeParams = node.typeParameters
    ? `<${node.typeParameters.map((param) => param.getText(sourceFile)).join(", ")}>`
    : "";
  const heritage =
    node.heritageClauses?.map((clause) => clause.getText(sourceFile)).join(" ") ?? "";
  const lines = [oneLine(`${prefix} ${modifiers} class ${name}${typeParams} ${heritage} {`)];

  const members = node.members
    .map((member, order) => ({ member, order, score: memberImportanceScore(member, sourceFile) }))
    .sort((a, b) => b.score - a.score || a.order - b.order);

  for (const { member } of members.slice(0, CONFIG.codeCompressor.maxClassMembers)) {
    if (
      ts.isMethodDeclaration(member) ||
      ts.isConstructorDeclaration(member) ||
      ts.isGetAccessorDeclaration(member) ||
      ts.isSetAccessorDeclaration(member)
    ) {
      lines.push(`  ${formatFunctionLike(member, sourceFile)} // ${lineRange(sourceFile, member)}`);
      continue;
    }
    if (ts.isPropertyDeclaration(member)) {
      const mods = modifiersText(member, sourceFile);
      const propName = member.name.getText(sourceFile);
      const type = member.type ? `: ${member.type.getText(sourceFile)}` : "";
      lines.push(`  ${oneLine(`${mods} ${propName}${type};`)} // ${lineRange(sourceFile, member)}`);
    }
  }
  if (members.length > CONFIG.codeCompressor.maxClassMembers) {
    lines.push(
      `  // ... ${members.length - CONFIG.codeCompressor.maxClassMembers} lower-priority members omitted`,
    );
  }
  lines.push("}");
  return lines;
}

function formatTopLevel(node: ts.Node, sourceFile: ts.SourceFile): string[] {
  if (ts.isFunctionDeclaration(node)) {
    return [
      ...leadingJsDoc(sourceFile, node),
      `${formatFunctionLike(node, sourceFile)} // ${lineRange(sourceFile, node)}`,
    ];
  }
  if (ts.isClassDeclaration(node)) {
    return [
      ...leadingJsDoc(sourceFile, node),
      ...formatClass(node, sourceFile).map((line, index) =>
        index === 0 ? `${line} // ${lineRange(sourceFile, node)}` : line,
      ),
    ];
  }
  if (ts.isInterfaceDeclaration(node)) {
    return [
      ...leadingJsDoc(sourceFile, node),
      `${formatInterface(node, sourceFile)} // ${lineRange(sourceFile, node)}`,
    ];
  }
  if (ts.isTypeAliasDeclaration(node)) {
    return [
      ...leadingJsDoc(sourceFile, node),
      `${formatTypeAlias(node, sourceFile)} // ${lineRange(sourceFile, node)}`,
    ];
  }
  if (ts.isEnumDeclaration(node)) {
    return [
      ...leadingJsDoc(sourceFile, node),
      `${formatEnum(node, sourceFile)} // ${lineRange(sourceFile, node)}`,
    ];
  }
  if (ts.isVariableStatement(node)) {
    return [
      ...leadingJsDoc(sourceFile, node),
      `${formatVariableStatement(node, sourceFile)} // ${lineRange(sourceFile, node)}`,
    ];
  }
  return [];
}

function collectNestedSymbols(sourceFile: ts.SourceFile): string[] {
  const lines: string[] = [];
  const seen = new Set<string>();
  const add = (line: string) => {
    const normalized = oneLine(line);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      lines.push(normalized);
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isFunctionDeclaration(node) && node.parent && !ts.isSourceFile(node.parent)) {
      add(`${formatFunctionLike(node, sourceFile)} // nested ${lineRange(sourceFile, node)}`);
      return;
    }
    if (
      ts.isVariableDeclaration(node) &&
      node.initializer &&
      !ts.isSourceFile(node.parent.parent)
    ) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        add(
          `const ${formatFunctionLike(node.initializer, sourceFile, node.name.getText(sourceFile))} // nested ${lineRange(sourceFile, node)}`,
        );
      }
    }
    if (ts.isMethodDeclaration(node) && ts.isObjectLiteralExpression(node.parent)) {
      add(
        `${formatFunctionLike(node, sourceFile)} // object method ${lineRange(sourceFile, node)}`,
      );
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);
  return lines.slice(0, CONFIG.codeCompressor.maxNestedSymbols);
}

function collectImportantLiterals(sourceFile: ts.SourceFile): string[] {
  const env = new Set<string>();
  const routes = new Set<string>();
  const sqlTables = new Set<string>();
  const codes = new Set<string>();

  const inspectString = (value: string) => {
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    if (/^\/[A-Za-z0-9_./:{}-]+$/.test(value)) {
      routes.add(value);
    }
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    if (/^(?:ERR|WARN|AUTH|PERM|ROLE|SCOPE|HTTP|MEMH)_[A-Z0-9_]+$/.test(value)) {
      codes.add(value);
    }
    // biome-ignore lint/performance/useTopLevelRegex: warning suppression
    if (/^[A-Z][A-Z0-9_]{2,}$/.test(value)) {
      env.add(value);
    }
    for (const match of value.matchAll(/\b(?:from|join|into|update)\s+([A-Za-z_][\w.]*)/gi)) {
      if (match[1]) {
        sqlTables.add(match[1]);
      }
    }
  };

  const visit = (node: ts.Node) => {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      inspectString(node.text);
    }
    if (
      ts.isPropertyAccessExpression(node) &&
      node.expression.getText(sourceFile) === "process.env"
    ) {
      env.add(node.name.getText(sourceFile));
    }
    if (
      ts.isElementAccessExpression(node) &&
      node.expression.getText(sourceFile) === "process.env" &&
      node.argumentExpression &&
      ts.isStringLiteralLike(node.argumentExpression)
    ) {
      env.add(node.argumentExpression.text);
    }
    ts.forEachChild(node, visit);
  };

  ts.forEachChild(sourceFile, visit);

  return [
    routes.size > 0
      ? `routes=${[...routes].slice(0, CONFIG.codeCompressor.maxImportantLiterals).join(",")}`
      : "",
    env.size > 0
      ? `env=${[...env].slice(0, CONFIG.codeCompressor.maxImportantLiterals).join(",")}`
      : "",
    codes.size > 0
      ? `codes=${[...codes].slice(0, CONFIG.codeCompressor.maxImportantLiterals).join(",")}`
      : "",
    sqlTables.size > 0
      ? `sql_tables=${[...sqlTables].slice(0, CONFIG.codeCompressor.maxImportantLiterals).join(",")}`
      : "",
  ].filter(Boolean);
}

function appendWithinBudget(output: string[], entry: string[], maxLines: number): number {
  const reserveForOmittedLines = 2;
  const available = maxLines - output.length - reserveForOmittedLines;
  if (available <= 0) {
    return entry.length;
  }
  if (entry.length <= available) {
    output.push(...entry);
    return 0;
  }
  if (available >= 2) {
    output.push(...entry.slice(0, available));
    return entry.length - available;
  }
  return entry.length;
}

export function compressCodeWithAst(
  text: string,
  opts: { path?: string; maxLines?: number } = {},
): CodeCompressionResult | null {
  const source = stripCodeFence(text);
  if (!isTypeScriptLikeCode(source, opts.path)) {
    return null;
  }

  const path = opts.path ?? "memory.ts";
  const sourceFile = ts.createSourceFile(
    path,
    source,
    ts.ScriptTarget.Latest,
    true,
    scriptKindForPath(path),
  );
  const parseDiagnostics =
    (sourceFile as ts.SourceFile & { parseDiagnostics?: readonly ts.Diagnostic[] })
      .parseDiagnostics ?? [];
  const hasParseErrors = parseDiagnostics.length > 0;

  const lines = source.split("\n");
  const importLines: string[] = [];
  const entries: SummaryEntry[] = [];

  sourceFile.statements.forEach((statement, order) => {
    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      importLines.push(oneLine(statement.getText(sourceFile)));
      return;
    }

    const entryLines = formatTopLevel(statement, sourceFile);
    if (entryLines.length === 0) {
      return;
    }
    entries.push({
      lines: entryLines,
      score: importanceScore(statement, sourceFile),
      order,
    });
  });

  if (entries.length === 0 && importLines.length === 0) {
    return null;
  }
  if (hasParseErrors && entries.length < 2 && importLines.length === 0) {
    return null;
  }

  const nested = collectNestedSymbols(sourceFile);
  const importantLiterals = collectImportantLiterals(sourceFile);
  const maxLines = opts.maxLines ?? CONFIG.codeCompressor.maxAstSummaryLines;
  const header = hasParseErrors
    ? `// ${lines.length} lines, partial TypeScript AST summary; implementation bodies deferred`
    : `// ${lines.length} lines, ranked TypeScript AST summary; implementation bodies deferred`;
  const output = [header];

  let omittedSummaryLines = 0;
  for (const importLine of importLines) {
    omittedSummaryLines += appendWithinBudget(output, [importLine], maxLines);
  }

  if (importantLiterals.length > 0) {
    omittedSummaryLines += appendWithinBudget(
      output,
      [`// important literals: ${importantLiterals.join(" | ")}`],
      maxLines,
    );
  }

  for (const entry of [...entries].sort((a, b) => b.score - a.score || a.order - b.order)) {
    omittedSummaryLines += appendWithinBudget(output, entry.lines, maxLines);
  }

  if (nested.length > 0) {
    omittedSummaryLines += appendWithinBudget(
      output,
      ["// nested declarations", ...nested],
      maxLines,
    );
  }

  if (omittedSummaryLines > 0 && output.length < maxLines) {
    output.push(`// ... ${omittedSummaryLines} lower-priority summary lines omitted`);
  }

  const display = output.filter((line) => line.trim().length > 0).join("\n");
  const nonEmptySourceLines = lines.filter((line) => line.trim().length > 0).length;
  const structurallyCompressed =
    opts.maxLines !== undefined ||
    hasParseErrors ||
    omittedSummaryLines > 0 ||
    display.split("\n").length < nonEmptySourceLines * 0.9;

  if (!structurallyCompressed && display.length >= source.length * 0.85) {
    return {
      display: source,
      compressed: false,
      displayTokens: Math.ceil(source.length / 4),
      strategy: "typescript-ast",
    };
  }

  const omittedSourceLines = Math.max(0, lines.length - display.split("\n").length);
  const finalDisplay = [
    display,
    omittedSourceLines > 0
      ? `// ... ${omittedSourceLines} source lines omitted (retrieve with memory_retrieve)`
      : "",
  ]
    .filter(Boolean)
    .join("\n");

  return {
    display: finalDisplay,
    compressed: true,
    displayTokens: Math.ceil(finalDisplay.length / 4),
    strategy: "typescript-ast",
  };
}
