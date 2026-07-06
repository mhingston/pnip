export interface ParseResult {
  command: string | undefined;
  rest: string[];
}

export function parseCommand(argv: string[]): ParseResult {
  const args = argv.slice(2);
  const command = args.length > 0 && !args[0].startsWith("-") ? args[0] : undefined;
  const rest = command ? args.slice(1) : args;
  return { command, rest };
}
