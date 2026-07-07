export function vectorToSql(v: number[]): string {
  return "[" + v.map((x) => x.toString()).join(",") + "]";
}

export function sqlToVector(s: string): number[] {
  const inner = s.replace(/^\[/, "").replace(/\]$/, "");
  if (!inner) return [];
  return inner.split(",").map((x) => parseFloat(x));
}
