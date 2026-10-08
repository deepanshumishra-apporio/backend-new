/** "Branch manager (North)" → "BRANCH_MANAGER_NORTH"; keys are A–Z and underscores only. */
export function roleKeyFrom(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 40)
    .replace(/_+$/, "");
}
