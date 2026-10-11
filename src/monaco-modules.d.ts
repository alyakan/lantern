// The language services have no type declarations of their own: only what monaco.ts uses of them.
declare module "monaco-editor/language/typescript/monaco.contribution" {
  export interface LanguageServiceDefaults {
    setCompilerOptions(options: Record<string, unknown>): void;
    setDiagnosticsOptions(options: { noSemanticValidation?: boolean; noSyntaxValidation?: boolean; noSuggestionDiagnostics?: boolean }): void;
    setEagerModelSync(value: boolean): void;
    /** Makes a file's text known to the service (by `filePath`, a file:// URI); the returned handle removes it again. */
    addExtraLib(content: string, filePath?: string): { dispose(): void };
    getExtraLibs(): Record<string, { content: string; version: number }>;
  }
  export const typescriptDefaults: LanguageServiceDefaults;
  export const javascriptDefaults: LanguageServiceDefaults;
  export const JsxEmit: Record<string, number>;
  export const ModuleKind: Record<string, number>;
  export const ModuleResolutionKind: Record<string, number>;
  export const ScriptTarget: Record<string, number>;
}
declare module "monaco-editor/language/json/monaco.contribution" {
  export const jsonDefaults: {
    setDiagnosticsOptions(options: { validate?: boolean; allowComments?: boolean; comments?: "error" | "warning" | "ignore"; trailingCommas?: "error" | "warning" | "ignore" }): void;
  };
}
declare module "monaco-editor/language/css/monaco.contribution";
declare module "monaco-editor/language/html/monaco.contribution";
