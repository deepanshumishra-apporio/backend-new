// CSV writing for report exports. Pure.
//
// RFC 4180 quoting, CRLF line ends and a UTF-8 byte-order mark: without the
// BOM, Excel on Windows reads the file as ANSI and mangles ₹ and any non-Latin
// name.

/** A cell a spreadsheet would run as a formula ("=HYPERLINK(...)"), which an investor-typed name must never become. */
const FORMULA_START = /^[=+\-@\t\r]/;

/**
 * Neutralises a free-text cell for a spreadsheet by prefixing a quote. Only
 * for text columns: a negative amount also starts with "-" and must stay a number.
 */
export function guardFormula(value: string): string {
  return FORMULA_START.test(value) ? `'${value}` : value;
}

function quote(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

export function toCsv(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows].map((cells) => cells.map(quote).join(","));
  return `﻿${lines.join("\r\n")}\r\n`;
}
