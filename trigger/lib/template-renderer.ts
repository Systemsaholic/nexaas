/**
 * Handlebars template renderer for skill system prompts.
 *
 * Reads .hbs files and fills {{slots}} with CAG context data.
 */

import Handlebars from "handlebars";
import { readFileSync } from "fs";

export function renderTemplate(templatePath: string, context: Record<string, unknown>): string {
  const template = readFileSync(templatePath, "utf-8");
  const compiled = Handlebars.compile(template, { noEscape: true });
  return compiled(context);
}
