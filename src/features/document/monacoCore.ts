/**
 * Slim Monaco entry: core editor + diff editor (edcore.main) plus only the
 * languages Anchor Code maps file extensions / markdown fences to
 * (see core/workspace/paths.ts EXT_LANG). Replaces the full
 * `monaco-editor` entry, which registers ~80 basic languages.
 *
 * When adding an extension mapping to a new language, add its contribution here.
 */
import * as monaco from "monaco-editor/esm/vs/editor/edcore.main.js";

// Language services (rich tokenization/validation via workers).
import * as cssContribution from "monaco-editor/esm/vs/language/css/monaco.contribution.js";
import * as htmlContribution from "monaco-editor/esm/vs/language/html/monaco.contribution.js";
import * as jsonContribution from "monaco-editor/esm/vs/language/json/monaco.contribution.js";
import * as tsContribution from "monaco-editor/esm/vs/language/typescript/monaco.contribution.js";

// Monarch tokenizers (each lazily loads its grammar chunk).
import "monaco-editor/esm/vs/basic-languages/cpp/cpp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/csharp/csharp.contribution.js";
import "monaco-editor/esm/vs/basic-languages/css/css.contribution.js";
import "monaco-editor/esm/vs/basic-languages/dockerfile/dockerfile.contribution.js";
import "monaco-editor/esm/vs/basic-languages/go/go.contribution.js";
import "monaco-editor/esm/vs/basic-languages/graphql/graphql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/html/html.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ini/ini.contribution.js";
import "monaco-editor/esm/vs/basic-languages/java/java.contribution.js";
import "monaco-editor/esm/vs/basic-languages/javascript/javascript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/kotlin/kotlin.contribution.js";
import "monaco-editor/esm/vs/basic-languages/less/less.contribution.js";
import "monaco-editor/esm/vs/basic-languages/markdown/markdown.contribution.js";
import "monaco-editor/esm/vs/basic-languages/mdx/mdx.contribution.js";
import "monaco-editor/esm/vs/basic-languages/php/php.contribution.js";
import "monaco-editor/esm/vs/basic-languages/python/python.contribution.js";
import "monaco-editor/esm/vs/basic-languages/ruby/ruby.contribution.js";
import "monaco-editor/esm/vs/basic-languages/rust/rust.contribution.js";
import "monaco-editor/esm/vs/basic-languages/scss/scss.contribution.js";
import "monaco-editor/esm/vs/basic-languages/shell/shell.contribution.js";
import "monaco-editor/esm/vs/basic-languages/sql/sql.contribution.js";
import "monaco-editor/esm/vs/basic-languages/typescript/typescript.contribution.js";
import "monaco-editor/esm/vs/basic-languages/xml/xml.contribution.js";
import "monaco-editor/esm/vs/basic-languages/yaml/yaml.contribution.js";

// Mirror editor.main.js: expose language-service namespaces on the API object.
const langs = monaco.languages as unknown as Record<string, unknown>;
langs.css ??= cssContribution;
langs.html ??= htmlContribution;
langs.json ??= jsonContribution;
langs.typescript ??= tsContribution;

export { monaco };
